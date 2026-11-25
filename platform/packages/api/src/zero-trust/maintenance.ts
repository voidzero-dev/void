import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db.ts';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { projects, projectZeroTrust } from '../schema.ts';
import { candidateQuery } from './candidates.ts';
import type { ZeroTrustCloudflareClient } from './cloudflare.ts';
import { readZeroTrustConfigurationStrict, zeroTrustConfigurationStatus } from './configuration.ts';
import type { ZeroTrustConfiguration } from './configuration.ts';
import { ZeroTrustUnavailableError } from './errors.ts';
import { resumePlatformZeroTrustOperation } from './installation.ts';
import { withProjectZeroTrustLock } from './lock.ts';
import { reconcileProjectZeroTrust } from './project.ts';
import { MAX_ROUTING_KEYS_PER_RUN, publishProjectZeroTrustRoutingLocked } from './routing.ts';
import type { RoutingBudget } from './routing.ts';
import {
  clientForConfiguration,
  getProjectZeroTrustState,
  initialProjectProtection,
  markPendingProjectError,
  MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT,
  putProjectState,
  updateProjectState,
} from './state.ts';

/** Clear protection left on a project after the installation finished disabling. */
async function retireDisabledProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  client: ZeroTrustCloudflareClient,
  routingBudget: RoutingBudget,
): Promise<void> {
  await withProjectZeroTrustLock(db, projectId, async (lockedDb, recordErrors) => {
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    if (!saved || saved.enabled || saved.operation) {
      throw new ZeroTrustUnavailableError('Project Zero Trust configuration changed.');
    }
    const project = await getProject(lockedDb, projectId);
    const row = await getProjectZeroTrustState(lockedDb, projectId);
    if (!project || project.status === 'deleting' || !row) {
      return;
    }
    await recordErrors(async () => {
      await putProjectState(lockedDb, projectId, {
        desired_protected: false,
        status: 'reconciling',
        ...(row.desired_protected ? { routing_cursor: null } : {}),
      });
      if (
        !(await publishProjectZeroTrustRoutingLocked(env, lockedDb, project, null, routingBudget))
      ) {
        routingBudget.exhausted = true;
        return;
      }
      // The wildcard is gone, so neither exception application still guards anything.
      await client.deleteApplication(row.protected_application_id, row.protected_application_name);
      await client.deleteApplication(row.bypass_application_id, row.bypass_application_name);
      await updateProjectState(lockedDb, projectId, {
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        protected_application_id: null,
        protected_application_name: null,
        protected_application_audience: null,
        bypass_application_id: null,
        bypass_application_name: null,
        last_error: null,
      });
    });
  });
}

async function retirePendingDisabledProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  configuration: ZeroTrustConfiguration,
  limit: number,
  routingBudget: RoutingBudget,
): Promise<void> {
  const rows = await candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        or(
          sql`${projectZeroTrust.status} <> 'ready'`,
          eq(projectZeroTrust.desired_protected, true),
          eq(projectZeroTrust.effective_protected, true),
          sql`${projectZeroTrust.protected_application_id} IS NOT NULL`,
          sql`${projectZeroTrust.protected_application_name} IS NOT NULL`,
          sql`${projectZeroTrust.bypass_application_id} IS NOT NULL`,
          sql`${projectZeroTrust.bypass_application_name} IS NOT NULL`,
        ),
      ),
    )
    .orderBy(projectZeroTrust.updated_at, projects.created_at)
    .limit(limit);
  if (rows.length === 0) {
    return;
  }
  const client = await clientForConfiguration(env, configuration);
  for (const row of rows) {
    if (routingBudget.exhausted || routingBudget.remaining < 1) {
      break;
    }
    await retireDisabledProjectZeroTrust(env, db, row.project.id, client, routingBudget).catch(
      (error: unknown) =>
        console.error('[zero-trust] scheduled project cleanup failed', {
          projectId: row.project.id,
          error,
        }),
    );
  }
}

export async function reconcilePendingProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  limit = 20,
  /** The cron run's routing budget; the public gate backstop spends the rest of it. */
  routingBudget: RoutingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN },
): Promise<void> {
  const configuration = await readZeroTrustConfigurationStrict(db);
  if (!configuration) {
    return;
  }
  if (configuration.operation) {
    // The hourly tier also retries an operation that failed; the fast tier does not.
    await resumePlatformZeroTrustOperation(env, db, { saved: configuration, retryFailed: true });
    return;
  }
  if (!configuration.enabled) {
    // Projects skipped by a completed disable operation still hold protection.
    await retirePendingDisabledProjectZeroTrust(env, db, configuration, limit, routingBudget);
    return;
  }
  if (zeroTrustConfigurationStatus(configuration) !== 'ready') {
    return;
  }
  const rows = await candidateQuery(db)
    .where(
      and(
        eq(projects.status, 'active'),
        or(isNull(projectZeroTrust.project_id), sql`${projectZeroTrust.status} <> 'ready'`),
      ),
    )
    // A project without a row has no recorded attempt and cannot deploy, so it
    // goes first. Postgres would otherwise sort its NULL timestamp last.
    .orderBy(sql`${projectZeroTrust.updated_at} ASC NULLS FIRST`, projects.created_at)
    .limit(limit);
  if (rows.length === 0) {
    return;
  }
  const client = await clientForConfiguration(env, configuration);
  for (const row of rows) {
    if (
      routingBudget.exhausted ||
      routingBudget.remaining < MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT + 1
    ) {
      break;
    }
    await reconcileProjectZeroTrust(env, db, row.project.id, {
      configuration,
      client,
      routingBudget,
    }).catch(async (error: unknown) => {
      console.error('[zero-trust] scheduled project reconciliation failed', {
        projectId: row.project.id,
        error,
      });
      // A checkpoint failure rolls back without touching the row, or without
      // creating it. Record it so the project moves behind other pending
      // projects in the next run.
      await markPendingProjectError(
        db,
        row.project.id,
        error,
        initialProjectProtection(configuration, row.project),
      ).catch((markError: unknown) =>
        console.error('[zero-trust] could not record scheduled reconciliation failure', {
          projectId: row.project.id,
          error: markError,
        }),
      );
    });
  }
}
