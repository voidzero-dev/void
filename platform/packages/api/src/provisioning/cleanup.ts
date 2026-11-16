import {
  sql as drizzleSql,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
} from 'drizzle-orm';
import { Context } from 'hono';
import { aiLoggingKey } from '../ai-logging-policy.ts';
import { deleteProjectAssets, deleteWorkerBundle } from '../assets.ts';
import { DEFAULT_DISPATCH_NAMESPACE } from '../constants.ts';
import { clearCronScheduler } from '../cron-scheduler-client.ts';
import {
  TERMINAL_DEPLOYMENT_STATUSES,
  type Db,
  deleteProjectCascade,
  cleanupJobsForResource,
  enqueueProjectCleanupJobs,
  deleteProjectEmailDestinations,
  getAllProjectDeployments,
  getActiveDeployment,
  getPendingDeploymentOperation,
  getDomainsByProjectId,
  getProject,
  getProjectResources,
  getUser,
  terminateBuildsForProject,
  type ProjectCleanupJobInput,
} from '../db.ts';
import { drainProjectEmailAdmissions } from '../email/admission.ts';
import { emailDomainRoutes, emailZoneConnections } from '../email/connection-schema.ts';
import { requestEmailDomainRemove, runEmailOperation } from '../email/connection-service.ts';
import { removeSharedEmailRecipients } from '../email/shared-recipient-service.ts';
import type { ApiEnv } from '../env.ts';
import { cancelContainerBuildDos } from '../github/cancel-builds.ts';
import { generateId } from '../id.ts';
import { getLegacyProjectWorkerName, getProjectDeploymentWorkerName } from '../naming.ts';
import { requireProjectCapability } from '../project-access.ts';
import { CLOSED_PROXY_TOKEN_STATE, proxyTokenStateKey } from '../proxy-token.ts';
import { projectRouteKey } from '../routing.ts';
import {
  deployments as deploymentsTable,
  projectCleanupJobs,
  projectOwnershipPeriods,
  projects as projectsTable,
} from '../schema.ts';
import { getCurrentBillingPeriodStart } from '../tiers.ts';
import type { Build, DeployManifest, Project, ProjectOwnershipPeriod, Resource } from '../types.ts';
import { cleanupProjectZeroTrust } from '../zero-trust/project.ts';
import {
  CloudflareApiError,
  deleteCustomHostname,
  deleteD1Database,
  deleteHyperdrive,
  deleteKVNamespace,
  deleteQueue,
  deleteR2Bucket,
} from './cloudflare-api.ts';
import {
  deleteContainerApplicationIdempotent,
  findContainerApplication,
  perDeployContainerApplicationName,
} from './containers.ts';
import { deleteManagedDurableObject } from './durable-objects.ts';
import { runEmailDestinationCleanup } from './email-destination-cleanup.ts';
import { deleteSandboxController, isManagedSandbox } from './sandbox-controller.ts';

function deleteCloudflareResource(
  accountId: string,
  apiToken: string,
  resource: Pick<Resource, 'type' | 'cf_id'>,
): Promise<void> {
  const resourceType = resource.type;

  switch (resourceType) {
    case 'd1':
      return deleteD1Database(accountId, apiToken, resource.cf_id);
    case 'kv':
      return deleteKVNamespace(accountId, apiToken, resource.cf_id);
    case 'r2':
      return deleteR2Bucket(accountId, apiToken, resource.cf_id);
    case 'queue':
      return deleteQueue(accountId, apiToken, resource.cf_id);
    case 'hyperdrive':
      return deleteHyperdrive(accountId, apiToken, resource.cf_id);
    case 'durable-object':
      throw new Error('Custom Durable Object deletion requires project ownership verification.');
    case 'container':
      return deleteContainerApplicationIdempotent(accountId, apiToken, resource.cf_id);
    default:
      resourceType satisfies never;
      throw new Error(`Unsupported resource type: ${resourceType}`);
  }
}

function cleanupJob(
  projectId: string,
  kind: ProjectCleanupJobInput['kind'],
  target: string,
  payload: Record<string, string>,
): ProjectCleanupJobInput {
  return { project_id: projectId, kind, target: `${kind}:${projectId}:${target}`, payload };
}

function jobValue(job: ProjectCleanupJobInput, key: string): string {
  const value = job.payload[key];
  if (!value) {
    throw new Error(`Project cleanup job ${job.target} is missing ${key}`);
  }
  return value;
}

async function ignoreMissingProviderObject(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return;
    }
    throw error;
  }
}

// Kinds the scheduled retry runner executes. Rows of any other kind stay in the
// table untouched, so a job kind added by a newer platform version survives a
// rollback and never fills the retry batch.
const RETRYABLE_CLEANUP_JOB_KINDS = [
  'cf-resource',
  'worker',
  'worker-bundle',
  'project-assets',
  'routing-key',
  'routing-put',
  'cron',
  'custom-hostname',
] as const satisfies ReadonlyArray<ProjectCleanupJobInput['kind']>;

async function executeCleanupJob(
  env: ApiEnv['Bindings'],
  job: ProjectCleanupJobInput,
): Promise<void> {
  switch (job.kind) {
    case 'cf-resource':
      if (job.payload.type === 'durable-object') {
        await deleteManagedDurableObject(env, job.project_id, {
          cf_id: jobValue(job, 'cfId'),
          binding_name: jobValue(job, 'className'),
          metadata: JSON.parse(jobValue(job, 'metadata')) as Record<string, unknown>,
        });
        return;
      }
      await ignoreMissingProviderObject(() =>
        deleteCloudflareResource(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, {
          type: jobValue(job, 'type') as Resource['type'],
          cf_id: jobValue(job, 'cfId'),
        }),
      );
      return;
    case 'worker': {
      const namespace = jobValue(job, 'namespace');
      const name = jobValue(job, 'name');
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${namespace}/scripts/${name}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
      );
      if (!response.ok && response.status !== 404) {
        throw new Error(`Worker delete returned HTTP ${response.status}: ${await response.text()}`);
      }
      void response.body?.cancel().catch(() => {});
      return;
    }
    case 'worker-bundle':
      await deleteWorkerBundle(
        env.STATIC_ASSETS_R2,
        jobValue(job, 'projectId'),
        jobValue(job, 'deploymentId'),
      );
      return;
    case 'project-assets':
      await deleteProjectAssets(env.STATIC_ASSETS_R2, jobValue(job, 'projectId'));
      return;
    case 'routing-key':
      await env.ROUTING.delete(jobValue(job, 'key'));
      return;
    case 'routing-put':
      await env.ROUTING.put(jobValue(job, 'key'), jobValue(job, 'value'));
      return;
    case 'cron':
      await clearCronScheduler(env, jobValue(job, 'projectId'));
      return;
    case 'custom-hostname':
      await ignoreMissingProviderObject(() =>
        deleteCustomHostname(
          jobValue(job, 'zoneId'),
          env.CF_API_TOKEN,
          jobValue(job, 'hostnameId'),
        ),
      );
      return;
    default:
      throw new Error(`unknown cleanup job kind: ${String((job as { kind: string }).kind)}`);
  }
}

async function runCleanupBatch(
  env: ApiEnv['Bindings'],
  jobs: ReadonlyArray<ProjectCleanupJobInput>,
): Promise<{ warnings: Array<string>; failed: Array<ProjectCleanupJobInput> }> {
  const warnings: Array<string> = [];
  const failed: Array<ProjectCleanupJobInput> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(5, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++]!;
        try {
          await executeCleanupJob(env, job);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Failed to delete ${job.target}: ${message}`);
          failed.push(job);
        }
      }
    }),
  );
  return { warnings, failed };
}

/**
 * Critical CF cleanup. These deletes MUST succeed before the DB cascade,
 * otherwise we orphan CF state with no DB pointer left for retry.
 *
 * Currently:
 *   - Container application(s) referenced by `resources` rows of type
 *     `container`.
 *   - Per-deploy container application orphans located by deterministic name
 *     (recovery for deploys whose container POST succeeded but whose resources
 *     UPSERT did not commit before the deploy rolled back).
 *
 * Throws on the first non-404 failure. The caller MUST NOT proceed to
 * `deleteProjectCascade` if this throws.
 */
async function cleanupCriticalResources(
  context: Context<ApiEnv>,
  projectId: string,
): Promise<void> {
  const resources = await getProjectResources(context.get('db'), projectId);
  for (const resource of resources) {
    if (resource.type !== 'container') {
      continue;
    }
    await deleteContainerApplicationIdempotent(
      context.env.CF_ACCOUNT_ID,
      context.env.CF_API_TOKEN,
      resource.cf_id,
    );
  }

  // Orphan-recovery fallback: a past `provisionPerDeployContainer` failure
  // could have left a CF container app behind without a corresponding
  // `resources` row (e.g. CF POST succeeded, DB UPSERT failed, deploy rolled
  // back). The primary loop above only catches container apps that have a
  // row; this fallback enumerates every deployment for the project, parses
  // its manifest, and locates per-deploy container orphans by deterministic
  // name (`perDeployContainerApplicationName`).
  //
  // Runs unconditionally because the failure mode this catches (resources
  // row missing) means we can't gate on resources presence without
  // defeating the recovery's purpose. Per-deployment GETs are cheap enough
  // to absorb on every teardown — and teardown is rare relative to deploy.
  //
  // Race-mitigation (full fix is project-level locking — see design-doc 0067):
  // an in-flight deploy whose container POST lands AFTER our first scan
  // would leak as an orphan once the DB cascade nulls its deployment row.
  // Run the scan TWICE with a short delay; the second pass catches any POST
  // that completed during the gap. `assertProjectNotDeleting` /
  // `assertDeploymentNotCanceled` checks in the deploy pipeline mean an
  // in-flight deploy aborts shortly after `lockAndMarkDeleting` flips the
  // status, so a 2s delay is comfortably longer than the worst-case
  // post-status-flip container POST tail.
  const alreadyDeletedCfIds = new Set(
    resources.filter((r) => r.type === 'container').map((r) => r.cf_id),
  );
  await sweepPerDeployContainerOrphans(context, projectId, alreadyDeletedCfIds);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await sweepPerDeployContainerOrphans(context, projectId, alreadyDeletedCfIds);
}

/**
 * Locate per-deploy container orphans by deterministic name and delete any
 * not already in `alreadyDeletedCfIds`. Mutates the set with each new id so
 * subsequent passes skip already-handled orphans.
 */
async function sweepPerDeployContainerOrphans(
  context: Context<ApiEnv>,
  projectId: string,
  alreadyDeletedCfIds: Set<string>,
): Promise<void> {
  const allDeployments = await getAllProjectDeployments(context.get('db'), projectId);
  for (const deployment of allDeployments) {
    const manifest = parseDeploymentManifest(deployment.manifest);
    if (!manifest?.sandbox) {
      continue;
    }
    if (isManagedSandbox(manifest)) {
      await deleteSandboxController(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        projectId,
        deployment.id,
        manifest.sandbox,
        context.env.SANDBOX_CONCURRENCY_COUNTER,
        context.get('db'),
      );
      continue;
    }
    const orphanName = perDeployContainerApplicationName(
      projectId,
      deployment.id,
      manifest.sandbox.containerName ?? 'void-sandbox',
    );
    const orphan = await findContainerApplication(
      context.env.CF_ACCOUNT_ID,
      context.env.CF_API_TOKEN,
      orphanName,
    );
    if (orphan && !alreadyDeletedCfIds.has(orphan.id)) {
      await deleteContainerApplicationIdempotent(
        context.env.CF_ACCOUNT_ID,
        context.env.CF_API_TOKEN,
        orphan.id,
      );
      alreadyDeletedCfIds.add(orphan.id);
    }
  }
}

/**
 * Best-effort manifest parse for orphan-recovery enumeration. Manifests are
 * stored as JSON-encoded text on `deployments.manifest`. Returns `null` for
 * absent or unparseable bodies so the caller can skip those rows.
 */
function parseDeploymentManifest(raw: string | null): DeployManifest | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as DeployManifest;
  } catch {
    return null;
  }
}

/**
 * Delete external resources and persist failed operations before the project
 * cascade. Names that another project can claim (the slug route, domain routes,
 * and legacy Worker name) must succeed first so a later retry cannot erase a
 * replacement project's state.
 */
async function cleanupBestEffortResources(
  context: Context<ApiEnv>,
  projectId: string,
  project: Pick<Project, 'slug'>,
): Promise<{ warnings: ReadonlyArray<string>; cleanedCfIds: ReadonlySet<string> }> {
  const warnings: Array<string> = [];
  const failedJobs: Array<ProjectCleanupJobInput> = [];
  const warn = (msg: string, job: ProjectCleanupJobInput) => (err: unknown) => {
    warnings.push(`${msg}: ${err instanceof Error ? err.message : String(err)}`);
    failedJobs.push(job);
  };
  // cf_ids whose CF object this sweep attempted to delete, so the post-cascade
  // race-window cleanup can skip them (it only needs the rows created AFTER the
  // snapshot below).
  const cleanedCfIds = new Set<string>();

  const [projectDeployments, resources, projectDomains] = await Promise.all([
    getAllProjectDeployments(context.get('db'), projectId),
    getProjectResources(context.get('db'), projectId),
    getDomainsByProjectId(context.get('db'), projectId),
  ]);

  const dispatchNamespace = context.env.DISPATCH_NAMESPACE ?? DEFAULT_DISPATCH_NAMESPACE;
  const workerNames = new Set([
    getLegacyProjectWorkerName(project.slug),
    ...projectDeployments.map((deployment) =>
      getProjectDeploymentWorkerName(project.slug, deployment.id),
    ),
  ]);

  // Delete user-facing worker scripts before queue resources so CF no longer
  // sees queue bindings in attached Workers.
  const workerResult = await runCleanupBatch(
    context.env,
    Array.from(workerNames, (workerName) =>
      cleanupJob(projectId, 'worker', `${dispatchNamespace}:${workerName}`, {
        namespace: dispatchNamespace,
        name: workerName,
      }),
    ),
  );
  warnings.push(...workerResult.warnings);
  failedJobs.push(...workerResult.failed);
  // The legacy script name is derived only from the reusable project slug.
  // Keep that slug reserved until its deletion succeeds; a later project with
  // the same slug must never be touched by this project's scheduled retry.
  if (
    workerResult.failed.some((job) => job.payload.name === getLegacyProjectWorkerName(project.slug))
  ) {
    throw new Error('Could not remove the legacy project Worker; retry project deletion.');
  }

  // Delete R2 worker bundle objects under `worker-bundles/{projectId}/{deploymentId}/...`
  // for every deployment. Without this, project teardown leaves these objects
  // permanently orphaned in STATIC_ASSETS_R2 (the cascade only drops DB rows).
  // `deleteWorkerBundle` is idempotent — listing returns no objects for deploys
  // that never stored a bundle, so we don't need to gate on `bundle_stored`.
  const bundleResult = await runCleanupBatch(
    context.env,
    projectDeployments.map((deployment) =>
      cleanupJob(projectId, 'worker-bundle', `${projectId}:${deployment.id}`, {
        projectId,
        deploymentId: deployment.id,
      }),
    ),
  );
  warnings.push(...bundleResult.warnings);
  failedJobs.push(...bundleResult.failed);

  // Delete R2 static-asset objects under `assets/{projectId}/...`. The retention
  // cleanup loop only walks hashes referenced by retained manifests, so any
  // bytes uploaded via the direct-to-R2 presigned PUTs that never landed in a
  // finalized deploy (TOCTOU race against teardown, abandoned upload, etc.)
  // are durable orphans without this sweep. Best-effort: failures here become
  // warnings — the surrounding teardown still cascades the DB rows.
  await deleteProjectAssets(context.env.STATIC_ASSETS_R2, projectId).catch(
    warn(
      `Failed to delete static assets for project ${projectId}`,
      cleanupJob(projectId, 'project-assets', projectId, { projectId }),
    ),
  );

  const cleanup: Array<ProjectCleanupJobInput> = [];

  // Best-effort CF resource cleanup (D1, KV, R2, Queue, Hyperdrive — user-
  // provisioned resources). Container resources were handled as critical above.
  for (const resource of resources) {
    if (resource.type === 'container') {
      continue;
    }
    cleanedCfIds.add(resource.cf_id);
    cleanup.push(
      ...cleanupJobsForResource(projectId, resource).filter((job) => job.kind === 'cf-resource'),
    );
  }

  // Clear cron scheduler DO unconditionally — /clear is idempotent
  // (deleteAll + deleteAlarm). KV `hasCrons` is omitted when false and
  // missing on older entries; the PG manifest is the authoritative source,
  // and unconditional clear avoids a stale-KV gate.
  cleanup.push(cleanupJob(projectId, 'cron', projectId, { projectId }));

  // KV routing entry
  cleanup.push(
    cleanupJob(projectId, 'routing-key', projectRouteKey(project), {
      key: projectRouteKey(project),
    }),
  );
  cleanup.push(
    cleanupJob(projectId, 'routing-key', `ai-block:${projectId}`, { key: `ai-block:${projectId}` }),
  );

  // Retire any account mirror left by the removed tenant-owned Sandbox proxy.
  cleanup.push(
    cleanupJob(projectId, 'routing-key', `project:${projectId}`, { key: `project:${projectId}` }),
  );
  // Proxy token accept floor: closed, not deleted. A missing floor accepts
  // the legacy token, so deleting it would revive every token ever issued.
  cleanup.push(
    cleanupJob(projectId, 'routing-put', proxyTokenStateKey(projectId), {
      key: proxyTokenStateKey(projectId),
      value: CLOSED_PROXY_TOKEN_STATE,
    }),
  );

  // Queue routing KV entries
  for (const q of resources.filter((r) => r.type === 'queue')) {
    cleanup.push(
      ...cleanupJobsForResource(projectId, q).filter((job) => job.kind === 'routing-key'),
    );
  }

  // Custom hostnames from CF + KV
  for (const domain of projectDomains) {
    cleanup.push(
      cleanupJob(
        projectId,
        'custom-hostname',
        `${context.env.CF_ZONE_ID}:${domain.cf_hostname_id}`,
        {
          zoneId: context.env.CF_ZONE_ID,
          hostnameId: domain.cf_hostname_id,
        },
      ),
      cleanupJob(projectId, 'routing-key', `domain:${domain.hostname}`, {
        key: `domain:${domain.hostname}`,
      }),
    );
  }

  const remaining = await runCleanupBatch(context.env, cleanup);
  warnings.push(...remaining.warnings);
  failedJobs.push(...remaining.failed);
  // Slug and custom-domain routing names can be claimed by another project
  // after cascade. A failed delete of either must keep the old project row and
  // its unique name reserved for a safe retry.
  if (
    remaining.failed.some(
      (job) =>
        job.kind === 'routing-key' &&
        (job.payload.key === projectRouteKey(project) || job.payload.key?.startsWith('domain:')),
    )
  ) {
    throw new Error('Could not remove project routing; retry project deletion.');
  }
  // The project and resource rows still exist here. If writing the retry
  // record fails, abort teardown rather than erase the only recovery handles.
  await enqueueProjectCleanupJobs(context.get('db'), failedJobs);
  return { warnings, cleanedCfIds };
}

/**
 * Acquire the project-row lock, flip status='deleting' (if not already), mark
 * every non-terminal deployment as 'canceling', and terminalize every in-flight
 * build. Returns the terminalized builds so the caller can stop their container
 * DOs. Idempotent for repeated teardown attempts.
 *
 * Holding the FOR UPDATE lock across the status flip + deployment cancellation
 * serializes with the deploy pipeline's atomic precheck-and-claim transaction,
 * which also locks the project row and checks status. Any in-flight deploy
 * that already passed its own status check will observe status='canceling' on
 * its NEXT `assertDeploymentNotCanceled` / `assertProjectNotDeleting` call
 * inside `routes/deploy.ts` and abort before issuing further CF mutations
 * (worker PUT, asset session, routing flip, etc.).
 *
 * Builds are terminalized HERE — at the very start of teardown, before any CF
 * cleanup — rather than only in `deleteProjectCascade` at the end. A build-scoped
 * deploy token is accepted while its bound build row is active
 * (`middleware/auth.ts`), so leaving builds active through the (multi-second) CF
 * cleanup window would let a still-live token keep hitting deploy-token
 * provisioning routes (e.g. POST /:id/database) and create CF resources the
 * cascade then orphans. The CAS in `terminateBuildsForProject` revokes each
 * token now; the caller stops the container DOs immediately after this commit.
 * The project FOR UPDATE lock is the one build-creation takes, so a racing
 * push/OIDC either committed before this lock (caught here) or serializes after
 * it (caught by `deleteProjectCascade`'s own terminate at the end).
 */
async function lockAndMarkDeleting(
  db: Db,
  projectId: string,
  actorUserId?: string,
  expectedOwnerUserId?: string,
): Promise<Readonly<{
  ownerUserId: string;
  ownerBillingCycleStart: string | null;
  ownershipStartedAt: string;
  ownershipEndedAt: string;
  cancelledBuilds: ReadonlyArray<{
    id: string;
    executor: Build['executor'];
    status: Build['status'];
    instance_type: string | null;
  }>;
}> | null> {
  return await db.transaction(async (tx) => {
    await tx.execute(drizzleSql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const lockedProject = await getProject(tx, projectId);
    if (!lockedProject) {
      throw new Error('project disappeared during deletion');
    }
    // User deletion discovers projects before teardown. Recheck ownership
    // under the lock shared with transfers before deleting anything.
    if (expectedOwnerUserId && lockedProject.user_id !== expectedOwnerUserId) {
      return null;
    }
    // The route precheck can go stale. Authorize again under the same lock as
    // the irreversible status transition. Operator cleanup has no actor here.
    if (actorUserId) {
      await requireProjectCapability(tx, projectId, actorUserId, 'delete');
    }
    const activeDeployment = await getActiveDeployment(tx, projectId);
    if (activeDeployment?.source === 'rollback-lease') {
      throw new ProjectOperationInProgressError();
    }
    if (await getPendingDeploymentOperation(tx, projectId)) {
      throw new ProjectOperationInProgressError(
        'Deployment execution is still settling. Cancel it or wait for its result, then retry project deletion.',
      );
    }
    const owner = await getUser(tx, lockedProject.user_id);
    if (!owner) {
      throw new Error('project owner disappeared during deletion');
    }
    const [openOwnership] = await tx
      .select()
      .from(projectOwnershipPeriods)
      .where(
        and(
          eq(projectOwnershipPeriods.project_id, projectId),
          isNull(projectOwnershipPeriods.ends_at),
        ),
      )
      .for('update')
      .limit(1);
    if (openOwnership && openOwnership.owner_user_id !== lockedProject.user_id) {
      throw new Error('project ownership history does not match the current owner');
    }
    const [latestClosedOwnership] = openOwnership
      ? []
      : await tx
          .select()
          .from(projectOwnershipPeriods)
          .where(
            and(
              eq(projectOwnershipPeriods.project_id, projectId),
              isNotNull(projectOwnershipPeriods.ends_at),
            ),
          )
          .orderBy(desc(projectOwnershipPeriods.ends_at))
          .for('update')
          .limit(1);
    let ownership: ProjectOwnershipPeriod | undefined;
    if (openOwnership) {
      [ownership] = await tx
        .update(projectOwnershipPeriods)
        .set({ ends_at: drizzleSql`clock_timestamp()` })
        .where(eq(projectOwnershipPeriods.id, openOwnership.id))
        .returning();
    } else if (
      lockedProject.status === 'deleting' &&
      latestClosedOwnership?.owner_user_id === lockedProject.user_id
    ) {
      // A previous teardown attempt may have stopped after detaching usage.
      // Extend its cutoff so the retry reconciles activity through this attempt.
      [ownership] = await tx
        .update(projectOwnershipPeriods)
        .set({
          ends_at: drizzleSql`greatest(${projectOwnershipPeriods.ends_at}, clock_timestamp())`,
        })
        .where(eq(projectOwnershipPeriods.id, latestClosedOwnership.id))
        .returning();
    } else {
      [ownership] = await tx
        .insert(projectOwnershipPeriods)
        .values({
          id: generateId('pown'),
          project_id: projectId,
          owner_user_id: lockedProject.user_id,
          starts_at: latestClosedOwnership?.ends_at ?? lockedProject.created_at,
          ends_at: drizzleSql`clock_timestamp()`,
        })
        .returning();
    }
    if (lockedProject.status !== 'deleting') {
      await tx
        .update(projectsTable)
        .set({ status: 'deleting' })
        .where(eq(projectsTable.id, projectId));
    }
    // Mark every non-terminal deployment as 'canceling' so the deploy
    // pipeline's `assertDeploymentNotCanceled` checks observe the cancellation
    // and abort before further CF mutations. We do this regardless of whether
    // the project status was already 'deleting' to cover replays where the
    // status flip succeeded but the deployment cancellation didn't commit
    // (e.g. earlier teardown crashed mid-tx).
    await tx
      .update(deploymentsTable)
      .set({
        status: 'canceling',
        updated_at: drizzleSql`now()`,
        error_message: drizzleSql`COALESCE(${deploymentsTable.error_message}, 'project deleted')`,
      })
      .where(
        and(
          eq(deploymentsTable.project_id, projectId),
          notInArray(deploymentsTable.status, TERMINAL_DEPLOYMENT_STATUSES),
        ),
      );
    // Revoke in-flight build deploy tokens up front (see doc above). Idempotent
    // on replay (already-terminal builds are not re-matched by the CAS).
    return {
      ownerUserId: lockedProject.user_id,
      ownerBillingCycleStart: owner.billing_cycle_start,
      ownershipStartedAt: ownership!.starts_at,
      ownershipEndedAt: ownership!.ends_at!,
      cancelledBuilds: await terminateBuildsForProject(tx, projectId, {
        reason: 'project deleted',
      }),
    };
  });
}

async function detachProjectUsage(
  context: Context<ApiEnv>,
  projectId: string,
  options: Readonly<{
    ownerUserId: string;
    ownerBillingCycleStart: string | null;
    ownershipStartedAt: string;
    ownershipEndedAt: string;
  }>,
): Promise<void> {
  const stub = context.env.USAGE_COUNTER.get(
    context.env.USAGE_COUNTER.idFromName(options.ownerUserId),
  );
  const response = await stub.fetch(
    new Request('https://do/detach-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        userId: options.ownerUserId,
        ...(options.ownerBillingCycleStart
          ? {
              billingPeriodStart: getCurrentBillingPeriodStart(
                options.ownerBillingCycleStart,
              ).toISOString(),
            }
          : {}),
        ownershipStartedAt: options.ownershipStartedAt,
        ownershipEndedAt: options.ownershipEndedAt,
      }),
    }),
  );
  if (!response.ok) {
    throw new Error(`UsageCounter /detach-project returned HTTP ${response.status}`);
  }
}

export class ProjectOperationInProgressError extends Error {
  constructor(message = 'project operation in progress') {
    super(message);
    this.name = 'ProjectOperationInProgressError';
  }
}

/**
 * Delete the CF object (and queue routing KV entry) behind any resource whose row
 * the cascade removed but whose cf_id the pre-cascade best-effort sweep did NOT
 * already handle. These are orphan-on-concurrent-create races: a provisioning
 * route (`POST/PUT /:id/database`) or a deploy (`provisionBindings`) that inserted
 * a `resources` row AFTER `cleanupBestEffortResources` took its one-time snapshot
 * but before the cascade — so the CF object was never deleted, yet its only
 * durable handle (the row) is now gone. `deleteProjectCascade` atomically writes
 * cleanup jobs for the COMPLETE set of missed resources before COMMIT (its FOR
 * UPDATE conflicts with the INSERT's FK FOR KEY SHARE), so failures remain
 * retryable. Containers are excluded — they have their own deterministic-name
 * double-sweep in `cleanupCriticalResources`. Failures become warnings backed by jobs. Normally a
 * no-op (no concurrent create → every row was in the snapshot). See design-doc 0067.
 */
async function cleanupRaceWindowResourceOrphans(
  context: Context<ApiEnv>,
  projectId: string,
  deletedResources: ReadonlyArray<Resource>,
  cleanedCfIds: ReadonlySet<string>,
): Promise<ReadonlyArray<string>> {
  const orphans = deletedResources.filter(
    (r) => r.type !== 'container' && !cleanedCfIds.has(r.cf_id),
  );
  const jobs = orphans.flatMap((resource) => cleanupJobsForResource(projectId, resource));
  const result = await runCleanupBatch(context.env, jobs);
  const failedTargets = new Set(result.failed.map((job) => job.target));
  const completedTargets = jobs
    .filter((job) => !failedTargets.has(job.target))
    .map((job) => job.target);
  if (completedTargets.length > 0) {
    await context
      .get('db')
      .delete(projectCleanupJobs)
      .where(inArray(projectCleanupJobs.target, completedTargets))
      .catch((error) => console.error('[project-cleanup] completed job delete failed:', error));
  }
  // Failed jobs were committed atomically with the project cascade and remain
  // in the ledger for scheduled retries after the project row is gone.
  return result.warnings;
}

/** Retry bounded remote cleanup work after a teardown attempt. */
export async function reconcileProjectCleanupJobs(db: Db, env: ApiEnv['Bindings']): Promise<void> {
  const due = await db
    .select()
    .from(projectCleanupJobs)
    .where(
      and(
        lte(projectCleanupJobs.next_attempt_at, drizzleSql`now()`),
        inArray(projectCleanupJobs.kind, [...RETRYABLE_CLEANUP_JOB_KINDS]),
      ),
    )
    .orderBy(asc(projectCleanupJobs.created_at), asc(projectCleanupJobs.target))
    .limit(50);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(5, due.length) }, async () => {
      while (next < due.length) {
        const job = due[next++]!;
        // A later invocation can observe the same due snapshot. Claim without
        // holding a database transaction open across provider I/O.
        const claimed = await db
          .update(projectCleanupJobs)
          .set({
            attempts: drizzleSql`${projectCleanupJobs.attempts} + 1`,
            next_attempt_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          })
          .where(
            and(
              eq(projectCleanupJobs.target, job.target),
              lte(projectCleanupJobs.next_attempt_at, drizzleSql`now()`),
            ),
          )
          .returning({ target: projectCleanupJobs.target });
        if (claimed.length === 0) {
          continue;
        }
        try {
          await executeCleanupJob(env, job);
          await db.delete(projectCleanupJobs).where(eq(projectCleanupJobs.target, job.target));
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error))
            .replaceAll(env.CF_API_TOKEN, '[redacted]')
            .slice(0, 500);
          await db
            .update(projectCleanupJobs)
            .set({ last_error: message })
            .where(eq(projectCleanupJobs.target, job.target));
          console.warn(`[project-cleanup] retry failed for ${job.target}: ${message}`);
        }
      }
    }),
  );
}

/**
 * Tear down a project end-to-end:
 *   1. Take FOR UPDATE on the project row, flip status='deleting' (if not
 *      already), mark all non-terminal deployments as 'canceling' so any
 *      in-flight deploy aborts before further CF mutations, and terminalize all
 *      in-flight builds (revoking their deploy tokens). Then stop the container
 *      DOs of those builds — BEFORE any CF cleanup runs, so a still-running build
 *      can't keep acting on its now-revoked token during the cleanup window.
 *   2. Run critical CF cleanup (container apps, per-deploy container orphan
 *      recovery). Throws on non-404 failure; the caller should surface a 5xx
 *      and the DB row remains, allowing retry.
 *   3. Delete CF resources (D1, KV, R2, queues, Hyperdrive, custom hostnames,
 *      routing entries, deployment Workers). Persist failed operations for
 *      scheduled retry; keep reusable names reserved if their deletion fails.
 *      Then delete the project's Zero Trust Access applications, whose
 *      handles exist only on the project row.
 *   4. Cascade-delete the project from the DB (terminalize any build that raced
 *      in after step 1 → domains → resources → secrets → builds → deployments →
 *      project), then best-effort stop the container DOs of any such late build
 *      and delete the CF object behind any resource that raced the step-3
 *      snapshot (a provisioning route / deploy that inserted a row after it).
 *      The cascade records those race-window cleanup jobs atomically.
 *
 * This is the ONLY caller of `cleanupCriticalResources`,
 * `cleanupBestEffortResources`, and `deleteProjectCascade` for the project-
 * teardown flow. Route handlers must use this helper instead of calling those
 * pieces directly so the lock + status flip + deployment/build cancellation
 * cannot be bypassed.
 */
export async function teardownProject(
  context: Context<ApiEnv>,
  projectId: string,
  project: Pick<Project, 'slug' | 'status'>,
  options: Readonly<{ actorUserId?: string; expectedOwnerUserId?: string }> = {},
): Promise<{ warnings: ReadonlyArray<string>; ownerChanged?: true }> {
  // Always run lock + mark — idempotent for `status='deleting'` (the helper
  // skips the flip and just (re-)marks any non-terminal deployments + builds).
  // This covers retried teardown after partial failure where the previous
  // attempt crashed before the cancellations committed.
  const deletion = await lockAndMarkDeleting(
    context.get('db'),
    projectId,
    options.actorUserId,
    options.expectedOwnerUserId,
  );
  if (deletion === null) {
    return { warnings: [], ownerChanged: true };
  }
  // Stop the container DOs for the builds revoked above BEFORE any CF cleanup
  // begins (post-commit, never under the row lock — it's a DO round-trip), so
  // their tokens are dead and their containers stopped before we touch CF.
  await cancelContainerBuildDos(context.env, deletion.cancelledBuilds, 'project deleted');

  // Detach after the durable status change and before cleanup so a failed DO
  // call leaves the project row available for retry.
  await detachProjectUsage(context, projectId, deletion);

  const emailDrain = await drainProjectEmailAdmissions(context.get('db'), projectId);
  if (emailDrain.inFlight > 0) {
    throw new ProjectOperationInProgressError(
      `${emailDrain.inFlight} email provider attempt(s) have unresolved outcomes`,
    );
  }

  await cleanupCriticalResources(context, projectId);
  await removeSharedEmailRecipients(context.get('db'), context.env, projectId);
  // Customer-side cleanup is durable and may continue after project deletion.
  await cleanupProjectEmailAssignments(context, projectId);
  const { warnings: bestEffortWarnings, cleanedCfIds } = await cleanupBestEffortResources(
    context,
    projectId,
    project,
  );
  // MUST run before `deleteProjectCascade`: the cascade destroys the
  // `email_destinations` rows the cross-project reference count is computed
  // from, so afterwards there is no way to tell whether an account-level CF
  // destination is still in use — the orphan becomes unrecoverable. Lives
  // here rather than in `routes/delete.ts` so the two admin teardown paths
  // (admin project delete, admin user delete) get it too.
  await cleanupProjectEmailDestinations(context, projectId);
  // Access application IDs live only on the project row, so deletion must
  // succeed before the cascade. It runs after every retryable step above: a
  // retried teardown must never leave a routed public project without its
  // bypass or a protected one without its exact application.
  await cleanupProjectZeroTrust(context.env, context.get('db'), projectId);
  // deleteProjectCascade re-terminalizes under the project lock to catch a build
  // that raced in after step 1 committed (build creation takes the same lock),
  // and returns both that build and every resource row it deleted.
  const { cancelledBuilds, deletedResources } = await deleteProjectCascade(
    context.get('db'),
    projectId,
    cleanedCfIds,
  );
  await cancelContainerBuildDos(context.env, cancelledBuilds, 'project deleted');
  // Close the orphan-on-concurrent-create window: delete the CF object behind any
  // resource whose row was created AFTER the best-effort snapshot above (so its
  // cf_id isn't in `cleanedCfIds`) and just cascade-deleted. Normally empty.
  const orphanWarnings = await cleanupRaceWindowResourceOrphans(
    context,
    projectId,
    deletedResources,
    cleanedCfIds,
  );
  // The AI logging key goes only once the row is gone. Until then a token can still
  // pass the live owner check, and a missing key means the gateway setting, so an
  // earlier removal would log prompts of a project set to `off` while teardown
  // runs or waits for a retry. A failed delete leaves an orphan key; the hourly
  // sweep removes it.
  const aiLogging = await runCleanupBatch(context.env, [
    cleanupJob(projectId, 'routing-key', aiLoggingKey(projectId), { key: aiLoggingKey(projectId) }),
  ]);
  return { warnings: [...bestEffortWarnings, ...orphanWarnings, ...aiLogging.warnings] };
}

/** Renewal and this expiry claim both serialize on the project row. */
export async function reapExpiredPreviews(db: Db, env: ApiEnv['Bindings']): Promise<void> {
  const candidates = await db
    .select()
    .from(projectsTable)
    .where(
      and(
        isNotNull(projectsTable.preview_client_id),
        lte(projectsTable.preview_expires_at, drizzleSql`now()`),
      ),
    )
    .limit(3);
  for (const project of candidates) {
    const claimed = await db
      .update(projectsTable)
      .set({ status: 'deleting' })
      .where(
        and(
          eq(projectsTable.id, project.id),
          lte(projectsTable.preview_expires_at, drizzleSql`now()`),
        ),
      )
      .returning();
    if (!claimed.length) {
      continue;
    }
    const context = new Context<ApiEnv>(new Request('https://preview.invalid/'), { env });
    context.set('db', db);
    try {
      await teardownProject(context, project.id, project);
    } catch (error) {
      console.error('[preview] teardown will retry', { projectId: project.id, error });
    }
  }
}

/** Revoke project consent and hand last-reference tags to durable cleanup. */
async function cleanupProjectEmailDestinations(
  context: Context<ApiEnv>,
  projectId: string,
): Promise<void> {
  const db = context.get('db');
  const tags = await deleteProjectEmailDestinations(db, projectId);
  for (const tag of tags) {
    await runEmailDestinationCleanup(
      db,
      { accountId: context.env.CF_ACCOUNT_ID, apiToken: context.env.CF_API_TOKEN },
      tag,
    );
  }
}

/** Disable project email assignments and record durable provider cleanup. */
async function cleanupProjectEmailAssignments(
  context: Context<ApiEnv>,
  projectId: string,
): Promise<void> {
  const db = context.get('db');
  // New connection-backed assignments are independent of project cascade.
  // Disable authority first; provider cleanup remains in the operation ledger
  // even if project teardown later removes its owning row.
  const assignments = await db
    .select()
    .from(emailDomainRoutes)
    .where(eq(emailDomainRoutes.project_id, projectId));
  for (const assignment of assignments) {
    if (assignment.desired_state === 'removed') {
      // An administrator may remove an owner-managed assignment while leaving
      // its connection resources for the manager. Project teardown inherits
      // cleanup authority, but only after the last live sibling is gone.
      const [connection] = await db
        .select({ id: emailZoneConnections.id, credentialId: emailZoneConnections.credential_id })
        .from(emailZoneConnections)
        .where(eq(emailZoneConnections.id, assignment.connection_id))
        .limit(1);
      if (!connection?.credentialId) {
        continue;
      }
      const [sibling] = await db
        .select({ id: emailDomainRoutes.id })
        .from(emailDomainRoutes)
        .where(
          and(
            eq(emailDomainRoutes.connection_id, connection.id),
            ne(emailDomainRoutes.id, assignment.id),
            ne(emailDomainRoutes.desired_state, 'removed'),
          ),
        )
        .limit(1);
      if (sibling) {
        continue;
      }
    }
    // The durable intent must exist before the project can cascade away.
    // A provider failure after that point is safe to reconcile later.
    const opId = await requestEmailDomainRemove(
      db,
      context.env,
      assignment.id,
      { kind: 'system' },
      `teardown:${projectId}:${assignment.id}`,
      projectId,
    );
    if (!opId) {
      continue;
    }
    try {
      await runEmailOperation(db, context.env, opId);
    } catch (error) {
      // The disabled assignment and connection survive project deletion; the
      // scheduled reconciler or operator can inspect and resume the cleanup.
      console.error(
        '[email] project teardown left pending connection cleanup',
        assignment.id,
        error,
      );
    }
  }
}
