import { platformProjectHostnames, readPlatformApplication } from '@void/platform';
import { and, eq, or, sql as drizzleSql } from 'drizzle-orm';
import { type Context } from 'hono';
import { findR2Assets, persistedR2AssetSizes } from '../asset-inventory.ts';
import {
  computeAssetHash,
  computeAssetStreamHashes,
  deleteWorkerBundle,
  scanProjectAssetOrphanCandidates,
  deleteUnreferencedAssets,
  type AssetEntry,
  type AssetManifestEntry,
} from '../assets.ts';
import { activeOAuthApproval } from '../auth/oauth.ts';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import {
  restoreCronScheduler,
  snapshotCronScheduler,
  type CronSyncState,
} from '../cron-scheduler-client.ts';
import {
  getProject,
  getUser,
  getDeployment,
  createDeployment,
  updateDeploymentManifest,
  updateDeploymentStatus,
  updateProjectWebSocketVersion,
  getDomainsByProjectId,
  countUserDeploymentsToday,
  getActiveDeployment,
  getInFlightDeploymentsExcluding,
  type Db,
} from '../db.ts';
import {
  appendDeploymentEvent,
  assertDeploymentExecutionAuthority,
} from '../deployment-execution.ts';
import type { ApiEnv } from '../env.ts';
import { type DeployLogger } from '../observability/logger.ts';
import { PLAN_CATALOG_SETTING, resolvePlanLimits } from '../plans.ts';
import { getPlatformSetting } from '../platform-settings.ts';
import { ensureProjectIngress } from '../project-ingress.ts';
import {
  restoreQueueConsumer,
  snapshotQueueConsumer,
  type QueueConsumerInfo,
} from '../provisioning/cloudflare-api.ts';
import { computeDispatchLimits, resolveRoutingUndo } from '../routing.ts';
import { deployments } from '../schema.ts';
import { routingSuspensionReason } from '../suspension.ts';
import { isWithinLimit } from '../tiers.ts';
import {
  type DeployManifest,
  type DeployEvent,
  type Deployment,
  type Project,
  type DeploymentStatus,
} from '../types.ts';
import type { WorkerModule } from '../worker-upload.ts';
import {
  resolveProjectZeroTrustRoutingForPublication,
  rewriteProjectRouteMetadata,
  withProjectZeroTrustRouting,
} from '../zero-trust/routing.ts';
import { recoverFailedDeployment } from './compensate.ts';
import { enrichWebSocketManifest, enrichLiveManifest } from './durable-bindings.ts';
import {
  PROJECT_DELETING_ERROR_MESSAGE,
  SUPERSEDED_BUILD_ERROR_MESSAGE,
  assertDeploymentNotCanceled,
  assertDeploymentCanProceed,
} from './guards.ts';
import { migrateDeploymentWorker } from './migrate-worker.ts';
import { publishStaticDeployment } from './publish-static.ts';
import { publishWorkerDeployment } from './publish-worker.ts';
import { requireActiveDeployAccess, cutoverIntentKey, parseCutoverMarker } from './recovery.ts';
import { parseManifest, equalAssetManifests, parseAssetManifest } from './serving-assets.ts';
import {
  ASSET_GC_MAX_HASHES_PER_DEPLOY,
  ASSET_GC_LOCK_BATCH,
  projectPublicUrls,
} from './shared.ts';
import { uploadDeploymentWorker } from './upload-worker.ts';

export async function runDeploymentPipeline(input: {
  readonly context: Context<ApiEnv>;
  readonly owner: ApiEnv['Variables']['user'];
  readonly preDeployment: Deployment;
  readonly logger: DeployLogger;
  readonly execution: ApiEnv['Variables']['deploymentExecution'];
  readonly cutoverOwnerId: string;
  readonly projectId: string;
  readonly actor: ApiEnv['Variables']['user'];
  readonly originalActiveDeploymentId: string | null;
  readonly project: Project;
  readonly incomingAssetManifest: Record<string, AssetManifestEntry>;
  readonly currentLiveDeployment: Deployment | null;
  readonly incomingManifest: DeployManifest;
  readonly hasWorkerFiles: boolean;
  readonly source: string | null;
  readonly commit: string | null;
  readonly cliVersion: string | null;
  readonly repositoryUrl: string | null;
  readonly commitUrl: string | null;
  readonly gitRef: string | null;
  readonly deployBuild: string | undefined;
  readonly workerFiles: Array<WorkerModule>;
  /** Deletes the request's Worker upload once the pipeline settles. */
  readonly releaseWorkerInput?: () => Promise<void>;
}): Promise<Response> {
  let logger = input.logger;
  const {
    context,
    owner,
    preDeployment,
    execution,
    cutoverOwnerId,
    projectId,
    actor,
    originalActiveDeploymentId,
    project,
    incomingAssetManifest,
    currentLiveDeployment,
    incomingManifest,
    hasWorkerFiles,
    source,
    commit,
    cliVersion,
    repositoryUrl,
    commitUrl,
    gitRef,
    deployBuild,
    workerFiles,
  } = input;
  const planLimits = await resolvePlanLimits(context.get('db'), owner.plan);

  // NDJSON response stream: heartbeats, progress events, `done`/`error`.
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let streamOpen = true;
  let currentStep = 'parsing';
  let currentDeploymentId: string = preDeployment.id;
  let currentStatus: DeploymentStatus = 'pending';
  let cutoverProtected = false;
  let phaseName = 'parsing';
  let phaseStartMs = Date.now();
  const markPhase = (next: string): void => {
    const now = Date.now();
    logger.info(phaseName, 'phase_end', { durationMs: now - phaseStartMs });
    phaseName = next;
    phaseStartMs = now;
    logger.info(next, 'phase_start');
  };
  let persistedEvents = Promise.resolve();
  let terminalEvent: DeployEvent | undefined;
  const emit = (event: DeployEvent): void => {
    if (execution) {
      if (event.event === 'done' || event.event === 'error') {
        terminalEvent = event;
        return;
      }
      persistedEvents = persistedEvents.then(async () => {
        // Intermediate progress is best effort. Retry a transient database
        // failure once, but never let it poison later events or prevent the
        // authoritative terminal result from being committed after execution.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await appendDeploymentEvent(context.get('db'), preDeployment.id, cutoverOwnerId, event);
            return;
          } catch (error) {
            if (attempt === 1) {
              logger.warn('progress', 'persist_failed', { event: event.event, err: String(error) });
            }
          }
        }
      });
      return;
    }
    logger.info('emit', 'ndjson_event', event as unknown as Record<string, unknown>);
    if (!streamOpen) {
      return;
    }
    writer.write(encoder.encode(JSON.stringify(event) + '\n')).catch((err) => {
      streamOpen = false;
      logger.warn('emit', 'stream_closed', { event: event.event, err: String(err) });
    });
  };
  const heartbeatOverride = context.env.DEPLOY_HEARTBEAT_INTERVAL_MS;
  const heartbeatIntervalMs =
    typeof heartbeatOverride === 'number' &&
    Number.isFinite(heartbeatOverride) &&
    heartbeatOverride > 0
      ? Math.max(1, heartbeatOverride)
      : 15_000;

  const pipeline = (async () => {
    logger.info('json_validate', 'phase_start');
    phaseName = 'json_validate';
    phaseStartMs = Date.now();
    let routingSwitched = false;
    let cutoverCommitted = false;
    const writtenRoutingKeys: Array<string> = [];
    const routingValuesBeforeWrite = new Map<string, string | null>();
    const routingValuesWritten = new Map<string, string | null>();
    const snapshotRoutingValue = async (key: string): Promise<void> => {
      if (!routingValuesBeforeWrite.has(key)) {
        routingValuesBeforeWrite.set(key, await context.env.ROUTING.get(key));
        writtenRoutingKeys.push(key);
      }
    };
    const putTrackedRouting = async (key: string, value: string): Promise<void> => {
      await snapshotRoutingValue(key);
      // Record the intended mutation before awaiting KV. A write can commit at
      // Cloudflare and still reject locally when its acknowledgement is lost;
      // compensation must then inspect and undo that possibly-landed value.
      routingValuesWritten.set(key, value);
      await context.env.ROUTING.put(key, value);
    };
    const deleteTrackedRouting = async (key: string): Promise<void> => {
      await snapshotRoutingValue(key);
      routingValuesWritten.set(key, null);
      await context.env.ROUTING.delete(key);
    };
    const withProjectCutoverFence = async <T>(
      deploymentId: string,
      mutate: (
        txDb: Db,
        currentOwner: Awaited<ReturnType<typeof requireActiveDeployAccess>>['owner'],
      ) => Promise<T>,
    ): Promise<T> => {
      return await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedProject = await getProject(tx, projectId);
        if (!lockedProject || lockedProject.status === 'deleting') {
          throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
        }
        const currentAccess = await requireActiveDeployAccess(tx, projectId, actor.id);
        if (execution) {
          await assertDeploymentExecutionAuthority(tx, execution.operation);
        } else if (context.get('oauthApproval')) {
          const { approval, user } = await activeOAuthApproval(
            tx,
            context.get('oauthApproval')!,
            context.get('companyIdentity'),
            true,
          );
          if (approval.data.projectId !== projectId || user.id !== actor.id) {
            throw new Error('Deployment approval is no longer active');
          }
        }
        await assertDeploymentNotCanceled(tx, deploymentId);
        if (cutoverProtected) {
          const intent = parseCutoverMarker(
            await context.env.ROUTING.get(cutoverIntentKey(deploymentId)),
          );
          if (intent?.ownerId !== cutoverOwnerId || intent.projectId !== projectId) {
            throw new Error(SUPERSEDED_BUILD_ERROR_MESSAGE);
          }
        }
        return await mutate(tx, currentAccess.owner);
      });
    };
    // Compensation must serialize with every project cutover, not only
    // teardown. Once a newer deploy or rollback owns the project, restoring
    // this attempt's snapshots would overwrite its routing, cron, and queue
    // state while PostgreSQL points at the newer deployment. Under the shared
    // project lock, require both the original active deployment provenance and
    // the absence of a competing in-flight operation. Teardown's `deleting`
    // state and a missing row likewise make absence authoritative.
    const withProjectCompensationFence = async (
      restore: (txDb: Db) => Promise<void>,
    ): Promise<void> => {
      await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedProject = await getProject(tx, projectId);
        if (!lockedProject || lockedProject.status === 'deleting') {
          return;
        }
        if (lockedProject.active_deployment_id !== originalActiveDeploymentId) {
          return;
        }
        if (cutoverProtected) {
          const ownedDeployment = await getDeployment(tx, currentDeploymentId);
          if (ownedDeployment?.status !== 'compensating') {
            return;
          }
          const intent = parseCutoverMarker(
            await context.env.ROUTING.get(cutoverIntentKey(currentDeploymentId)),
          );
          if (intent?.projectId !== projectId || intent.ownerId !== cutoverOwnerId) {
            return;
          }
        }
        const competingOperation = await getActiveDeployment(tx, projectId);
        if (competingOperation && competingOperation.id !== currentDeploymentId) {
          return;
        }
        await restore(tx);
      });
    };
    const withProjectAssetGcFence = async <T>(
      knownRetainedHashes: ReadonlySet<string>,
      cleanup: (retainedHashes: Set<string>) => Promise<T>,
    ): Promise<T | null> => {
      return await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedProject = await getProject(tx, projectId);
        if (!lockedProject || lockedProject.status === 'deleting') {
          return null;
        }

        // Retention selection happens after go-live, so another deployment or
        // rollback can become authoritative before external GC begins. Rebuild
        // the protected hash set under the same lock used by final cutover and
        // keep that lock through R2 deletion. A following static deploy performs
        // its last R2 existence check under this lock before committing live.
        const protectedHashes = new Set(knownRetainedHashes);
        // Migrated stored bundles still reference their asset copies even when
        // their historical deployment failed or is no longer retained.
        const retained = await tx
          .select()
          .from(deployments)
          .where(
            and(
              eq(deployments.project_id, projectId),
              or(eq(deployments.retained, true), eq(deployments.bundle_stored, true)),
            ),
          );
        if (
          lockedProject.active_deployment_id &&
          !retained.some((deployment) => deployment.id === lockedProject.active_deployment_id)
        ) {
          const active = await getDeployment(tx, lockedProject.active_deployment_id);
          if (active) {
            retained.push(active);
          }
        }
        // A direct upload lands in R2 before its deployment can become live.
        // Once the row has placement-bearing asset_hashes, protect it through
        // every nonterminal state (including canceling/compensating). The
        // recent-upload timestamp guard covers the short pre-persistence gap.
        for (const inFlight of await getInFlightDeploymentsExcluding(tx, projectId)) {
          if (!retained.some((deployment) => deployment.id === inFlight.id)) {
            retained.push(inFlight);
          }
        }
        for (const protectedDeployment of retained) {
          if (!protectedDeployment.asset_hashes) {
            if (protectedDeployment.id === lockedProject.active_deployment_id) {
              return null;
            }
            continue;
          }
          try {
            const retainedManifest = JSON.parse(protectedDeployment.asset_hashes) as Record<
              string,
              { hash: string }
            >;
            for (const entry of Object.values(retainedManifest)) {
              protectedHashes.add(entry.hash);
            }
          } catch {
            // Corrupt retained metadata cannot prove an object is unreferenced.
            return null;
          }
        }
        return await cleanup(protectedHashes);
      });
    };
    const evictStoredWorkerBundle = async (deploymentId: string): Promise<void> => {
      await deleteWorkerBundle(context.env.STATIC_ASSETS_R2, projectId, deploymentId);
      // Stored history protects its migrated asset copy until the bundle is
      // actually gone. The following orphan sweep can now collect those bytes.
      await context
        .get('db')
        .update(deployments)
        .set({ bundle_stored: false })
        .where(and(eq(deployments.id, deploymentId), eq(deployments.project_id, projectId)));
    };
    let remainingAssetGcHashBudget = ASSET_GC_MAX_HASHES_PER_DEPLOY;
    let orphanSweepAfterResponse: (() => Promise<void>) | null = null;
    const finishOrphanSweep = async (): Promise<void> => {
      const sweep = orphanSweepAfterResponse;
      if (!sweep) {
        return;
      }
      const work = Promise.resolve().then(sweep);
      try {
        context.executionCtx.waitUntil(work);
      } catch {
        // app.fetch() has no ExecutionContext in integration tests. Await the
        // same work there so cleanup remains observable and deterministic.
        await work;
      }
    };
    const deleteAssetHashesWithProjectFence = async (
      knownRetainedHashes: ReadonlySet<string>,
      hashes: ReadonlyArray<string>,
    ): Promise<number> => {
      let deleted = 0;
      const budgetedHashes = hashes.slice(0, remainingAssetGcHashBudget);
      for (let index = 0; index < budgetedHashes.length; index += ASSET_GC_LOCK_BATCH) {
        const batch = budgetedHashes.slice(index, index + ASSET_GC_LOCK_BATCH);
        remainingAssetGcHashBudget -= batch.length;
        const batchDeleted = await withProjectAssetGcFence(
          knownRetainedHashes,
          (currentRetainedHashes) =>
            deleteUnreferencedAssets(
              context.env.STATIC_ASSETS,
              context.env.STATIC_ASSETS_R2,
              batch,
              currentRetainedHashes,
              projectId,
            ),
        );
        deleted += batchDeleted ?? 0;
      }
      return deleted;
    };
    const sweepAssetOrphansWithProjectFence = async (
      knownRetainedHashes: ReadonlySet<string>,
    ): Promise<number> => {
      let deleted = 0;
      await scanProjectAssetOrphanCandidates(
        context.env.STATIC_ASSETS_R2,
        projectId,
        async (candidates) => {
          deleted += await deleteAssetHashesWithProjectFence(knownRetainedHashes, candidates);
        },
        { maxCandidates: remainingAssetGcHashBudget },
      );
      return deleted;
    };
    const restoreTrackedRouting = async (): Promise<void> => {
      await withProjectCompensationFence(async (txDb) => {
        const zeroTrust = await resolveProjectZeroTrustRoutingForPublication(txDb, projectId);
        const currentProject = await getProject(txDb, projectId);
        const currentOwner = currentProject ? await getUser(txDb, currentProject.user_id) : null;
        if (!currentProject || !currentOwner) {
          throw new Error('project owner is unavailable during routing compensation');
        }
        const refreshPolicy =
          currentOwner.id !== owner.id ||
          currentOwner.plan !== owner.plan ||
          (await getPlatformSetting(txDb, PLAN_CATALOG_SETTING)) !== null;
        const committedDeployment =
          refreshPolicy && currentProject.active_deployment_id
            ? await getDeployment(txDb, currentProject.active_deployment_id)
            : null;
        const committedManifest = committedDeployment?.manifest
          ? (JSON.parse(committedDeployment.manifest) as DeployManifest)
          : null;
        const currentLimits = refreshPolicy
          ? computeDispatchLimits(
              await resolvePlanLimits(txDb, currentOwner.plan),
              committedManifest?.limits,
            )
          : null;
        const errors: Array<unknown> = [];
        for (const [key, previous] of [...routingValuesBeforeWrite].reverse()) {
          try {
            if (!routingValuesWritten.has(key)) {
              continue;
            }
            const undo = resolveRoutingUndo(
              await context.env.ROUTING.get(key),
              routingValuesWritten.get(key)!,
              previous,
            );
            if (!undo.restore) {
              continue;
            }
            if (undo.value === null) {
              await context.env.ROUTING.delete(key);
            } else {
              let value = undo.value;
              if (key === project.slug || key.startsWith('domain:')) {
                value = refreshPolicy
                  ? rewriteProjectRouteMetadata(JSON.parse(value) as Record<string, unknown>, {
                      projectId,
                      userId: currentOwner.id,
                      limits: currentLimits,
                      suspended: routingSuspensionReason(currentOwner.suspended_reason),
                      zeroTrust,
                    })
                  : withProjectZeroTrustRouting(value, zeroTrust, projectId);
              }
              await context.env.ROUTING.put(key, value);
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'one or more routing entries could not be restored');
        }
      });
    };
    let cronStateBeforeWrite: CronSyncState | null | undefined;
    let cronSchedulerWriteAttempted = false;
    const snapshotCronState = async (): Promise<void> => {
      if (cronStateBeforeWrite === undefined) {
        cronStateBeforeWrite = await snapshotCronScheduler(context.env, projectId);
      }
    };
    const restoreTrackedCronState = async (): Promise<void> => {
      if (cronSchedulerWriteAttempted && cronStateBeforeWrite !== undefined) {
        await withProjectCompensationFence(() =>
          restoreCronScheduler(context.env, projectId, cronStateBeforeWrite!),
        );
      }
    };
    const queueConsumerSnapshots = new Map<
      string,
      { queueId: string; scriptName: string; state: QueueConsumerInfo | null }
    >();
    const snapshotTrackedQueueConsumer = async (
      queueId: string,
      scriptName: string,
    ): Promise<void> => {
      const key = `${queueId}\0${scriptName}`;
      if (!queueConsumerSnapshots.has(key)) {
        queueConsumerSnapshots.set(key, {
          queueId,
          scriptName,
          state: await snapshotQueueConsumer(
            context.env.CF_ACCOUNT_ID,
            context.env.CF_API_TOKEN,
            queueId,
            scriptName,
          ),
        });
      }
    };
    const restoreTrackedQueueConsumers = async (): Promise<void> => {
      await withProjectCompensationFence(async () => {
        const errors: Array<unknown> = [];
        for (const snapshot of [...queueConsumerSnapshots.values()].reverse()) {
          try {
            await restoreQueueConsumer(
              context.env.CF_ACCOUNT_ID,
              context.env.CF_API_TOKEN,
              snapshot.queueId,
              snapshot.scriptName,
              snapshot.state,
            );
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'one or more queue consumers could not be restored');
        }
      });
    };
    let workerUploaded = false;
    let workerUploadUrl: string | undefined;
    let sandboxControllerAttempted = false;
    let manifest: DeployManifest | undefined;
    let workerName: string | undefined;
    let dispatchNamespace: string | undefined;
    let deployment: Awaited<ReturnType<typeof createDeployment>> | undefined;
    let projectDomains: Awaited<ReturnType<typeof getDomainsByProjectId>> | undefined;

    // Bytes uploaded directly to R2 by the CLI before this request landed.
    // For static deploys this map stays empty (the static branch reads
    // them straight from R2 by hash). For WfP deploys it gets populated
    // from R2 fetches further down — the CF asset upload session needs
    // the actual bytes to fan into upload buckets.
    const assetsByHash = new Map<string, AssetEntry>();
    const heartbeat = setInterval(() => {
      emit(
        currentDeploymentId
          ? { event: 'heartbeat', deploymentId: currentDeploymentId, step: currentStep }
          : { event: 'heartbeat', step: currentStep },
      );
    }, heartbeatIntervalMs);

    let wfpMirroredManifestDeploymentId: string | null = null;

    try {
      // New deployments use only project-scoped R2 assets. Historical KV and
      // unscoped objects remain readable by their existing deployments, but a
      // redeploy must upload any bytes not present in the current store.
      currentStep = 'asset_verify';
      markPhase('asset_verify');
      const declaredHashes = Array.from(
        new Set(Object.values(incomingAssetManifest).map((e) => e.hash)),
      );
      // The active deployment's placement-bearing manifest is protected from
      // platform GC. Reusing those exact R2 hashes avoids inventorying the
      // whole project prefix again on an unchanged Worker redeploy. New or
      // legacy entries still require the existing object-store verification.
      const activeR2Sizes =
        currentLiveDeployment?.status === 'live' && currentLiveDeployment.project_id === projectId
          ? persistedR2AssetSizes(currentLiveDeployment.asset_hashes)
          : new Map<string, number>();
      const declaredSizeByHash = new Map<string, number | null>();
      for (const entry of Object.values(incomingAssetManifest)) {
        if (!declaredSizeByHash.has(entry.hash)) {
          declaredSizeByHash.set(entry.hash, entry.size);
        } else if (declaredSizeByHash.get(entry.hash) !== entry.size) {
          declaredSizeByHash.set(entry.hash, null);
        }
      }
      // Only scoped placement verified by this runtime (or the migration)
      // can skip inventory. Legacy store:'r2' alone does not prove scoping.
      const unverifiedHashes = declaredHashes.filter(
        (hash) => activeR2Sizes.get(hash) !== declaredSizeByHash.get(hash),
      );
      const missingHashes: Array<string> = [];
      // R2 binding operations count toward a Worker's per-request subrequest
      // budget. A valid manifest may contain 5,000 assets, so one HEAD per hash
      // can fail a healthy deployment before validation. Inventory the scoped
      // project prefix in paginated calls instead; this runs outside every
      // PostgreSQL transaction and stops as soon as all required hashes appear.
      const foundAssets = await findR2Assets(
        context.env.STATIC_ASSETS_R2,
        projectId,
        new Set(unverifiedHashes),
      );
      for (const hash of unverifiedHashes) {
        const object = foundAssets.get(hash);
        if (!object || object.size !== declaredSizeByHash.get(hash)) {
          missingHashes.push(hash);
        }
      }
      if (missingHashes.length > 0) {
        const cap = 10;
        const sample = missingHashes.slice(0, cap);
        const more = missingHashes.length > cap ? ` (+${missingHashes.length - cap} more)` : '';
        emit({
          event: 'error',
          message:
            `${missingHashes.length} declared asset hash${missingHashes.length === 1 ? '' : 'es'} not found in R2: ${sample.join(', ')}${more}. ` +
            `Upload may have been skipped, or presigned URLs may have expired (10 min TTL). Re-run preflight + upload-urls.`,
          step: currentStep,
        });
        return;
      }

      if (context.get('oauthApproval')) {
        // An app's declared digest is a commitment, not proof of the uploaded
        // bytes. Verify BLAKE3 rather than trusting MD5 or object metadata.
        // Its signed PUTs are conditional, so it cannot change verified bytes.
        for (const hash of declaredHashes) {
          const paths = Object.entries(incomingAssetManifest)
            .filter(([, entry]) => entry.hash === hash)
            .map(([path]) => path);
          const object = await context.env.STATIC_ASSETS_R2.get(`assets/${projectId}/${hash}`);
          if (!object) {
            throw new Error('Approved asset is missing.');
          }
          const size = declaredSizeByHash.get(hash);
          if (size == null) {
            throw new Error('Approved asset has conflicting sizes.');
          }
          const verified = await computeAssetStreamHashes(object.body, paths, size);
          if (verified.size !== size || verified.hashes.some((value) => value !== hash)) {
            emit({
              event: 'error',
              message: 'Uploaded asset differs from the artifact approved on Void.',
              step: currentStep,
            });
            return;
          }
        }
      }

      await ensureProjectIngress(context.env, project);

      // === MANIFEST VALIDATION & DEDUPE ===
      currentStep = 'validating';
      markPhase('manifest_validate');

      const previousManifest = parseManifest(currentLiveDeployment?.manifest);
      const websocketManifestResult = enrichWebSocketManifest(
        incomingManifest,
        previousManifest,
        project.websocket_version,
      );
      const liveManifestResult = enrichLiveManifest(
        websocketManifestResult.manifest,
        previousManifest,
        websocketManifestResult.nextVersion,
      );
      const manifestVersionChanged = websocketManifestResult.changed || liveManifestResult.changed;
      manifest = liveManifestResult.manifest;
      if (manifest.sandbox) {
        manifest = { ...manifest, sandbox: { ...manifest.sandbox, runtime: { protocol: 2 } } };
      }
      if (hasWorkerFiles && manifest.type === undefined) {
        // Rollback identifies retained Workers from their manifest, including
        // older clients that omit type and workerMain but configure asset fallbacks.
        manifest = { ...manifest, type: manifest.framework ? 'framework' : 'void' };
      }
      const finalManifestRaw = JSON.stringify(manifest);

      // Host-scoped routing rules.
      const hostScopedRedirects = manifest.redirectRules?.some((r) => r.host) ?? false;
      const hostScopedFallbacks = manifest.fallbackRules?.some((r) => r.host) ?? false;
      if (hostScopedRedirects || hostScopedFallbacks) {
        const application = readPlatformApplication(context.env);
        projectDomains ??= await getDomainsByProjectId(context.get('db'), projectId);
        const boundHosts = new Set<string>(platformProjectHostnames(project, application));
        for (const d of projectDomains) {
          boundHosts.add(d.hostname);
        }
        const unbound = [...(manifest.redirectRules ?? []), ...(manifest.fallbackRules ?? [])]
          .map((r) => r.host)
          .filter((h): h is string => typeof h === 'string' && !boundHosts.has(h));
        if (unbound.length > 0) {
          const unique = Array.from(new Set(unbound));
          emit({
            event: 'error',
            message: `routing rule host not bound to project: ${unique.join(', ')} — add the domain (\`void domain add\`) before deploying rules scoped to it`,
            step: currentStep,
          });
          return;
        }
      }

      if (!hasWorkerFiles && currentLiveDeployment && currentLiveDeployment.status === 'live') {
        const sameManifest = currentLiveDeployment.manifest === finalManifestRaw;
        const sameAssets = equalAssetManifests(
          incomingAssetManifest,
          parseAssetManifest(currentLiveDeployment.asset_hashes),
        );
        const sameScopedAssets = declaredHashes.every(
          (hash) => activeR2Sizes.get(hash) === declaredSizeByHash.get(hash),
        );
        if (sameManifest && sameAssets && sameScopedAssets) {
          projectDomains ??= await getDomainsByProjectId(context.get('db'), projectId);
          const urls = projectPublicUrls(context.env, project, projectDomains);
          emit({ event: 'start', deploymentId: currentLiveDeployment.id });
          emit({
            event: 'done',
            deployment: currentLiveDeployment.id,
            url: urls[0]!,
            urls,
            assets: 0,
            workers: 0,
          });
          // Release the placeholder row — verified no-op.
          await context.get('db').delete(deployments).where(eq(deployments.id, preDeployment.id));
          return;
        }
      }

      // Daily deploy-count limit. JSON-mode deploys don't write any KV/R2
      // bytes during this request (assets pre-existed direct-to-R2), so
      // we can defer the cap check until AFTER the dedupe short-circuit.
      if (planLimits.deploysPerDay > 0) {
        const todayCount = await countUserDeploymentsToday(context.get('db'), owner.id);
        if (!isWithinLimit(planLimits.deploysPerDay, todayCount)) {
          emit({ event: 'error', message: 'deploy limit exceeded', step: currentStep });
          return;
        }
      }

      // Fill in the deployment record under the project lock. Once this
      // completes the deployment row is no longer a precheck placeholder —
      // every subsequent failure must transition it to a terminal status via
      // the catch path.
      deployment = await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedProject = await getProject(tx, projectId);
        if (!lockedProject || lockedProject.status === 'deleting') {
          throw new Error(PROJECT_DELETING_ERROR_MESSAGE);
        }
        return await updateDeploymentManifest(
          tx,
          preDeployment.id,
          finalManifestRaw,
          source,
          commit,
          {
            cliVersion,
            repositoryUrl,
            commitUrl,
            gitRef,
          },
        );
      });
      currentDeploymentId = deployment.id;
      logger = logger.with({ deploymentId: deployment.id });
      if (manifestVersionChanged) {
        await updateProjectWebSocketVersion(
          context.get('db'),
          projectId,
          liveManifestResult.nextVersion,
        );
      }
      dispatchNamespace = context.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
      workerName = `user-${project.slug}-${deployment.id}`;

      const pipelineDeployment = deployment;
      const pipelineManifest = manifest;
      const pipelineWorkerName = workerName;
      const pipelineDispatchNamespace = dispatchNamespace;

      try {
        const deployment = pipelineDeployment;
        const manifest = pipelineManifest;
        const workerName = pipelineWorkerName;
        const dispatchNamespace = pipelineDispatchNamespace;

        emit({ event: 'start', deploymentId: deployment.id });

        // === ASSET UPLOAD PHASE ===
        currentStep = 'asset_upload';
        markPhase('asset_upload');
        logger.info('status_transition', 'status_change', {
          from: currentStatus,
          to: 'uploading',
        });
        if (!cutoverProtected) {
          await updateDeploymentStatus(context.get('db'), deployment.id, 'uploading');
          currentStatus = 'uploading';
        }
        await assertDeploymentCanProceed(context.get('db'), deployment.id, projectId);

        // JSON-mode CLI always sends the full assetManifest including
        // preflight-skipped paths; no server-side fill-in needed. Clone so
        // the cache-buster injection below mutates a fresh object rather
        // than the validated incoming map.
        const assetManifest: Record<string, AssetManifestEntry> = { ...incomingAssetManifest };

        const isStaticOnly = !hasWorkerFiles;
        logger = logger.with({ branch: isStaticOnly ? 'static' : 'wfp' });

        // CF dedupe-poisoning workaround: WfP deploys with non-empty asset
        // manifests inject a unique cache buster so CF's asset session always
        // sees at least one novel hash. The buster's bytes still need to reach CF, so we put
        // them directly into `assetsByHash` (not into our R2 — they're
        // a deploy-local artifact, not a CLI-uploaded asset).
        if (!isStaticOnly && Object.keys(assetManifest).length > 0) {
          const bustPath = `/.void-deploy/${deployment.id}.txt`;
          const bustContent = `${deployment.id}\n${Date.now()}\n`;
          const bustBytes = new TextEncoder().encode(bustContent);
          const bustBuffer = bustBytes.buffer.slice(
            bustBytes.byteOffset,
            bustBytes.byteOffset + bustBytes.byteLength,
          );
          const bustHash = computeAssetHash(bustBuffer, bustPath);
          assetManifest[bustPath] = { hash: bustHash, size: bustBytes.byteLength };
          assetsByHash.set(bustHash, {
            bytes: bustBytes,
            contentType: 'text/plain; charset=utf-8',
          });
        }

        // `assetCount` includes the cache-buster and gates Cloudflare asset
        // work; `deployedAssetCount` is what the user deployed and is reported.
        const assetCount = Object.keys(assetManifest).length;
        const deployedAssetCount = Object.keys(incomingAssetManifest).length;

        projectDomains ??= await getDomainsByProjectId(context.get('db'), projectId);

        if (isStaticOnly) {
          // Static-only branch: bytes already in R2; build the serving
          // manifest with `!{hash}` for every entry (direct-to-R2 always
          // lands in R2). No KV/R2 writes for asset bodies — only the
          // serving manifest under `manifest:{deploymentId}` and the
          // routing entry under `project.slug`.
          return await publishStaticDeployment({
            get currentStep() {
              return currentStep!;
            },
            set currentStep(value: string) {
              currentStep = value;
            },
            manifest,
            emit,
            assetCount: deployedAssetCount,
            context,
            deployment,
            projectId,
            assetManifest,
            cutoverOwnerId,
            deployBuild,
            get cutoverProtected() {
              return cutoverProtected!;
            },
            set cutoverProtected(value: boolean) {
              cutoverProtected = value;
            },
            get currentStatus() {
              return currentStatus!;
            },
            set currentStatus(value: DeploymentStatus) {
              currentStatus = value;
            },
            withProjectCutoverFence,
            previousManifest,
            snapshotTrackedQueueConsumer,
            deleteTrackedRouting,
            snapshotCronState,
            markPhase,
            project,
            putTrackedRouting,
            get routingSwitched() {
              return routingSwitched!;
            },
            set routingSwitched(value: boolean) {
              routingSwitched = value;
            },
            get logger() {
              return logger!;
            },
            set logger(value: DeployLogger) {
              logger = value;
            },
            get cronSchedulerWriteAttempted() {
              return cronSchedulerWriteAttempted!;
            },
            set cronSchedulerWriteAttempted(value: boolean) {
              cronSchedulerWriteAttempted = value;
            },
            actor,
            get cutoverCommitted() {
              return cutoverCommitted!;
            },
            set cutoverCommitted(value: boolean) {
              cutoverCommitted = value;
            },
            dispatchNamespace,
            deleteAssetHashesWithProjectFence,
            evictStoredWorkerBundle,
            get orphanSweepAfterResponse() {
              return orphanSweepAfterResponse!;
            },
            set orphanSweepAfterResponse(value: (() => Promise<void>) | null) {
              orphanSweepAfterResponse = value;
            },
            sweepAssetOrphansWithProjectFence,
            projectDomains,
            finishOrphanSweep,
          });
        }

        // === WfP branch ===
        // Direct-to-R2 doesn't change anything about CF's asset upload
        // session: CF still wants the actual bytes to fan into upload
        // buckets. We fetch the bytes back from OUR R2 (where the CLI
        // just uploaded them) — server-internal R2-to-CF traffic that
        // doesn't go through the user's pipe. The fetch concurrency
        // matches the existing R2 head verify pool.
        const uploadDeploymentWorkerResult = await uploadDeploymentWorker({
          get currentStep() {
            return currentStep!;
          },
          set currentStep(value: string) {
            currentStep = value;
          },
          markPhase,
          manifest,
          emit,
          context,
          projectId,
          project,
          deployment,
          assetCount,
          deployedAssetCount,
          dispatchNamespace,
          workerName,
          assetManifest,
          logger,
          assetsByHash,
          incomingAssetManifest,
          get wfpMirroredManifestDeploymentId() {
            return wfpMirroredManifestDeploymentId!;
          },
          set wfpMirroredManifestDeploymentId(value: string | null) {
            wfpMirroredManifestDeploymentId = value;
          },
          workerFiles,
          get sandboxControllerAttempted() {
            return sandboxControllerAttempted!;
          },
          set sandboxControllerAttempted(value: boolean) {
            sandboxControllerAttempted = value;
          },
          owner,
          get workerUploadUrl() {
            return workerUploadUrl!;
          },
          set workerUploadUrl(value: string | undefined) {
            workerUploadUrl = value;
          },
          get workerUploaded() {
            return workerUploaded!;
          },
          set workerUploaded(value: boolean) {
            workerUploaded = value;
          },
          deadline: execution?.deadline,
        });
        const workerBindings = uploadDeploymentWorkerResult.workerBindings;
        const assetConfig = uploadDeploymentWorkerResult.assetConfig;

        // Migrations
        const migrateDeploymentWorkerResult = await migrateDeploymentWorker({
          manifest,
          get currentStep() {
            return currentStep!;
          },
          set currentStep(value: string) {
            currentStep = value;
          },
          markPhase,
          logger,
          get currentStatus() {
            return currentStatus!;
          },
          set currentStatus(value: DeploymentStatus) {
            currentStatus = value;
          },
          cutoverProtected,
          context,
          deployment,
          projectId,
          emit,
          workerBindings,
          workerName,
          actor,
        });
        const migrationsApplied = migrateDeploymentWorkerResult.migrationsApplied;

        // Queue setup is the first authoritative external mutation for a
        // Worker deploy. Persist a protected intent before it so no reaper can
        // terminalize a request whose queue/routing cutover may have landed.
        await publishWorkerDeployment({
          get currentStep() {
            return currentStep!;
          },
          set currentStep(value: string) {
            currentStep = value;
          },
          projectId,
          cutoverOwnerId,
          deployBuild,
          context,
          deployment,
          get cutoverProtected() {
            return cutoverProtected!;
          },
          set cutoverProtected(value: boolean) {
            cutoverProtected = value;
          },
          get currentStatus() {
            return currentStatus!;
          },
          set currentStatus(value: DeploymentStatus) {
            currentStatus = value;
          },
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
          get logger() {
            return logger!;
          },
          set logger(value: DeployLogger) {
            logger = value;
          },
          project,
          snapshotCronState,
          assetCount,
          deployedAssetCount,
          assetConfig,
          get routingSwitched() {
            return routingSwitched!;
          },
          set routingSwitched(value: boolean) {
            routingSwitched = value;
          },
          get cronSchedulerWriteAttempted() {
            return cronSchedulerWriteAttempted!;
          },
          set cronSchedulerWriteAttempted(value: boolean) {
            cronSchedulerWriteAttempted = value;
          },
          actor,
          get cutoverCommitted() {
            return cutoverCommitted!;
          },
          set cutoverCommitted(value: boolean) {
            cutoverCommitted = value;
          },
          planLimits,
          assetManifest,
          dispatchNamespace,
          deleteAssetHashesWithProjectFence,
          evictStoredWorkerBundle,
          get orphanSweepAfterResponse() {
            return orphanSweepAfterResponse!;
          },
          set orphanSweepAfterResponse(value: (() => Promise<void>) | null) {
            orphanSweepAfterResponse = value;
          },
          sweepAssetOrphansWithProjectFence,
          projectDomains,
          workerFiles,
          migrationsApplied,
          finishOrphanSweep,
          deadline: execution?.deadline,
        });
      } catch (err) {
        return await recoverFailedDeployment({
          err,
          logger,
          workerName,
          currentStep,
          routingSwitched,
          workerUploaded,
          get wfpMirroredManifestDeploymentId() {
            return wfpMirroredManifestDeploymentId!;
          },
          set wfpMirroredManifestDeploymentId(value: string | null) {
            wfpMirroredManifestDeploymentId = value;
          },
          context,
          deployment,
          manifest,
          dispatchNamespace,
          cutoverCommitted,
          projectId,
          cutoverOwnerId,
          cutoverProtected,
          writtenRoutingKeys,
          get currentStatus() {
            return currentStatus!;
          },
          set currentStatus(value: DeploymentStatus) {
            currentStatus = value;
          },
          emit,
          restoreTrackedQueueConsumers,
          restoreTrackedRouting,
          restoreTrackedCronState,
          workerUploadUrl,
          sandboxControllerAttempted,
          project,
          owner,
        });
      }
    } catch (err) {
      logger.error('catch', 'unhandled_pipeline_error', err, { currentPhase: currentStep });
      emit({
        event: 'error',
        message: 'deploy failed due to an internal error',
        step: currentStep,
      });
    } finally {
      clearInterval(heartbeat);
      // Reap the placeholder deployment row if it never advanced past the
      // initial 'pending' + null-manifest state. A row stuck at 'pending'
      // with a manifest set is the bug class we want surfaced.
      //
      // A `canceling` placeholder means a `cancelDeployment` API call
      // raced an early-return path (asset-verify failure, quota check,
      // etc.) AFTER the precheck-and-claim insert but BEFORE the manifest
      // update. The two-phase cancellation flip sets status='canceling'
      // but the pipeline's catch never reached a force-finalize path.
      // DELETE alongside `pending` placeholders — both represent no real
      // deploy attempt (manifest is still null).
      try {
        const latest = await getDeployment(context.get('db'), preDeployment.id);
        if (
          latest &&
          (latest.status === 'pending' || latest.status === 'canceling') &&
          latest.manifest === null
        ) {
          await context.get('db').delete(deployments).where(eq(deployments.id, preDeployment.id));
          logger.info('placeholder_reap', 'placeholder_deleted', {
            placeholderId: preDeployment.id,
            priorStatus: latest.status,
          });
        } else if (latest && latest.status === 'pending' && latest.manifest !== null) {
          logger.warn('placeholder_reap', 'stranded_pending_row', {
            placeholderId: preDeployment.id,
            latestStatus: latest.status,
            hasManifest: latest.manifest !== null,
          });
        }
      } catch (err) {
        logger.warn('placeholder_reap', 'reap_failed', {
          placeholderId: preDeployment.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      if (input.releaseWorkerInput) {
        // Before the stream closes: closing the response can end the request.
        await input.releaseWorkerInput().catch((err) =>
          logger.warn('worker_input', 'delete_failed', {
            err: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      await persistedEvents;
      streamOpen = false;
      try {
        if (!execution) {
          await writer.close();
        }
      } catch {
        // ignore
      }
    }
  })();

  if (execution) {
    await pipeline;
    if (terminalEvent) {
      await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const candidate = await getDeployment(tx, preDeployment.id);
        const event = terminalEvent!;
        if (event.event === 'done') {
          const completed = await getDeployment(tx, event.deployment);
          if (completed?.status === 'live') {
            await appendDeploymentEvent(tx, preDeployment.id, cutoverOwnerId, event);
          }
        } else if (
          event.event === 'error' &&
          (!candidate || candidate.status === 'failed' || candidate.status === 'canceled')
        ) {
          await appendDeploymentEvent(tx, preDeployment.id, cutoverOwnerId, event);
        }
        // An unresolved cutover/compensation is still an owned operation. The
        // Queue outbox reconciles it after the invocation's hard lifetime.
      });
    }
    return new Response(null, { status: 204 });
  }
  void pipeline;
  return new Response(readable, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}
