import { isrCacheKey } from '@void/isr';
import {
  hasSharedCacheOptOut,
  resolvePageTtl,
  resolveRevalidateTtl,
  SHARED_CACHE_POLICY_VERSION,
  type IsrCacheMetadata,
} from '@void/isr/core';
import { platformProjectHostname, readPlatformApplication } from '@void/platform';
import { sql as drizzleSql } from 'drizzle-orm';
import { type Context } from 'hono';
import { type AssetManifestEntry } from '../assets.ts';
import { deleteDispatchScript } from '../cf-api.ts';
import { uploadPool } from '../concurrency.ts';
import { clearCronScheduler, syncCronScheduler } from '../cron-scheduler-client.ts';
import {
  getProject,
  updateDeploymentStatus,
  beginDeploymentCutover,
  getDomainsByProjectId,
  markDeploymentRetained,
  getRetainedDeploymentsExcluding,
  getProjectResources,
  type Db,
} from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { createIsrStore } from '../isr-store.ts';
import { getProjectQueueName } from '../naming.ts';
import { type DeployLogger } from '../observability/logger.ts';
import { resolvePlanLimits } from '../plans.ts';
import { addQueueConsumer, removeQueueConsumer } from '../provisioning/cloudflare-api.ts';
import {
  deleteContainerApplicationIdempotent,
  findContainerApplication,
  perDeployContainerApplicationName,
} from '../provisioning/containers.ts';
import { reconcileManagedDurableObjects } from '../provisioning/durable-objects.ts';
import { provisionBindings } from '../provisioning/provision.ts';
import { deleteSandboxController, isManagedSandbox } from '../provisioning/sandbox-controller.ts';
import { projectRouteKey } from '../routing.ts';
import { buildRoutingJson, computeDispatchLimits } from '../routing.ts';
import { REASON_REQUESTS_EXCEEDED } from '../suspension.ts';
import type { PlanLimits } from '../tiers.ts';
import {
  type DeployManifest,
  type DeployEvent,
  type Deployment,
  type Project,
  type DeploymentStatus,
} from '../types.ts';
import type { WorkerModule } from '../worker-upload.ts';
import { resolveProjectZeroTrustRouting } from '../zero-trust/routing.ts';
import { clearIsrCache, serializePrerenderHeaders, packIsrValue } from './cache.ts';
import { assertDeploymentCanProceed } from './guards.ts';
import {
  commitCutoverLive,
  requireActiveDeployAccess,
  cutoverIntentKey,
  cutoverReadyKey,
  type CutoverMarker,
} from './recovery.ts';
import { projectPublicUrls } from './shared.ts';

export async function publishWorkerDeployment(input: {
  currentStep: string;
  readonly projectId: string;
  readonly cutoverOwnerId: string;
  readonly deployBuild: string | undefined;
  readonly context: Context<ApiEnv>;
  readonly deployment: Deployment;
  cutoverProtected: boolean;
  currentStatus: DeploymentStatus;
  readonly markPhase: (next: string) => void;
  readonly manifest: DeployManifest;
  readonly emit: (event: DeployEvent) => void;
  readonly workerBindings: Awaited<ReturnType<typeof provisionBindings>>;
  readonly withProjectCutoverFence: <T>(
    deploymentId: string,
    mutate: (
      txDb: Db,
      currentOwner: Awaited<ReturnType<typeof requireActiveDeployAccess>>['owner'],
    ) => Promise<T>,
  ) => Promise<T>;
  readonly snapshotTrackedQueueConsumer: (queueId: string, scriptName: string) => Promise<void>;
  readonly putTrackedRouting: (key: string, value: string) => Promise<void>;
  readonly workerName: string;
  readonly previousManifest: DeployManifest | null;
  readonly deleteTrackedRouting: (key: string) => Promise<void>;
  logger: DeployLogger;
  readonly project: Project;
  readonly snapshotCronState: () => Promise<void>;
  readonly assetCount: number;
  readonly deployedAssetCount: number;
  readonly assetConfig: DeployManifest['assetConfig'];
  routingSwitched: boolean;
  cronSchedulerWriteAttempted: boolean;
  readonly actor: ApiEnv['Variables']['user'];
  cutoverCommitted: boolean;
  readonly planLimits: Readonly<PlanLimits>;
  readonly assetManifest: Record<string, AssetManifestEntry>;
  readonly dispatchNamespace: string;
  readonly deleteAssetHashesWithProjectFence: (
    knownRetainedHashes: ReadonlySet<string>,
    hashes: ReadonlyArray<string>,
  ) => Promise<number>;
  readonly evictStoredWorkerBundle: (deploymentId: string) => Promise<void>;
  orphanSweepAfterResponse: (() => Promise<void>) | null;
  readonly sweepAssetOrphansWithProjectFence: (
    knownRetainedHashes: ReadonlySet<string>,
  ) => Promise<number>;
  readonly projectDomains: Awaited<ReturnType<typeof getDomainsByProjectId>>;
  readonly workerFiles: ReadonlyArray<WorkerModule>;
  readonly migrationsApplied: number;
  readonly finishOrphanSweep: () => Promise<void>;
  /** When the uploads of a queued deployment run must end (epoch ms); undefined outside one. */
  readonly deadline: number | undefined;
}) {
  const {
    projectId,
    cutoverOwnerId,
    deployBuild,
    context,
    deployment,
    markPhase,
    manifest,
    emit,
    workerBindings,
    withProjectCutoverFence,
    snapshotTrackedQueueConsumer,
    putTrackedRouting,
    workerName,
    previousManifest,
    deleteTrackedRouting,
    project,
    snapshotCronState,
    assetCount,
    deployedAssetCount,
    assetConfig,
    actor,
    planLimits,
    assetManifest,
    dispatchNamespace,
    deleteAssetHashesWithProjectFence,
    evictStoredWorkerBundle,
    sweepAssetOrphansWithProjectFence,
    projectDomains,
    workerFiles,
    migrationsApplied,
    finishOrphanSweep,
  } = input;

  input.currentStep = 'cutover_intent';
  const cutoverMarker: CutoverMarker = {
    projectId: projectId,
    ownerId: cutoverOwnerId,
    buildId: deployBuild ?? null,
  };
  await context.env.ROUTING.put(cutoverIntentKey(deployment.id), JSON.stringify(cutoverMarker));
  if (!input.cutoverProtected) {
    const claimed = await beginDeploymentCutover(context.get('db'), deployment.id);
    if (!claimed) {
      throw new Error('deployment canceled');
    }
    input.cutoverProtected = true;
    input.currentStatus = 'cutover';
  }

  // Queue setup
  input.currentStep = 'queue_setup';
  markPhase('queue_setup');
  const queueNames = (manifest.queues ?? []).map((q) => q.name);
  if (queueNames.length > 0) {
    emit({ event: 'queue_setup', queues: queueNames });
  }
  const dispatchWorkerName = context.env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
  const proxyToken = workerBindings.find((b) => b.name === '__VOID_PROXY_TOKEN')?.text;
  const queueConflicts: Array<{ queue: string; ownerScript: string }> = [];
  const projectResources = await getProjectResources(context.get('db'), projectId);
  await withProjectCutoverFence(deployment.id, async () => {
    for (const q of manifest.queues ?? []) {
      const queueBinding = workerBindings.find(
        (binding) => binding.type === 'queue' && binding.name === q.bindingName,
      );
      if (queueBinding?.queue_id) {
        await snapshotTrackedQueueConsumer(queueBinding.queue_id, dispatchWorkerName);
      }
    }
    const settledConsumerOutcomes = await Promise.allSettled(
      (manifest.queues ?? []).map(async (q) => {
        const queueBinding = workerBindings.find(
          (b) => b.type === 'queue' && b.name === q.bindingName,
        );
        if (!queueBinding?.queue_id) {
          return null;
        }
        const consumerResult = await addQueueConsumer(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          queueBinding.queue_id,
          dispatchWorkerName,
          {
            ...(q.maxBatchSize != null && { batch_size: q.maxBatchSize }),
            ...(q.maxBatchTimeout != null && {
              max_wait_time_ms: q.maxBatchTimeout * 1000,
            }),
            ...(q.maxRetries != null && { max_retries: q.maxRetries }),
            ...(q.retryDelay != null && { retry_delay: q.retryDelay }),
          },
        );
        if (consumerResult.status === 'conflict') {
          emit({
            event: 'queue_consumer_conflict',
            queue: q.name,
            ownerScript: consumerResult.ownerScript,
          });
          queueConflicts.push({ queue: q.name, ownerScript: consumerResult.ownerScript });
        }
        return { q, queueBinding, status: consumerResult.status };
      }),
    );
    const consumerErrors = settledConsumerOutcomes
      .filter((outcome) => outcome.status === 'rejected')
      .map((outcome) => outcome.reason);
    if (consumerErrors.length > 0) {
      throw new AggregateError(consumerErrors, 'one or more queue consumers failed to sync');
    }
    const consumerOutcomes = settledConsumerOutcomes
      .filter((outcome) => outcome.status === 'fulfilled')
      .map((outcome) => outcome.value);
    if (queueConflicts.length > 0) {
      const details = queueConflicts
        .map((conflict) => `${conflict.queue} owned by ${conflict.ownerScript}`)
        .join('; ');
      throw new Error(`queue consumer conflict: ${details}`);
    }
    for (const outcome of consumerOutcomes) {
      if (!outcome) {
        continue;
      }
      const queueKey = `queue:${outcome.queueBinding.queue_name}`;
      await putTrackedRouting(
        queueKey,
        JSON.stringify({
          workerName: workerName,
          projectId: projectId,
          queueName: outcome.q.name,
          proxyToken,
        }),
      );
    }
    const desiredQueueNames = new Set((manifest.queues ?? []).map((queue) => queue.name));
    for (const previousQueue of previousManifest?.queues ?? []) {
      if (!desiredQueueNames.has(previousQueue.name)) {
        const resource = projectResources.find(
          (entry) => entry.type === 'queue' && entry.binding_name === previousQueue.name,
        );
        if (resource) {
          await snapshotTrackedQueueConsumer(resource.cf_id, dispatchWorkerName);
          await removeQueueConsumer(
            context.env.CF_ACCOUNT_ID,
            context.env.CF_API_TOKEN,
            resource.cf_id,
            dispatchWorkerName,
          );
        }
        await deleteTrackedRouting(`queue:${getProjectQueueName(projectId, previousQueue.name)}`);
      }
    }
  });
  await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);

  const hasCrons = manifest.schedules && manifest.schedules.length > 0;

  await clearIsrCache(
    createIsrStore(context.env.STATIC_ASSETS_R2, context.env.ISR_CACHE),
    projectId,
    deployment.id,
  );
  await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);

  input.currentStep = 'prerender';
  if (
    manifest.prerender &&
    manifest.prerender.length > 0 &&
    (manifest.revalidate || (manifest.pages && manifest.pages.length > 0))
  ) {
    markPhase('prerender');
    emit({ event: 'prerender', pages: manifest.prerender.length });
    input.logger.info('status_transition', 'status_change', {
      from: input.currentStatus,
      to: 'prerendering',
    });
    if (!input.cutoverProtected) {
      await updateDeploymentStatus(context.get('db'), deployment.id, 'prerendering');
      input.currentStatus = 'prerendering';
    }
    await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);
    const application = readPlatformApplication(context.env);

    await uploadPool(manifest.prerender, 3, async (pathname) => {
      const ttl = resolvePageTtl(
        manifest.pages,
        manifest.revalidate,
        manifest.pathRevalidate,
        pathname,
      );
      if (ttl <= 0) {
        return;
      }
      try {
        const userWorker = context.env.DISPATCH.get(workerName);
        const slugHost = platformProjectHostname(project, application);
        const url = `https://${slugHost}${pathname}`;
        const response = await userWorker.fetch(new Request(url));
        // Mirror dispatch's live-miss / background write gate so prewarm
        // cannot seed an entry the edge would refuse. A render that opts
        // out — `x-revalidate: 0` (→ effectiveTtl 0) or `Cache-Control:
        // private/no-store/no-cache` — must NOT be warmed: dispatch serves
        // a HIT without re-checking opt-out, and `serializePrerenderHeaders`
        // strips `Cache-Control`, so the opt-out is only visible HERE,
        // before the write. `x-revalidate` overrides the TTL exactly as
        // dispatch's `resolveRevalidateTtl` does; a full 200 is required
        // (parity with the dispatch write sites — no partial/redirect body).
        const effectiveTtl = resolveRevalidateTtl(response, ttl);
        if (
          response.status === 200 &&
          effectiveTtl > 0 &&
          !hasSharedCacheOptOut(response) &&
          (manifest.type !== 'framework' ||
            response.headers.get('content-type')?.toLowerCase().split(';', 1)[0]?.trim() ===
              'text/html')
        ) {
          // Host-scope the warmed key to the slug host implied by the
          // fetch URL — dispatch reads `<pid>/isr/v3/<did>/<host>/<path>`
          // keyed on the request hostname, so without this the warmed
          // bytes are a permanent cold miss (see @void/isr `isrCacheKey`).
          const key = isrCacheKey(projectId, deployment.id, slugHost, pathname);
          const headers = serializePrerenderHeaders(response);
          const body = await response.arrayBuffer();
          const packed = packIsrValue(headers, body);
          await createIsrStore(context.env.STATIC_ASSETS_R2).put(key, packed, {
            // `c` (createdAt) + `t` (ttl) are REQUIRED by dispatch's
            // `readIsrCache` — it returns null (permanent cold miss)
            // without them. `satisfies IsrCacheMetadata` makes any field
            // drift a typecheck error.
            metadata: {
              s: response.status,
              c: Date.now(),
              t: effectiveTtl,
              p: SHARED_CACHE_POLICY_VERSION,
            } satisfies IsrCacheMetadata,
          });
        }
      } catch {
        // non-blocking
      }
    });
    emit({ event: 'prerender_done' });
  }
  await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);

  // Routing switch
  await snapshotCronState();
  await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);
  markPhase('routing_switch');
  await withProjectCutoverFence(deployment.id, async (txDb, currentOwner) => {
    const dispatchLimits = computeDispatchLimits(
      await resolvePlanLimits(txDb, currentOwner.plan),
      manifest.limits,
    );
    const existingRouting = await context.env.ROUTING.get(projectRouteKey(project));
    const existingEntry = existingRouting ? JSON.parse(existingRouting) : null;
    const zeroTrust = await resolveProjectZeroTrustRouting(txDb, projectId);
    const routingJson = buildRoutingJson({
      privatePreview: Boolean(project.preview_client_id),
      workerName: workerName,
      projectId: projectId,
      userId: project.user_id,
      manifest: manifest,
      deploymentId: deployment.id,
      dispatchLimits,
      suspended:
        existingEntry?.suspended ??
        (currentOwner.suspended_reason === REASON_REQUESTS_EXCEEDED
          ? REASON_REQUESTS_EXCEEDED
          : undefined),
      hasCrons,
      assetManifestId: assetCount > 0 ? deployment.id : undefined,
      assetConfig: assetCount > 0 ? assetConfig : undefined,
      zeroTrust,
    });
    const cutoverDomains = await getDomainsByProjectId(txDb, projectId);
    await reconcileManagedDurableObjects(
      context.env,
      txDb,
      projectId,
      deployment.id,
      manifest,
      undefined,
      input.deadline,
    );
    await putTrackedRouting(projectRouteKey(project), routingJson);
    input.routingSwitched = true;
    input.logger = input.logger.with({ routingSwitched: true });
    input.logger.info('routing_switch', 'slug_routed', { slug: project.slug });

    for (const domain of cutoverDomains) {
      if (domain.status === 'active') {
        const domainKey = `domain:${domain.hostname}`;
        await putTrackedRouting(domainKey, routingJson);
      }
    }

    input.currentStep = 'cron_setup';
    markPhase('cron_sync');
    input.cronSchedulerWriteAttempted = true;
    if (hasCrons) {
      await syncCronScheduler(context.env, projectId, {
        workerName: workerName,
        schedules: manifest.schedules!,
        proxyToken,
      });
    } else {
      await clearCronScheduler(context.env, projectId);
    }
  });

  input.currentStep = 'db_finalize';
  markPhase('db_finalize');
  await context.env.ROUTING.put(cutoverReadyKey(deployment.id), JSON.stringify(cutoverMarker));
  input.logger.info('status_transition', 'status_change', {
    from: input.currentStatus,
    to: 'live',
    reason: 'wfp_deploy',
  });
  await commitCutoverLive(context.get('db'), context.env.ROUTING, {
    projectId,
    actorId: actor.id,
    deploymentId: deployment.id,
    cutoverOwnerId,
    deployBuild,
    projectType: manifest.type ?? (manifest.framework ? 'framework' : 'void'),
  });
  input.cutoverCommitted = true;
  input.currentStatus = 'live';
  await Promise.all([
    context.env.ROUTING.delete(cutoverIntentKey(deployment.id)),
    context.env.ROUTING.delete(cutoverReadyKey(deployment.id)),
  ]).catch(() => {
    // Stale markers are harmless once PostgreSQL is live.
  });

  markPhase('retention_cleanup');
  const retentionLimit = planLimits.retainedDeployments;
  if (retentionLimit > 0) {
    const retained = await getRetainedDeploymentsExcluding(
      context.get('db'),
      projectId,
      deployment.id,
    );
    const toEvict = retained.slice(retentionLimit - 1);

    // Build the union of hashes that must remain in R2 after this deploy:
    // this deploy's manifest plus every kept retained deployment's
    // manifest. Always built (independent of `toEvict.length`) because
    // the post-eviction R2 keyspace sweep below uses it to opportunistically
    // GC direct-to-R2 orphans (bytes uploaded via presigned PUTs that
    // never finalized into a live deploy).
    const retainedHashes = new Set<string>();
    for (const [, entry] of Object.entries(assetManifest)) {
      retainedHashes.add(entry.hash);
    }
    const keptDeployments = retained.slice(0, retentionLimit - 1);
    for (const kept of keptDeployments) {
      if (kept.asset_hashes) {
        try {
          const keptManifest = JSON.parse(kept.asset_hashes) as Record<string, { hash: string }>;
          for (const entry of Object.values(keptManifest)) {
            retainedHashes.add(entry.hash);
          }
        } catch (e) {
          // A single corrupt asset_hashes blob must not poison the
          // sweep — skip the bad row and keep walking. The orphan sweep
          // is best-effort either way.
          input.logger.warn('retention_cleanup', 'retained_asset_hashes_parse_failed', {
            retainedDeploymentId: kept.id,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    const { evictable, activeToKeep } = await context.get('db').transaction(async (tx) => {
      await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
      const lockedProject = await getProject(tx, projectId);
      const evictable: typeof toEvict = [];
      let activeToKeep: (typeof toEvict)[number] | undefined;
      for (const old of toEvict) {
        if (lockedProject?.active_deployment_id === old.id) {
          activeToKeep = old;
          continue;
        }
        await markDeploymentRetained(tx, old.id, false);
        evictable.push(old);
      }
      return { evictable, activeToKeep };
    });

    let assetCleanupSafe = true;
    if (activeToKeep) {
      if (!activeToKeep.asset_hashes) {
        assetCleanupSafe = false;
      } else {
        try {
          const activeManifest = JSON.parse(activeToKeep.asset_hashes) as Record<
            string,
            { hash: string }
          >;
          for (const entry of Object.values(activeManifest)) {
            retainedHashes.add(entry.hash);
          }
        } catch (e) {
          assetCleanupSafe = false;
          input.logger.warn('retention_cleanup', 'active_asset_hashes_parse_failed', {
            retainedDeploymentId: activeToKeep.id,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }

    for (const old of evictable) {
      try {
        const oldWorkerName = `user-${project.slug}-${old.id}`;
        await deleteDispatchScript(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          dispatchNamespace,
          oldWorkerName,
        ).catch((e) => {
          input.logger.warn('retention_cleanup', 'evicted_dispatch_script_delete_failed', {
            evictedDeploymentId: old.id,
            err: e instanceof Error ? e.message : String(e),
          });
        });
        if (assetCleanupSafe && old.asset_hashes) {
          try {
            const evictedManifest = JSON.parse(old.asset_hashes) as Record<
              string,
              { hash: string }
            >;
            const evictedHashes = Object.values(evictedManifest).map((e) => e.hash);
            await deleteAssetHashesWithProjectFence(retainedHashes, evictedHashes).catch((e) => {
              input.logger.warn('retention_cleanup', 'evicted_unreferenced_assets_delete_failed', {
                evictedDeploymentId: old.id,
                err: e instanceof Error ? e.message : String(e),
              });
            });
            await context.env.ROUTING.delete(`manifest:${old.id}`).catch((e) => {
              input.logger.warn('retention_cleanup', 'evicted_routing_manifest_delete_failed', {
                evictedDeploymentId: old.id,
                err: e instanceof Error ? e.message : String(e),
              });
            });
          } catch (e) {
            input.logger.warn('retention_cleanup', 'evicted_asset_hashes_parse_failed', {
              evictedDeploymentId: old.id,
              err: e instanceof Error ? e.message : String(e),
            });
          }
        }
        if (old.manifest) {
          try {
            const oldManifest = JSON.parse(old.manifest) as DeployManifest;
            if (oldManifest.sandbox) {
              if (isManagedSandbox(oldManifest)) {
                await deleteSandboxController(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  projectId,
                  old.id,
                  oldManifest.sandbox,
                  context.env.SANDBOX_CONCURRENCY_COUNTER,
                  context.get('db'),
                );
              } else {
                const oldContainerAppName = perDeployContainerApplicationName(
                  projectId,
                  old.id,
                  oldManifest.sandbox.containerName ?? 'void-sandbox',
                );
                const existing = await findContainerApplication(
                  context.env.CF_ACCOUNT_ID,
                  context.env.CF_API_TOKEN,
                  oldContainerAppName,
                );
                if (existing) {
                  await deleteContainerApplicationIdempotent(
                    context.env.CF_ACCOUNT_ID,
                    context.env.CF_API_TOKEN,
                    existing.id,
                  );
                }
              }
            }
          } catch (e) {
            input.logger.error('retention_cleanup', 'evicted_sandbox_container_delete_failed', e, {
              evictedDeploymentId: old.id,
            });
          }
        }
        if (old.bundle_stored) {
          try {
            await evictStoredWorkerBundle(old.id);
          } catch (e) {
            input.logger.error('retention_cleanup', 'evicted_worker_bundle_delete_failed', e, {
              evictedDeploymentId: old.id,
            });
          }
        }
        await clearIsrCache(
          createIsrStore(context.env.STATIC_ASSETS_R2, context.env.ISR_CACHE),
          projectId,
          old.id,
        ).catch((e) =>
          input.logger.error('retention_cleanup', 'evicted_isr_cache_clear_failed', e, {
            evictedDeploymentId: old.id,
          }),
        );
      } catch (e) {
        input.logger.warn('retention_cleanup', 'eviction_partial_failure', {
          evictedDeploymentId: old.id,
          err: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
    }

    // Presigned uploads without a finalized manifest become orphans.
    // Sweep after the terminal event so R2 history does not delay a
    // successful deploy. The project fence still protects live hashes.
    if (assetCleanupSafe) {
      input.orphanSweepAfterResponse = async () => {
        try {
          const orphans = await sweepAssetOrphansWithProjectFence(retainedHashes);
          if (orphans > 0) {
            input.logger.info('retention_cleanup', 'r2_orphans_swept', { count: orphans });
          }
        } catch (e) {
          input.logger.warn('retention_cleanup', 'r2_orphan_sweep_failed', {
            err: e instanceof Error ? e.message : String(e),
          });
        }
      };
    }
  }

  const urls = projectPublicUrls(context.env, project, projectDomains);
  emit({
    event: 'done',
    deployment: deployment.id,
    url: urls[0]!,
    urls,
    assets: deployedAssetCount,
    workers: workerFiles.length,
    ...(migrationsApplied > 0 && { migrations: migrationsApplied }),
  });
  await finishOrphanSweep();
}
