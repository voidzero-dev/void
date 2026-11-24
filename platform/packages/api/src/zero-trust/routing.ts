import type { ProjectZeroTrustRouting } from '@void/edge';
import { and, eq, gt } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import {
  getActiveDeployment,
  getDeployment,
  getDomainsByProjectId,
  getLatestLiveDeployment,
  getUser,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { resolvePlanLimits } from '../plans.ts';
import { computeDispatchLimits } from '../routing-limits.ts';
import { projectRouteKey } from '../routing.ts';
import { domains } from '../schema.ts';
import { routingSuspensionReason } from '../suspension.ts';
import type { DeployManifest, Project, ProjectZeroTrust } from '../types.ts';
import { ZeroTrustConfigurationError, readZeroTrustConfigurationStrict } from './configuration.ts';
import type { ManagedAccessApplication, ZeroTrustConfiguration } from './configuration.ts';
import { ZeroTrustUnavailableError } from './errors.ts';
import { lockZeroTrustConfiguration } from './lock.ts';
import {
  getProjectZeroTrustState,
  MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT,
  putProjectState,
} from './state.ts';

export const MAX_ROUTING_KEYS_PER_RUN = 300;

/** Routing writes left in one invocation. `exhausted` stops the batch before another project. */
export type RoutingBudget = { remaining: number; exhausted?: boolean };

export function requiredRoutingBudget(row: Pick<ProjectZeroTrust, 'desired_protected'>): number {
  // Protected routes are published in one pass: slug plus every capped custom domain.
  return row.desired_protected ? MAX_ZERO_TRUST_CUSTOM_DOMAINS_PER_PROJECT + 1 : 1;
}

export function routingProtection(
  configuration: ZeroTrustConfiguration,
  protectedApplication: ManagedAccessApplication | null,
): ProjectZeroTrustRouting {
  if (!configuration.wildcardApplication) {
    throw new ZeroTrustUnavailableError('The platform Access application is unavailable.');
  }
  return {
    teamDomain: configuration.teamDomain,
    audiences: [
      ...configuration.wildcardApplication.destinations.map((hostname) => ({
        hostname,
        audience: configuration.wildcardApplication!.audience,
      })),
      ...(protectedApplication
        ? protectedApplication.destinations.map((hostname) => ({
            hostname,
            audience: protectedApplication.audience,
          }))
        : []),
    ],
  };
}

function managedProtectedApplication(
  row: ProjectZeroTrust,
  destinations: ReadonlyArray<string>,
): ManagedAccessApplication | null {
  return row.protected_application_id &&
    row.protected_application_name &&
    row.protected_application_audience
    ? {
        id: row.protected_application_id,
        name: row.protected_application_name,
        audience: row.protected_application_audience,
        destinations,
      }
    : null;
}

export async function resolveProjectZeroTrustRouting(
  db: DbOrTx,
  projectId: string,
): Promise<ProjectZeroTrustRouting | null> {
  return readProjectZeroTrustRouting(db, projectId, false);
}

async function readProjectZeroTrustRouting(
  db: DbOrTx,
  projectId: string,
  allowReconcilingPublic: boolean,
): Promise<ProjectZeroTrustRouting | null> {
  await lockZeroTrustConfiguration(db, 'shared');
  const [configuration, row] = await Promise.all([
    readZeroTrustConfigurationStrict(db),
    getProjectZeroTrustState(db, projectId),
  ]);
  if (!configuration) {
    return null;
  }
  if (!row) {
    if (
      configuration.enabled ||
      (configuration.operation !== null && configuration.operation.kind !== 'disable')
    ) {
      throw new ZeroTrustUnavailableError('Project Zero Trust is still being initialized.');
    }
    return null;
  }
  if (!row.desired_protected) {
    if (
      configuration.enabled &&
      configuration.operation?.kind !== 'disable' &&
      (!row.bypass_application_id || (!allowReconcilingPublic && row.status !== 'ready'))
    ) {
      throw new ZeroTrustUnavailableError('The project public exception is still reconciling.');
    }
    return null;
  }
  if (!configuration.enabled || !configuration.wildcardApplication) {
    throw new ZeroTrustUnavailableError('Project Zero Trust is still being initialized.');
  }
  if (!row.effective_protected) {
    throw new ZeroTrustUnavailableError('Project Zero Trust is still reconciling.');
  }
  const protectedApplication = managedProtectedApplication(
    row,
    (await getDomainsByProjectId(db as Db, projectId)).map((domain) => domain.hostname),
  );
  return routingProtection(configuration, protectedApplication);
}

/** An empty audience set makes dispatch deny every request until reconciliation finishes. */
const DENY_ALL_ROUTING: ProjectZeroTrustRouting = { teamDomain: '', audiences: [] };

/**
 * Read current protection inside the caller's project-row transaction before
 * publishing KV. When protection is not settled:
 * - a desired or effectively protected project gets the deny-all marker;
 * - a public project with a durable bypass stays public;
 * - anything else is unknown. A writer that can retry later (`retryable`)
 *   gets the error; every other writer must publish now and gets deny-all.
 */
export async function resolveProjectZeroTrustRoutingForPublication(
  db: DbOrTx,
  projectId: string,
  options: Readonly<{ retryable?: boolean }> = {},
): Promise<ProjectZeroTrustRouting | null> {
  try {
    // A durable bypass makes PUBLIC intent safe even while paginated cleanup
    // is unfinished. Reintroducing a deny marker behind its routing cursor
    // would strand already-completed keys. Deploys retain the stricter gate.
    return await readProjectZeroTrustRouting(db, projectId, true);
  } catch (error) {
    if (
      !(error instanceof ZeroTrustUnavailableError) &&
      !(error instanceof ZeroTrustConfigurationError)
    ) {
      throw error;
    }
    const row = await getProjectZeroTrustState(db, projectId);
    if (row && (row.desired_protected || row.effective_protected)) {
      return DENY_ALL_ROUTING;
    }
    if (row?.bypass_application_id) {
      return null;
    }
    if (options.retryable) {
      throw error;
    }
    return DENY_ALL_ROUTING;
  }
}

/**
 * KV can still return the previous project's route for a reused slug or
 * hostname. That payload carries its own project's Worker and protection, so
 * applying this project's protection to it could strip the Access gate from
 * a still-live Worker. Callers retry once KV converges.
 */
export function assertRouteBelongsToProject(
  entry: Record<string, unknown>,
  projectId: string,
): void {
  if (entry.projectId !== undefined && entry.projectId !== projectId) {
    throw new ZeroTrustUnavailableError(
      'Live routing still belongs to another project. Retry once routing converges.',
    );
  }
}

export function withProjectZeroTrustRouting(
  raw: string,
  protection: ProjectZeroTrustRouting | null,
  projectId: string,
): string {
  const entry = JSON.parse(raw) as Record<string, unknown>;
  assertRouteBelongsToProject(entry, projectId);
  if (protection) {
    entry.zeroTrust = protection;
  } else {
    delete entry.zeroTrust;
  }
  return JSON.stringify(entry);
}

/**
 * Rewrite the fields of a live route that can change after deployment: the
 * owner, plan limits (Worker routes only), suspension and protection. The
 * deployment payload itself is immutable and left as published.
 */
export function rewriteProjectRouteMetadata(
  entry: Record<string, unknown>,
  metadata: Readonly<{
    projectId: string;
    userId: string;
    limits: ReturnType<typeof computeDispatchLimits>;
    suspended: string | null;
    zeroTrust: ProjectZeroTrustRouting | null;
  }>,
): string {
  assertRouteBelongsToProject(entry, metadata.projectId);
  entry.userId = metadata.userId;
  if ('workerName' in entry) {
    if (metadata.limits) {
      entry.limits = metadata.limits;
    } else {
      delete entry.limits;
    }
  }
  if (metadata.suspended) {
    entry.suspended = metadata.suspended;
  } else {
    delete entry.suspended;
  }
  if (metadata.zeroTrust) {
    entry.zeroTrust = metadata.zeroTrust;
  } else {
    delete entry.zeroTrust;
  }
  return JSON.stringify(entry);
}

function routingMatchesDeployment(
  entry: Record<string, unknown>,
  projectSlug: string,
  deploymentId: string,
): boolean {
  const identifiers = [entry.version, entry.staticDeploymentId, entry.deploymentId];
  if (typeof entry.workerName === 'string' && entry.workerName.length > 0) {
    if (entry.workerName !== `user-${projectSlug}-${deploymentId}`) {
      return false;
    }
    identifiers.push(deploymentId);
  }
  // Canonical builders identify the target. Unknown legacy snapshots cannot
  // prove freshness after a committed deployment, and conflicting fields must
  // not be hidden by another field that happens to match.
  const knownIdentifiers = identifiers.filter(
    (identifier) => typeof identifier === 'string' && identifier.length > 0,
  );
  return (
    knownIdentifiers.length > 0 &&
    knownIdentifiers.every((identifier) => identifier === deploymentId)
  );
}

export async function publishProjectZeroTrustRoutingLocked(
  env: Pick<ApiEnv['Bindings'], 'ROUTING'>,
  db: Db,
  project: Pick<Project, 'id' | 'slug' | 'user_id' | 'active_deployment_id'>,
  protection: ProjectZeroTrustRouting | null,
  budget = { remaining: MAX_ROUTING_KEYS_PER_RUN },
): Promise<boolean> {
  const row = await getProjectZeroTrustState(db, project.id);
  // Cutover publishes before committing the project pointer. Read its target
  // once under the project lock so metadata changes can accompany that route,
  // but cannot republish a stale previous deployment from KV.
  const [activeDeployment, owner] = await Promise.all([
    getActiveDeployment(db, project.id),
    getUser(db, project.user_id),
  ]);
  if (!owner) {
    throw new ZeroTrustUnavailableError('Project owner is unavailable.');
  }
  const routeDeployment =
    activeDeployment?.status === 'cutover'
      ? activeDeployment
      : project.active_deployment_id
        ? await getDeployment(db, project.active_deployment_id)
        : await getLatestLiveDeployment(db, project.id);
  const expectedDeploymentId =
    activeDeployment?.status === 'cutover'
      ? activeDeployment.id
      : (project.active_deployment_id ?? routeDeployment?.id);
  const manifest = routeDeployment?.manifest
    ? (JSON.parse(routeDeployment.manifest) as DeployManifest)
    : null;
  const dispatchLimits = computeDispatchLimits(
    await resolvePlanLimits(db, owner.plan),
    manifest?.limits,
  );
  const suspensionReason = routingSuspensionReason(owner.suspended_reason);
  // Protected destinations are capped separately. Clearing public routing has
  // no domain cap and checkpoints progress while holding the project lock.
  const cursor = protection ? null : (row?.routing_cursor ?? null);
  const domainBudget = Math.max(0, budget.remaining - (cursor === null ? 1 : 0));
  const projectDomains = await db
    .select({ hostname: domains.hostname, status: domains.status })
    .from(domains)
    .where(
      and(
        eq(domains.project_id, project.id),
        cursor === null ? undefined : gt(domains.hostname, cursor),
      ),
    )
    .orderBy(domains.hostname)
    .limit(domainBudget + 1);
  const page = projectDomains.slice(0, domainBudget);
  const keys = [
    ...(cursor === null
      ? [{ key: projectRouteKey(project), expected: !!expectedDeploymentId, pending: false }]
      : []),
    ...page.map((domain) => ({
      key: `domain:${domain.hostname}`,
      expected: domain.status === 'active',
      pending: domain.status === 'pending',
    })),
  ];
  for (const { key, expected, pending } of keys) {
    budget.remaining -= 1;
    const raw = await env.ROUTING.get(key);
    if (!raw) {
      // KV can return a cached miss even after a route was published. Keep its
      // cleanup checkpoint retryable instead of permanently skipping live keys.
      if (expected) {
        throw new ZeroTrustUnavailableError(
          `Live routing for ${key} is temporarily unavailable. Retry Zero Trust reconciliation.`,
        );
      }
      continue;
    }
    const entry = JSON.parse(raw) as Record<string, unknown>;
    if (entry.projectId !== undefined && entry.projectId !== project.id) {
      // A reused slug or hostname may still return the previous project's KV
      // value, even when this project has never deployed. Never republish or
      // delete another project's route based on that stale read.
      throw new ZeroTrustUnavailableError(
        `Live routing for ${key} is temporarily unavailable. Retry Zero Trust reconciliation.`,
      );
    }
    if (
      expectedDeploymentId &&
      !routingMatchesDeployment(entry, project.slug, expectedDeploymentId)
    ) {
      if (pending) {
        // Activation may have crashed before marking this domain active. Drop
        // obsolete residue so its next activation can publish the current slug
        // without getting stuck on reconciliation of the old deployment.
        await env.ROUTING.delete(key);
        continue;
      }
      throw new ZeroTrustUnavailableError(
        `Live routing for ${key} is temporarily unavailable. Retry Zero Trust reconciliation.`,
      );
    }
    // A fresh project lock does not make a cached KV snapshot fresh, so every
    // mutable field is rewritten from PostgreSQL.
    await env.ROUTING.put(
      key,
      rewriteProjectRouteMetadata(entry, {
        projectId: project.id,
        userId: owner.id,
        limits: dispatchLimits,
        suspended: suspensionReason,
        zeroTrust: protection,
      }),
    );
  }
  const complete = projectDomains.length <= domainBudget;
  await putProjectState(db, project.id, {
    routing_cursor: complete ? null : (page.at(-1)?.hostname ?? cursor ?? ''),
    ...(!complete ? { status: 'reconciling' as const } : {}),
  });
  return complete;
}
