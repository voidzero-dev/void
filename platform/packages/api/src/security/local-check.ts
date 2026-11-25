/**
 * Local checks (`void project security check`, design doc 0095 M32): a scan of a working
 * tree before deploy. POST checks (preview or create + one presigned archive PUT), POST
 * start (queued), GET (row and result). Its result is separate and short-lived (R13): it
 * never touches findings, base, backlog, email or public requests.
 */
import { isRecord } from '@void/deploy-core';
import { SECURITY_LOCAL_CHECK_LIMITS } from '@void/platform/security-local-check';
import {
  securityModelThirdPartyHost,
  securityProviderNotice,
} from '@void/platform/security-models';
import { and, eq, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { presignAssetPut } from '../r2-presign.ts';
import { projects, users } from '../schema.ts';
import { NANO_USD_PER_USD, securityScanReserveNano } from './budget.ts';
import { pokeSecurityScanScheduler, securityScanProjectPrefix } from './enqueue.ts';
import { SecurityApiError } from './errors.ts';
import { lockSecurityPolicyShared, readSecurityPolicyLenient } from './policy.ts';
import {
  readSecurityProjectSettings,
  securityProjectBudgetView,
  securityProjectModelView,
  securityProjectPolicyView,
  securityScanView,
  scanColumns,
} from './project-view.ts';
import { securityScans } from './schema.ts';
import type { SecuritySeverity } from './schema.ts';

/** The presigned upload works this long. */
export const SECURITY_LOCAL_UPLOAD_TTL_SECONDS = 30 * 60;
/** A check still waiting for its upload after this (URL dead, plus a margin) is canceled. */
export const SECURITY_LOCAL_UPLOAD_STALE_MS = (SECURITY_LOCAL_UPLOAD_TTL_SECONDS + 5 * 60) * 1000;
/** Findings one local result lists, at most. */
export const SECURITY_LOCAL_RESULT_MAX_FINDINGS = 200;
/** Ended checks whose uploaded tree one hourly run deletes, at most. */
const TREE_SWEEP_LIMIT = 100;

const WAITING_OR_RUNNING = ['pending_input', 'queued', 'running'] as const;
/** A check that blocks a new one; one waiting for its upload is replaced instead. */
const BUSY = ['queued', 'running'] as const;

function scanPrefix(projectId: string, scanId: string): string {
  return `${securityScanProjectPrefix(projectId)}scans/${scanId}/`;
}

/** The uploaded archive, next to the scan's raw output. */
export function securityLocalTreeKey(projectId: string, scanId: string): string {
  return `${scanPrefix(projectId, scanId)}local-tree.tar.gz`;
}

/** The result the CLI reads, per attempt so a late fenced-off write never replaces it. */
export function securityLocalResultKey(projectId: string, scanId: string, attempt: number): string {
  return `${scanPrefix(projectId, scanId)}local-result.${attempt}.json`;
}

export type SecurityLocalCheckFinding = Readonly<{
  verdict: 'confirmed' | 'needs_validation';
  severity: SecuritySeverity | null;
  confidence: string | null;
  title: string;
  category: string;
  cwe: string | null;
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  source: 'scanner' | 'server';
  verdictSource: 'static' | 'runtime';
  detail: Readonly<Record<string, unknown>>;
}>;

export type SecurityLocalCheckResult = Readonly<{
  version: 1;
  findings: ReadonlyArray<SecurityLocalCheckFinding>;
  /** Records before the cap. */
  total: number;
  capped: boolean;
}>;

/** `size` and `md5` (32 lowercase hex) are signed into the upload; R2 checks the body. */
export type SecurityLocalCheckRequest = Readonly<{
  dryRun: boolean;
  files: number;
  bytes: number;
  size: number;
  md5: string;
}>;

const MB = 1024 * 1024;

function isLowerHex(value: string): boolean {
  for (const char of value) {
    if (!'0123456789abcdef'.includes(char)) {
      return false;
    }
  }
  return true;
}

export function parseSecurityLocalCheckRequest(body: unknown): SecurityLocalCheckRequest {
  const input = isRecord(body) ? body : {};
  const count = (name: string, min: number): number => {
    const value = input[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
      throw SecurityApiError.invalid(`${name} must be a whole number of at least ${min}.`);
    }
    return value;
  };
  const { dryRun, md5 } = input;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw SecurityApiError.invalid('dryRun must be true or false.');
  }
  const files = count('files', 1);
  const bytes = count('bytes', 0);
  const size = count('size', 1);
  if (typeof md5 !== 'string' || md5.length !== 32 || !isLowerHex(md5)) {
    throw SecurityApiError.invalid('md5 must be 32 lowercase hex characters.');
  }
  const limits = SECURITY_LOCAL_CHECK_LIMITS;
  const tooLarge = (what: string) =>
    new SecurityApiError(
      413,
      'security_check_too_large',
      `A local check sends at most ${what}. Run it from the app's folder.`,
      { limits },
    );
  if (files > limits.maxFiles) {
    throw tooLarge(
      `${limits.maxFiles.toLocaleString('en-US')} files; this tree has ${files.toLocaleString('en-US')}`,
    );
  }
  if (bytes > limits.maxBytes || size > limits.maxArchiveBytes) {
    throw tooLarge(
      `${limits.maxBytes / MB} MB of code; this tree has ${(bytes / MB).toFixed(1)} MB`,
    );
  }
  return { dryRun: dryRun === true, files, bytes, size, md5 };
}

type CheckProject = Readonly<{ id: string; slug: string }>;

/** What a local check would run on, read before code leaves the machine (rescan scope). */
export async function previewSecurityLocalCheck(db: Db, project: CheckProject) {
  const [row] = await db
    .select({ status: projects.status, suspended: users.suspended_reason })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.user_id))
    .where(eq(projects.id, project.id))
    .limit(1);
  if (!row) {
    throw new SecurityApiError(404, 'not_found', 'Project not found.');
  }
  if (row.status === 'deleting') {
    throw new SecurityApiError(409, 'project_deleting', 'Project is being deleted.');
  }
  const policy = await readSecurityPolicyLenient(db);
  const scope = await securityProjectPolicyView(db, {
    projectId: project.id,
    slug: project.slug,
    capability: true,
    policy,
  });
  // A local check is no scan of a public request, so the rule `never` (M34) refuses it
  // even while a request is open.
  if (!scope.applies || scope.override === 'never') {
    throw new SecurityApiError(
      409,
      'security_not_in_scope',
      `${project.slug} is not scanned: ${scope.override === 'never' ? 'a platform admin turned scans off for this project' : scope.reason}.`,
    );
  }
  if (row.suspended !== null) {
    throw new SecurityApiError(
      409,
      'security_not_in_scope',
      `${project.slug}'s owner is suspended.`,
    );
  }
  const busy = await activeLocalCheck(db, project.id);
  if (busy) {
    throw checkInProgress(busy);
  }
  const settings = await readSecurityProjectSettings(db, project.id);
  const model = securityProjectModelView(policy, settings);
  if (model.id === null) {
    throw new SecurityApiError(
      409,
      'security_no_model',
      'No scan model can run now: every model is blocked on this platform. Ask your platform admin.',
    );
  }
  const host = securityModelThirdPartyHost(model.id);
  const worstCase = securityScanReserveNano(model.id, policy.limits);
  return {
    model: model.id,
    thirdParty: model.thirdParty,
    notice: host ? [...securityProviderNotice(host)] : null,
    worstCaseUsd: worstCase === null ? null : worstCase / NANO_USD_PER_USD,
    budget: await securityProjectBudgetView(db, project.id, policy, settings.caps),
    limits: SECURITY_LOCAL_CHECK_LIMITS,
  };
}

async function activeLocalCheck(db: DbOrTx, projectId: string) {
  const [row] = await db
    .select({ id: securityScans.id, status: securityScans.status })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.project_id, projectId),
        eq(securityScans.trigger, 'local'),
        inArray(securityScans.status, [...BUSY]),
      ),
    )
    .limit(1);
  return row ?? null;
}

function checkInProgress(busy: { id: string; status: string }): SecurityApiError {
  return new SecurityApiError(
    409,
    'security_check_in_progress',
    `A local check of this project is already ${busy.status === 'running' ? 'running' : 'waiting in the scan queue'} (${busy.id}). Wait for it: void project security check ${busy.id}`,
    { checkId: busy.id },
  );
}

export type SecurityLocalUploadEnv = Pick<
  ApiEnv['Bindings'],
  'CF_ACCOUNT_ID' | 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'R2_STATIC_ASSETS_BUCKET'
>;

/**
 * Stores the check (`pending_input`) and signs the one archive upload (write-once key);
 * an earlier check still waiting for its upload is canceled.
 */
export async function createSecurityLocalCheck(
  env: SecurityLocalUploadEnv,
  db: Db,
  project: CheckProject,
  request: SecurityLocalCheckRequest,
  now = Date.now(),
) {
  const preview = await previewSecurityLocalCheck(db, project);
  const checkId = generateId('scan');
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${project.id} FOR UPDATE`);
    // Shared with deploys (`enqueueInSavepoint`, same lock order): turning the policy
    // Off waits for this commit and cancels the row, or this reads Off and stops.
    await lockSecurityPolicyShared(tx);
    const policy = await readSecurityPolicyLenient(tx);
    if (policy.mode === 'disabled') {
      throw new SecurityApiError(
        409,
        'security_not_in_scope',
        `${project.slug} is not scanned: security audits are off on this platform.`,
      );
    }
    const busy = await activeLocalCheck(tx, project.id);
    if (busy) {
      throw checkInProgress(busy);
    }
    // A check whose upload never came (Ctrl-C, a failed PUT): it never ran.
    await tx
      .update(securityScans)
      .set({ status: 'canceled', status_reason: 'upload_replaced', finished_at: sql`now()` })
      .where(
        and(
          eq(securityScans.project_id, project.id),
          eq(securityScans.trigger, 'local'),
          eq(securityScans.status, 'pending_input'),
        ),
      );
    await tx.insert(securityScans).values({
      id: checkId,
      project_id: project.id,
      deployment_id: null,
      status: 'pending_input',
      trigger: 'local',
      input_r2_key: securityLocalTreeKey(project.id, checkId),
      policy_mode_at_enqueue: policy.mode,
    });
  });
  const upload = await presignAssetPut({
    accountId: env.CF_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_STATIC_ASSETS_BUCKET,
    key: securityLocalTreeKey(project.id, checkId),
    md5: request.md5,
    contentType: 'application/gzip',
    contentLength: request.size,
    ifNoneMatch: '*',
    ttlSeconds: SECURITY_LOCAL_UPLOAD_TTL_SECONDS,
  });
  return {
    checkId,
    upload,
    expiresAt: new Date(now + SECURITY_LOCAL_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    model: preview.model,
    thirdParty: preview.thirdParty,
  };
}

async function readLocalRow(db: DbOrTx, projectId: string, checkId: string) {
  const [row] = await db
    .select({
      ...scanColumns,
      inputR2Key: securityScans.input_r2_key,
      attempt: securityScans.attempt,
    })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.id, checkId),
        eq(securityScans.project_id, projectId),
        eq(securityScans.trigger, 'local'),
      ),
    )
    .limit(1);
  if (!row) {
    throw new SecurityApiError(404, 'not_found', `Local check ${checkId} not found.`);
  }
  return row;
}

/** The archive is uploaded: the check joins the queue. A later call reads the state. */
export async function startSecurityLocalCheck(
  env: Pick<ApiEnv['Bindings'], 'STATIC_ASSETS_R2' | 'SECURITY_SCAN_SCHEDULER'>,
  db: Db,
  projectId: string,
  checkId: string,
) {
  const row = await readLocalRow(db, projectId, checkId);
  if (row.status !== 'pending_input') {
    // A second start (a lost reply, or `check <id>` after the upload) gets the state back.
    return { checkId, status: row.status };
  }
  const object = row.inputR2Key ? await env.STATIC_ASSETS_R2.head(row.inputR2Key) : null;
  if (!object) {
    throw new SecurityApiError(
      409,
      'security_check_upload_missing',
      'The code of this check was not uploaded. Run void project security check again.',
    );
  }
  const moved = await db.transaction(async (tx) => {
    // Shared policy lock, as at create: a check never joins the queue while it is Off.
    await lockSecurityPolicyShared(tx);
    const policy = await readSecurityPolicyLenient(tx);
    const [updated] = await tx
      .update(securityScans)
      .set(
        policy.mode === 'disabled'
          ? { status: 'canceled', status_reason: 'policy_off', finished_at: sql`now()` }
          : { status: 'queued', first_queued_at: sql`now()`, queued_at: sql`now()` },
      )
      .where(and(eq(securityScans.id, checkId), eq(securityScans.status, 'pending_input')))
      .returning({ status: securityScans.status });
    return updated?.status === 'queued';
  });
  if (moved) {
    await pokeSecurityScanScheduler(env);
  }
  const [after] = await db
    .select({ status: securityScans.status })
    .from(securityScans)
    .where(eq(securityScans.id, checkId));
  return { checkId, status: after?.status ?? 'queued' };
}

function parseResult(text: string | null): SecurityLocalCheckResult | null {
  if (text === null) {
    return null;
  }
  try {
    const value = JSON.parse(text) as Partial<SecurityLocalCheckResult>;
    return value?.version === 1 && Array.isArray(value.findings)
      ? (value as SecurityLocalCheckResult)
      : null;
  } catch {
    return null;
  }
}

const ENDED_WITH_RESULT = new Set(['succeeded', 'incomplete']);

/** The check as the scans list shows it, and its result once it ended with one. */
export async function readSecurityLocalCheck(
  env: Pick<ApiEnv['Bindings'], 'STATIC_ASSETS_R2'>,
  db: Db,
  projectId: string,
  checkId: string,
) {
  const row = await readLocalRow(db, projectId, checkId);
  let result: SecurityLocalCheckResult | null = null;
  if (ENDED_WITH_RESULT.has(row.status)) {
    const object = await env.STATIC_ASSETS_R2.get(
      securityLocalResultKey(projectId, checkId, row.attempt),
    );
    result = parseResult(object ? await object.text() : null);
  }
  const ended = !WAITING_OR_RUNNING.some((status) => status === row.status);
  return {
    check: { ...securityScanView(row, 'full'), coverageNotes: [...row.coverageNotes] },
    ended,
    result,
  };
}

/** Deletes a check's uploaded tree and forgets its key. Best effort for the caller. */
export async function deleteSecurityLocalTree(
  db: DbOrTx,
  r2: R2Bucket,
  projectId: string,
  checkId: string,
): Promise<void> {
  await r2.delete(securityLocalTreeKey(projectId, checkId));
  await db
    .update(securityScans)
    .set({ input_r2_key: null })
    .where(and(eq(securityScans.id, checkId), eq(securityScans.trigger, 'local')));
}

/** Hourly: cancels checks whose upload never came and deletes every ended check's tree. */
export async function sweepSecurityLocalChecks(db: Db, r2: R2Bucket, now: number): Promise<number> {
  await db
    .update(securityScans)
    .set({ status: 'canceled', status_reason: 'upload_missing', finished_at: sql`now()` })
    .where(
      and(
        eq(securityScans.trigger, 'local'),
        eq(securityScans.status, 'pending_input'),
        lt(securityScans.created_at, new Date(now - SECURITY_LOCAL_UPLOAD_STALE_MS).toISOString()),
      ),
    );
  const ended = await db
    .select({ id: securityScans.id, projectId: securityScans.project_id })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.trigger, 'local'),
        isNotNull(securityScans.input_r2_key),
        notInArray(securityScans.status, [...WAITING_OR_RUNNING]),
      ),
    )
    .limit(TREE_SWEEP_LIMIT);
  for (const row of ended) {
    await deleteSecurityLocalTree(db, r2, row.projectId, row.id);
  }
  return ended.length;
}
