/**
 * The installation security audit policy store (spec §5.3, §5.4): lenient and strict
 * readers of the `platform_settings` row, the locked revision CAS write, and the
 * operator change operation with its `dryRun` preview text. The admin panel (M18) and
 * the operator CLI share `changeSecurityPolicy`.
 */
import {
  getSecurityModel,
  isSecurityModelId,
  isSecurityModelPriced,
  isThirdPartySecurityModel,
  SECURITY_MODEL_IDS,
  SECURITY_PROVIDER_NAMES,
  SECURITY_PROVIDER_NOTICE_VERSION,
  securityModelBadges,
  securityModelThirdPartyHost,
  securityProviderNotice,
  type SecurityModelId,
} from '@void/platform/security-models';
import {
  defaultSecurityPolicy,
  isSecurityEntitlementFresh,
  isSecurityMode,
  parseSecurityLimitsPatch,
  parseSecurityPolicy,
  parseSecuritySweepDays,
  readSecurityPolicy,
  SECURITY_LIMIT_KEYS,
  SECURITY_MODE_LABELS,
  SECURITY_POLICY_SETTINGS_KEY,
  type SecurityLimitKey,
  type SecurityMode,
  type SecurityPolicy,
  type SecurityEntitlement,
  type SecurityPolicyLimits,
  type SecuritySweeps,
  type SecurityThirdPartyNotice,
} from '@void/platform/security-policy';
import { and, count, eq, gte, inArray, notLike, sql, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import { getPlatformSetting, setPlatformSetting } from '../platform-settings.ts';
import { projects, projectZeroTrust } from '../schema.ts';
import {
  readZeroTrustConfigurationStrict,
  zeroTrustConfigurationStatus,
} from '../zero-trust/configuration.ts';
import { lockZeroTrustConfiguration } from '../zero-trust/lock.ts';
import { SecurityApiError, SecurityPolicyUnreadableError } from './errors.ts';
import type { SecurityProbeReport } from './probe.ts';
import { cancelAllOpenRequests, listOpenRequestSlugs } from './public-gate.ts';
import { countSecurityScanCandidates } from './scan-candidates.ts';
import {
  projectSecuritySettings,
  securityPlatformSpend,
  securityScans,
  type SecurityScanStatus,
} from './schema.ts';

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** The stored row as read. `unreadable` holds the reason when the row is bad data. */
export type StoredSecurityPolicy = Readonly<{
  policy: SecurityPolicy;
  /** A row exists (readable or not). */
  saved: boolean;
  unreadable: string | null;
}>;

function storedRevision(value: unknown): number {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const revision = (value as Record<string, unknown>).revision;
    if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) {
      return revision;
    }
  }
  return 0;
}

/**
 * Reads a stored value. Bad data reads as the default policy (mode `disabled`) with
 * the stored revision when it has one, so a later write can still replace it.
 */
export function interpretStoredSecurityPolicy(value: unknown): StoredSecurityPolicy {
  if (value === null || value === undefined) {
    return { policy: defaultSecurityPolicy(), saved: false, unreadable: null };
  }
  try {
    return { policy: readSecurityPolicy(value), saved: true, unreadable: null };
  } catch (error) {
    return {
      policy: { ...defaultSecurityPolicy(), revision: storedRevision(value) },
      saved: true,
      unreadable: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

export async function readStoredSecurityPolicy(db: DbOrTx): Promise<StoredSecurityPolicy> {
  const stored = interpretStoredSecurityPolicy(
    await getPlatformSetting(db, SECURITY_POLICY_SETTINGS_KEY),
  );
  if (stored.unreadable !== null) {
    console.error(
      `[security-policy] ${SECURITY_POLICY_SETTINGS_KEY} is malformed; reading it as disabled: ${stored.unreadable}`,
    );
  }
  return stored;
}

/** Lenient reader for scan paths: bad data reads as `disabled` and is logged. */
export async function readSecurityPolicyLenient(db: DbOrTx): Promise<SecurityPolicy> {
  return (await readStoredSecurityPolicy(db)).policy;
}

/**
 * Strict reader for paths that must fail closed (the public gate and its Zero Trust
 * refusals). Bad data throws `SecurityPolicyUnreadableError` (503). A missing row is
 * the default policy.
 */
export async function readSecurityPolicyStrict(db: DbOrTx): Promise<SecurityPolicy> {
  const stored = interpretStoredSecurityPolicy(
    await getPlatformSetting(db, SECURITY_POLICY_SETTINGS_KEY),
  );
  if (stored.unreadable !== null) {
    throw new SecurityPolicyUnreadableError(stored.unreadable);
  }
  return stored.policy;
}

/** Every policy writer takes this lock first, then checks the revision it read. */
export async function lockSecurityPolicy(tx: DbOrTx): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('void:platform:security-policy', 0))`,
  );
}

/** Takes the policy lock shared: a gate check runs while no policy writer does (design doc 0095 M16). */
export async function lockSecurityPolicyShared(tx: DbOrTx): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('void:platform:security-policy', 0))`,
  );
}

/**
 * Writes `next` with the revision after `current`'s. Call under `lockSecurityPolicy`
 * in the transaction that read `current`. Throws when `next` breaks a policy rule.
 */
export async function replaceSecurityPolicy(
  tx: DbOrTx,
  current: SecurityPolicy,
  next: SecurityPolicy,
): Promise<SecurityPolicy> {
  const written = parseSecurityPolicy({ ...next, revision: current.revision + 1 });
  await setPlatformSetting(tx, SECURITY_POLICY_SETTINGS_KEY, written);
  return written;
}

// ---------------------------------------------------------------------------
// Change request
// ---------------------------------------------------------------------------

export type SecurityPolicyChangeRequest = Readonly<{
  expectedRevision?: number;
  mode?: SecurityMode;
  defaultModel?: SecurityModelId;
  /** Replaces the whole blocked list (admin panel checkboxes). */
  blockedModels?: ReadonlyArray<SecurityModelId>;
  /** Adds to and removes from the blocked list (CLI `--block` / `--unblock`). */
  block?: ReadonlyArray<SecurityModelId>;
  unblock?: ReadonlyArray<SecurityModelId>;
  /** The provider notice version the admin read and accepted. */
  acceptProviderNoticeVersion?: number;
  limits?: Partial<SecurityPolicyLimits>;
  publicGate?: boolean;
  /** Scheduled full sweeps; a field left out keeps its value. */
  sweeps?: Partial<SecuritySweeps>;
}>;

const REQUEST_KEYS = new Set([
  'dryRun',
  'expectedRevision',
  'mode',
  'defaultModel',
  'blockedModels',
  'block',
  'unblock',
  'acceptProviderNoticeVersion',
  'limits',
  'publicGate',
  'sweeps',
]);

function requestModel(value: unknown, label: string): SecurityModelId {
  if (!isSecurityModelId(value)) {
    throw SecurityApiError.of(
      'modelNotAllowed',
      `${label} must be one of: ${SECURITY_MODEL_IDS.join(', ')}.`,
    );
  }
  return value;
}

function requestModels(value: unknown, label: string): ReadonlyArray<SecurityModelId> {
  if (!Array.isArray(value) || value.length > SECURITY_MODEL_IDS.length * 2) {
    throw SecurityApiError.invalid(`${label} must be a list of model IDs.`);
  }
  const ids: Array<SecurityModelId> = [];
  for (const entry of value) {
    const id = requestModel(entry, `Each model in ${label}`);
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function wholeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw SecurityApiError.invalid(`${label} must be a nonnegative whole number.`);
  }
  return value;
}

/** Parses an operator change body. Unknown fields are refused so a typo is not ignored. */
export function parseSecurityPolicyChangeRequest(
  body: Record<string, unknown>,
): SecurityPolicyChangeRequest {
  for (const key of Object.keys(body)) {
    if (!REQUEST_KEYS.has(key)) {
      throw SecurityApiError.invalid(`Unknown security policy field: ${key}.`);
    }
  }
  if (
    body.blockedModels !== undefined &&
    (body.block !== undefined || body.unblock !== undefined)
  ) {
    throw SecurityApiError.invalid('Send blockedModels, or block and unblock, not both.');
  }
  const request: {
    -readonly [Key in keyof SecurityPolicyChangeRequest]: SecurityPolicyChangeRequest[Key];
  } = {};
  if (body.expectedRevision !== undefined) {
    request.expectedRevision = wholeNumber(body.expectedRevision, 'expectedRevision');
  }
  if (body.mode !== undefined) {
    if (!isSecurityMode(body.mode)) {
      throw SecurityApiError.invalid('mode must be disabled, public or all.');
    }
    request.mode = body.mode;
  }
  if (body.defaultModel !== undefined) {
    request.defaultModel = requestModel(body.defaultModel, 'defaultModel');
  }
  if (body.blockedModels !== undefined) {
    request.blockedModels = requestModels(body.blockedModels, 'blockedModels');
  }
  if (body.block !== undefined) {
    request.block = requestModels(body.block, 'block');
  }
  if (body.unblock !== undefined) {
    request.unblock = requestModels(body.unblock, 'unblock');
  }
  const both = (request.block ?? []).filter((id) => request.unblock?.includes(id));
  if (both.length > 0) {
    throw SecurityApiError.invalid(`A model cannot be blocked and unblocked at once: ${both[0]}.`);
  }
  if (body.acceptProviderNoticeVersion !== undefined) {
    request.acceptProviderNoticeVersion = wholeNumber(
      body.acceptProviderNoticeVersion,
      'acceptProviderNoticeVersion',
    );
  }
  if (body.limits !== undefined) {
    try {
      request.limits = parseSecurityLimitsPatch(body.limits);
    } catch (error) {
      throw SecurityApiError.invalid(error instanceof Error ? error.message : 'Invalid limits.');
    }
  }
  if (body.publicGate !== undefined) {
    if (typeof body.publicGate !== 'boolean') {
      throw SecurityApiError.invalid('publicGate must be true or false.');
    }
    request.publicGate = body.publicGate;
  }
  if (body.sweeps !== undefined) {
    request.sweeps = parseSweepsRequest(body.sweeps);
  }
  return request;
}

function parseSweepsRequest(value: unknown): Partial<SecuritySweeps> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw SecurityApiError.invalid('sweeps must be an object with on and everyDays.');
  }
  const input = value as Record<string, unknown>;
  const sweeps: { on?: boolean; everyDays?: number } = {};
  for (const key of Object.keys(input)) {
    if (key !== 'on' && key !== 'everyDays') {
      throw SecurityApiError.invalid(`Unknown sweeps field: ${key}.`);
    }
  }
  if (input.on !== undefined) {
    if (typeof input.on !== 'boolean') {
      throw SecurityApiError.invalid('sweeps.on must be true or false.');
    }
    sweeps.on = input.on;
  }
  if (input.everyDays !== undefined) {
    try {
      sweeps.everyDays = parseSecuritySweepDays(input.everyDays);
    } catch (error) {
      throw SecurityApiError.invalid(error instanceof Error ? error.message : 'Invalid sweeps.');
    }
  }
  if (sweeps.on === undefined && sweeps.everyDays === undefined) {
    throw SecurityApiError.invalid('sweeps needs on, everyDays or both.');
  }
  return sweeps;
}

// ---------------------------------------------------------------------------
// Proposal (pure)
// ---------------------------------------------------------------------------

export type SecurityPolicyChanges = Readonly<{
  mode: Readonly<{ from: SecurityMode; to: SecurityMode }> | null;
  defaultModel: Readonly<{ from: SecurityModelId; to: SecurityModelId }> | null;
  blocked: ReadonlyArray<SecurityModelId>;
  unblocked: ReadonlyArray<SecurityModelId>;
  noticeAccepted: number | null;
  limits: ReadonlyArray<Readonly<{ key: SecurityLimitKey; from: number; to: number }>>;
  publicGateOn: boolean;
  publicGateOff: boolean;
  sweeps: Readonly<{ from: SecuritySweeps; to: SecuritySweeps }> | null;
  /** The stored row was bad data; this write replaces it. */
  repaired: boolean;
}>;

export type SecurityPolicyProposal = Readonly<{
  next: SecurityPolicy;
  changes: SecurityPolicyChanges;
}>;

export type SecurityPolicyChangeContext = Readonly<{
  userId: string;
  now: number;
  /**
   * A probe that just ran (the policy change re-runs it when it leaves `disabled`).
   * It replaces the stored result and is what the turn-on check reads.
   */
  entitlement?: SecurityEntitlement;
  /** A preview of a change whose apply runs the probe: the stored result is not checked. */
  probeOnApply?: boolean;
  /**
   * Installation Zero Trust as the public gate needs it. Left out, the gate cannot turn
   * on (it is read under the Zero Trust lock by `changeSecurityPolicy`).
   */
  zeroTrust?: SecurityZeroTrustFact;
}>;

/** Installation Zero Trust, as far as the public gate cares (spec §5.5 turn-on table). */
export type SecurityZeroTrustFact = 'enabled' | 'off' | 'public_only' | 'operation';

function noticeIsCurrent(notice: SecurityThirdPartyNotice | null): boolean {
  return notice !== null && notice.version === SECURITY_PROVIDER_NOTICE_VERSION;
}

function nextBlockedModels(
  current: ReadonlyArray<SecurityModelId>,
  request: SecurityPolicyChangeRequest,
): ReadonlyArray<SecurityModelId> {
  if (request.blockedModels) {
    return SECURITY_MODEL_IDS.filter((id) => request.blockedModels?.includes(id));
  }
  return SECURITY_MODEL_IDS.filter(
    (id) => (current.includes(id) || request.block?.includes(id)) && !request.unblock?.includes(id),
  );
}

function assertDefaultModel(
  next: SecurityPolicy,
  request: SecurityPolicyChangeRequest,
  probeRunsOnApply: boolean,
): void {
  const id = next.defaultModel;
  if (next.blockedModels.includes(id)) {
    throw SecurityApiError.of(
      'modelNotAllowed',
      request.defaultModel
        ? `${id} is blocked. Unblock it to make it the default model.`
        : `${id} is the default model. Pick another default model before blocking it.`,
      { model: id },
    );
  }
  if (!isSecurityModelPriced(id)) {
    throw SecurityApiError.of(
      'modelNotAllowed',
      `${id} has no list price yet, so its scans cannot be metered. It can be picked after a platform release adds the price.`,
      { model: id },
    );
  }
  const host = securityModelThirdPartyHost(id);
  if (!host || request.defaultModel === undefined) {
    return;
  }
  // The apply re-runs the probe and checks the host against that fresh result.
  if (!probeRunsOnApply && !next.entitlement?.hosts[host]) {
    throw SecurityApiError.of(
      'modelNotAllowed',
      `${host}/* models cannot be picked: they were not ready in the last probe (check 5: AI Gateway credits or the scanner image). See the check 5 lines of: void platform security probe`,
      { model: id, host },
    );
  }
  if (!noticeIsCurrent(next.thirdPartyNotice)) {
    throw SecurityApiError.of(
      'providerNoticeNotAccepted',
      `${id} is run by ${SECURITY_PROVIDER_NAMES[host]}. Read the provider notice, then accept it to make ${id} the default: void platform security models --default ${id} --accept-provider-notice`,
      {
        model: id,
        version: SECURITY_PROVIDER_NOTICE_VERSION,
        notice: securityProviderNotice(host),
      },
    );
  }
}

function assertEntitlement(policy: SecurityPolicy, now: number): void {
  const entitlement = policy.entitlement;
  if (isSecurityEntitlementFresh(entitlement, now)) {
    return;
  }
  if (!entitlement) {
    throw SecurityApiError.of(
      'entitlementMissing',
      'Run the entitlement probe before turning security audits on: void platform security probe',
      { missing: ['probe'], checkedAt: null },
    );
  }
  if (entitlement.ok) {
    throw SecurityApiError.of(
      'entitlementMissing',
      'The last entitlement probe is more than 24 hours old. Run it again: void platform security probe',
      { missing: ['probe'], checkedAt: entitlement.checkedAt },
    );
  }
  throw SecurityApiError.of(
    'entitlementMissing',
    `The last entitlement probe failed (${entitlement.missing.join(', ')}). Fix it and run: void platform security probe`,
    { missing: entitlement.missing, checkedAt: entitlement.checkedAt },
  );
}

function probeRunsOnApply(
  current: SecurityPolicy,
  mode: SecurityMode,
  context: SecurityPolicyChangeContext,
): boolean {
  return context.probeOnApply === true && current.mode === 'disabled' && mode !== 'disabled';
}

/** The turn-on conditions of "Scan before a project goes public" (spec §5.5), one message per reason. */
function assertPublicGateTurnsOn(
  mode: SecurityMode,
  next: SecurityPolicy,
  context: SecurityPolicyChangeContext,
  probeRunsOnApply: boolean,
): void {
  if (mode === 'disabled') {
    throw SecurityApiError.of(
      'publicGateNeedsPolicy',
      'Set the policy to Public projects only or All projects first: void platform security policy public',
    );
  }
  if (!probeRunsOnApply && !isSecurityEntitlementFresh(next.entitlement, context.now)) {
    throw SecurityApiError.of('entitlementMissing', 'Run void platform security probe first.', {
      missing: next.entitlement && !next.entitlement.ok ? next.entitlement.missing : ['probe'],
      checkedAt: next.entitlement?.checkedAt ?? null,
    });
  }
  switch (context.zeroTrust) {
    case 'enabled':
      return;
    case 'public_only':
      throw SecurityApiError.of(
        'publicGateNeedsZeroTrust',
        'Turn off public-only mode first: run void platform zero-trust configure with identity providers and policies.',
      );
    case 'operation':
      throw SecurityApiError.of(
        'publicGateNeedsZeroTrust',
        'Wait for the Zero Trust change to finish, then try again.',
      );
    default:
      throw SecurityApiError.of(
        'publicGateNeedsZeroTrust',
        'Turn on platform Zero Trust first: void platform zero-trust configure …',
      );
  }
}

/**
 * The policy after `request`, with every rule checked. Throws `SecurityApiError` for
 * a refused change. Leaving `disabled` needs a probe pass less than 24 hours old;
 * turning the policy Off also turns "Scan before a project goes public" off.
 */
export function proposeSecurityPolicyChange(
  stored: StoredSecurityPolicy,
  request: SecurityPolicyChangeRequest,
  context: SecurityPolicyChangeContext,
): SecurityPolicyProposal {
  const current = stored.policy;
  let thirdPartyNotice = current.thirdPartyNotice;
  if (request.acceptProviderNoticeVersion !== undefined) {
    if (request.acceptProviderNoticeVersion !== SECURITY_PROVIDER_NOTICE_VERSION) {
      throw SecurityApiError.of(
        'providerNoticeNotAccepted',
        `The provider notice changed (now version ${SECURITY_PROVIDER_NOTICE_VERSION}). Read it again and accept the new version.`,
        { version: SECURITY_PROVIDER_NOTICE_VERSION },
      );
    }
    thirdPartyNotice = {
      acceptedByUserId: context.userId,
      acceptedAt: new Date(context.now).toISOString(),
      version: SECURITY_PROVIDER_NOTICE_VERSION,
    };
  }
  const mode = request.mode ?? current.mode;
  const limits = { ...current.limits, ...request.limits };
  const next: SecurityPolicy = {
    ...current,
    mode,
    defaultModel: request.defaultModel ?? current.defaultModel,
    blockedModels: nextBlockedModels(current.blockedModels, request),
    thirdPartyNotice,
    limits,
    entitlement: context.entitlement ?? current.entitlement,
    // Policy Off turns the gate off in the same change.
    publicGate: mode === 'disabled' ? false : (request.publicGate ?? current.publicGate),
    sweeps: { ...current.sweeps, ...request.sweeps },
  };
  const probeApplies = probeRunsOnApply(current, mode, context);
  if (request.publicGate === true) {
    assertPublicGateTurnsOn(mode, next, context, probeApplies);
  }
  assertDefaultModel(next, request, probeApplies);
  if (current.mode === 'disabled' && mode !== 'disabled' && !probeApplies) {
    assertEntitlement(next, context.now);
  }
  const changes: SecurityPolicyChanges = {
    mode: mode === current.mode ? null : { from: current.mode, to: mode },
    defaultModel:
      next.defaultModel === current.defaultModel
        ? null
        : { from: current.defaultModel, to: next.defaultModel },
    blocked: next.blockedModels.filter((id) => !current.blockedModels.includes(id)),
    unblocked: current.blockedModels.filter((id) => !next.blockedModels.includes(id)),
    noticeAccepted: request.acceptProviderNoticeVersion ?? null,
    limits: SECURITY_LIMIT_KEYS.flatMap((key) =>
      limits[key] === current.limits[key]
        ? []
        : [{ key, from: current.limits[key], to: limits[key] }],
    ),
    publicGateOn: !current.publicGate && next.publicGate,
    publicGateOff: current.publicGate && !next.publicGate,
    sweeps:
      next.sweeps.on === current.sweeps.on && next.sweeps.everyDays === current.sweeps.everyDays
        ? null
        : { from: current.sweeps, to: next.sweeps },
    repaired: stored.unreadable !== null,
  };
  const changed =
    changes.mode ||
    changes.defaultModel ||
    changes.blocked.length > 0 ||
    changes.unblocked.length > 0 ||
    changes.noticeAccepted !== null ||
    changes.limits.length > 0 ||
    changes.publicGateOn ||
    changes.publicGateOff ||
    changes.sweeps !== null ||
    changes.repaired;
  if (!changed) {
    throw SecurityApiError.invalid('Nothing to change: the policy already has these values.');
  }
  try {
    parseSecurityPolicy(next);
  } catch (error) {
    throw SecurityApiError.invalid(
      error instanceof Error ? error.message : 'Invalid security policy.',
    );
  }
  return { next, changes };
}

// ---------------------------------------------------------------------------
// Preview (spec §5.4)
// ---------------------------------------------------------------------------

export type SecurityPolicyPreviewCounts = Readonly<{
  /** Projects in scope for the new mode (Off → on). */
  scannedProjects: number;
  /** Of those, projects with no succeeded scan: their first scan is a full scan. */
  firstFullScan: number;
  /** Of those, projects with an open urgent finding. */
  urgentProjects: number;
  /** Projects protected by Zero Trust right now. */
  protectedProjects: number;
  /** Scans `pending_input` or `queued`. */
  queuedScans: number;
  runningScans: number;
  /** Projects with no model of their own. */
  noOwnModel: number;
  /** Of those, projects that accepted the current provider notice. */
  noOwnModelAccepted: number;
  /** Projects whose own pick is a newly blocked model, per model. */
  pickedBlocked: Readonly<Partial<Record<SecurityModelId, number>>>;
  /**
   * Of those, projects that accepted the current provider notice. Read only when the
   * new default is third-party: the others stay on `securityFallbackModel` (spec §8.3).
   */
  pickedBlockedAccepted: Readonly<Partial<Record<SecurityModelId, number>>>;
  /** Only with a public gate change (spec §5.5). */
  gate?: SecurityPolicyGateCounts;
  /** Only when sweeps turn on or change: projects due for a sweep now. */
  sweepProjects?: number;
}>;

export type SecurityPolicyGateCounts = Readonly<{
  /** Turning on: protected projects the gate covers. */
  protectedProjects: number;
  /** Turning on: projects already going public; they finish going public (edge #87). */
  goingPublic: number;
  /** Turning on: new projects start public, so they are not gated. */
  newProjectsStartPublic: boolean;
  /** Turning off: slugs with an open request; the requests are canceled. */
  openRequests: ReadonlyArray<string>;
}>;

function projectsText(count: number, adjective = ''): string {
  const noun = count === 1 ? 'project' : 'projects';
  return `${count} ${adjective ? `${adjective} ` : ''}${noun}`;
}

function scansText(count: number, adjective: string): string {
  return `${count} ${adjective} ${count === 1 ? 'scan' : 'scans'}`;
}

/** The first non-blocked, priced `@cf` model: where a project without the notice stays. */
export function securityFallbackModel(
  blocked: ReadonlyArray<SecurityModelId>,
): SecurityModelId | null {
  return (
    SECURITY_MODEL_IDS.find(
      (id) => !isThirdPartySecurityModel(id) && isSecurityModelPriced(id) && !blocked.includes(id),
    ) ?? null
  );
}

function openRequestLines(counts: SecurityPolicyPreviewCounts): Array<string> {
  const open = counts.gate?.openRequests ?? [];
  if (open.length === 0) {
    return [];
  }
  return [
    `  ${open.length} open public ${open.length === 1 ? 'request is' : 'requests are'} canceled; ${open.length === 1 ? 'the project stays' : 'the projects stay'} protected: ${open.slice(0, 10).join(', ')}${open.length > 10 ? `, and ${open.length - 10} more` : ''}`,
    '  The owners and project admins get an email.',
  ];
}

function modeLines(
  current: SecurityPolicy,
  next: SecurityPolicy,
  counts: SecurityPolicyPreviewCounts,
): Array<string> {
  const from = current.mode;
  const to = next.mode;
  const lines = [`Change policy: ${SECURITY_MODE_LABELS[from]} → ${SECURITY_MODE_LABELS[to]}`];
  if (from === 'disabled') {
    lines.push(`  ${projectsText(counts.scannedProjects)} will be scanned at their next deploy.`);
    if (counts.scannedProjects > 0 && counts.firstFullScan === counts.scannedProjects) {
      lines.push(
        '  The first scan of each project reviews the whole app (no earlier scan to compare to).',
      );
    } else if (counts.firstFullScan > 0) {
      lines.push(
        `  ${counts.firstFullScan} of them ${counts.firstFullScan === 1 ? 'has' : 'have'} no earlier scan: their first scan reviews the whole app.`,
      );
    }
    if (counts.urgentProjects > 0) {
      lines.push(
        `  ${projectsText(counts.urgentProjects)} still ${counts.urgentProjects === 1 ? 'has' : 'have'} open urgent findings from before. They show in those projects' deploy output again.`,
      );
    }
    if (!next.budgets.platformCapOn && !next.budgets.projectCapsOn) {
      lines.push(
        '  Monthly scan budgets are off (no money limit). Set them with: void platform security budget',
      );
    }
    return lines;
  }
  if (to === 'disabled') {
    lines.push('  New deploys are not scanned.');
    if (counts.queuedScans > 0) {
      lines.push(
        `  ${scansText(counts.queuedScans, 'queued')} ${counts.queuedScans === 1 ? 'is' : 'are'} canceled.`,
      );
    }
    if (counts.runningScans > 0) {
      lines.push(
        `  ${scansText(counts.runningScans, 'running')} ${counts.runningScans === 1 ? 'finishes and is' : 'finish and are'} stored, with no email.`,
      );
    }
    lines.push(
      '  Open findings stay listed and can still be read, commented on and resolved. Only the deploy-time notice stops.',
    );
    if (current.publicGate) {
      lines.push('  "Scan before a project goes public" turns off too.');
      lines.push(...openRequestLines(counts));
    }
    return lines;
  }
  if (to === 'public') {
    lines.push(
      `  ${projectsText(counts.protectedProjects, 'protected')} ${counts.protectedProjects === 1 ? 'is' : 'are'} no longer scanned at deploy. ${current.publicGate ? 'Gate scans still run; running scans finish.' : 'Running scans finish.'}`,
    );
  } else {
    lines.push(
      `  ${projectsText(counts.protectedProjects, 'protected')} will also be scanned at their next deploy.`,
    );
  }
  return lines;
}

/**
 * Which model `total` projects move to when the installation default applies to them.
 * A third-party default reaches only the `accepted` ones (current provider notice); the
 * others stay on the first non-blocked `@cf` model (spec §8.3).
 */
function defaultModelOutcome(
  next: SecurityPolicy,
  modelText: string,
  total: number,
  accepted: number,
): string {
  const host = securityModelThirdPartyHost(next.defaultModel);
  if (!host || (accepted === total && total > 0)) {
    return total === 1
      ? `It uses ${modelText} from its next scan.`
      : `They use ${modelText} from their next scan.`;
  }
  const fallback = securityFallbackModel(next.blockedModels) ?? 'no model';
  const notice = `until a project owner or admin accepts the ${SECURITY_PROVIDER_NAMES[host]} notice.`;
  if (accepted === 0) {
    return `${total === 1 ? 'It stays' : 'They stay'} on ${fallback} ${notice}`;
  }
  const waiting = total - accepted;
  return `${accepted} of them accepted the provider notice and use ${modelText} from their next scan; the other ${waiting} ${waiting === 1 ? 'stays' : 'stay'} on ${fallback} ${notice}`;
}

function defaultModelLines(
  next: SecurityPolicy,
  change: Readonly<{ from: SecurityModelId; to: SecurityModelId }>,
  counts: SecurityPolicyPreviewCounts,
): Array<string> {
  const subject = `  ${projectsText(counts.noOwnModel)} ${counts.noOwnModel === 1 ? 'has' : 'have'} no model of ${counts.noOwnModel === 1 ? 'its' : 'their'} own.`;
  return [
    `Change default model: ${change.from} → ${change.to}`,
    `${subject} ${defaultModelOutcome(next, change.to, counts.noOwnModel, counts.noOwnModelAccepted)}`,
  ];
}

function sweepLines(
  next: SecurityPolicy,
  change: Readonly<{ from: SecuritySweeps; to: SecuritySweeps }>,
  projects: number,
): Array<string> {
  const { from, to: sweeps } = change;
  const interval = `Sweep interval: ${from.everyDays} → ${sweeps.everyDays} days.`;
  if (!sweeps.on) {
    return from.on
      ? ['Turn off: scheduled full sweeps. Sweeps already queued still run.']
      : [`${interval} Sweeps stay off.`];
  }
  const lines = from.on
    ? [interval]
    : [
        `Turn on: scheduled full sweeps, every ${sweeps.everyDays} days. Each sweep reviews the whole live app with the deeper profile, so it costs more than a deploy scan.`,
      ];
  if (next.mode === 'disabled') {
    lines.push('  The policy is Off, so no sweep runs until it is turned on.');
  } else {
    lines.push(
      `  ${projectsText(projects)} in scope ${projects === 1 ? 'has' : 'have'} not had a full scan in the last ${sweeps.everyDays} days. The hourly job sweeps a few at a time; monthly caps apply.`,
    );
  }
  return lines;
}

/** The plan preview shown before saving (`dryRun`), one string per line. */
export function securityPolicyPreviewLines(
  current: SecurityPolicy,
  next: SecurityPolicy,
  changes: SecurityPolicyChanges,
  counts: SecurityPolicyPreviewCounts,
): ReadonlyArray<string> {
  const lines: Array<string> = [];
  if (changes.repaired) {
    lines.push('The saved policy could not be read. Saving replaces it, starting from Off.');
  }
  if (changes.mode) {
    lines.push(...modeLines(current, next, counts));
  }
  if (changes.noticeAccepted !== null) {
    lines.push(`Provider notice accepted (version ${changes.noticeAccepted}).`);
  }
  if (changes.defaultModel) {
    lines.push(...defaultModelLines(next, changes.defaultModel, counts));
  }
  for (const id of changes.blocked) {
    const picked = counts.pickedBlocked[id] ?? 0;
    const accepted = counts.pickedBlockedAccepted[id] ?? 0;
    lines.push(
      picked > 0
        ? `Block ${id}: ${projectsText(picked)} picked it. ${defaultModelOutcome(next, `the default model (${next.defaultModel})`, picked, accepted)}`
        : `Block ${id}: no project picked it.`,
    );
  }
  for (const id of changes.unblocked) {
    lines.push(`Unblock ${id}: project owners and admins can pick it again.`);
  }
  if (changes.limits.length > 0) {
    lines.push(
      `Limits: ${changes.limits.map((limit) => `${limit.key} ${limit.from} → ${limit.to}`).join(', ')}`,
    );
  }
  if (changes.publicGateOn) {
    lines.push('Turn on: Scan before a project goes public');
    const gate = counts.gate;
    lines.push(
      `  Asking to make one of ${projectsText(gate?.protectedProjects ?? 0, 'protected')} public scans its live deployment first. It stays protected until the scan passes or a project admin bypasses it with a reason.`,
    );
    if ((gate?.goingPublic ?? 0) > 0) {
      lines.push(
        `  ${projectsText(gate?.goingPublic ?? 0)} already going public finish going public (asked before the gate).`,
      );
    }
    if (gate?.newProjectsStartPublic) {
      lines.push(
        '  New projects start public, so they are not gated. Turn on "protect new projects" in Zero Trust to cover them.',
      );
    }
    lines.push(
      '  While it is on, installation Zero Trust cannot be turned off or switched to public-only mode.',
    );
  }
  if (changes.publicGateOff && !changes.mode) {
    lines.push('Turn off: Scan before a project goes public');
    lines.push(...openRequestLines(counts));
  }
  if (changes.sweeps) {
    lines.push(...sweepLines(next, changes.sweeps, counts.sweepProjects ?? 0));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

const QUEUED_STATUSES = [
  'pending_input',
  'queued',
] as const satisfies ReadonlyArray<SecurityScanStatus>;

/** Scans that count toward the 24-hour failure rate. */
const FAILED_STATUSES = [
  'failed',
  'refused',
  'timed_out',
  'incomplete',
] as const satisfies ReadonlyArray<SecurityScanStatus>;

type ProjectScope = 'all' | 'public' | 'protected';

/**
 * Project protection as spec §4 defines it (fail-safe): protected only while
 * installation Zero Trust is on and not public-only, and the project row is settled
 * protected. Bad Zero Trust data reads as "everything public".
 */
export async function installationZeroTrustProtects(db: DbOrTx): Promise<boolean> {
  try {
    const configuration = await readZeroTrustConfigurationStrict(db);
    return !!configuration?.enabled && !configuration.publicAccess;
  } catch {
    return false;
  }
}

const protectedRow = sql`(${projectZeroTrust.status} = 'ready' AND ${projectZeroTrust.desired_protected} AND ${projectZeroTrust.effective_protected})`;

async function countProjects(
  db: DbOrTx,
  scope: ProjectScope,
  protects: boolean,
  extra?: SQL,
): Promise<number> {
  const scopeCondition =
    scope === 'all'
      ? undefined
      : scope === 'protected'
        ? protects
          ? protectedRow
          : sql`false`
        : protects
          ? sql`NOT COALESCE(${protectedRow}, false)`
          : undefined;
  const [row] = await db
    .select({ total: count() })
    .from(projects)
    .leftJoin(projectZeroTrust, eq(projectZeroTrust.project_id, projects.id))
    .leftJoin(projectSecuritySettings, eq(projectSecuritySettings.project_id, projects.id))
    .where(
      and(
        eq(projects.status, 'active'),
        // Preview projects are never scanned.
        notLike(projects.slug, 'preview-%'),
        scopeCondition,
        extra,
      ),
    );
  return row?.total ?? 0;
}

async function countScans(
  db: DbOrTx,
  statuses: ReadonlyArray<SecurityScanStatus>,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(securityScans)
    .where(inArray(securityScans.status, [...statuses]));
  return row?.total ?? 0;
}

const noSucceededScan = sql`NOT EXISTS (SELECT 1 FROM security_scans s WHERE s.project_id = ${projects.id} AND s.status = 'succeeded')`;
const openUrgentFinding = sql`EXISTS (SELECT 1 FROM security_findings f WHERE f.project_id = ${projects.id} AND f.verdict = 'confirmed' AND COALESCE(f.severity_override, f.severity) IN ('critical', 'high') AND f.state = 'open')`;

/** Counts behind the preview lines. Only the counts a change needs are read. */
export async function securityPolicyPreviewCounts(
  db: DbOrTx,
  current: SecurityPolicy,
  next: SecurityPolicy,
  changes: SecurityPolicyChanges,
): Promise<SecurityPolicyPreviewCounts> {
  const protects = await installationZeroTrustProtects(db);
  const turningOn = changes.mode?.from === 'disabled';
  const scope: ProjectScope = next.mode === 'public' ? 'public' : 'all';
  const [scannedProjects, firstFullScan, urgentProjects] = turningOn
    ? await Promise.all([
        countProjects(db, scope, protects),
        countProjects(db, scope, protects, noSucceededScan),
        countProjects(db, scope, protects, openUrgentFinding),
      ])
    : [0, 0, 0];
  const betweenOnModes = !!changes.mode && !turningOn && next.mode !== 'disabled';
  const protectedProjects = betweenOnModes ? await countProjects(db, 'protected', protects) : 0;
  const turningOff = changes.mode?.to === 'disabled' && current.mode !== 'disabled';
  const [queuedScans, runningScans] = turningOff
    ? await Promise.all([countScans(db, QUEUED_STATUSES), countScans(db, ['running'])])
    : [0, 0];
  const [noOwnModel, noOwnModelAccepted] = changes.defaultModel
    ? await Promise.all([
        countProjects(db, 'all', protects, sql`${projectSecuritySettings.model} IS NULL`),
        countProjects(
          db,
          'all',
          protects,
          sql`${projectSecuritySettings.model} IS NULL AND ${projectSecuritySettings.provider_notice_version} = ${SECURITY_PROVIDER_NOTICE_VERSION}`,
        ),
      ])
    : [0, 0];
  const pickedBlocked: Partial<Record<SecurityModelId, number>> = {};
  const pickedBlockedAccepted: Partial<Record<SecurityModelId, number>> = {};
  const thirdPartyDefault = isThirdPartySecurityModel(next.defaultModel);
  for (const id of changes.blocked) {
    pickedBlocked[id] = await countProjects(
      db,
      'all',
      protects,
      eq(projectSecuritySettings.model, id),
    );
    if (thirdPartyDefault && (pickedBlocked[id] ?? 0) > 0) {
      pickedBlockedAccepted[id] = await countProjects(
        db,
        'all',
        protects,
        sql`${projectSecuritySettings.model} = ${id} AND ${projectSecuritySettings.provider_notice_version} = ${SECURITY_PROVIDER_NOTICE_VERSION}`,
      );
    }
  }
  return {
    scannedProjects,
    firstFullScan,
    urgentProjects,
    protectedProjects,
    queuedScans,
    runningScans,
    noOwnModel,
    noOwnModelAccepted,
    pickedBlocked,
    pickedBlockedAccepted,
    ...(changes.publicGateOn || changes.publicGateOff
      ? { gate: await gatePreviewCounts(db, changes, protects) }
      : {}),
    ...(changes.sweeps?.to.on
      ? {
          sweepProjects: await countSecurityScanCandidates(db, {
            kind: 'sweep',
            mode: next.mode,
            protects,
            everyDays: changes.sweeps.to.everyDays,
            now: Date.now(),
          }),
        }
      : {}),
  };
}

async function gatePreviewCounts(
  db: DbOrTx,
  changes: SecurityPolicyChanges,
  protects: boolean,
): Promise<SecurityPolicyGateCounts> {
  if (changes.publicGateOff) {
    return {
      protectedProjects: 0,
      goingPublic: 0,
      newProjectsStartPublic: false,
      openRequests: await listOpenRequestSlugs(db),
    };
  }
  const [goingPublic] = await db
    .select({ total: count() })
    .from(projects)
    .innerJoin(projectZeroTrust, eq(projectZeroTrust.project_id, projects.id))
    .where(
      and(
        eq(projects.status, 'active'),
        notLike(projects.slug, 'preview-%'),
        sql`NOT ${projectZeroTrust.desired_protected} AND ${projectZeroTrust.status} <> 'ready'`,
      ),
    );
  let newProjectsStartPublic = false;
  try {
    newProjectsStartPublic =
      (await readZeroTrustConfigurationStrict(db))?.protectNewProjects === false;
  } catch {
    newProjectsStartPublic = false;
  }
  return {
    protectedProjects: await countProjects(db, 'protected', protects),
    goingPublic: goingPublic?.total ?? 0,
    newProjectsStartPublic,
    openRequests: [],
  };
}

/** Installation Zero Trust, as the public gate needs it (spec §5.5 turn-on table). */
export async function readSecurityZeroTrustFact(db: DbOrTx): Promise<SecurityZeroTrustFact> {
  try {
    const configuration = await readZeroTrustConfigurationStrict(db);
    if (!configuration?.enabled) {
      return 'off';
    }
    if (configuration.publicAccess) {
      return 'public_only';
    }
    return zeroTrustConfigurationStatus(configuration) === 'ready' ? 'enabled' : 'operation';
  } catch {
    return 'off';
  }
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

/** The policy plus what the panel and CLI show next to it. */
export function securityPolicyView(stored: StoredSecurityPolicy, capability: boolean, now: number) {
  const { policy } = stored;
  return {
    capability,
    policy,
    unreadable: stored.unreadable,
    entitlementFresh: isSecurityEntitlementFresh(policy.entitlement, now),
    providerNotice: {
      version: SECURITY_PROVIDER_NOTICE_VERSION,
      accepted: noticeIsCurrent(policy.thirdPartyNotice),
    },
    models: SECURITY_MODEL_IDS.map((id) => {
      const model = getSecurityModel(id);
      const host = securityModelThirdPartyHost(id);
      const hostOk = host === null || policy.entitlement?.hosts[host] === true;
      const priced = isSecurityModelPriced(id);
      const blocked = policy.blockedModels.includes(id);
      return {
        id,
        host: model.host,
        engine: model.engine,
        badges: securityModelBadges(id),
        price: model.price,
        priced,
        blocked,
        hostOk,
        pickable: priced && !blocked && hostOk,
        default: policy.defaultModel === id,
      };
    }),
  };
}

export type SecurityPolicyChangeResult =
  | Readonly<{
      dryRun: true;
      action: 'security.policy';
      target: 'platform';
      expectedRevision: number;
      policy: SecurityPolicy;
      changes: SecurityPolicyChanges;
      counts: SecurityPolicyPreviewCounts;
      preview: ReadonlyArray<string>;
    }>
  | Readonly<{
      ok: true;
      policy: SecurityPolicy;
      changes: SecurityPolicyChanges;
      canceledScans: number;
      /** Open public requests the gate-off canceled; the projects stay protected. */
      canceledRequests: number;
    }>;

export class SecurityPolicyRevisionError extends SecurityApiError {
  constructor(expected: number, current: number) {
    super(409, 'revision_conflict', 'The security policy changed. Preview your change again.', {
      expectedRevision: expected,
      currentRevision: current,
    });
  }
}

/**
 * Changes the policy (operator CLI and admin panel). A real change needs
 * `expectedRevision`; a preview takes it optionally and returns the revision to send.
 * Turning the policy Off cancels queued scans in the same transaction; running scans
 * finish.
 */
export async function changeSecurityPolicy(
  db: Db,
  body: Record<string, unknown>,
  options: Readonly<{
    userId: string;
    preview: boolean;
    now?: number;
    /**
     * Runs the entitlement probe (spec §5.2). When given, a change that leaves
     * `disabled` runs it before the write and checks its result instead of the stored
     * one; a failing probe is stored and refuses the change.
     */
    probe?: () => Promise<SecurityProbeReport>;
  }>,
): Promise<SecurityPolicyChangeResult> {
  const request = parseSecurityPolicyChangeRequest(body);
  if (!options.preview && request.expectedRevision === undefined) {
    throw SecurityApiError.invalid(
      'expectedRevision must be the policy revision from a fresh preview.',
    );
  }
  const leavesDisabled = (policy: SecurityPolicy) =>
    policy.mode === 'disabled' && request.mode !== undefined && request.mode !== 'disabled';
  let entitlement: SecurityEntitlement | undefined;
  if (options.probe && !options.preview) {
    const before = await readStoredSecurityPolicy(db);
    if (leavesDisabled(before.policy) && request.expectedRevision === before.policy.revision) {
      // Refuse a change that fails anyway before the probe provisions the scanner,
      // starts a container and pays for model calls. Only the probe result is unknown.
      proposeSecurityPolicyChange(before, request, {
        userId: options.userId,
        now: options.now ?? Date.now(),
        probeOnApply: true,
        zeroTrust: request.publicGate === true ? await readSecurityZeroTrustFact(db) : undefined,
      });
      // The probe takes up to a few minutes, so it runs outside the transaction. The
      // revision check below still refuses the write if the policy changed meanwhile.
      const report = await options.probe();
      entitlement = report.entitlement;
      if (!entitlement.ok) {
        await recordSecurityEntitlement(db, entitlement);
        throw probeFailedError(report);
      }
    }
  }
  // Read the clock after the probe: its result must not look like it is from the future.
  const now = options.now ?? Date.now();
  return db.transaction(async (tx) => {
    // Turning the gate on re-reads Zero Trust under its lock, taken before the policy
    // lock (the order the public gate checkpoint uses). The disable and public-only
    // claims take the same lock exclusive and read `publicGate` under it, so the two
    // writes run one at a time (spec §5.5, edge #90).
    if (request.publicGate === true) {
      await lockZeroTrustConfiguration(tx, 'shared');
    }
    await lockSecurityPolicy(tx);
    const stored = await readStoredSecurityPolicy(tx);
    const current = stored.policy;
    if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision) {
      throw new SecurityPolicyRevisionError(request.expectedRevision, current.revision);
    }
    const { next, changes } = proposeSecurityPolicyChange(stored, request, {
      userId: options.userId,
      now,
      entitlement,
      probeOnApply: options.preview && options.probe !== undefined,
      zeroTrust: request.publicGate === true ? await readSecurityZeroTrustFact(tx) : undefined,
    });
    if (options.preview) {
      const counts = await securityPolicyPreviewCounts(tx, current, next, changes);
      return {
        dryRun: true as const,
        action: 'security.policy' as const,
        target: 'platform' as const,
        expectedRevision: current.revision,
        policy: { ...next, revision: current.revision + 1 },
        changes,
        counts,
        preview:
          options.probe && leavesDisabled(current)
            ? withProbeLine(securityPolicyPreviewLines(current, next, changes, counts))
            : securityPolicyPreviewLines(current, next, changes, counts),
      };
    }
    const written = await replaceSecurityPolicy(tx, current, next);
    let canceledScans = 0;
    if (changes.mode?.to === 'disabled') {
      // Any → Off: queued scans are canceled; running ones finish and are stored.
      const canceled = await tx
        .update(securityScans)
        .set({ status: 'canceled', status_reason: 'policy_off', finished_at: sql`now()` })
        .where(inArray(securityScans.status, [...QUEUED_STATUSES]))
        .returning({ id: securityScans.id });
      canceledScans = canceled.length;
    }
    let canceledRequests = 0;
    if (changes.publicGateOff) {
      // Gate off, for any cause: open requests are canceled and the projects stay
      // protected. The emails are queued here and sent after the commit.
      canceledRequests = (
        await cancelAllOpenRequests(
          tx,
          changes.mode?.to === 'disabled' ? 'policy_off' : 'gate_off',
          {
            kind: 'installation_admin',
            userId: options.userId,
            role: null,
          },
        )
      ).length;
    }
    return { ok: true as const, policy: written, changes, canceledScans, canceledRequests };
  });
}

/**
 * The refusal for a failed turn-on probe: each failing check's own copy (spec §5.2),
 * and the probe id that finds its log line.
 */
function probeFailedError(report: SecurityProbeReport): SecurityApiError {
  // Only the checks that refuse the change (1–4); a host without credits does not.
  const failing = report.checks.filter((check) => report.entitlement.missing.includes(check.name));
  const lines = failing.flatMap((check) =>
    check.message ? [`  ${check.label}: ${check.message}`] : [],
  );
  return SecurityApiError.of(
    'entitlementMissing',
    [
      `The entitlement probe failed (${report.entitlement.missing.join(', ')}; probe ${report.probeId}). Fix it and run: void platform security probe`,
      ...lines,
    ].join('\n'),
    {
      missing: report.entitlement.missing,
      checkedAt: report.entitlement.checkedAt,
      probeId: report.probeId,
      checks: failing.map((check) => ({
        name: check.name,
        ...(check.message ? { message: check.message } : {}),
        ...(check.link ? { link: check.link } : {}),
      })),
    },
  );
}

/** Adds the probe line at the end of the "Change policy: Off → …" block. */
function withProbeLine(lines: ReadonlyArray<string>): Array<string> {
  const start = lines.findIndex((line) => line.startsWith('Change policy:'));
  if (start === -1) {
    return [...lines];
  }
  let end = start + 1;
  while (end < lines.length && lines[end]!.startsWith('  ')) {
    end++;
  }
  return [
    ...lines.slice(0, end),
    '  The entitlement probe runs again when you apply. A failing check refuses the change.',
    ...lines.slice(end),
  ];
}

/**
 * Stores a probe result (`entitlement`, revision + 1) under the policy lock. A stored
 * row that cannot be read is left alone: the operator saves the policy first.
 */
export async function recordSecurityEntitlement(
  db: Db,
  entitlement: SecurityEntitlement,
): Promise<Readonly<{ saved: boolean; revision: number | null }>> {
  return db.transaction(async (tx) => {
    await lockSecurityPolicy(tx);
    const stored = await readStoredSecurityPolicy(tx);
    if (stored.unreadable !== null) {
      return { saved: false, revision: null };
    }
    const written = await replaceSecurityPolicy(tx, stored.policy, {
      ...stored.policy,
      entitlement,
    });
    return { saved: true, revision: written.revision };
  });
}

// ---------------------------------------------------------------------------
// Status (`void platform security status`)
// ---------------------------------------------------------------------------

/** First day of the UTC month of `now`, as stored in the spend tables. */
export function securitySpendMonth(now: number): string {
  return `${new Date(now).toISOString().slice(0, 7)}-01`;
}

const NANO_PER_USD = 1_000_000_000;

export async function securityStatus(db: DbOrTx, capability: boolean, now = Date.now()) {
  const stored = await readStoredSecurityPolicy(db);
  const { policy } = stored;
  const month = securitySpendMonth(now);
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const [waiting, finished, spend] = await Promise.all([
    db
      .select({ status: securityScans.status, total: count() })
      .from(securityScans)
      .where(inArray(securityScans.status, [...QUEUED_STATUSES, 'running']))
      .groupBy(securityScans.status),
    db
      .select({ status: securityScans.status, total: count() })
      .from(securityScans)
      .where(
        and(
          inArray(securityScans.status, ['succeeded', ...FAILED_STATUSES]),
          gte(securityScans.finished_at, since),
        ),
      )
      .groupBy(securityScans.status),
    db
      .select({
        spent: securityPlatformSpend.spent_nano_usd,
        reserved: securityPlatformSpend.reserved_nano_usd,
      })
      .from(securityPlatformSpend)
      .where(eq(securityPlatformSpend.month, month))
      .limit(1),
  ]);
  const total = (rows: ReadonlyArray<{ status: string; total: number }>, status: string) =>
    rows.find((row) => row.status === status)?.total ?? 0;
  const finishedCount = finished.reduce((sum, row) => sum + row.total, 0);
  const failedCount = FAILED_STATUSES.reduce((sum, status) => sum + total(finished, status), 0);
  return {
    capability,
    unreadable: stored.unreadable,
    mode: policy.mode,
    publicGate: policy.publicGate,
    defaultModel: policy.defaultModel,
    revision: policy.revision,
    probe: policy.entitlement
      ? { ...policy.entitlement, fresh: isSecurityEntitlementFresh(policy.entitlement, now) }
      : null,
    queue: {
      pendingInput: total(waiting, 'pending_input'),
      queued: total(waiting, 'queued'),
      running: total(waiting, 'running'),
    },
    month: {
      month,
      spentUsd: (spend[0]?.spent ?? 0) / NANO_PER_USD,
      reservedUsd: (spend[0]?.reserved ?? 0) / NANO_PER_USD,
      platformCapOn: policy.budgets.platformCapOn,
      platformCapUsd: policy.budgets.platformMonthlyUsd,
    },
    last24h: {
      finished: finishedCount,
      failed: failedCount,
      failureRate: finishedCount === 0 ? 0 : failedCount / finishedCount,
    },
  };
}
