import {
  PLATFORM_APPLICATION_KEY,
  platformHealthHostname,
  readPlatformApplication,
} from '@void/platform';
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { setPlatformSetting } from '../platform-settings.ts';
import { projectZeroTrust } from '../schema.ts';
import {
  PLATFORM_APPLICATION_SETTING,
  resolveZeroTrustApplicationEnvironment,
} from './application.ts';
import {
  bypassCleanupCandidates,
  disableCandidates,
  publicBypassCandidates,
  reconciliationCandidates,
  retrySkippedProjects,
  seedCandidates,
  skippedOperationKey,
  skippedProjectIds,
} from './candidates.ts';
import type { ZeroTrustCloudflareClient } from './cloudflare.ts';
import {
  ZeroTrustCloudflareError,
  reusablePolicyReferences,
  publicAppManagementApplication,
} from './cloudflare.ts';
import {
  readZeroTrustConfigurationStrict,
  replaceZeroTrustConfiguration,
  writeZeroTrustConfiguration,
  zeroTrustWildcardDestinations,
} from './configuration.ts';
import type { ZeroTrustConfiguration, ZeroTrustOperation } from './configuration.ts';
import { errorMessage, ZeroTrustUnavailableError } from './errors.ts';
import { lockZeroTrustConfiguration, withProjectZeroTrustLock } from './lock.ts';
import { reconcileProjectZeroTrust, reconcilePublicProjectForOperation } from './project.ts';
import { MAX_ROUTING_KEYS_PER_RUN, publishProjectZeroTrustRoutingLocked } from './routing.ts';
import type { RoutingBudget } from './routing.ts';
import {
  applicationName,
  clientForConfiguration,
  getProjectZeroTrustState,
  initialProjectProtection,
  putProjectState,
  sameConfiguration,
  updateProjectState,
} from './state.ts';

const OPERATION_LEASE_MS = 15 * 60 * 1000;
const MAX_PROJECTS_PER_RUN = 100;

async function setInitialProjectProtection(
  db: Db,
  projectId: string,
  protectedProject: boolean,
  configuration: ZeroTrustConfiguration,
): Promise<void> {
  await withProjectZeroTrustLock(db, projectId, async (lockedDb) => {
    if (!sameConfiguration(configuration, await readZeroTrustConfigurationStrict(lockedDb))) {
      throw new ZeroTrustUnavailableError('The Zero Trust operation was replaced.');
    }
    const project = await getProject(lockedDb, projectId);
    if (!project || project.status === 'deleting') {
      return;
    }
    await putProjectState(lockedDb, projectId, {
      desired_protected: protectedProject,
      status: 'reconciling',
      last_error: null,
    });
  });
}

export function leaseExpiresAt(): string {
  return new Date(Date.now() + OPERATION_LEASE_MS).toISOString();
}

export function leaseActive(operation: ZeroTrustOperation): boolean {
  const expiry = operation.leaseExpiresAt ? Date.parse(operation.leaseExpiresAt) : Number.NaN;
  return operation.owner !== null && Number.isFinite(expiry) && expiry > Date.now();
}

export async function operationStartedAt(db: DbOrTx): Promise<string> {
  // Project timestamps are stored without a time zone. Use their database clock,
  // rather than a Worker clock/UTC literal that may compare in a different zone.
  const result = await db.execute<{ startedAt: string }>(
    sql`SELECT now()::timestamp::text AS "startedAt"`,
  );
  return result.rows[0]!.startedAt;
}

/**
 * Claim the installation operation under the exclusive lock. A resumed
 * operation keeps its id; a new one gets a fresh id from the claim callback.
 */
export async function claimConfiguration(
  db: Db,
  claim: (
    current: ZeroTrustConfiguration | null,
    owner: string,
    startedAt: string,
  ) => ZeroTrustConfiguration | Promise<ZeroTrustConfiguration>,
): Promise<ZeroTrustConfiguration> {
  return db.transaction(async (tx) => {
    await lockZeroTrustConfiguration(tx, 'exclusive');
    const current = await readZeroTrustConfigurationStrict(tx);
    if (current?.operation && leaseActive(current.operation)) {
      throw new ZeroTrustUnavailableError('Another Zero Trust operation is already running.');
    }
    const configuration = await claim(current, crypto.randomUUID(), await operationStartedAt(tx));
    await writeZeroTrustConfiguration(tx, configuration);
    return configuration;
  });
}

async function patchConfiguration(
  db: Db,
  current: ZeroTrustConfiguration,
  values: Partial<ZeroTrustConfiguration>,
): Promise<ZeroTrustConfiguration> {
  const next: ZeroTrustConfiguration = {
    ...current,
    ...values,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  if (!(await replaceZeroTrustConfiguration(db, current.revision, next))) {
    throw new ZeroTrustUnavailableError('A newer Zero Trust operation replaced this request.');
  }
  return next;
}

async function heartbeatConfiguration(
  db: Db,
  current: ZeroTrustConfiguration,
): Promise<ZeroTrustConfiguration> {
  if (!current.operation?.owner) {
    throw new ZeroTrustUnavailableError('The Zero Trust operation lease was lost.');
  }
  return patchConfiguration(db, current, {
    operation: { ...current.operation, leaseExpiresAt: leaseExpiresAt() },
  });
}

async function advanceOperation(
  db: Db,
  current: ZeroTrustConfiguration,
  phase: ZeroTrustOperation['phase'],
  values: Partial<ZeroTrustConfiguration> = {},
): Promise<ZeroTrustConfiguration> {
  if (!current.operation?.owner) {
    throw new ZeroTrustUnavailableError('The Zero Trust operation lease was lost.');
  }
  return patchConfiguration(db, current, {
    ...values,
    operation: { ...current.operation, phase, leaseExpiresAt: leaseExpiresAt() },
  });
}

async function releaseOperation(
  db: Db,
  current: ZeroTrustConfiguration,
): Promise<ZeroTrustConfiguration> {
  if (!current.operation) {
    return current;
  }
  return patchConfiguration(db, current, {
    operation: { ...current.operation, owner: null, leaseExpiresAt: null },
  });
}

async function failOperation(
  db: Db,
  current: ZeroTrustConfiguration,
  error: unknown,
): Promise<void> {
  await patchConfiguration(db, current, {
    lastError: errorMessage(error),
    operation: current.operation
      ? { ...current.operation, owner: null, leaseExpiresAt: null }
      : null,
  }).catch(() => undefined);
}

function isDeletedProject(error: unknown): boolean {
  return error instanceof ZeroTrustUnavailableError && error.message === 'Project is unavailable.';
}

/** Credential, rate-limit and provider outages affect every project; the whole operation retries. */
function isOperationWideFailure(error: unknown): boolean {
  if (error instanceof ZeroTrustCloudflareError) {
    return (
      error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500
    );
  }
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError'))
  );
}

/**
 * Record a project failure and let the operation continue. The row keeps a
 * skip marker so later batches pass over it; scheduled per-project maintenance
 * retries it after the operation finishes. An operation with an application
 * target cannot finish while such a row remains (completeConfigureOperation).
 * The skip never marks a row
 * effectively public. Routes a disable already cleared stay cleared; they open
 * with every other project when the wildcard is deleted. Returns false,
 * writing nothing, when a newer operation has replaced this one.
 */
async function skipFailedProject(
  db: Db,
  projectId: string,
  configuration: ZeroTrustConfiguration & { operation: ZeroTrustOperation },
  error: unknown,
): Promise<boolean> {
  const reconciledOperation = skippedOperationKey(configuration.operation);
  const lastError = errorMessage(error);
  const skipped = await withProjectZeroTrustLock(db, projectId, async (lockedDb) => {
    // A claim takes the exclusive lock, so the revision cannot change while this
    // shared lock is held. A newer operation may already have reconciled this
    // row; recording the stale failure would overwrite its result.
    if (!sameConfiguration(configuration, await readZeroTrustConfigurationStrict(lockedDb))) {
      return false;
    }
    const project = await getProject(lockedDb, projectId);
    if (!project || project.status === 'deleting') {
      return true;
    }
    await lockedDb
      .insert(projectZeroTrust)
      .values({
        project_id: projectId,
        desired_protected:
          configuration.operation.kind !== 'disable' &&
          initialProjectProtection(configuration, project),
        effective_protected: false,
        status: 'error',
        reconciled_operation: reconciledOperation,
        last_error: lastError,
      })
      .onConflictDoUpdate({
        target: projectZeroTrust.project_id,
        set: {
          status: 'error',
          reconciled_operation: reconciledOperation,
          last_error: lastError,
          updated_at: sql`now()`,
        },
      });
    return true;
  });
  if (skipped) {
    console.error('[zero-trust] installation operation skipped a failed project', {
      projectId,
      error,
    });
  }
  return skipped;
}

/** Run one project's work inside an installation batch; only operation-wide failures escape. */
async function runOperationProjectStep(
  db: Db,
  configuration: ZeroTrustConfiguration,
  projectId: string,
  step: () => Promise<unknown>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (isDeletedProject(error)) {
      return;
    }
    const operation = configuration.operation;
    if (
      !operation ||
      isOperationWideFailure(error) ||
      !(await skipFailedProject(db, projectId, { ...configuration, operation }, error))
    ) {
      throw error;
    }
  }
}

async function withZeroTrustOperationLock(
  db: Db,
  configuration: ZeroTrustConfiguration,
  mutate: (lockedDb: Db) => Promise<ZeroTrustConfiguration>,
): Promise<ZeroTrustConfiguration> {
  return db.transaction(async (tx) => {
    await lockZeroTrustConfiguration(tx, 'exclusive');
    const saved = await readZeroTrustConfigurationStrict(tx);
    if (!sameConfiguration(configuration, saved) || !saved.operation?.owner) {
      throw new ZeroTrustUnavailableError('The Zero Trust operation was replaced.');
    }
    // The provider write and its checkpoint share the claim lock. A CAS after
    // the provider call alone cannot stop a stale request restoring old policy
    // or deleting the application used by a newer operation.
    return mutate(tx);
  });
}

function skippedProjectsError(projectIds: ReadonlyArray<string>): string {
  const shown = projectIds.slice(0, 5).join(', ');
  const more = projectIds.length > 5 ? ' and others' : '';
  return `The new application domain stays unpublished until Zero Trust can update projects ${shown}${more}. See each project's last error with \`void platform zero-trust project-status <project-id>\`, fix the cause, then run \`void platform zero-trust reconcile\`. Void also retries every hour.`;
}

async function completeConfigureOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  configuration: ZeroTrustConfiguration,
): Promise<ZeroTrustConfiguration | null> {
  return db.transaction(async (tx) => {
    await lockZeroTrustConfiguration(tx, 'exclusive');
    const saved = await readZeroTrustConfigurationStrict(tx);
    if (!sameConfiguration(configuration, saved) || !saved.operation) {
      throw new ZeroTrustUnavailableError('A newer Zero Trust operation replaced this request.');
    }
    // Project mutation/deployment holds the shared lock. Recheck under its exclusive
    // counterpart so the final publication cannot overtake an in-flight reconciliation.
    if ((await reconciliationCandidates(tx, saved.operation, 1)).length) {
      return null;
    }
    if (saved.operation.applicationTarget) {
      // A skipped project still lacks the new hostnames: a protected route has
      // no audience for them (dispatch answers 403) and a public bypass does
      // not cover them (Access asks for sign-in). Keep the domain unpublished,
      // make those projects candidates for the next run, and stop this run
      // failed so only the hourly tier or an operator retries it.
      const skipped = await skippedProjectIds(tx, saved.operation, 6);
      if (skipped.length > 0) {
        await retrySkippedProjects(tx, saved.operation);
        return patchConfiguration(tx, saved, {
          lastError: skippedProjectsError(skipped),
          operation: { ...saved.operation, owner: null, leaseExpiresAt: null },
        });
      }
      const application = saved.operation.applicationTarget;
      await setPlatformSetting(tx, PLATFORM_APPLICATION_SETTING, application);
      await env.ROUTING.put(PLATFORM_APPLICATION_KEY, JSON.stringify(application));
    }
    return patchConfiguration(tx, saved, {
      operation: null,
      lastError: null,
    });
  });
}

export async function runConfigureOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  initial: ZeroTrustConfiguration,
  suppliedClient?: ZeroTrustCloudflareClient,
  suppliedSelection?: { teamDomain: string },
): Promise<ZeroTrustConfiguration> {
  let configuration = initial;
  let projectsProcessed = 0;
  const routingBudget: RoutingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN };
  try {
    env = await resolveZeroTrustApplicationEnvironment(env, db, configuration);
    const client = suppliedClient ?? (await clientForConfiguration(env, configuration));
    const selection =
      suppliedSelection ??
      (await (configuration.publicAccess
        ? client.getOrganization()
        : client.validateSelection({
            identityProviderIds: configuration.identityProviderIds,
            policyIds: configuration.policyIds,
          })));
    if (selection.teamDomain !== configuration.teamDomain) {
      configuration = await patchConfiguration(db, configuration, {
        teamDomain: selection.teamDomain,
      });
    }

    while (configuration.operation && configuration.operation.kind !== 'disable') {
      const operation = configuration.operation;
      if (operation.phase === 'seed') {
        if (operation.existingProjects) {
          const existing = await seedCandidates(
            db,
            operation,
            true,
            MAX_PROJECTS_PER_RUN - projectsProcessed,
          );
          for (const candidate of existing) {
            await setInitialProjectProtection(
              db,
              candidate.project.id,
              initialProjectProtection(configuration, candidate.project),
              configuration,
            );
            projectsProcessed += 1;
            configuration = await heartbeatConfiguration(db, configuration);
          }
          if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
            return releaseOperation(db, configuration);
          }
        }
        const missing = await seedCandidates(
          db,
          operation,
          false,
          MAX_PROJECTS_PER_RUN - projectsProcessed,
        );
        for (const candidate of missing) {
          await setInitialProjectProtection(
            db,
            candidate.project.id,
            initialProjectProtection(configuration, candidate.project),
            configuration,
          );
          projectsProcessed += 1;
          configuration = await heartbeatConfiguration(db, configuration);
        }
        if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
          return releaseOperation(db, configuration);
        }
        configuration = await advanceOperation(
          db,
          configuration,
          configuration.wildcardApplication && !operation.applicationTarget
            ? 'wildcard'
            : 'public-bypasses',
        );
        continue;
      }

      if (operation.phase === 'public-bypasses') {
        const candidates = await publicBypassCandidates(
          db,
          MAX_PROJECTS_PER_RUN - projectsProcessed,
          operation,
        );
        for (const candidate of candidates) {
          const batch = configuration;
          await runOperationProjectStep(db, batch, candidate.project.id, () =>
            reconcilePublicProjectForOperation(
              env,
              db,
              candidate.project.id,
              batch,
              client,
              routingBudget,
            ),
          );
          projectsProcessed += 1;
          configuration = await heartbeatConfiguration(db, configuration);
          if (routingBudget.exhausted || routingBudget.remaining === 0) {
            return releaseOperation(db, configuration);
          }
        }
        if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
          return releaseOperation(db, configuration);
        }
        configuration = await advanceOperation(db, configuration, 'wildcard');
        continue;
      }

      if (operation.phase === 'wildcard') {
        const healthHostname = platformHealthHostname(readPlatformApplication(env));
        if (healthHostname && !configuration.healthApplicationName) {
          // Configurations saved before the health exception existed lack its
          // name. Commit it before any create so a lost response is recoverable.
          configuration = await patchConfiguration(db, configuration, {
            healthApplicationName: await applicationName(env, 'platform-health'),
          });
          continue;
        }
        const name = configuration.wildcardApplicationName;
        configuration = await withZeroTrustOperationLock(db, configuration, async (lockedDb) => {
          // Health probes reach dispatch through this bypass of `/health` on
          // the health hostname. It exists before the wildcard covers that
          // hostname, and dispatch never routes that path to a project.
          const health =
            healthHostname && configuration.healthApplicationName
              ? await client.ensureHealthApplication(
                  configuration.healthApplicationName,
                  healthHostname,
                  configuration.healthApplication,
                )
              : configuration.healthApplication;
          const wildcard = await client.ensureApplication(
            configuration.publicAccess
              ? publicAppManagementApplication(name, configuration.publicAccessGuardDestination!)
              : {
                  name,
                  destinations: zeroTrustWildcardDestinations(readPlatformApplication(env)),
                  allowedIdentityProviderIds: configuration.identityProviderIds,
                  policies: reusablePolicyReferences(configuration.policyIds),
                },
            { id: configuration.wildcardApplication?.id, name },
          );
          return advanceOperation(lockedDb, configuration, 'projects', {
            enabled: true,
            wildcardApplication: wildcard,
            healthApplication: health,
            lastError: null,
          });
        });
        continue;
      }

      if (operation.phase === 'projects') {
        const candidates = await reconciliationCandidates(
          db,
          operation,
          MAX_PROJECTS_PER_RUN - projectsProcessed,
        );
        if (candidates.length === 0) {
          const completed = await completeConfigureOperation(env, db, configuration);
          if (completed) {
            return completed;
          }
          continue;
        }
        let stoppedForRoutingBudget = false;
        for (const candidate of candidates) {
          const batch = configuration;
          // The budget check runs after the project checkpoint, which may
          // create the row or change its intent.
          await runOperationProjectStep(db, batch, candidate.project.id, () =>
            reconcileProjectZeroTrust(env, db, candidate.project.id, {
              configuration: batch,
              client,
              routingBudget,
            }),
          );
          if (routingBudget.exhausted) {
            stoppedForRoutingBudget = true;
            break;
          }
          projectsProcessed += 1;
          configuration = await heartbeatConfiguration(db, configuration);
          if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
            break;
          }
        }
        if (stoppedForRoutingBudget || projectsProcessed >= MAX_PROJECTS_PER_RUN) {
          return releaseOperation(db, configuration);
        }
        continue;
      }

      throw new Error(`Invalid configure operation phase: ${operation.phase}`);
    }
    throw new Error('The Zero Trust configure operation was replaced.');
  } catch (error) {
    await failOperation(db, configuration, error);
    throw error;
  }
}

async function disableProjectZeroTrust(
  env: ApiEnv['Bindings'],
  db: Db,
  projectId: string,
  client: ZeroTrustCloudflareClient,
  routingBudget: RoutingBudget,
  configuration: ZeroTrustConfiguration,
): Promise<void> {
  await withProjectZeroTrustLock(db, projectId, async (lockedDb, recordErrors) => {
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    if (!sameConfiguration(configuration, saved) || saved.operation?.kind !== 'disable') {
      throw new ZeroTrustUnavailableError('The Zero Trust disable operation was replaced.');
    }
    const operation = saved.operation;
    await recordErrors(async () => {
      const project = await getProject(lockedDb, projectId);
      if (!project || project.status === 'deleting') {
        return;
      }
      const row = await getProjectZeroTrustState(lockedDb, projectId);
      // Record public intent before any routing write. Partial pages and caught
      // provider failures commit this checkpoint, so later metadata writes cannot
      // restore protection behind the cleanup cursor. Unvisited projects retain
      // their existing protection until their own disable batch starts.
      await putProjectState(lockedDb, projectId, {
        desired_protected: false,
        status: 'reconciling',
        // Replay older partial checkpoints that still recorded protected intent;
        // readers may have restored protection to keys before their saved cursor.
        ...(row?.desired_protected ? { routing_cursor: null } : {}),
      });
      if (
        !(await publishProjectZeroTrustRoutingLocked(env, lockedDb, project, null, routingBudget))
      ) {
        return;
      }
      if (row) {
        await client.deleteApplication(
          row.protected_application_id,
          row.protected_application_name,
        );
      }
      await putProjectState(lockedDb, projectId, {
        desired_protected: false,
        effective_protected: false,
        status: 'ready',
        reconciled_operation: operation.id,
        // Public exceptions must outlive the wildcard, including when a later
        // project or wildcard deletion fails. The final phase clears these handles.
        protected_application_id: null,
        protected_application_name: null,
        protected_application_audience: null,
        last_error: null,
      });
    });
  });
}

async function deleteProjectZeroTrustBypass(
  db: Db,
  projectId: string,
  client: ZeroTrustCloudflareClient,
  configuration: ZeroTrustConfiguration,
): Promise<void> {
  await withProjectZeroTrustLock(db, projectId, async (lockedDb, recordErrors) => {
    const saved = await readZeroTrustConfigurationStrict(lockedDb);
    if (!sameConfiguration(configuration, saved) || saved.operation?.phase !== 'bypass-delete') {
      throw new ZeroTrustUnavailableError('The Zero Trust disable operation was replaced.');
    }
    const row = await getProjectZeroTrustState(lockedDb, projectId);
    if (!row) {
      return;
    }
    await recordErrors(async () => {
      await client.deleteApplication(row.bypass_application_id, row.bypass_application_name);
      await updateProjectState(lockedDb, projectId, {
        bypass_application_id: null,
        bypass_application_name: null,
        status: 'ready',
        last_error: null,
      });
    });
  });
}

export async function runDisableOperation(
  env: ApiEnv['Bindings'],
  db: Db,
  initial: ZeroTrustConfiguration,
): Promise<ZeroTrustConfiguration> {
  let configuration = initial;
  let projectsProcessed = 0;
  const routingBudget: RoutingBudget = { remaining: MAX_ROUTING_KEYS_PER_RUN };
  try {
    const client = await clientForConfiguration(env, configuration);
    if (configuration.operation?.phase === 'seed') {
      configuration = await advanceOperation(db, configuration, 'projects');
    }
    while (configuration.operation?.kind === 'disable') {
      const operation = configuration.operation;
      if (operation.phase === 'projects') {
        const candidates = await disableCandidates(
          db,
          operation,
          MAX_PROJECTS_PER_RUN - projectsProcessed,
        );
        if (candidates.length === 0) {
          configuration = await advanceOperation(db, configuration, 'wildcard-delete');
          continue;
        }
        let stoppedForRoutingBudget = false;
        for (const candidate of candidates) {
          if (routingBudget.remaining < 1) {
            stoppedForRoutingBudget = true;
            break;
          }
          const batch = configuration;
          await runOperationProjectStep(db, batch, candidate.project.id, () =>
            disableProjectZeroTrust(env, db, candidate.project.id, client, routingBudget, batch),
          );
          projectsProcessed += 1;
          configuration = await heartbeatConfiguration(db, configuration);
          if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
            break;
          }
        }
        if (stoppedForRoutingBudget || projectsProcessed >= MAX_PROJECTS_PER_RUN) {
          return releaseOperation(db, configuration);
        }
        continue;
      }
      if (operation.phase === 'wildcard-delete') {
        configuration = await withZeroTrustOperationLock(db, configuration, async (lockedDb) => {
          // A resumed cleanup must drain late/legacy project work before losing
          // the wildcard checkpoint, including work left by an errored request.
          if ((await disableCandidates(lockedDb, operation, 1)).length > 0) {
            return advanceOperation(lockedDb, configuration, 'projects');
          }
          await client.deleteApplication(
            configuration.wildcardApplication?.id,
            configuration.wildcardApplicationName,
          );
          // The health exception outlives the wildcard, so health probes never
          // meet Access. Deleting the wildcard again on a retry is a no-op.
          // A different name identifies a verified installer/operator-owned
          // exception. Keep it for platform health after project Access ends.
          if (
            !configuration.healthApplication ||
            configuration.healthApplication.name === configuration.healthApplicationName
          ) {
            await client.deleteApplication(
              configuration.healthApplication?.id,
              configuration.healthApplicationName,
            );
          }
          return advanceOperation(lockedDb, configuration, 'bypass-delete', {
            enabled: false,
            wildcardApplication: null,
            healthApplication: null,
            lastError: null,
          });
        });
        continue;
      }
      if (operation.phase === 'bypass-delete') {
        const candidates = await bypassCleanupCandidates(
          db,
          operation,
          MAX_PROJECTS_PER_RUN - projectsProcessed,
        );
        for (const candidate of candidates) {
          const batch = configuration;
          await runOperationProjectStep(db, batch, candidate.project.id, () =>
            deleteProjectZeroTrustBypass(db, candidate.project.id, client, batch),
          );
          projectsProcessed += 1;
          configuration = await heartbeatConfiguration(db, configuration);
        }
        if (projectsProcessed >= MAX_PROJECTS_PER_RUN) {
          return releaseOperation(db, configuration);
        }
        configuration = await withZeroTrustOperationLock(db, configuration, async (lockedDb) => {
          // Recheck late project work under the lock used by project mutations
          // before releasing the disable operation and allowing configuration again.
          if ((await disableCandidates(lockedDb, operation, 1)).length > 0) {
            return advanceOperation(lockedDb, configuration, 'projects');
          }
          if ((await bypassCleanupCandidates(lockedDb, operation, 1)).length > 0) {
            return configuration;
          }
          return patchConfiguration(lockedDb, configuration, {
            operation: null,
            lastError: null,
          });
        });
        if (configuration.operation) {
          continue;
        }
        return configuration;
      }
      throw new Error(`Invalid disable operation phase: ${operation.phase}`);
    }
    throw new Error('The Zero Trust disable operation was replaced.');
  } catch (error) {
    await failOperation(db, configuration, error);
    throw error;
  }
}
