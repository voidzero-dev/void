/**
 * Scan before public (M16, spec §5.5): the in-transaction steps of the public gate. Each
 * runs under `withProjectZeroTrustLock` or the policy lock; `public-gate-flow.ts` drives
 * Zero Trust afterwards.
 *
 *   ask     gate off ─► open; gate on ─► request stored or returned, judged
 *   flip    the open request is judged again (ingest, resolve, cutover, ...)
 *   bypass  items 1–2 + no urgent finding, then recorded
 *   cancel  protect, gate off, policy off
 *
 * A pass writes nothing: the checkpoint writes the row, then calls `complete`.
 */
import type { SecurityMode } from '@void/platform/security-policy';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { generateId } from '../id.ts';
import { projectRoleForUser } from '../project-access.ts';
import {
  deploymentOperations,
  deployments,
  operatorEvents,
  projects,
  projectZeroTrust,
} from '../schema.ts';
import {
  ZeroTrustConfigurationError,
  readZeroTrustConfigurationStrict,
} from '../zero-trust/configuration.ts';
import { ZeroTrustUnavailableError } from '../zero-trust/errors.ts';
import { projectZeroTrustAvailable } from '../zero-trust/state.ts';
import { securityAuditsOn, securityScanHoldsInputSql, securityScanInputPrefix } from './enqueue.ts';
import { SecurityApiError } from './errors.ts';
import { SECURITY_FINDINGS_CAPPED_NOTE } from './findings.ts';
import { securityNotesLeftFilesUnread } from './input/build.ts';
import { enqueueSecurityNotification } from './notifications.ts';
import { lockSecurityPolicyShared, readSecurityPolicyStrict } from './policy.ts';
import { SECURITY_PROJECT_POLICY_SKIP_REASON } from './project-policy.ts';
import { urgentFindingsRefusal } from './public-gate-copy.ts';
import { bypassSkips, judgeGate, SECURITY_GATE_UNREAD_FILES } from './public-gate-judge.ts';
import type {
  GateHeldState,
  GateJudgeInput,
  GateScanFacts,
  GateVerdict,
} from './public-gate-judge.ts';
import {
  SECURITY_PUBLIC_REQUEST_OPEN_STATES,
  SECURITY_BYPASSABLE_REQUEST_STATES,
  securityFindings,
  securityProjectEvents,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
} from './schema.ts';
import type {
  SecurityBypassableRequestState,
  SecurityProjectEventAction,
  SecurityPublicRequestState,
} from './schema.ts';

export type PublicRequestRow = typeof securityPublicRequests.$inferSelect;

export const SECURITY_BYPASS_REASON_MAX_CHARS = 4000;

/** Who acts: a project member (with their role), an installation admin, or the platform. */
export type GateActor = Readonly<{
  kind: 'user' | 'installation_admin' | 'system';
  userId: string | null;
  role: string | null;
}>;

const SYSTEM: GateActor = { kind: 'system', userId: null, role: null };

export type GateRequestedVia = 'project' | 'admin' | 'operator';

// --- Gate state ---

export type GateState = Readonly<{ on: boolean; mode: SecurityMode }>;

/**
 * Whether the gate applies now (capability and policy on). Bad policy data throws (503).
 * The shared policy lock makes a gate-off write wait, so it never misses a request.
 */
export async function readGateState(
  tx: DbOrTx,
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES'>,
): Promise<GateState> {
  if (!securityAuditsOn(env)) {
    return { on: false, mode: 'disabled' };
  }
  await lockSecurityPolicyShared(tx);
  const policy = await readSecurityPolicyStrict(tx);
  return { on: policy.mode !== 'disabled' && policy.publicGate, mode: policy.mode };
}

/** Whether the gate is on, strictly read (bad policy data throws, 503). */
export async function publicGateIsOn(
  db: DbOrTx,
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES'>,
): Promise<boolean> {
  return (await readGateState(db, env)).on;
}

/** Zero Trust off or public-only mode is refused while the gate is on (spec §5.5). */
export async function assertPublicGateOff(
  tx: DbOrTx,
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES'>,
): Promise<void> {
  if ((await readGateState(tx, env)).on) {
    throw SecurityApiError.of(
      'publicGateOn',
      'Turn off "Scan before a project goes public" first: void platform security public-gate off',
    );
  }
}

// --- Reading ---

const openState = () =>
  inArray(securityPublicRequests.state, [...SECURITY_PUBLIC_REQUEST_OPEN_STATES]);

async function readRequest(db: DbOrTx, projectId: string, where: SQL) {
  const [row] = await db
    .select()
    .from(securityPublicRequests)
    .where(and(eq(securityPublicRequests.project_id, projectId), where))
    .limit(1);
  return row ?? null;
}

export async function readOpenPublicRequest(db: DbOrTx, projectId: string) {
  return readRequest(db, projectId, openState());
}

export async function readPublicRequestById(db: DbOrTx, projectId: string, requestId: string) {
  return readRequest(db, projectId, eq(securityPublicRequests.id, requestId));
}

const urgentCondition = sql`${securityFindings.verdict} = 'confirmed' AND ${securityFindings.state} = 'open' AND COALESCE(${securityFindings.severity_override}, ${securityFindings.severity}) IN ('critical', 'high')`;

/** Open urgent findings of a project, as `F-n`, oldest number first. */
export async function openUrgentFindingLabels(
  db: DbOrTx,
  projectId: string,
): Promise<Array<string>> {
  const rows = await db
    .select({ number: securityFindings.number })
    .from(securityFindings)
    .where(and(eq(securityFindings.project_id, projectId), urgentCondition))
    .orderBy(securityFindings.number);
  return rows.map((row) => `F-${row.number}`);
}

/**
 * `fixed` critical/high claims not proven in the live code (spec §4): no clean scan checked
 * them, or the live deployment was admitted before the resolve (a rollback).
 */
export async function unprovenFixLabels(
  db: DbOrTx,
  projectId: string,
  deploymentId: string,
): Promise<Array<string>> {
  const rows = await db
    .select({ number: securityFindings.number })
    .from(securityFindings)
    .where(
      and(
        eq(securityFindings.project_id, projectId),
        eq(securityFindings.state, 'resolved'),
        eq(securityFindings.resolution, 'fixed'),
        eq(securityFindings.verdict, 'confirmed'),
        sql`${securityFindings.resolved_severity} IN ('critical', 'high')`,
        sql`(${securityFindings.fix_checked_scan_id} IS NULL OR ${securityFindings.resolved_at} > (SELECT ${deployments.created_at} AT TIME ZONE current_setting('TimeZone') FROM ${deployments} WHERE ${deployments.id} = ${deploymentId}))`,
      ),
    )
    .orderBy(securityFindings.number);
  return rows.map((row) => `F-${row.number}`);
}

/** The newest scan of the deployment that can say something about it (see the judge). */
async function newestScan(
  db: DbOrTx,
  projectId: string,
  deploymentId: string,
): Promise<GateScanFacts | null> {
  const [row] = await db
    .select({
      id: securityScans.id,
      status: securityScans.status,
      statusReason: securityScans.status_reason,
      failureCause: securityScans.failure_cause,
      backlogFiles: securityScans.backlog_files,
      notes: securityScans.coverage_notes,
    })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.project_id, projectId),
        eq(securityScans.deployment_id, deploymentId),
        ne(securityScans.status, 'superseded'),
        // Not a result: a deploy skipped while protected, or by the project rule `never` (M34).
        sql`NOT (${securityScans.status} = 'skipped' AND ${securityScans.status_reason} IN ('protected', ${SECURITY_PROJECT_POLICY_SKIP_REASON}))`,
      ),
    )
    .orderBy(desc(securityScans.created_at), desc(securityScans.id))
    .limit(1);
  if (!row) {
    return null;
  }
  const { notes, ...facts } = row;
  const capped = notes.includes(SECURITY_FINDINGS_CAPPED_NOTE);
  return { ...facts, capped, unreadFiles: securityNotesLeftFilesUnread(notes) };
}

/** Where a new scan reads the code: a snapshot, the held staged deploy input, or the bundle. */
type LiveInput = Readonly<{ r2Key: string | null; inputPrefix: string | null }>;

/**
 * Whether a scan of the deployment can read its code: an R2 snapshot, the staged deploy
 * input an ended gate scan still holds, or the stored Worker bundle.
 */
export async function findLiveInput(
  env: Pick<ApiEnv['Bindings'], 'STATIC_ASSETS_R2'>,
  db: DbOrTx,
  projectId: string,
  deploymentId: string,
): Promise<LiveInput | null> {
  const rows = await db
    .select({ key: securityScans.input_r2_key })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.project_id, projectId),
        eq(securityScans.deployment_id, deploymentId),
        sql`${securityScans.input_r2_key} IS NOT NULL`,
      ),
    )
    .orderBy(desc(securityScans.created_at))
    .limit(5);
  const keys = new Set<string>(rows.flatMap((row) => (row.key ? [row.key] : [])));
  keys.add(securityScanInputPrefix(projectId, deploymentId));
  for (const key of keys) {
    try {
      if (await env.STATIC_ASSETS_R2.head(`${key}modules.json`)) {
        return { r2Key: key, inputPrefix: null };
      }
    } catch {
      // An unreadable bucket is the same as no snapshot.
    }
  }
  const [staged] = await db
    .select({ prefix: securityScans.input_prefix })
    .from(securityScans)
    .innerJoin(
      deploymentOperations,
      and(
        eq(deploymentOperations.project_id, securityScans.project_id),
        eq(deploymentOperations.input_prefix, securityScans.input_prefix),
        eq(deploymentOperations.inputs_deleted, false),
      ),
    )
    .where(
      and(
        eq(securityScans.project_id, projectId),
        eq(securityScans.deployment_id, deploymentId),
        securityScanHoldsInputSql(),
      ),
    )
    .limit(1);
  if (staged?.prefix) {
    return { r2Key: null, inputPrefix: staged.prefix };
  }
  const [deployment] = await db
    .select({ stored: deployments.bundle_stored })
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.project_id, projectId)))
    .limit(1);
  return deployment?.stored ? { r2Key: null, inputPrefix: null } : null;
}

// --- Judging ---

type Judged = Readonly<{
  verdict: GateVerdict;
  activeDeploymentId: string | null;
  input: LiveInput | null;
}>;

async function zeroTrustReady(tx: DbOrTx, projectId: string): Promise<boolean> {
  let configuration;
  try {
    configuration = await readZeroTrustConfigurationStrict(tx);
  } catch (error) {
    if (error instanceof ZeroTrustConfigurationError) {
      return false;
    }
    throw error;
  }
  if (!projectZeroTrustAvailable(configuration) || configuration?.publicAccess) {
    return false;
  }
  const [row] = await tx
    .select({
      status: projectZeroTrust.status,
      desired: projectZeroTrust.desired_protected,
      effective: projectZeroTrust.effective_protected,
    })
    .from(projectZeroTrust)
    .where(eq(projectZeroTrust.project_id, projectId))
    .limit(1);
  return row?.status === 'ready' && row.desired && row.effective;
}

/** Item 3: a cutover writes routes before it moves the active deployment. */
async function deploymentMoving(tx: DbOrTx, projectId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        inArray(deployments.status, ['cutover', 'compensating']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Flip re-check items 1–5 for the deployment that is live now. Reads only. */
export async function judgeRequest(
  tx: DbOrTx,
  env: Pick<ApiEnv['Bindings'], 'STATIC_ASSETS_R2'>,
  request: PublicRequestRow,
  active: string | null,
  options: Readonly<{ zeroTrustReady?: boolean }> = {},
): Promise<Judged> {
  const projectId = request.project_id;
  const target = active ?? request.target_deployment_id;
  const moving = await deploymentMoving(tx, projectId);
  const scan = await newestScan(tx, projectId, target);
  const waiting =
    scan !== null &&
    (scan.status === 'pending_input' || scan.status === 'queued' || scan.status === 'running');
  // Also for a scan with no usable result: asking again queues a new gate scan from it.
  const needsInput =
    !waiting &&
    (scan === null ||
      scan.status !== 'succeeded' ||
      scan.backlogFiles > 0 ||
      scan.capped ||
      scan.unreadFiles);
  const input = needsInput ? await findLiveInput(env, tx, projectId, target) : null;
  const judgeInput: GateJudgeInput = {
    targetDeploymentId: target,
    activeDeploymentId: active,
    deploymentMoving: moving,
    zeroTrustReady: options.zeroTrustReady ?? (await zeroTrustReady(tx, projectId)),
    scan,
    hasInput: input !== null,
    urgent: await openUrgentFindingLabels(tx, projectId),
    unproven: await unprovenFixLabels(tx, projectId, target),
  };
  return { verdict: judgeGate(judgeInput), activeDeploymentId: active, input };
}

// --- Writing ---

async function writeEvent(
  tx: DbOrTx,
  projectId: string,
  action: SecurityProjectEventAction,
  actor: GateActor,
  request?: Readonly<{ id: string; state: SecurityPublicRequestState }>,
): Promise<void> {
  await tx.insert(securityProjectEvents).values({
    id: generateId('spe'),
    project_id: projectId,
    actor_kind: actor.kind,
    actor_user_id: actor.userId,
    actor_role: actor.role,
    action,
    request_id: request?.id,
    request_state: request?.state,
  });
}

type Insert = typeof securityPublicRequests.$inferInsert;

/**
 * A change of the project's wanted Zero Trust protection; the admin panel flags 2+ in 7 days
 * while urgent findings are open (spec §11.4, edge #39).
 */
export async function recordProtectionChange(
  tx: DbOrTx,
  input: Readonly<{ projectId: string; protectedNow: boolean; actor: GateActor | null }>,
): Promise<void> {
  const action = input.protectedNow ? 'protection_on' : 'protection_off';
  await writeEvent(tx, input.projectId, action, input.actor ?? SYSTEM);
}

async function insertRequest(tx: DbOrTx, values: Insert): Promise<PublicRequestRow> {
  const [row] = await tx.insert(securityPublicRequests).values(values).returning();
  return row;
}

async function updateRequest(
  tx: DbOrTx,
  request: PublicRequestRow,
  values: { [Key in keyof Insert]?: Insert[Key] | SQL },
): Promise<PublicRequestRow> {
  const [row] = await tx
    .update(securityPublicRequests)
    .set({
      ...values,
      revision: sql`${securityPublicRequests.revision} + 1`,
      updated_at: sql`now()`,
    })
    .where(eq(securityPublicRequests.id, request.id))
    .returning();
  return row ?? request;
}

/** Inserts a `queued` gate scan of the deployment, diffed from the base chosen at start. */
async function queueGateScan(
  tx: DbOrTx,
  request: PublicRequestRow,
  deploymentId: string,
  input: LiveInput,
  mode: SecurityMode,
): Promise<string> {
  const id = generateId('scan');
  await tx.insert(securityScans).values({
    id,
    project_id: request.project_id,
    deployment_id: deploymentId,
    status: 'queued',
    trigger: 'gate',
    public_request_id: request.id,
    input_r2_key: input.r2Key,
    input_prefix: input.inputPrefix,
    policy_mode_at_enqueue: mode,
    public_at_enqueue: false,
    first_queued_at: sql`now()`,
    queued_at: sql`now()`,
  });
  return id;
}

export type GateEffects = { poke: boolean };

/**
 * Applies a `hold` verdict: state, reason, blockers, a new gate scan when asked for, and
 * the held event and email once per state per gate scan.
 */
async function applyHold(
  tx: DbOrTx,
  request: PublicRequestRow,
  judged: Judged,
  verdict: Extract<GateVerdict, { kind: 'hold' }>,
  options: Readonly<{
    mode: SecurityMode;
    actor: GateActor;
    effects: GateEffects;
    askAgain?: boolean;
    created?: boolean;
  }>,
): Promise<PublicRequestRow> {
  const target = judged.activeDeploymentId ?? request.target_deployment_id;
  let { state, reason } = verdict;
  let scanId = verdict.scanId;
  // Asking again on `held_no_result` queues one new gate scan (edge #79). The judge
  // gives `needs_deploy` when the live deployment's code is gone (edge #54).
  const askAgain =
    options.askAgain === true &&
    verdict.state === 'held_no_result' &&
    // A rescan of the same code leaves the same files unread.
    verdict.reason !== SECURITY_GATE_UNREAD_FILES;
  if ((verdict.queue || askAgain) && judged.input !== null && judged.activeDeploymentId !== null) {
    scanId = await queueGateScan(tx, request, target, judged.input, options.mode);
    state = 'waiting_scan';
    reason = verdict.reason === 'backlog' ? 'backlog' : 'scan_queued';
    options.effects.poke = true;
  }
  const blockers = verdict.blockers;
  const changed =
    request.state !== state ||
    request.held_reason !== reason ||
    request.gate_scan_id !== scanId ||
    request.target_deployment_id !== target ||
    request.blockers !== blockers.length ||
    request.blocker_ids.join(',') !== blockers.join(',');
  const next = changed
    ? await updateRequest(tx, request, {
        state,
        held_reason: reason,
        gate_scan_id: scanId,
        target_deployment_id: target,
        blockers: blockers.length,
        blocker_ids: [...blockers],
      })
    : request;
  if (
    (state === 'held_findings' || state === 'held_no_result' || state === 'needs_deploy') &&
    (options.created === true || request.state !== state || request.gate_scan_id !== scanId)
  ) {
    await writeEvent(tx, request.project_id, 'public_held', SYSTEM, { id: request.id, state });
    if (
      await enqueueSecurityNotification(tx, {
        kind: 'public_held',
        projectId: request.project_id,
        requestId: request.id,
        state,
        gateScanId: scanId,
      })
    ) {
      options.effects.poke = true;
    }
  }
  return next;
}

async function closeRequest(
  tx: DbOrTx,
  request: PublicRequestRow,
  state: 'passed' | 'bypassed' | 'canceled',
  options: Readonly<{
    userId?: string | null;
    cause?: 'protect' | 'gate_off' | 'policy_off';
    scanId?: string | null;
  }>,
): Promise<PublicRequestRow> {
  return updateRequest(tx, request, {
    state,
    cancel_cause: state === 'canceled' ? (options.cause ?? 'protect') : null,
    // A pass holds nothing any more, so the reason of the last hold goes with it.
    ...(state === 'passed' ? { held_reason: null } : {}),
    closed_by_user_id: options.userId ?? null,
    closed_at: sql`now()`,
    ...(options.scanId !== undefined ? { gate_scan_id: options.scanId } : {}),
  });
}

/** Cancels the request with its event, and with `notify` its email. */
async function cancelRequest(
  tx: DbOrTx,
  request: PublicRequestRow,
  cause: 'protect' | 'gate_off' | 'policy_off',
  actor: GateActor,
  notify: boolean,
): Promise<PublicRequestRow> {
  const { id, project_id: projectId } = request;
  const closed = await closeRequest(tx, request, 'canceled', { cause, userId: actor.userId });
  await writeEvent(tx, projectId, 'public_canceled', actor, { id, state: 'canceled' });
  if (notify) {
    await enqueueSecurityNotification(tx, { kind: 'public_canceled', projectId, requestId: id });
  }
  return closed;
}

// --- Steps the checkpoint takes ---

/**
 * What the gate decided for one checkpoint:
 *   open  the gate does not apply; the checkpoint goes on as today
 *   held  the request holds the project; the Zero Trust row stays as it is
 *   go    the project may go public; the checkpoint writes the row, then `complete`
 */
export type GateStep =
  | Readonly<{ kind: 'open' }>
  | Readonly<{ kind: 'held'; request: PublicRequestRow }>
  | Readonly<{
      kind: 'go';
      request: PublicRequestRow | null;
      /** A bypass: what it skips, for the reply. */
      skipped?: string | null;
      complete(tx: DbOrTx): Promise<PublicRequestRow | null>;
    }>;

export type GateProject = Readonly<{
  id: string;
  slug: string;
  active_deployment_id: string | null;
}>;

async function activeDeploymentOf(tx: DbOrTx, projectId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: projects.active_deployment_id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.id ?? null;
}

function goPassed(
  request: PublicRequestRow,
  scanId: string | null,
  effects: GateEffects,
): GateStep {
  return {
    kind: 'go',
    request,
    async complete(tx) {
      const { id, project_id: projectId } = request;
      const closed = await closeRequest(tx, request, 'passed', { scanId });
      await writeEvent(tx, projectId, 'public_passed', SYSTEM, { id, state: 'passed' });
      const notice = { kind: 'public_now_public', projectId, requestId: id } as const;
      if (await enqueueSecurityNotification(tx, notice)) {
        effects.poke = true;
      }
      return closed;
    },
  };
}

/**
 * A person asks to turn Zero Trust off. Gate off (or `preview-*`): `open`. Gate on: the open
 * request is judged again (asking again on `held_no_result` queues a scan) or one is stored
 * and judged; a pass returns `go`.
 */
export async function gateAsk(
  tx: DbOrTx,
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES' | 'STATIC_ASSETS_R2'>,
  input: Readonly<{
    project: GateProject;
    via: GateRequestedVia;
    actor: GateActor;
    effects: GateEffects;
  }>,
): Promise<GateStep> {
  const gate = await readGateState(tx, env);
  if (!gate.on || input.project.slug.startsWith('preview-')) {
    return { kind: 'open' };
  }
  const { project, actor, effects } = input;
  const active = await activeDeploymentOf(tx, project.id);
  const existing = await readOpenPublicRequest(tx, project.id);
  if (active === null && existing === null && !(await deploymentMoving(tx, project.id))) {
    // Nothing is live or on its way, so there is nothing a scan could review or an exposure to hold.
    return { kind: 'open' };
  }
  let request =
    existing ??
    (await insertRequest(tx, {
      id: generateId('spr'),
      project_id: project.id,
      state: 'waiting_scan',
      held_reason: 'scan_queued',
      requested_by_user_id: actor.userId,
      requested_via: input.via,
      target_deployment_id: active ?? '',
    }));
  const created = existing === null;
  if (created) {
    await writeEvent(tx, project.id, 'public_requested', actor, request);
  }
  const judged = await judgeRequest(tx, env, request, active);
  if (judged.verdict.kind === 'pass') {
    return goPassed(request, judged.verdict.scanId, effects);
  }
  request = await applyHold(tx, request, judged, judged.verdict, {
    mode: gate.mode,
    actor,
    effects,
    askAgain: !created,
    created,
  });
  return { kind: 'held', request };
}

/** The gate's own flip: the open request `requestId` is judged again (`closed` if it is not open). */
export async function gateFlip(
  tx: DbOrTx,
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES' | 'STATIC_ASSETS_R2'>,
  input: Readonly<{ projectId: string; requestId: string; effects: GateEffects }>,
): Promise<GateStep | { kind: 'closed' }> {
  const gate = await readGateState(tx, env);
  const request = await readPublicRequestById(tx, input.projectId, input.requestId);
  if (!request || !SECURITY_PUBLIC_REQUEST_OPEN_STATES.some((state) => state === request.state)) {
    return { kind: 'closed' };
  }
  if (!gate.on) {
    // The policy write that turned the gate off cancels the requests in its own
    // transaction; a request seen open here is a missed one, never a pass.
    return { kind: 'held', request: await cancelRequest(tx, request, 'gate_off', SYSTEM, true) };
  }
  const active = await activeDeploymentOf(tx, input.projectId);
  const judged = await judgeRequest(tx, env, request, active);
  if (judged.verdict.kind === 'pass') {
    return goPassed(request, judged.verdict.scanId, input.effects);
  }
  const held = await applyHold(tx, request, judged, judged.verdict, {
    mode: gate.mode,
    actor: SYSTEM,
    effects: input.effects,
  });
  return { kind: 'held', request: held };
}

export type GateBypassInput = Readonly<{
  projectId: string;
  slug: string;
  /** The request the caller saw; it must still be open. */
  requestId: string | null;
  reason: string;
  actor: GateActor & { kind: 'user' | 'installation_admin'; userId: string };
  effects: GateEffects;
}>;

/** Trims and checks a bypass reason (1–4,000 characters). */
export function parseBypassReason(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0 || Array.from(text).length > SECURITY_BYPASS_REASON_MAX_CHARS) {
    throw SecurityApiError.of(
      'scanBypassReasonRequired',
      `A reason of 1 to ${SECURITY_BYPASS_REASON_MAX_CHARS} characters is required. Say why, for example: --reason "Launch today; scanner is down. Will re-check."`,
    );
  }
  return text;
}

/** The refusal rules of a bypass; the operator dry run calls them too. */
export async function checkBypassable(
  tx: DbOrTx,
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES'>,
  input: Pick<GateBypassInput, 'projectId' | 'slug' | 'requestId'>,
) {
  const gate = await readGateState(tx, env);
  const open = await readOpenPublicRequest(tx, input.projectId);
  if (!open || (input.requestId !== null && open.id !== input.requestId)) {
    const closed =
      input.requestId === null
        ? null
        : await readPublicRequestById(tx, input.projectId, input.requestId);
    if (closed) {
      throw SecurityApiError.of(
        'publicRequestClosed',
        `The public request is already ${closed.state}.`,
        { state: closed.state },
      );
    }
    throw SecurityApiError.of(
      'noPublicRequest',
      `${input.slug} has no public request to bypass. Run: void project zero-trust public`,
    );
  }
  if (!gate.on) {
    throw SecurityApiError.of('publicRequestClosed', 'The public request is already canceled.', {
      state: 'canceled',
    });
  }
  if (!(await zeroTrustReady(tx, input.projectId))) {
    throw new ZeroTrustUnavailableError('The Zero Trust row of this project is not ready.');
  }
  const urgent = await openUrgentFindingLabels(tx, input.projectId);
  if (urgent.length > 0 || open.state === 'held_findings') {
    throw SecurityApiError.of('publicRequestHasUrgentFindings', urgentFindingsRefusal(urgent), {
      blockers: { count: urgent.length, ids: urgent },
    });
  }
  const state = open.state as SecurityBypassableRequestState;
  if (!SECURITY_BYPASSABLE_REQUEST_STATES.includes(state)) {
    throw SecurityApiError.of('publicRequestClosed', `The public request is ${open.state}.`, {
      state: open.state,
    });
  }
  const unproven = await unprovenFixLabels(tx, input.projectId, open.target_deployment_id);
  return { open, state, unproven };
}

/** Bypass (spec §5.5): items 1–2 and no urgent finding; skips the scan and `fixed` proofs. */
export async function gateBypass(
  tx: DbOrTx,
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES'>,
  input: GateBypassInput,
): Promise<GateStep> {
  const { open, state, unproven } = await checkBypassable(tx, env, input);
  const { actor, effects } = input;
  return {
    kind: 'go',
    request: open,
    skipped: bypassSkips(state, open.held_reason, unproven),
    async complete(complete) {
      const bypassId = generateId('ssb');
      await complete.insert(securityScanBypasses).values({
        id: bypassId,
        project_id: input.projectId,
        request_id: open.id,
        deployment_id: open.target_deployment_id,
        actor_kind: actor.kind,
        actor_user_id: actor.userId,
        actor_role: actor.role,
        reason: input.reason,
        request_state: state,
        held_reason: open.held_reason,
        gate_scan_id: open.gate_scan_id,
        blockers: unproven.length,
        blocker_ids: unproven,
      });
      const closed = await closeRequest(complete, open, 'bypassed', { userId: actor.userId });
      await writeEvent(complete, input.projectId, 'scan_bypassed', actor, {
        id: open.id,
        state: 'bypassed',
      });
      // Ids only (the row outlives the project). An admin's bypass is audited by its caller.
      if (actor.kind !== 'installation_admin') {
        await complete.insert(operatorEvents).values({
          id: crypto.randomUUID(),
          user_id: actor.userId,
          login: 'project member',
          action: 'security.public-request.bypass',
          target: JSON.stringify({
            projectId: input.projectId,
            requestId: open.id,
            bypassId,
            deploymentId: open.target_deployment_id,
          }),
          status: 'success',
          http_status: 200,
        });
      }
      const queued = await enqueueSecurityNotification(complete, {
        kind: 'scan_bypass',
        projectId: input.projectId,
        requestId: open.id,
        bypassId,
      });
      const nowPublic = await enqueueSecurityNotification(complete, {
        kind: 'public_now_public',
        projectId: input.projectId,
        requestId: open.id,
      });
      if (queued || nowPublic) {
        effects.poke = true;
      }
      return closed;
    },
  };
}

// --- Cancel ---

/** `protect` with an open request: it only cancels. Quiet: no email (edge #80). */
export async function cancelOpenRequestForProtect(
  tx: DbOrTx,
  projectId: string,
  actor: GateActor,
): Promise<PublicRequestRow | null> {
  const open = await readOpenPublicRequest(tx, projectId);
  if (!open) {
    return null;
  }
  return cancelRequest(tx, open, 'protect', actor, false);
}

/** The gate or policy was turned off: every open request is canceled and told; projects stay protected. */
export async function cancelAllOpenRequests(
  tx: DbOrTx,
  cause: 'gate_off' | 'policy_off',
  actor: GateActor = SYSTEM,
): Promise<ReadonlyArray<PublicRequestRow>> {
  const rows = await tx
    .select()
    .from(securityPublicRequests)
    .where(openState())
    .orderBy(securityPublicRequests.created_at);
  const closed: Array<PublicRequestRow> = [];
  for (const row of rows) {
    closed.push(await cancelRequest(tx, row, cause, actor, true));
  }
  return closed;
}

/** The open requests, for the turn-off preview (spec §5.5, edge #66). */
export async function listOpenRequestSlugs(db: DbOrTx): Promise<Array<string>> {
  const rows = await db
    .select({ slug: projects.slug })
    .from(securityPublicRequests)
    .innerJoin(projects, eq(projects.id, securityPublicRequests.project_id))
    .where(openState())
    .orderBy(projects.slug);
  return rows.map((row) => row.slug);
}

/** A cutover or rollback moved the live deployment: the open request follows it. */
export async function retargetOpenPublicRequest(
  tx: DbOrTx,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  await tx
    .update(securityPublicRequests)
    .set({
      target_deployment_id: deploymentId,
      revision: sql`${securityPublicRequests.revision} + 1`,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(securityPublicRequests.project_id, projectId),
        openState(),
        ne(securityPublicRequests.target_deployment_id, deploymentId),
      ),
    );
}

// --- View ---

export type PublicRequestView = Readonly<{
  id: string;
  state: SecurityPublicRequestState;
  heldReason: string | null;
  targetDeploymentId: string;
  gateScanId: string | null;
  blockers: Readonly<{ count: number; ids: ReadonlyArray<string> }>;
  requestedAt: string;
  requestedByRole: string | null;
}>;

function isoStamp(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

/** The request as the API shows it (spec §13.3 `--json`): states, ids and codes, no text. */
export async function publicRequestView(
  db: DbOrTx,
  request: PublicRequestRow,
): Promise<PublicRequestView> {
  const userId = request.requested_by_user_id;
  const requestedByRole =
    request.requested_via !== 'project'
      ? 'installation_admin'
      : userId === null
        ? null
        : await projectRoleForUser(db, request.project_id, userId);
  return {
    id: request.id,
    state: request.state,
    heldReason: request.held_reason,
    targetDeploymentId: request.target_deployment_id,
    gateScanId: request.gate_scan_id,
    blockers: { count: request.blockers, ids: request.blocker_ids },
    requestedAt: isoStamp(request.created_at),
    requestedByRole,
  };
}

/** The newest bypass of a project (spec §13.3 `void project zero-trust status`). */
export type LastBypassView = Readonly<{
  id: string;
  at: string;
  /** The project role at bypass time, or `installation_admin`. */
  byRole: string | null;
  /** Only for callers who see full detail (`deploy` and up). */
  reason?: string;
}>;

export async function lastBypassView(
  db: DbOrTx,
  projectId: string,
  withReason: boolean,
): Promise<LastBypassView | null> {
  const [row] = await db
    .select({
      id: securityScanBypasses.id,
      at: securityScanBypasses.created_at,
      kind: securityScanBypasses.actor_kind,
      role: securityScanBypasses.actor_role,
      reason: securityScanBypasses.reason,
    })
    .from(securityScanBypasses)
    .where(eq(securityScanBypasses.project_id, projectId))
    .orderBy(desc(securityScanBypasses.created_at), desc(securityScanBypasses.id))
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    at: isoStamp(row.at),
    byRole: row.kind === 'installation_admin' ? 'installation_admin' : row.role,
    ...(withReason ? { reason: row.reason } : {}),
  };
}

/** The open request of a project as the API shows it, or `null`. */
export async function openPublicRequestView(
  db: DbOrTx,
  projectId: string,
): Promise<PublicRequestView | null> {
  const open = await readOpenPublicRequest(db, projectId);
  return open ? publicRequestView(db, open) : null;
}

export type { GateHeldState };
