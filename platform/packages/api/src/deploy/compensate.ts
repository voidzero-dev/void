import { platformProjectHostname, readPlatformApplication } from '@void/platform';
import { sql as drizzleSql } from 'drizzle-orm';
import { type Context } from 'hono';
import { deleteDispatchScript } from '../cf-api.ts';
import {
  getProject,
  getDeployment,
  updateDeploymentStatus,
  beginDeploymentCompensation,
  updateProjectType,
  getDomainsByProjectId,
  setActiveDeployment,
  markDeploymentRetained,
  CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES,
  TERMINAL_DEPLOYMENT_STATUSES,
} from '../db.ts';
import { sendDeployFailedEmail } from '../email.ts';
import type { ApiEnv } from '../env.ts';
import { createIsrStore } from '../isr-store.ts';
import { type DeployLogger } from '../observability/logger.ts';
import { ProjectAccessDeniedError } from '../project-access.ts';
import { reconcileManagedDurableObjects } from '../provisioning/durable-objects.ts';
import { deleteSandboxController } from '../provisioning/sandbox-controller.ts';
import { projectRouteKey } from '../routing.ts';
import {
  type DeployManifest,
  type DeployEvent,
  type Deployment,
  type Project,
  type DeploymentStatus,
} from '../types.ts';
import {
  resolveProjectZeroTrustRoutingForPublication,
  withProjectZeroTrustRouting,
} from '../zero-trust/routing.ts';
import { clearIsrCache } from './cache.ts';
import { PROJECT_DELETING_ERROR_MESSAGE, SUPERSEDED_BUILD_ERROR_MESSAGE } from './guards.ts';
import {
  cutoverIntentKey,
  cutoverReadyKey,
  cutoverCompensatedKey,
  parseCutoverMarker,
  replayDeploymentCutover,
  clearProjectExternalState,
  reconcileProjectDomainRoutes,
} from './recovery.ts';
import { StaticAssetDisappearedError } from './serving-assets.ts';
import { sanitizeDeployErrorMessage } from './shared.ts';

export async function recoverFailedDeployment(input: {
  readonly err: unknown;
  readonly logger: DeployLogger;
  readonly workerName: string | undefined;
  readonly currentStep: string;
  readonly routingSwitched: boolean;
  readonly workerUploaded: boolean;
  wfpMirroredManifestDeploymentId: string | null;
  readonly context: Context<ApiEnv>;
  readonly deployment: Deployment | undefined;
  readonly manifest: DeployManifest | undefined;
  readonly dispatchNamespace: string | undefined;
  readonly cutoverCommitted: boolean;
  readonly projectId: string;
  readonly cutoverOwnerId: string;
  readonly cutoverProtected: boolean;
  readonly writtenRoutingKeys: Array<string>;
  currentStatus: DeploymentStatus;
  readonly emit: (event: DeployEvent) => void;
  readonly restoreTrackedQueueConsumers: () => Promise<void>;
  readonly restoreTrackedRouting: () => Promise<void>;
  readonly restoreTrackedCronState: () => Promise<void>;
  readonly workerUploadUrl: string | undefined;
  readonly sandboxControllerAttempted: boolean;
  readonly project: Project;
  readonly owner: ApiEnv['Variables']['user'];
}): Promise<void> {
  const {
    err,
    logger,
    workerName,
    currentStep,
    routingSwitched,
    workerUploaded,
    context,
    deployment,
    manifest,
    dispatchNamespace,
    cutoverCommitted,
    projectId,
    cutoverOwnerId,
    cutoverProtected,
    writtenRoutingKeys,
    emit,
    restoreTrackedQueueConsumers,
    restoreTrackedRouting,
    restoreTrackedCronState,
    workerUploadUrl,
    sandboxControllerAttempted,
    project,
    owner,
  } = input;

  const raw =
    err instanceof ProjectAccessDeniedError
      ? err.userMessage
      : err instanceof Error
        ? err.message
        : String(err);
  const msg = sanitizeDeployErrorMessage(raw);
  if (msg !== raw) {
    logger.error('catch', 'raw_error_before_sanitization', err, {
      workerName: workerName,
      currentPhase: currentStep,
    });
  }
  logger.error('catch', 'pipeline_error', err, {
    currentPhase: currentStep,
    routingSwitched: routingSwitched,
    workerUploaded: workerUploaded,
  });

  // Evict the WfP mirror manifest on pre-routing failure.
  if (!routingSwitched && input.wfpMirroredManifestDeploymentId) {
    const id = input.wfpMirroredManifestDeploymentId;
    input.wfpMirroredManifestDeploymentId = null;
    await context.env.ROUTING.delete(`manifest:${id}`).catch((e) =>
      logger.warn('catch', 'mirrored_manifest_evict_failed', {
        deploymentId: id,
        err: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  const failedDeployment = deployment!;
  const failedManifest = manifest!;
  const failedWorkerName = workerName!;
  const failedDispatchNamespace = dispatchNamespace!;

  const cleanupSandboxController = async (): Promise<void> => {
    if (sandboxControllerAttempted && deployment && manifest?.sandbox) {
      await deleteSandboxController(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        projectId,
        deployment.id,
        manifest.sandbox,
        context.env.SANDBOX_CONCURRENCY_COUNTER,
        context.get('db'),
      ).catch((error) =>
        logger.error('catch', 'sandbox_controller_cleanup_failed', error, {
          deploymentId: deployment?.id,
        }),
      );
    }
  };
  const emitSlugDone = (): void => {
    const slugUrl = `https://${platformProjectHostname(project, readPlatformApplication(context.env))}`;
    emit({
      event: 'done',
      deployment: failedDeployment.id,
      url: slugUrl,
      urls: [slugUrl],
      assets: 0,
      workers: 0,
    });
  };

  // A connection can fail after PostgreSQL has committed the go-live
  // transaction but before the client receives COMMIT's acknowledgement.
  // Before undoing any external state, reconcile that ambiguous outcome
  // from the durable deployment row. A readable non-live row after three
  // checks proves the callback did not commit. A live row proves it did,
  // even when a newer deploy/rollback has since changed project.active.
  // If PostgreSQL remains unreadable, preserve external state: leaking a
  // version temporarily is recoverable, deleting a possibly-live Worker
  // and restoring stale tenant routing is not.
  const supersededBuild = raw === SUPERSEDED_BUILD_ERROR_MESSAGE;
  const teardownRaceLost = routingSwitched && raw === PROJECT_DELETING_ERROR_MESSAGE;
  const deploymentCanceled = raw === 'deployment canceled';
  const staticAssetsMissing = err instanceof StaticAssetDisappearedError;
  let ambiguousCutoverOutcome:
    | 'committed'
    | 'pending_reconcile'
    | 'not_committed'
    | 'unknown'
    | undefined;
  if (
    routingSwitched &&
    !cutoverCommitted &&
    currentStep === 'db_finalize' &&
    !supersededBuild &&
    !teardownRaceLost &&
    !deploymentCanceled &&
    !staticAssetsMissing
  ) {
    let durableReadSucceeded = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const latest = await getDeployment(context.get('db'), failedDeployment.id);
        durableReadSucceeded = true;
        if (latest?.status === 'live') {
          ambiguousCutoverOutcome = 'committed';
          break;
        }
        if (latest?.status === 'cutover') {
          ambiguousCutoverOutcome = 'pending_reconcile';
          break;
        }
      } catch (readError) {
        logger.warn('catch', 'cutover_outcome_read_failed', {
          deploymentId: failedDeployment.id,
          attempt: attempt + 1,
          err: readError instanceof Error ? readError.message : String(readError),
        });
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
    ambiguousCutoverOutcome ??= durableReadSucceeded ? 'not_committed' : 'unknown';
    logger.warn('catch', 'cutover_outcome_reconciled', {
      deploymentId: failedDeployment.id,
      outcome: ambiguousCutoverOutcome,
    });
  }
  let readyMarkerConfirmed: boolean | undefined;
  if (ambiguousCutoverOutcome === 'pending_reconcile') {
    try {
      const ready = parseCutoverMarker(
        await context.env.ROUTING.get(cutoverReadyKey(failedDeployment.id)),
      );
      readyMarkerConfirmed = ready?.projectId === projectId && ready.ownerId === cutoverOwnerId;
    } catch {
      // An unreadable marker leaves the protected intent fenced. A
      // later deploy can retry this proof under the project lock.
    }
  }
  const preserveAmbiguousCutover =
    ambiguousCutoverOutcome === 'committed' ||
    (ambiguousCutoverOutcome === 'pending_reconcile' && readyMarkerConfirmed !== false) ||
    ambiguousCutoverOutcome === 'unknown';

  // SUPERSEDED is thrown only inside the go-live tx (by
  // `assertBoundBuildStillActive`), so the message alone identifies it.
  // A teardown race is PROJECT_DELETING thrown AFTER routing was switched
  // (the in-tx delete re-check). Both abort the go-live: roll back the
  // routing keys this attempt wrote and tear down the worker/bundle/
  // container state, then mark the deployment failed (never live).
  const cutoverFailed = cutoverProtected && !cutoverCommitted && !preserveAmbiguousCutover;
  if (teardownRaceLost || supersededBuild || cutoverFailed) {
    const failureEvent = supersededBuild
      ? 'superseded_build'
      : teardownRaceLost
        ? 'teardown_race_lost'
        : 'cutover_failed';
    logger.error('catch', failureEvent, err, {
      workerName: failedWorkerName,
      writtenRoutingKeyCount: writtenRoutingKeys.length,
    });

    // Once a protected cutover intent exists, claim an explicit
    // compensation state under the project lock before undoing or
    // deleting anything. A concurrent recovery that already published
    // this deployment makes the conditional claim fail, in which case
    // this stale request must not touch its external state or artifacts.
    const needsProtectedClaim = !teardownRaceLost && input.currentStatus === 'cutover';
    if (needsProtectedClaim) {
      const claimed = await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const intent = parseCutoverMarker(
          await context.env.ROUTING.get(cutoverIntentKey(failedDeployment.id)),
        );
        if (intent?.projectId !== projectId || intent.ownerId !== cutoverOwnerId) {
          return false;
        }
        return await beginDeploymentCompensation(tx, failedDeployment.id);
      });
      if (!claimed) {
        logger.warn('catch', 'cutover_compensation_claim_lost', {
          deploymentId: failedDeployment.id,
        });
        emit({ event: 'error', message: msg, step: currentStep });
        return;
      }
      input.currentStatus = 'compensating';
    }

    const compensationErrors: Array<unknown> = [];
    if (!cutoverCommitted) {
      await restoreTrackedQueueConsumers().catch((e) => {
        compensationErrors.push(e);
        logger.error('catch', 'queue_consumer_rollback_failed', e);
      });
    }
    await restoreTrackedRouting().catch((e) => {
      compensationErrors.push(e);
      logger.error('catch', 'routing_rollback_failed', e);
    });
    await restoreTrackedCronState().catch((e) => {
      compensationErrors.push(e);
      logger.error('catch', 'cron_rollback_failed', e);
    });

    // Snapshot compensation is best-effort per surface. Retry once when
    // one of those exact undos failed, then normalize the whole project
    // back to PostgreSQL's committed active deployment if exact restore
    // is still incomplete.
    if (needsProtectedClaim && compensationErrors.length > 0) {
      compensationErrors.length = 0;
      await restoreTrackedQueueConsumers().catch((error) => compensationErrors.push(error));
      await restoreTrackedRouting().catch((error) => compensationErrors.push(error));
      await restoreTrackedCronState().catch((error) => compensationErrors.push(error));
    }
    if (needsProtectedClaim) {
      await context.get('db').transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
        const lockedProject = await getProject(tx, projectId);
        if (!lockedProject || lockedProject.status === 'deleting') {
          return;
        }
        if (
          compensationErrors.length > 0 ||
          failedManifest.durableObjects ||
          currentStep === 'durable_objects'
        ) {
          const committedActive = lockedProject.active_deployment_id
            ? await getDeployment(tx, lockedProject.active_deployment_id)
            : null;
          if (committedActive) {
            await replayDeploymentCutover(
              context.env,
              tx,
              lockedProject,
              committedActive,
              lockedProject.type,
              { restoreCommitted: true },
            );
          } else {
            await clearProjectExternalState(context.env, tx, lockedProject);
          }
        } else {
          const committedActive = lockedProject.active_deployment_id
            ? await getDeployment(tx, lockedProject.active_deployment_id)
            : null;
          await reconcileManagedDurableObjects(
            context.env,
            tx,
            projectId,
            committedActive?.id ?? null,
            committedActive?.manifest ? JSON.parse(committedActive.manifest) : null,
          );
          if (!routingSwitched) {
            return;
          }
          // Exact undo succeeded, but a domain activation may have
          // committed after the earlier snapshot and copied this failed
          // deployment's slug route. Reconcile only domain keys to the
          // restored route; touching cron/queues here would regress
          // pre-routing failures that never changed those surfaces.
          const currentDomains = await getDomainsByProjectId(tx, projectId);
          const rawRouting = await context.env.ROUTING.get(projectRouteKey(lockedProject));
          const restoredRouting =
            rawRouting === null
              ? null
              : withProjectZeroTrustRouting(
                  rawRouting,
                  await resolveProjectZeroTrustRoutingForPublication(tx, projectId),
                  projectId,
                );
          await reconcileProjectDomainRoutes(context.env, currentDomains, restoredRouting);
        }
      });
    }
    if (workerUploaded && workerUploadUrl) {
      await fetch(workerUploadUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${context.env.CF_API_TOKEN}` },
      }).catch((e) =>
        logger.error('catch', 'orphan_worker_delete_failed', e, {
          workerName: failedWorkerName,
        }),
      );
    }
    await cleanupSandboxController();

    if (needsProtectedClaim) {
      const compensatedKey = cutoverCompensatedKey(failedDeployment.id);
      try {
        await context.env.ROUTING.put(compensatedKey, projectId);
      } catch (markerError) {
        const confirmed = await context.env.ROUTING.get(compensatedKey).catch(() => null);
        if (confirmed !== projectId) {
          throw markerError;
        }
      }
    }
    const latestAfterFailure = await getDeployment(context.get('db'), failedDeployment.id);
    const wasCanceled =
      latestAfterFailure !== null &&
      CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES.includes(latestAfterFailure.status);
    logger.info('status_transition', 'status_change', {
      deploymentId: failedDeployment.id,
      from: input.currentStatus,
      to: wasCanceled ? 'canceled' : 'failed',
      reason: failureEvent,
    });
    await updateDeploymentStatus(
      context.get('db'),
      failedDeployment.id,
      wasCanceled ? 'canceled' : 'failed',
      msg,
      wasCanceled ? { force: true } : undefined,
    ).catch(() => {});
    input.currentStatus = wasCanceled ? 'canceled' : 'failed';
    const terminal = await getDeployment(context.get('db'), failedDeployment.id).catch(() => null);
    if (terminal && TERMINAL_DEPLOYMENT_STATUSES.includes(terminal.status)) {
      await Promise.all([
        context.env.ROUTING.delete(cutoverIntentKey(failedDeployment.id)),
        context.env.ROUTING.delete(cutoverReadyKey(failedDeployment.id)),
        context.env.ROUTING.delete(cutoverCompensatedKey(failedDeployment.id)),
      ]).catch(() => {
        // Terminal PostgreSQL state makes stale markers harmless.
      });
    }
    emit({ event: 'error', message: msg, step: currentStep });
  } else if (preserveAmbiguousCutover) {
    logger.warn('catch', 'ambiguous_cutover_preserved', {
      deploymentId: failedDeployment.id,
      outcome: ambiguousCutoverOutcome,
    });
    if (ambiguousCutoverOutcome === 'committed') {
      input.currentStatus = 'live';
      await Promise.all([
        context.env.ROUTING.delete(cutoverIntentKey(failedDeployment.id)),
        context.env.ROUTING.delete(cutoverReadyKey(failedDeployment.id)),
      ]).catch(() => {
        // Stale markers are harmless once PostgreSQL is live.
      });
      emitSlugDone();
    } else {
      emit({ event: 'error', message: msg, step: currentStep });
    }
  } else if (routingSwitched) {
    logger.error('catch', 'post_routing_step_failed', err, {
      workerName: failedWorkerName,
      currentPhase: currentStep,
    });
    logger.info('status_transition', 'status_change', {
      deploymentId: failedDeployment.id,
      from: input.currentStatus,
      to: 'live',
      reason: 'post_routing_recovery',
    });
    await updateDeploymentStatus(context.get('db'), failedDeployment.id, 'live', undefined, {
      force: true,
    }).catch(() => {});
    input.currentStatus = 'live';
    await updateProjectType(
      context.get('db'),
      projectId,
      failedManifest.type ?? (failedManifest.framework ? 'framework' : 'void'),
    ).catch(() => {});
    await setActiveDeployment(context.get('db'), projectId, failedDeployment.id).catch(() => {});
    await markDeploymentRetained(context.get('db'), failedDeployment.id, true).catch(() => {});
    emitSlugDone();
  } else {
    const latest = await getDeployment(context.get('db'), failedDeployment.id);
    const wasCanceled =
      latest && CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES.includes(latest.status);
    await restoreTrackedRouting().catch((e) => logger.error('catch', 'routing_rollback_failed', e));
    await deleteDispatchScript(
      context.env.CF_ACCOUNT_ID,
      context.env.CF_API_TOKEN,
      failedDispatchNamespace,
      failedWorkerName,
    ).catch((e) =>
      logger.error('catch', 'worker_script_cleanup_failed', e, {
        workerName: failedWorkerName,
      }),
    );
    await cleanupSandboxController();
    await clearIsrCache(
      createIsrStore(context.env.STATIC_ASSETS_R2, context.env.ISR_CACHE),
      projectId,
      failedDeployment.id,
    ).catch((e) =>
      logger.error('catch', 'isr_cache_clear_failed', e, {
        deploymentId: failedDeployment.id,
      }),
    );
    logger.info('status_transition', 'status_change', {
      deploymentId: failedDeployment.id,
      from: input.currentStatus,
      to: wasCanceled ? 'canceled' : 'failed',
      reason: 'pre_routing_failure',
      wasCanceled,
    });
    if (!wasCanceled) {
      await updateDeploymentStatus(context.get('db'), failedDeployment.id, 'failed', msg);
      input.currentStatus = 'failed';
    } else {
      await updateDeploymentStatus(context.get('db'), failedDeployment.id, 'canceled', msg, {
        force: true,
      });
      input.currentStatus = 'canceled';
    }
    emit({ event: 'error', message: msg, step: currentStep });
    if (!wasCanceled && context.env.EMAIL && owner.email) {
      const notification = sendDeployFailedEmail(context.env, owner.email, project.slug, msg).catch(
        (err) =>
          logger.error('catch', 'failed_email_send_failed', err, {
            projectSlug: project.slug,
          }),
      );
      try {
        context.executionCtx.waitUntil(notification);
      } catch {
        await notification;
      }
    }
  }
}
