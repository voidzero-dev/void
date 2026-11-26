/**
 * The scan outbox (spec §6.1, §7.2): the go-live transaction writes the scan row, and
 * `finishSecurityScanEnqueue` copies inputs and queues it after the commit. Never blocks,
 * slows or fails a deploy (D45): the in-transaction part runs in a savepoint, the
 * after-commit part never throws.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { paginatedR2Delete } from '../assets.ts';
import { getPlatformCapabilities } from '../capabilities.ts';
import type { Db, DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { deploymentOperations, deployments, projects, projectZeroTrust, users } from '../schema.ts';
import { withKnownLength } from '../worker-upload.ts';
import type { WorkerModule } from '../worker-upload.ts';
import { errorMessage } from '../zero-trust/errors.ts';
import { installationZeroTrustProtects, readSecurityPolicyLenient } from './policy.ts';
import {
  readSecurityProjectPolicyOverride,
  SECURITY_PROJECT_POLICY_SKIP_REASON,
} from './project-policy.ts';
import {
  SECURITY_PUBLIC_REQUEST_OPEN_STATES,
  securityPublicRequests,
  securityScans,
} from './schema.ts';
import type { SecurityScanTrigger } from './schema.ts';

/**
 * Scans in these states hold the staged deploy input `input_prefix` names; a running one
 * until `input/prepare.ts` copies it at start.
 */
const INPUT_HOLD_STATUSES = ['pending_input', 'queued', 'running'] as const;

/**
 * The row still holds its staged deploy input: it waits or runs, or it is the scan of an
 * open public request's live deployment (its own gate scan, or a deploy scan the request
 * took over), so asking again can scan it (spec §7.2).
 */
export function securityScanHoldsInputSql(): SQL {
  const open = sql.join(
    SECURITY_PUBLIC_REQUEST_OPEN_STATES.map((state) => sql`${state}`),
    sql`, `,
  );
  return sql`(${inArray(securityScans.status, [...INPUT_HOLD_STATUSES])} OR EXISTS (SELECT 1 FROM security_public_requests r WHERE (r.id = ${securityScans.public_request_id} OR r.gate_scan_id = ${securityScans.id}) AND r.target_deployment_id = ${securityScans.deployment_id} AND r.state IN (${open})))`;
}

/** Inline modules copied after the commit: at most this many bytes, in 30 s. */
export const SECURITY_SCAN_COPY_MAX_BYTES = 50 * 1024 * 1024;
const COPY_TIMEOUT_MS = 30_000;

export function securityScanInputPrefix(projectId: string, deploymentId: string): string {
  return `security-scans/${projectId}/${deploymentId}/`;
}

export function securityScanProjectPrefix(projectId: string): string {
  return `security-scans/${projectId}/`;
}

/** What the commit wrote; handed to `finishSecurityScanEnqueue` after it. */
export type SecurityScanEnqueued = Readonly<{
  scanId: string;
  projectId: string;
  deploymentId: string;
  /** `skipped` = `skipped:protected`, or `skipped:project_policy` (M34 `never`). */
  status: 'pending_input' | 'skipped';
  trigger: SecurityScanTrigger;
  inputPrefix: string | null;
}>;

type EnqueueEnv = Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES'>;

/** The `securityAudits` capability; unreadable capabilities count as off. */
export function securityAuditsOn(env: EnqueueEnv): boolean {
  try {
    return getPlatformCapabilities(env).securityAudits;
  } catch {
    return false;
  }
}

/** The singleton `SecurityScanScheduler` stub. */
export function securityScheduler(env: Pick<ApiEnv['Bindings'], 'SECURITY_SCAN_SCHEDULER'>) {
  return env.SECURITY_SCAN_SCHEDULER.get(env.SECURITY_SCAN_SCHEDULER.idFromName('global'));
}

/** Runs `run`, logging instead of throwing. */
export async function securityBestEffort<T>(
  what: string,
  scanId: string,
  run: () => Promise<T>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.warn(`[security-scan] ${what} failed`, { scanId, error: errorMessage(error) });
  }
}

/**
 * Writes the scan row for a deployment that just went live, in the transaction that sets
 * the active deployment, under the project row lock. `null` when no row is written.
 */
export async function enqueueSecurityScanInTx(
  tx: DbOrTx,
  env: EnqueueEnv,
  input: Readonly<{
    projectId: string;
    deploymentId: string;
    trigger: Extract<SecurityScanTrigger, 'deploy' | 'recovery'>;
  }>,
): Promise<SecurityScanEnqueued | null> {
  if (!securityAuditsOn(env)) {
    return null;
  }
  try {
    // A savepoint: a failed statement must not abort the deploy's transaction.
    return await tx.transaction((savepoint) => enqueueInSavepoint(savepoint, input));
  } catch (error) {
    console.error('[security-scan] enqueue failed; the deploy goes on without a scan row', {
      projectId: input.projectId,
      deploymentId: input.deploymentId,
      error: errorMessage(error),
    });
    return null;
  }
}

/**
 * For a go-live path that writes `live` outside a transaction (compensation's
 * `post_routing_recovery`): one short transaction under the project lock, only while the
 * deployment is still live. Best effort (risk R8).
 */
export async function enqueueSecurityScanForLiveDeployment(
  db: Db,
  env: EnqueueEnv,
  input: Readonly<{ projectId: string; deploymentId: string }>,
): Promise<SecurityScanEnqueued | null> {
  if (!securityAuditsOn(env)) {
    return null;
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${input.projectId} FOR UPDATE`);
    const [live] = await tx
      .select({ id: deployments.id })
      .from(projects)
      .innerJoin(deployments, eq(deployments.id, projects.active_deployment_id))
      .where(
        and(
          eq(projects.id, input.projectId),
          eq(deployments.id, input.deploymentId),
          eq(deployments.status, 'live'),
        ),
      );
    return live ? enqueueSecurityScanInTx(tx, env, { ...input, trigger: 'deploy' }) : null;
  });
}

async function enqueueInSavepoint(
  tx: DbOrTx,
  input: Readonly<{ projectId: string; deploymentId: string; trigger: SecurityScanTrigger }>,
): Promise<SecurityScanEnqueued | null> {
  const { projectId, deploymentId } = input;
  // Shared: a policy writer (exclusive) waits for this commit, so Off cancels this row
  // instead of missing it. Lock order: project row (caller), then the policy lock.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('void:platform:security-policy', 0))`,
  );
  const policy = await readSecurityPolicyLenient(tx);
  if (policy.mode === 'disabled') {
    return null;
  }
  const [project] = await tx
    .select({
      slug: projects.slug,
      status: projects.status,
      suspended: users.suspended_reason,
      ztStatus: projectZeroTrust.status,
      desired: projectZeroTrust.desired_protected,
      effective: projectZeroTrust.effective_protected,
    })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.user_id))
    .leftJoin(projectZeroTrust, eq(projectZeroTrust.project_id, projects.id))
    .where(eq(projects.id, projectId));
  if (
    !project ||
    project.status === 'deleting' ||
    project.slug.startsWith('preview-') ||
    project.suspended !== null
  ) {
    return null;
  }
  const [existing] = await tx
    .select({
      id: securityScans.id,
      status: securityScans.status,
      statusReason: securityScans.status_reason,
      trigger: securityScans.trigger,
      inputPrefix: securityScans.input_prefix,
      inputR2Key: securityScans.input_r2_key,
    })
    .from(securityScans)
    .where(
      and(eq(securityScans.project_id, projectId), eq(securityScans.deployment_id, deploymentId)),
    )
    .orderBy(sql`${securityScans.created_at} DESC`)
    .limit(1);
  if (existing) {
    // One row per live deployment. A second call gets the row back while its
    // after-commit step is still owed: a waiting row, or a skipped row with no copy yet.
    const owed =
      existing.status === 'pending_input' ||
      (existing.status === 'skipped' &&
        (existing.statusReason === 'protected' ||
          existing.statusReason === SECURITY_PROJECT_POLICY_SKIP_REASON) &&
        existing.inputR2Key === null);
    return owed
      ? {
          scanId: existing.id,
          projectId,
          deploymentId,
          status: existing.status === 'pending_input' ? 'pending_input' : 'skipped',
          trigger: existing.trigger,
          inputPrefix: existing.inputPrefix,
        }
      : null;
  }
  // Spec §4, fail-safe: protected only when every part says so, read fresh.
  const isProtected =
    project.ztStatus === 'ready' &&
    project.desired === true &&
    project.effective === true &&
    (await installationZeroTrustProtects(tx));
  const [openRequest] = await tx
    .select({ id: securityPublicRequests.id })
    .from(securityPublicRequests)
    .where(
      and(
        eq(securityPublicRequests.project_id, projectId),
        inArray(securityPublicRequests.state, [...SECURITY_PUBLIC_REQUEST_OPEN_STATES]),
      ),
    )
    .limit(1);
  // An open public request makes every live deploy its gate scan (§5.5, D46), whatever
  // the mode or project rule, and follows the new live deployment.
  if (openRequest) {
    await tx
      .update(securityPublicRequests)
      .set({
        target_deployment_id: deploymentId,
        revision: sql`${securityPublicRequests.revision} + 1`,
        updated_at: sql`now()`,
      })
      .where(eq(securityPublicRequests.id, openRequest.id));
  }
  const trigger: SecurityScanTrigger = openRequest ? 'gate' : input.trigger;
  const override = await readSecurityProjectPolicyOverride(tx, projectId);
  const skipReason = openRequest
    ? null
    : override === 'never'
      ? SECURITY_PROJECT_POLICY_SKIP_REASON
      : policy.mode === 'public' && isProtected && override !== 'always'
        ? 'protected'
        : null;
  const skipped = skipReason !== null;
  const [operation] = await tx
    .select({ prefix: deploymentOperations.input_prefix })
    .from(deploymentOperations)
    .where(
      and(
        eq(deploymentOperations.id, deploymentId),
        eq(deploymentOperations.project_id, projectId),
        eq(deploymentOperations.inputs_deleted, false),
      ),
    )
    .limit(1);
  const inputPrefix = operation?.prefix ?? null;
  const scanId = generateId('scan');
  // Coalesce (§6.2): the new row replaces a waiting scan and keeps its place in the
  // queue. A running scan and a local check (M32) are never replaced.
  const replaced = await tx
    .update(securityScans)
    .set({ status: 'superseded', superseded_by_scan_id: scanId, finished_at: sql`now()` })
    .where(
      and(
        eq(securityScans.project_id, projectId),
        inArray(securityScans.status, ['pending_input', 'queued']),
        ne(securityScans.trigger, 'local'),
      ),
    )
    .returning({ firstQueuedAt: securityScans.first_queued_at });
  let firstQueuedAt: string | null = null;
  for (const row of replaced) {
    if (
      row.firstQueuedAt !== null &&
      (firstQueuedAt === null || Date.parse(row.firstQueuedAt) < Date.parse(firstQueuedAt))
    ) {
      firstQueuedAt = row.firstQueuedAt;
    }
  }
  const status = skipped ? 'skipped' : 'pending_input';
  await tx.insert(securityScans).values({
    id: scanId,
    project_id: projectId,
    deployment_id: deploymentId,
    status,
    status_reason: skipReason,
    trigger,
    public_request_id: openRequest?.id ?? null,
    input_prefix: inputPrefix,
    policy_mode_at_enqueue: policy.mode,
    public_at_enqueue: !isProtected,
    first_queued_at: skipped ? null : (firstQueuedAt ?? sql`now()`),
    finished_at: skipped ? sql`now()` : null,
  });
  return { scanId, projectId, deploymentId, status, trigger, inputPrefix };
}

/**
 * After the commit: copy Worker modules nothing else keeps (inline `workerFiles`, and a
 * skipped row so an exposure catch-up scan can read them), then move the row to `queued`
 * and poke. A failed copy ends the row `failed (input_missing)`. Never throws.
 */
export async function finishSecurityScanEnqueue(
  env: Pick<ApiEnv['Bindings'], 'STATIC_ASSETS_R2' | 'SECURITY_SCAN_SCHEDULER'>,
  db: DbOrTx,
  scan: SecurityScanEnqueued | null,
  modules: ReadonlyArray<WorkerModule> = [],
): Promise<void> {
  if (!scan) {
    return;
  }
  const waiting = and(eq(securityScans.id, scan.scanId), eq(securityScans.status, 'pending_input'));
  try {
    const copy =
      modules.length > 0 && (scan.status === 'skipped' || scan.inputPrefix === null)
        ? await copySecurityScanModules(env.STATIC_ASSETS_R2, scan, modules)
        : null;
    if (scan.status === 'skipped') {
      if (copy?.ok) {
        const kept = await db
          .update(securityScans)
          .set({ input_r2_key: copy.key })
          .where(and(eq(securityScans.id, scan.scanId), eq(securityScans.status, 'skipped')))
          .returning({ id: securityScans.id });
        if (kept.length === 0) {
          await dropUnclaimedCopy(env.STATIC_ASSETS_R2, db, copy.key);
        }
      }
      return;
    }
    if (copy && !copy.ok) {
      await db
        .update(securityScans)
        .set({
          status: 'failed',
          status_reason: 'input_missing',
          error_class: 'input_missing',
          failure_cause: 'project',
          finished_at: sql`now()`,
        })
        .where(waiting);
      return;
    }
    const moved = await db
      .update(securityScans)
      .set({
        status: 'queued',
        queued_at: sql`now()`,
        ...(copy?.ok ? { input_r2_key: copy.key } : {}),
      })
      .where(waiting)
      .returning({ id: securityScans.id });
    if (moved.length > 0) {
      await pokeSecurityScanScheduler(env);
    } else if (copy?.ok) {
      // Canceled or superseded meanwhile: no row reads this copy.
      await dropUnclaimedCopy(env.STATIC_ASSETS_R2, db, copy.key);
    }
  } catch (error) {
    // The hourly re-poke (M9) picks up a row left in `pending_input`.
    console.error('[security-scan] after-commit step failed', {
      scanId: scan.scanId,
      deploymentId: scan.deploymentId,
      error: errorMessage(error),
    });
  }
}

/** Deletes a module copy no scan row points at (another call may have won the CAS). */
async function dropUnclaimedCopy(r2: R2Bucket, db: DbOrTx, key: string): Promise<void> {
  const [claimed] = await db
    .select({ id: securityScans.id })
    .from(securityScans)
    .where(eq(securityScans.input_r2_key, key))
    .limit(1);
  if (!claimed) {
    await paginatedR2Delete(r2, key);
  }
}

/** Arms the scheduler's alarm. Best effort: the hourly re-poke covers a lost poke. */
export async function pokeSecurityScanScheduler(
  env: Pick<ApiEnv['Bindings'], 'SECURITY_SCAN_SCHEDULER'>,
): Promise<void> {
  try {
    const response = await securityScheduler(env).fetch('https://scheduler/poke', {
      method: 'POST',
    });
    await response.body?.cancel();
  } catch (error) {
    console.warn('[security-scan] scheduler poke failed', { error: errorMessage(error) });
  }
}

type CopyResult = Readonly<{ ok: true; key: string }> | Readonly<{ ok: false; reason: string }>;

/** `modules/{i}`, then `modules.json` last (a copy without it is incomplete); 50 MB, 30 s. */
async function copySecurityScanModules(
  r2: R2Bucket,
  scan: SecurityScanEnqueued,
  modules: ReadonlyArray<WorkerModule>,
): Promise<CopyResult> {
  const prefix = securityScanInputPrefix(scan.projectId, scan.deploymentId);
  const total = modules.reduce((sum, module) => sum + module.size, 0);
  if (total > SECURITY_SCAN_COPY_MAX_BYTES) {
    console.warn('[security-scan] Worker modules too large to copy for the scan', {
      scanId: scan.scanId,
      bytes: total,
    });
    return { ok: false, reason: 'too_large' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CopyResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), COPY_TIMEOUT_MS);
  });
  let stopped = false;
  const copy = (async (): Promise<CopyResult> => {
    const entries: Array<Readonly<{ name: string; type: string; size: number; key: string }>> = [];
    for (const [index, module] of modules.entries()) {
      if (stopped) {
        return { ok: false, reason: 'timeout' };
      }
      const key = `${prefix}modules/${index}`;
      await r2.put(key, withKnownLength(await module.open(), module.size));
      entries.push({ name: module.name, type: module.type, size: module.size, key });
    }
    if (stopped) {
      return { ok: false, reason: 'timeout' };
    }
    await r2.put(`${prefix}modules.json`, JSON.stringify({ version: 1, modules: entries }));
    return { ok: true, key: prefix };
  })().catch((error: unknown): CopyResult => ({ ok: false, reason: errorMessage(error) }));
  const result = await Promise.race([copy, timeout]);
  stopped = true;
  clearTimeout(timer);
  if (!result.ok) {
    console.warn('[security-scan] Worker module copy failed', {
      scanId: scan.scanId,
      reason: result.reason,
    });
    await paginatedR2Delete(r2, prefix).catch(() => {});
    // A `put` still in flight after a timeout can land after that delete: delete again.
    void copy.then(() => paginatedR2Delete(r2, prefix)).catch(() => {});
  }
  return result;
}

/** Whether a scan still holds the staged deploy input under `prefix`. */
export async function securityScanHoldsInput(db: DbOrTx, prefix: string): Promise<boolean> {
  const [held] = await db
    .select({ id: securityScans.id })
    .from(securityScans)
    .where(and(eq(securityScans.input_prefix, prefix), securityScanHoldsInputSql()))
    .limit(1);
  return held !== undefined;
}
