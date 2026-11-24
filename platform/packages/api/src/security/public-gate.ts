/**
 * Scan before public (design doc 0095 M16, spec §5.5): the transaction-level building
 * blocks of the public gate. Every function here runs inside a transaction that holds
 * `withProjectZeroTrustLock` (the project row and the shared Zero Trust lock), taken by
 * `checkpointProjectReconciliation` (`zero-trust/project.ts`), or by a policy write
 * that holds the policy lock. The drivers that run Zero Trust reconciliation afterwards
 * live in `public-gate-flow.ts`.
 *
 *   ask (a person turns protection off)   gate off ─► open: normal path
 *                                         gate on  ─► request stored or returned, judged
 *   flip (ingest, resolve, cutover, ...)  the open request is judged again
 *   bypass                                items 1–2 + no urgent finding, then recorded
 *   cancel (protect, gate off, policy off)
 *
 * A judgement that passes does not write anything: the checkpoint writes
 * `desired_protected = false` and then calls `complete`, so the request closes in the
 * same transaction as the row. A hold changes only the request.
 */
import type { SecurityMode } from '@void/platform/security-policy';
import { and, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { getPlatformCapabilities } from '../capabilities.ts';
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
import { securityScanHoldsInputSql, securityScanInputPrefix } from './enqueue.ts';
import { SecurityApiError } from './errors.ts';
import { SECURITY_FINDINGS_CAPPED_NOTE } from './findings.ts';
import { enqueueSecurityNotification } from './notifications.ts';
import { lockSecurityPolicyShared, readSecurityPolicyStrict } from './policy.ts';
import { SECURITY_PROJECT_POLICY_SKIP_REASON } from './project-policy.ts';
import { urgentFindingsRefusal } from './public-gate-copy.ts';
import {
  bypassSkips,
  judgeGate,
  type GateHeldState,
  type GateJudgeInput,
  type GateScanFacts,
  type GateVerdict,
} from './public-gate-judge.ts';
import {
  SECURITY_PUBLIC_REQUEST_OPEN_STATES,
  SECURITY_BYPASSABLE_REQUEST_STATES,
  securityFindings,
  securityProjectEvents,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
  type SecurityBypassableRequestState,
  type SecurityProjectEventAction,
  type SecurityPublicRequestState,
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

// ---------------------------------------------------------------------------
// Gate state
// ---------------------------------------------------------------------------

export type GateState = Readonly<{ on: boolean; mode: SecurityMode }>;

/**
 * Whether the gate applies now: the capability is on and the policy has the gate on.
 * Bad policy data throws `SecurityPolicyUnreadableError` (503, fail closed). Takes the
 * policy lock shared, so a policy write that turns the gate off (and cancels the open
 * requests) waits for this transaction and never misses its request.
 */
export async function readGateState(
  tx: DbOrTx,
  env: Pick<ApiEnv['Bindings'], 'PLATFORM_CAPABILITIES'>,
): Promise<GateState> {
  let capability = false;
  try {
    capability = getPlatformCapabilities(env).securityAudits;
  } catch {
    capability = false;
  }
  if (!capability) {
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

/**
 * The installation-wide Zero Trust disable and the switch to public-only mode are
 * refused while the gate is on (spec §5.5). Bad policy data refuses them too (503).
 */
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

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function readOpenPublicRequest(
  db: DbOrTx,
  projectId: string,
): Promise<PublicRequestRow | null> {
  const [row] = await db
    .select()
    .from(securityPublicRequests)
    .where(
      and(
        eq(securityPublicRequests.project_id, projectId),
        inArray(securityPublicRequests.state, [...SECURITY_PUBLIC_REQUEST_OPEN_STATES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function readPublicRequestById(
  db: DbOrTx,
  projectId: string,
  requestId: string,
): Promise<PublicRequestRow | null> {
  const [row] = await db
    .select()
    .from(securityPublicRequests)
    .where(
      and(
        eq(securityPublicRequests.project_id, projectId),
        eq(securityPublicRequests.id, requestId),
      ),
    )
    .limit(1);
  return row ?? null;
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
 * `fixed` critical/high claims not proven in the live code (spec §4, gate blocker): no
 * clean scan has checked them, or the live deployment was admitted before the resolve
 * (for example after a rollback).
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
  return row
    ? {
        id: row.id,
        status: row.status,
        statusReason: row.statusReason,
        failureCause: row.failureCause,
        backlogFiles: row.backlogFiles,
        capped: row.notes.includes(SECURITY_FINDINGS_CAPPED_NOTE),
      }
    : null;
}

/** Where a new scan reads the code: a snapshot, the held staged deploy input, or the bundle. */
type LiveInput = Readonly<{ r2Key: string | null; inputPrefix: string | null }>;

/**
 * Whether a scan of the deployment can read its code: a snapshot in R2 (the
 * `skipped:protected` copy, a base kept for the next diff), the staged deploy input an
 * ended gate scan still holds (`securityScanHoldsInputSql`), or the stored Worker bundle.
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

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

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
  const [moving] = await tx
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        inArray(deployments.status, ['cutover', 'compensating']),
      ),
    )
    .limit(1);
  const scan = await newestScan(tx, projectId, target);
  const waiting =
    scan !== null &&
    (scan.status === 'pending_input' || scan.status === 'queued' || scan.status === 'running');
  // Also for a scan with no usable result: asking again queues a new gate scan from it.
  const needsInput =
    !waiting &&
    (scan === null || scan.status !== 'succeeded' || scan.backlogFiles > 0 || scan.capped);
  const input = needsInput ? await findLiveInput(env, tx, projectId, target) : null;
  const judgeInput: GateJudgeInput = {
    targetDeploymentId: target,
    activeDeploymentId: active,
    deploymentMoving: moving !== undefined,
    zeroTrustReady: options.zeroTrustReady ?? (await zeroTrustReady(tx, projectId)),
    scan,
    hasInput: input !== null,
    urgent: await openUrgentFindingLabels(tx, projectId),
    unproven: await unprovenFixLabels(tx, projectId, target),
  };
  return { verdict: judgeGate(judgeInput), activeDeploymentId: active, input };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function writeEvent(
  tx: DbOrTx,
  input: Readonly<{
    projectId: string;
    action: SecurityProjectEventAction;
    actor: GateActor;
    requestId: string;
    state: SecurityPublicRequestState;
  }>,
): Promise<void> {
  await tx.insert(securityProjectEvents).values({
    id: generateId('spe'),
    project_id: input.projectId,
    actor_kind: input.actor.kind,
    actor_user_id: input.actor.userId,
    actor_role: input.actor.role,
    action: input.action,
    request_id: input.requestId,
    request_state: input.state,
  });
}

type Insert = typeof securityPublicRequests.$inferInsert;

/**
 * A change of the project's wanted Zero Trust protection, in the transaction that writes
 * it. The admin panel flags 2+ of these in 7 days while urgent findings are open (spec
 * §11.4, edge #39): with the gate off, a protect → deploy → unprotect skips the scan.
 */
export async function recordProtectionChange(
  tx: DbOrTx,
  input: Readonly<{ projectId: string; protectedNow: boolean; actor: GateActor | null }>,
): Promise<void> {
  const actor = input.actor ?? SYSTEM;
  await tx.insert(securityProjectEvents).values({
    id: generateId('spe'),
    project_id: input.projectId,
    actor_kind: actor.kind,
    actor_user_id: actor.userId,
    actor_role: actor.role,
    action: input.protectedNow ? 'protection_on' : 'protection_off',
  });
}

async function insertRequest(tx: DbOrTx, values: Insert): Promise<PublicRequestRow> {
  const [row] = await tx.insert(securityPublicRequests).values(values).returning();
  return row!;
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
 * Applies a `hold` verdict to the request: state, reason, blockers, the gate scan (a new
 * one when the verdict asks for it and `queue` allows), and the held event and email once
 * per state per gate scan.
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
  const askAgain = options.askAgain === true && verdict.state === 'held_no_result';
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
    await writeEvent(tx, {
      projectId: request.project_id,
      action: 'public_held',
      actor: SYSTEM,
      requestId: request.id,
      state,
    });
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

// ---------------------------------------------------------------------------
// Steps the checkpoint takes
// ---------------------------------------------------------------------------

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

function goPassed(request: PublicRequestRow, scanId: string, effects: GateEffects): GateStep {
  return {
    kind: 'go',
    request,
    async complete(tx) {
      const closed = await closeRequest(tx, request, 'passed', { scanId });
      await writeEvent(tx, {
        projectId: request.project_id,
        action: 'public_passed',
        actor: SYSTEM,
        requestId: request.id,
        state: 'passed',
      });
      if (
        await enqueueSecurityNotification(tx, {
          kind: 'public_now_public',
          projectId: request.project_id,
          requestId: request.id,
        })
      ) {
        effects.poke = true;
      }
      return closed;
    },
  };
}

/**
 * A person asks to turn Zero Trust off for a protected project. Gate off (or a
 * `preview-*` project): `open`. Gate on: the open request is returned (judged again; on
 * `held_no_result` one new gate scan is queued) or one is stored and judged. A pass
 * returns `go`: the same call flips the project, and no request stays open.
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
  if (active === null && existing === null) {
    // Nothing is live, so there is nothing a scan could review or an exposure to hold.
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
    await writeEvent(tx, {
      projectId: project.id,
      action: 'public_requested',
      actor,
      requestId: request.id,
      state: request.state,
    });
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

/**
 * The gate's own flip: the open request `requestId` is judged again. Returns `open`
 * when that request is no longer open (the checkpoint then does nothing for it).
 */
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
    const canceled = await closeRequest(tx, request, 'canceled', { cause: 'gate_off' });
    await writeEvent(tx, {
      projectId: input.projectId,
      action: 'public_canceled',
      actor: SYSTEM,
      requestId: request.id,
      state: 'canceled',
    });
    await enqueueSecurityNotification(tx, {
      kind: 'public_canceled',
      projectId: input.projectId,
      requestId: request.id,
    });
    return { kind: 'held', request: canceled };
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
  if (text.length === 0 || [...text].length > SECURITY_BYPASS_REASON_MAX_CHARS) {
    throw SecurityApiError.of(
      'scanBypassReasonRequired',
      `A reason of 1 to ${SECURITY_BYPASS_REASON_MAX_CHARS} characters is required. Say why, for example: --reason "Launch today; scanner is down. Will re-check."`,
    );
  }
  return text;
}

/**
 * The refusal rules of a bypass, run before it changes anything. The real bypass and
 * the operator dry run both call this, so a preview cannot succeed where the call fails.
 */
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

/**
 * Bypass (spec §5.5), under the project lock and the Zero Trust lock. Checks items 1–2
 * and that no urgent finding is open; skips the scan and the proof of `fixed` claims.
 * The caller has already refused a Zero Trust installation that is not ready.
 */
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
      await writeEvent(complete, {
        projectId: input.projectId,
        action: 'scan_bypassed',
        actor,
        requestId: open.id,
        state: 'bypassed',
      });
      // Ids only: the audit row outlives the project and carries no reason text. An
      // installation admin's bypass is audited by the operator API or the admin panel
      // around this call, so it writes no second row.
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

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

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
  const closed = await closeRequest(tx, open, 'canceled', {
    cause: 'protect',
    userId: actor.userId,
  });
  await writeEvent(tx, {
    projectId,
    action: 'public_canceled',
    actor,
    requestId: open.id,
    state: 'canceled',
  });
  return closed;
}

/**
 * The gate (or the whole policy) was turned off: every open request is canceled, the
 * projects stay protected, and requester + owner + admins are told (queued here, in the
 * policy transaction). Returns the canceled requests.
 */
export async function cancelAllOpenRequests(
  tx: DbOrTx,
  cause: 'gate_off' | 'policy_off',
  actor: GateActor = SYSTEM,
): Promise<ReadonlyArray<PublicRequestRow>> {
  const rows = await tx
    .select()
    .from(securityPublicRequests)
    .where(inArray(securityPublicRequests.state, [...SECURITY_PUBLIC_REQUEST_OPEN_STATES]))
    .orderBy(securityPublicRequests.created_at);
  const closed: Array<PublicRequestRow> = [];
  for (const row of rows) {
    const next = await closeRequest(tx, row, 'canceled', { cause, userId: actor.userId });
    await writeEvent(tx, {
      projectId: row.project_id,
      action: 'public_canceled',
      actor,
      requestId: row.id,
      state: 'canceled',
    });
    await enqueueSecurityNotification(tx, {
      kind: 'public_canceled',
      projectId: row.project_id,
      requestId: row.id,
    });
    closed.push(next);
  }
  return closed;
}

/** The open requests, for the turn-off preview (spec §5.5, edge #66). */
export async function listOpenRequestSlugs(db: DbOrTx): Promise<Array<string>> {
  const rows = await db
    .select({ slug: projects.slug })
    .from(securityPublicRequests)
    .innerJoin(projects, eq(projects.id, securityPublicRequests.project_id))
    .where(inArray(securityPublicRequests.state, [...SECURITY_PUBLIC_REQUEST_OPEN_STATES]))
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
        inArray(securityPublicRequests.state, [...SECURITY_PUBLIC_REQUEST_OPEN_STATES]),
        ne(securityPublicRequests.target_deployment_id, deploymentId),
      ),
    );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

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
  let requestedByRole: string | null = null;
  if (request.requested_via !== 'project') {
    requestedByRole = 'installation_admin';
  } else if (request.requested_by_user_id !== null) {
    requestedByRole = await projectRoleForUser(
      db as Parameters<typeof projectRoleForUser>[0],
      request.project_id,
      request.requested_by_user_id,
    );
  }
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
