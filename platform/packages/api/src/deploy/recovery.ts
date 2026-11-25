import { sql as drizzleSql } from 'drizzle-orm';
import { hmacSignState } from '../auth/hmac.ts';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import { clearCronScheduler, syncCronScheduler } from '../cron-scheduler-client.ts';
import {
  getProject,
  getUser,
  getDeployment,
  cancelDeployment,
  updateDeploymentStatus,
  deleteRollbackLease,
  updateRollbackLeaseState,
  getDomainsByProjectId,
  getProjectResources,
  getAllProjectDeployments,
  markDeploymentRetained,
  setActiveDeployment,
  updateProjectType,
  TERMINAL_DEPLOYMENT_STATUSES,
} from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { getProjectQueueName } from '../naming.ts';
import { resolvePlanLimits } from '../plans.ts';
import { requireProjectCapability } from '../project-access.ts';
import { ProjectRequiresNormalizationError, requireNormalizedProject } from '../project-state.ts';
import {
  addQueueConsumer,
  removeQueueConsumer,
  getDispatchWorkerProxyToken,
} from '../provisioning/cloudflare-api.ts';
import { reconcileManagedDurableObjects } from '../provisioning/durable-objects.ts';
import { requestRotationIfReplacingUntrustedCode } from '../proxy-token-rotation.ts';
import { projectRouteKey } from '../routing.ts';
import { buildRoutingJson, buildStaticRoutingJson, computeDispatchLimits } from '../routing.ts';
import type { DeployManifest, Deployment, Project } from '../types.ts';
import {
  resolveProjectZeroTrustRouting,
  resolveProjectZeroTrustRoutingForPublication,
} from '../zero-trust/routing.ts';
import {
  PROJECT_DELETING_ERROR_MESSAGE,
  SUPERSEDED_BUILD_ERROR_MESSAGE,
  assertBoundBuildStillActive,
  assertDeploymentNotCanceled,
} from './guards.ts';

export const CUTOVER_RECOVERY_STALE_MS = 90 * 60 * 1000;

const DEPLOYMENT_CANCEL_STALE_MS = 10 * 60 * 1000;

export const cutoverIntentKey = (deploymentId: string): string => `cutover-intent:${deploymentId}`;

export const cutoverReadyKey = (deploymentId: string): string => `cutover-ready:${deploymentId}`;

export const cutoverCompensatedKey = (deploymentId: string): string =>
  `cutover-compensated:${deploymentId}`;

/**
 * Flip a protected cutover to live under the project lock. Aborts when the
 * project is being deleted, another owner took over the cutover markers, the
 * deployment was canceled, or the bound build was superseded.
 */
export async function commitCutoverLive(
  db: Db,
  routing: KVNamespace,
  input: Readonly<{
    projectId: string;
    actorId: string;
    deploymentId: string;
    cutoverOwnerId: string;
    deployBuild: string | undefined;
    projectType: Project['type'];
  }>,
): Promise<void> {
  const { projectId, deploymentId, cutoverOwnerId } = input;
  await db.transaction(async (tx) => {
    await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const lockedProject = await getProject(tx, projectId);
    if (!lockedProject || lockedProject.status === 'deleting') {
      throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
    }
    await requireActiveDeployAccess(tx, projectId, input.actorId);
    const [intent, ready] = await Promise.all([
      routing.get(cutoverIntentKey(deploymentId)).then(parseCutoverMarker),
      routing.get(cutoverReadyKey(deploymentId)).then(parseCutoverMarker),
    ]);
    if (
      intent?.ownerId !== cutoverOwnerId ||
      ready?.ownerId !== cutoverOwnerId ||
      intent.projectId !== projectId ||
      ready.projectId !== projectId
    ) {
      throw new Error(SUPERSEDED_BUILD_ERROR_MESSAGE);
    }
    await assertDeploymentNotCanceled(tx, deploymentId);
    // Re-check the bound build under a row lock before going live. The
    // up-front guard can pass and then a newer GitHub Actions run
    // supersede (cancel) this build while we spent minutes building and
    // uploading; without this re-check a superseded runner would still
    // go live with stale code. See `assertBoundBuildStillActive`.
    await assertBoundBuildStillActive(tx, input.deployBuild, projectId);
    // Asset GC takes this same project lock and protects hashes from every
    // nonterminal deployment. Serving placement was persisted before cutover
    // began, so no final object-store scan is needed.
    await updateDeploymentStatus(tx, deploymentId, 'live', undefined, { force: true });
    await updateProjectType(tx, projectId, input.projectType);
    await requestRotationIfReplacingUntrustedCode(tx, projectId, deploymentId);
    await setActiveDeployment(tx, projectId, deploymentId);
    await markDeploymentRetained(tx, deploymentId, true);
  });
}

export async function requireActiveDeployAccess(db: Db, projectId: string, actorUserId: string) {
  return requireProjectCapability(db, projectId, actorUserId, 'deploy');
}

export function databaseTimestampMs(value: string): number | null {
  const withSeparator = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /[+-]\d{2}$/.test(withSeparator)
    ? `${withSeparator}:00`
    : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(withSeparator)
      ? withSeparator
      : `${withSeparator}Z`;
  const parsed = new Date(withZone).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export type CutoverMarker = {
  projectId: string;
  ownerId: string;
  buildId: string | null;
};

export function parseCutoverMarker(raw: string | null): CutoverMarker | null {
  if (!raw) {
    return null;
  }
  try {
    const marker = JSON.parse(raw) as Partial<CutoverMarker>;
    if (
      typeof marker.projectId !== 'string' ||
      typeof marker.ownerId !== 'string' ||
      (marker.buildId !== null && typeof marker.buildId !== 'string')
    ) {
      return null;
    }
    return marker as CutoverMarker;
  } catch {
    return null;
  }
}

export function resolvePersistedDeploymentType(
  manifest: DeployManifest,
  deployment: Deployment,
  committedProjectType?: Project['type'],
): 'void' | 'spa' | 'static' | 'framework' {
  if (manifest.type) {
    return manifest.type;
  }
  if (manifest.framework) {
    return 'framework';
  }
  if (deployment.bundle_stored || manifest.workerMain) {
    return 'void';
  }
  if (committedProjectType) {
    return committedProjectType;
  }
  return manifest.assetConfig?.not_found_handling === 'single-page-application' ? 'spa' : 'static';
}

async function resolveCutoverProxyToken(
  env: ApiEnv['Bindings'],
  workerName: string,
  projectId: string,
): Promise<string> {
  const lookup = await getDispatchWorkerProxyToken(
    env.CF_ACCOUNT_ID,
    env.CF_API_TOKEN,
    env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE,
    workerName,
  );
  if (lookup.kind === 'found') {
    return lookup.token;
  }
  if (lookup.kind === 'error') {
    throw lookup.error;
  }
  return hmacSignState(projectId, env.JWT_SECRET);
}

/** Make every persisted custom-domain key match one authoritative route. */
export async function reconcileProjectDomainRoutes(
  env: ApiEnv['Bindings'],
  domains: Awaited<ReturnType<typeof getDomainsByProjectId>>,
  routingJson: string | null,
): Promise<void> {
  for (const domain of domains) {
    const key = `domain:${domain.hostname}`;
    if (domain.status === 'active' && routingJson !== null) {
      await env.ROUTING.put(key, routingJson);
    } else {
      // A hostname can become active at Cloudflare and have its route written
      // immediately before the PostgreSQL status update is interrupted. Treat
      // every persisted domain row as an authoritative key inventory so
      // recovery removes that pending-row/live-KV crash residue as well as
      // updating currently active domains.
      await env.ROUTING.delete(key);
    }
  }
}

/** Queue names declared by any of the project's persisted deployments. */
async function persistedQueueNames(db: Db, projectId: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const row of await getAllProjectDeployments(db, projectId)) {
    try {
      const rowManifest = row.manifest ? (JSON.parse(row.manifest) as DeployManifest) : null;
      for (const queue of rowManifest?.queues ?? []) {
        names.add(queue.name);
      }
    } catch {
      // Corrupt historical metadata cannot authorize a queue write.
    }
  }
  return names;
}

async function detachProjectQueue(
  env: ApiEnv['Bindings'],
  resources: Awaited<ReturnType<typeof getProjectResources>>,
  dispatchWorkerName: string,
  projectId: string,
  queueName: string,
): Promise<void> {
  const resource = resources.find(
    (entry) => entry.type === 'queue' && entry.binding_name === queueName,
  );
  if (resource) {
    await removeQueueConsumer(
      env.CF_ACCOUNT_ID,
      env.CF_API_TOKEN,
      resource.cf_id,
      dispatchWorkerName,
    );
  }
  await env.ROUTING.delete(`queue:${getProjectQueueName(projectId, queueName)}`);
}

/** Idempotently make every authoritative external surface match one deployment. */
export async function replayDeploymentCutover(
  env: ApiEnv['Bindings'],
  db: Db,
  project: Project,
  deployment: Deployment,
  committedProjectType?: Project['type'],
  options: Readonly<{ restoreCommitted?: boolean }> = {},
): Promise<void> {
  const currentOwner = await getUser(db, project.user_id);
  if (!currentOwner) {
    throw new Error('project owner is unavailable during routing publication');
  }
  const planLimits = await resolvePlanLimits(db, currentOwner.plan);
  if (!deployment.manifest) {
    throw new Error(`deployment ${deployment.id} has no manifest for cutover recovery`);
  }
  const manifest = JSON.parse(deployment.manifest) as DeployManifest;
  const targetType = resolvePersistedDeploymentType(manifest, deployment, committedProjectType);
  const isStatic = targetType === 'static' || targetType === 'spa';
  const workerName = `user-${project.slug}-${deployment.id}`;
  const existingRouting = await env.ROUTING.get(projectRouteKey(project));
  const existingEntry = existingRouting
    ? (JSON.parse(existingRouting) as { suspended?: string })
    : {};
  // Restoring committed code must not wait for Zero Trust reconciliation. The
  // publication resolver fails closed, as deploy compensation does. Promoting
  // a new deployment keeps the strict readiness gate.
  const zeroTrust = options.restoreCommitted
    ? await resolveProjectZeroTrustRoutingForPublication(db, project.id)
    : await resolveProjectZeroTrustRouting(db, project.id);
  let hasAssets = false;
  if (deployment.asset_hashes) {
    const assetHashes = JSON.parse(deployment.asset_hashes) as Record<string, unknown>;
    hasAssets = Object.keys(assetHashes).length > 0;
  }
  const routingJson = isStatic
    ? buildStaticRoutingJson({
        privatePreview: Boolean(project.preview_client_id),
        projectId: project.id,
        userId: project.user_id,
        deploymentId: deployment.id,
        assetConfig:
          manifest.assetConfig ??
          ({
            not_found_handling: targetType === 'spa' ? 'single-page-application' : '404-page',
          } as const),
        manifest,
        suspended: existingEntry.suspended,
        zeroTrust,
      })
    : buildRoutingJson({
        privatePreview: Boolean(project.preview_client_id),
        workerName,
        projectId: project.id,
        userId: project.user_id,
        manifest,
        deploymentId: deployment.id,
        dispatchLimits: computeDispatchLimits(planLimits, manifest.limits),
        suspended: existingEntry.suspended,
        hasCrons: !!manifest.schedules?.length,
        assetManifestId: hasAssets ? deployment.id : undefined,
        assetConfig: hasAssets ? manifest.assetConfig : undefined,
        zeroTrust,
      });

  // Complete every PostgreSQL read and validation before the first external
  // mutation. A failed statement aborts its surrounding recovery transaction;
  // if it happened after a KV/DO/Queue write, that same transaction could no
  // longer persist `compensating` or restore the authoritative deployment.
  const domains = await getDomainsByProjectId(db, project.id);
  const resources = await getProjectResources(db, project.id);
  const historicalQueueNames = await persistedQueueNames(db, project.id);
  const desiredQueues = isStatic ? [] : (manifest.queues ?? []);
  const desiredQueueNames = new Set(desiredQueues.map((queue) => queue.name));
  const desiredQueueResources = desiredQueues.map((queue) => {
    const resource = resources.find(
      (entry) => entry.type === 'queue' && entry.binding_name === queue.name,
    );
    if (!resource) {
      throw new Error(`cutover recovery is missing queue resource ${queue.name}`);
    }
    return { queue, resource };
  });
  const needsProxyToken = !isStatic && (!!manifest.schedules?.length || desiredQueues.length > 0);
  // The token the replayed Worker holds, which may be older than the issued one.
  const proxyToken = needsProxyToken
    ? await resolveCutoverProxyToken(env, workerName, project.id)
    : null;

  await reconcileManagedDurableObjects(env, db, project.id, deployment.id, manifest);
  await env.ROUTING.put(projectRouteKey(project), routingJson);
  await reconcileProjectDomainRoutes(env, domains, routingJson);
  if (!isStatic && manifest.schedules?.length) {
    if (!proxyToken) {
      throw new Error('cutover recovery requires the Worker proxy token for schedules');
    }
    await syncCronScheduler(env, project.id, {
      workerName,
      schedules: manifest.schedules,
      proxyToken,
    });
  } else {
    await clearCronScheduler(env, project.id);
  }

  const dispatchWorkerName = env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
  for (const { queue, resource } of desiredQueueResources) {
    const consumer = await addQueueConsumer(
      env.CF_ACCOUNT_ID,
      env.CF_API_TOKEN,
      resource.cf_id,
      dispatchWorkerName,
      {
        ...(queue.maxBatchSize !== null &&
          queue.maxBatchSize !== undefined && { batch_size: queue.maxBatchSize }),
        ...(queue.maxBatchTimeout !== null &&
          queue.maxBatchTimeout !== undefined && {
            max_wait_time_ms: queue.maxBatchTimeout * 1000,
          }),
        ...(queue.maxRetries !== null &&
          queue.maxRetries !== undefined && { max_retries: queue.maxRetries }),
        ...(queue.maxConcurrency !== null &&
          queue.maxConcurrency !== undefined && { max_concurrency: queue.maxConcurrency }),
        ...(queue.retryDelay !== null &&
          queue.retryDelay !== undefined && { retry_delay: queue.retryDelay }),
      },
    );
    if (consumer.status === 'conflict') {
      throw new Error(`queue consumer conflict: ${queue.name} owned by ${consumer.ownerScript}`);
    }
    await env.ROUTING.put(
      `queue:${getProjectQueueName(project.id, queue.name)}`,
      JSON.stringify({ workerName, projectId: project.id, queueName: queue.name, proxyToken }),
    );
  }

  for (const queueName of historicalQueueNames) {
    if (!desiredQueueNames.has(queueName)) {
      await detachProjectQueue(env, resources, dispatchWorkerName, project.id, queueName);
    }
  }
}

export async function clearProjectExternalState(
  env: ApiEnv['Bindings'],
  db: Db,
  project: Project,
): Promise<void> {
  // As in replayDeploymentCutover, finish DB work before any external delete
  // so a PostgreSQL error cannot strand a partially-cleared project while also
  // preventing the caller from persisting its compensation fence.
  const domains = await getDomainsByProjectId(db, project.id);
  const resources = await getProjectResources(db, project.id);
  const queueNames = await persistedQueueNames(db, project.id);

  await reconcileManagedDurableObjects(env, db, project.id, null, null);
  await env.ROUTING.delete(projectRouteKey(project));
  await reconcileProjectDomainRoutes(env, domains, null);
  await clearCronScheduler(env, project.id);
  const dispatchWorkerName = env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
  for (const queueName of queueNames) {
    await detachProjectQueue(env, resources, dispatchWorkerName, project.id, queueName);
  }
}

export type SandboxDrainDeploymentSettlement = Readonly<{
  state: 'terminal' | 'cancel_requested' | 'waiting' | 'recovery_incomplete';
}>;

/**
 * Settle one abandoned deployment before the managed Sandbox drain deletes its
 * container. Ordinary requests receive the same two-phase cancellation grace
 * used by deploy admission. Protected cutovers are fenced by replacing their
 * owner marker under the project lock, then compensating every external
 * surface back to PostgreSQL's committed active deployment.
 */
export async function settleDeploymentForSandboxDrain(
  env: ApiEnv['Bindings'],
  db: Db,
  deploymentId: string,
  options: { expiredInvocation?: boolean; reason?: string } = {},
): Promise<SandboxDrainDeploymentSettlement> {
  const reason = options.reason ?? 'legacy managed Sandbox drain';
  const initial = await getDeployment(db, deploymentId);
  if (!initial || TERMINAL_DEPLOYMENT_STATUSES.includes(initial.status)) {
    return { state: 'terminal' };
  }

  const markerKeys: Array<string> = [];
  const settlement = await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`SELECT id FROM projects WHERE id = ${initial.project_id} FOR UPDATE`,
    );
    const deployment = await getDeployment(tx, deploymentId);
    if (!deployment || TERMINAL_DEPLOYMENT_STATUSES.includes(deployment.status)) {
      return { state: 'terminal' } as const;
    }
    const updatedAtMs = databaseTimestampMs(deployment.updated_at);
    if (updatedAtMs === null) {
      return { state: 'waiting' } as const;
    }
    const ageMs = Date.now() - updatedAtMs;
    if (deployment.source === 'rollback-lease') {
      const project = await getProject(tx, deployment.project_id);
      if (!project || project.status === 'deleting' || !deployment.manifest) {
        return { state: 'recovery_incomplete' } as const;
      }
      let lease: {
        targetDeploymentId: string;
        state: 'running' | 'retryable' | 'applied';
        ownerId: string;
      };
      try {
        const parsed = JSON.parse(deployment.manifest) as Partial<typeof lease>;
        if (
          typeof parsed.targetDeploymentId !== 'string' ||
          typeof parsed.ownerId !== 'string' ||
          (parsed.state !== 'running' && parsed.state !== 'retryable' && parsed.state !== 'applied')
        ) {
          return { state: 'recovery_incomplete' } as const;
        }
        lease = parsed as typeof lease;
      } catch {
        return { state: 'recovery_incomplete' } as const;
      }
      if (lease.state === 'applied') {
        if (project.active_deployment_id !== lease.targetDeploymentId) {
          return { state: 'recovery_incomplete' } as const;
        }
        return {
          state: (await deleteRollbackLease(tx, deployment.id, lease.ownerId))
            ? 'terminal'
            : 'waiting',
        } as const;
      }
      if (lease.state === 'running' && ageMs < 30 * 60 * 1000) {
        return { state: 'waiting' } as const;
      }

      try {
        await requireNormalizedProject(tx, project);
      } catch (error) {
        if (error instanceof ProjectRequiresNormalizationError) {
          return { state: 'recovery_incomplete' } as const;
        }
        throw error;
      }
      const owner = await getUser(tx, project.user_id);
      if (!owner) {
        return { state: 'recovery_incomplete' } as const;
      }
      const recoveryOwnerId = crypto.randomUUID();
      const adopted = await updateRollbackLeaseState(
        tx,
        deployment.id,
        lease.targetDeploymentId,
        'running',
        recoveryOwnerId,
        lease.ownerId,
      );
      if (!adopted) {
        return { state: 'waiting' } as const;
      }
      const committedActive = project.active_deployment_id
        ? await getDeployment(tx, project.active_deployment_id)
        : null;
      try {
        if (committedActive) {
          await replayDeploymentCutover(env, tx, project, committedActive, project.type, {
            restoreCommitted: true,
          });
        } else {
          await clearProjectExternalState(env, tx, project);
        }
      } catch {
        await updateRollbackLeaseState(
          tx,
          deployment.id,
          lease.targetDeploymentId,
          'retryable',
          recoveryOwnerId,
          recoveryOwnerId,
        );
        return { state: 'recovery_incomplete' } as const;
      }
      return {
        state: (await deleteRollbackLease(tx, deployment.id, recoveryOwnerId))
          ? 'terminal'
          : 'recovery_incomplete',
      } as const;
    }

    if (deployment.status !== 'cutover' && deployment.status !== 'compensating') {
      if (deployment.status !== 'canceling') {
        const requested = await cancelDeployment(tx, deployment.id, reason);
        return { state: requested ? 'cancel_requested' : 'waiting' } as const;
      }
      if (!options.expiredInvocation && ageMs < DEPLOYMENT_CANCEL_STALE_MS) {
        return { state: 'waiting' } as const;
      }
      await updateDeploymentStatus(tx, deployment.id, 'canceled', reason, { force: true });
      return { state: 'terminal' } as const;
    }

    const project = await getProject(tx, deployment.project_id);
    if (!project || project.status === 'deleting') {
      return { state: 'waiting' } as const;
    }
    const compensatedKey = cutoverCompensatedKey(deployment.id);
    const [intentRaw, compensated] = await Promise.all([
      env.ROUTING.get(cutoverIntentKey(deployment.id)),
      env.ROUTING.get(compensatedKey),
    ]);
    if (compensated === project.id) {
      await updateDeploymentStatus(
        tx,
        deployment.id,
        options.expiredInvocation ? 'canceling' : 'failed',
        options.reason ?? 'cutover compensation completed',
        { force: true },
      );
      markerKeys.push(
        cutoverIntentKey(deployment.id),
        cutoverReadyKey(deployment.id),
        compensatedKey,
      );
      return { state: 'terminal' } as const;
    }
    if (
      !options.expiredInvocation &&
      deployment.status === 'cutover' &&
      ageMs < CUTOVER_RECOVERY_STALE_MS
    ) {
      return { state: 'waiting' } as const;
    }

    try {
      await requireNormalizedProject(tx, project);
    } catch (error) {
      if (error instanceof ProjectRequiresNormalizationError) {
        return { state: 'recovery_incomplete' } as const;
      }
      throw error;
    }
    const committedActiveDeploymentId = project.active_deployment_id;
    if (committedActiveDeploymentId === deployment.id) {
      return { state: 'waiting' } as const;
    }
    const owner = await getUser(tx, project.user_id);
    if (!owner) {
      return { state: 'recovery_incomplete' } as const;
    }

    const intent = parseCutoverMarker(intentRaw);
    const recoveryMarker: CutoverMarker = {
      projectId: project.id,
      ownerId: crypto.randomUUID(),
      buildId: intent?.buildId ?? null,
    };
    // This durable owner change is the fence checked by the original cutover
    // and by its compensation path before either may mutate another surface.
    await env.ROUTING.put(cutoverIntentKey(deployment.id), JSON.stringify(recoveryMarker));

    const committedActive = committedActiveDeploymentId
      ? await getDeployment(tx, committedActiveDeploymentId)
      : null;
    try {
      if (committedActive) {
        await replayDeploymentCutover(env, tx, project, committedActive, project.type, {
          restoreCommitted: true,
        });
      } else {
        await clearProjectExternalState(env, tx, project);
      }
      // Persist this before the database transition so a lost COMMIT
      // acknowledgement can be completed safely by the next drain request.
      await env.ROUTING.put(compensatedKey, project.id);
    } catch {
      await updateDeploymentStatus(
        tx,
        deployment.id,
        'compensating',
        options.reason ?? 'Sandbox drain cutover compensation incomplete',
        { force: true },
      );
      return { state: 'recovery_incomplete' } as const;
    }
    await updateDeploymentStatus(
      tx,
      deployment.id,
      options.expiredInvocation ? 'canceling' : 'failed',
      options.reason ?? 'abandoned cutover recovered for managed Sandbox disable',
      { force: true },
    );
    markerKeys.push(
      cutoverIntentKey(deployment.id),
      cutoverReadyKey(deployment.id),
      compensatedKey,
    );
    return { state: 'terminal' } as const;
  });

  for (const markerKey of markerKeys) {
    await env.ROUTING.delete(markerKey).catch(() => {
      // The acknowledged database transition is authoritative. A later
      // recovery can safely remove any stale marker left by a failed cleanup.
    });
  }
  return settlement;
}
