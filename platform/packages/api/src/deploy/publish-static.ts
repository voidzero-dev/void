import { eq, sql as drizzleSql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { AssetManifestEntry } from '../assets.ts';
import { deleteDispatchScript } from '../cf-api.ts';
import { clearCronScheduler } from '../cron-scheduler-client.ts';
import {
  getProject,
  beginDeploymentCutover,
  getDomainsByProjectId,
  markDeploymentRetained,
  getRetainedDeploymentsExcluding,
  getProjectResources,
} from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { getProjectQueueName } from '../naming.ts';
import type { DeployLogger } from '../observability/logger.ts';
import { removeQueueConsumer } from '../provisioning/cloudflare-api.ts';
import { reconcileManagedDurableObjects } from '../provisioning/durable-objects.ts';
import { projectRouteKey } from '../routing.ts';
import { buildStaticRoutingJson } from '../routing.ts';
import { deployments } from '../schema.ts';
import { finishSecurityScanEnqueue } from '../security/enqueue.ts';
import { recheckPublicRequestBestEffort } from '../security/public-gate-flow.ts';
import { REASON_REQUESTS_EXCEEDED } from '../suspension.ts';
import { STATIC_RETENTION_LIMIT } from '../tiers.ts';
import type {
  DeployManifest,
  DeployEvent,
  Deployment,
  Project,
  DeploymentStatus,
} from '../types.ts';
import { resolveProjectZeroTrustRouting } from '../zero-trust/routing.ts';
import { assertDeploymentCanProceed } from './guards.ts';
import { commitCutoverLive, cutoverIntentKey, cutoverReadyKey } from './recovery.ts';
import type { CutoverMarker, requireActiveDeployAccess } from './recovery.ts';
import { attachServingStoreMetadata } from './serving-assets.ts';
import { projectPublicUrls } from './shared.ts';

export async function publishStaticDeployment(input: {
  currentStep: string;
  readonly manifest: DeployManifest;
  readonly emit: (event: DeployEvent) => void;
  readonly assetCount: number;
  readonly context: Context<ApiEnv>;
  readonly deployment: Deployment;
  readonly projectId: string;
  readonly assetManifest: Record<string, AssetManifestEntry>;
  readonly cutoverOwnerId: string;
  readonly deployBuild: string | undefined;
  cutoverProtected: boolean;
  currentStatus: DeploymentStatus;
  readonly withProjectCutoverFence: <T>(
    deploymentId: string,
    mutate: (
      txDb: Db,
      currentOwner: Awaited<ReturnType<typeof requireActiveDeployAccess>>['owner'],
    ) => Promise<T>,
  ) => Promise<T>;
  readonly previousManifest: DeployManifest | null;
  readonly snapshotTrackedQueueConsumer: (queueId: string, scriptName: string) => Promise<void>;
  readonly deleteTrackedRouting: (key: string) => Promise<void>;
  readonly snapshotCronState: () => Promise<void>;
  readonly markPhase: (next: string) => void;
  readonly project: Project;
  readonly putTrackedRouting: (key: string, value: string) => Promise<void>;
  routingSwitched: boolean;
  logger: DeployLogger;
  cronSchedulerWriteAttempted: boolean;
  readonly actor: ApiEnv['Variables']['user'];
  cutoverCommitted: boolean;
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
  readonly finishOrphanSweep: () => Promise<void>;
}): Promise<void> {
  const {
    manifest,
    emit,
    assetCount,
    context,
    deployment,
    projectId,
    assetManifest,
    cutoverOwnerId,
    deployBuild,
    withProjectCutoverFence,
    previousManifest,
    snapshotTrackedQueueConsumer,
    deleteTrackedRouting,
    snapshotCronState,
    markPhase,
    project,
    putTrackedRouting,
    actor,
    dispatchNamespace,
    deleteAssetHashesWithProjectFence,
    evictStoredWorkerBundle,
    sweepAssetOrphansWithProjectFence,
    projectDomains,
    finishOrphanSweep,
  } = input;

  input.currentStep = 'asset_upload';
  const assetConfig = manifest.assetConfig ?? {
    not_found_handling: 'single-page-application',
  };

  // Every asset was pre-uploaded direct-to-R2 by the CLI, so none are new
  // to this request; `cached` counts assets verified in R2.
  emit({
    event: 'asset_upload',
    total: assetCount,
    new: 0,
    cached: assetCount,
  });
  await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);
  emit({ event: 'asset_upload_done' });

  const servingManifest = Object.fromEntries(
    Object.entries(assetManifest).map(([path, entry]) => [path, `!${entry.hash}`]),
  );

  await context.env.ROUTING.put(`manifest:${deployment.id}`, JSON.stringify(servingManifest));

  await context
    .get('db')
    .update(deployments)
    .set({
      asset_hashes: JSON.stringify(
        attachServingStoreMetadata(assetManifest, servingManifest, true),
      ),
    })
    .where(eq(deployments.id, deployment.id));

  const type =
    manifest.type ??
    (assetConfig.not_found_handling === 'single-page-application' ? 'spa' : 'static');

  input.currentStep = 'cutover_intent';
  const cutoverMarker: CutoverMarker = {
    projectId,
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
  const dispatchWorkerName = context.env.DISPATCH_WORKER_NAME ?? 'void-dispatch';
  const projectResources = await getProjectResources(context.get('db'), projectId);
  await withProjectCutoverFence(deployment.id, async () => {
    for (const previousQueue of previousManifest?.queues ?? []) {
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
  });
  await snapshotCronState();
  await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);
  markPhase('routing_switch');
  await withProjectCutoverFence(deployment.id, async (txDb, currentOwner) => {
    const existingRouting = await context.env.ROUTING.get(projectRouteKey(project));
    const existingEntry = existingRouting
      ? (JSON.parse(existingRouting) as { suspended?: string })
      : null;
    const zeroTrust = await resolveProjectZeroTrustRouting(txDb, projectId);
    const routingJson = buildStaticRoutingJson({
      privatePreview: Boolean(project.preview_client_id),
      projectId,
      userId: project.user_id,
      deploymentId: deployment.id,
      assetConfig,
      manifest,
      suspended:
        existingEntry?.suspended ??
        (currentOwner.suspended_reason === REASON_REQUESTS_EXCEEDED
          ? REASON_REQUESTS_EXCEEDED
          : undefined),
      zeroTrust,
    });
    const cutoverDomains = await getDomainsByProjectId(txDb, projectId);
    await reconcileManagedDurableObjects(context.env, txDb, projectId, deployment.id, manifest);
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
    await clearCronScheduler(context.env, projectId);
  });

  input.currentStep = 'db_finalize';
  markPhase('db_finalize');
  await context.env.ROUTING.put(cutoverReadyKey(deployment.id), JSON.stringify(cutoverMarker));
  input.logger.info('status_transition', 'status_change', {
    from: input.currentStatus,
    to: 'live',
    reason: 'static_deploy',
  });
  const securityScan = await commitCutoverLive(context.get('db'), context.env.ROUTING, {
    projectId,
    actorId: actor.id,
    deploymentId: deployment.id,
    cutoverOwnerId,
    deployBuild,
    projectType: type,
    env: context.env,
  });
  input.cutoverCommitted = true;
  input.currentStatus = 'live';
  await Promise.all([
    context.env.ROUTING.delete(cutoverIntentKey(deployment.id)),
    context.env.ROUTING.delete(cutoverReadyKey(deployment.id)),
  ]).catch(() => {
    // Stale markers are harmless once PostgreSQL is live.
  });

  const retained = await getRetainedDeploymentsExcluding(
    context.get('db'),
    projectId,
    deployment.id,
  );

  markPhase('retention_cleanup');
  if (STATIC_RETENTION_LIMIT > 0) {
    const toEvict = retained.slice(STATIC_RETENTION_LIMIT - 1);
    // Build the post-eviction retained-hashes union once. Always
    // built (independent of `toEvict.length`) because the R2
    // keyspace sweep below uses it to opportunistically GC
    // direct-to-R2 orphans (bytes uploaded via presigned PUTs that
    // never finalized into a live deploy).
    const retainedHashes = new Set<string>();
    for (const [, entry] of Object.entries(assetManifest)) {
      retainedHashes.add(entry.hash);
    }
    const keptDeployments = retained.slice(0, STATIC_RETENTION_LIMIT - 1);
    for (const kept of keptDeployments) {
      if (kept.asset_hashes) {
        try {
          const keptManifest = JSON.parse(kept.asset_hashes) as Record<string, { hash: string }>;
          for (const entry of Object.values(keptManifest)) {
            retainedHashes.add(entry.hash);
          }
        } catch (e) {
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

    // A rollback can make a row selected for eviction active before
    // this lock is acquired. Preserve its hashes before deleting any
    // other deployment's assets or running the orphan sweep. Missing
    // legacy metadata fails closed by disabling asset GC for this
    // pass; retaining extra bytes is safer than deleting live bytes.
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
      await deleteDispatchScript(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        dispatchNamespace,
        `user-${project.slug}-${old.id}`,
      );
      if (assetCleanupSafe && old.asset_hashes) {
        const evictedManifest = JSON.parse(old.asset_hashes) as Record<string, { hash: string }>;
        const evictedHashes = Object.values(evictedManifest).map((e) => e.hash);
        await deleteAssetHashesWithProjectFence(retainedHashes, evictedHashes);
      }
      await context.env.ROUTING.delete(`manifest:${old.id}`);
      if (old.bundle_stored) {
        try {
          await evictStoredWorkerBundle(old.id);
        } catch (e) {
          input.logger.error('retention_cleanup', 'evicted_worker_bundle_delete_failed', e, {
            evictedDeploymentId: old.id,
          });
        }
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
    url: urls[0],
    urls,
    assets: assetCount,
    workers: 0,
  });
  await finishSecurityScanEnqueue(context.env, context.get('db'), securityScan);
  await recheckPublicRequestBestEffort(context.env, context.get('db'), project.id, 'a deploy');
  await finishOrphanSweep();
}
