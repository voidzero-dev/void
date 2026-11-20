/**
 * Findings for the project API (spec §9, §13.5): paged lists, one finding, comments,
 * resolve and reopen. The role filter is `securityDetailLevel`:
 *
 *   counts: open findings show F-id, severity, verdict and state only; resolved ones
 *           also show the title (spec §3)
 *   full:   everything, plus the history with comments
 *
 * Every lookup is `WHERE project_id = :id AND (id = :fid OR number = :n)`, so a finding
 * of another project is a 404.
 */
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import { generateId } from '../id.ts';
import { requireProjectCapability } from '../project-access.ts';
import { users } from '../schema.ts';
import type { ProjectRole } from '../types.ts';
import { SecurityApiError } from './errors.ts';
import { isUrgentSeverity } from './findings.ts';
import { enqueueSecurityNotification } from './notifications.ts';
import {
  effectiveSeverity,
  parseSecurityFindingRef,
  securityDuplicateHints,
  securityFindingLabel,
  securityIso,
  type SecurityDetailLevel,
  type SecurityDuplicateHint,
} from './project-view.ts';
import {
  securityFindingEvents,
  securityFindings,
  type SecurityResolution,
  type SecuritySeverity,
} from './schema.ts';

export const SECURITY_COMMENT_MAX_CHARS = 4000;

export class SecurityFindingNotFoundError extends SecurityApiError {
  constructor() {
    super(404, 'finding not found', 'No finding with that id in this project.');
    this.name = 'SecurityFindingNotFoundError';
  }
}

const findingColumns = {
  id: securityFindings.id,
  number: securityFindings.number,
  verdict: securityFindings.verdict,
  severity: effectiveSeverity,
  confidence: securityFindings.confidence,
  title: securityFindings.title,
  category: securityFindings.category,
  cwe: securityFindings.cwe,
  file: securityFindings.file,
  lineStart: securityFindings.line_start,
  lineEnd: securityFindings.line_end,
  detail: securityFindings.detail,
  state: securityFindings.state,
  resolution: securityFindings.resolution,
  resolvedAt: securityFindings.resolved_at,
  resolvedByUserId: securityFindings.resolved_by_user_id,
  notSeenInLatest: securityFindings.not_seen_in_latest,
  possibleDuplicateOf: securityFindings.possible_duplicate_of,
  reopenCount: securityFindings.reopen_count,
  revision: securityFindings.revision,
  outsideDiff: securityFindings.outside_diff,
  source: securityFindings.source,
  verdictSource: securityFindings.verdict_source,
  fixChecked: securityFindings.fix_checked_scan_id,
  firstScanId: securityFindings.first_scan_id,
  lastSeenScanId: securityFindings.last_seen_scan_id,
  firstDeploymentId: securityFindings.first_deployment_id,
  createdAt: securityFindings.created_at,
  updatedAt: securityFindings.updated_at,
};

type FindingRow = Readonly<{
  id: string;
  number: number;
  verdict: 'confirmed' | 'needs_validation';
  severity: SecuritySeverity | null;
  confidence: string | null;
  title: string;
  category: string;
  cwe: string | null;
  file: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  detail: unknown;
  state: 'open' | 'resolved';
  resolution: SecurityResolution | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  notSeenInLatest: boolean;
  possibleDuplicateOf: string | null;
  reopenCount: number;
  revision: number;
  outsideDiff: boolean;
  source: 'scanner' | 'server';
  verdictSource: 'static' | 'runtime';
  fixChecked: string | null;
  firstScanId: string;
  lastSeenScanId: string;
  firstDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

function isUrgent(row: Pick<FindingRow, 'verdict' | 'state' | 'severity'>): boolean {
  return (
    row.verdict === 'confirmed' &&
    row.state === 'open' &&
    (row.severity === 'critical' || row.severity === 'high')
  );
}

export type SecurityFindingView = Readonly<Record<string, unknown>>;

/** One finding as the caller may see it. */
export function securityFindingView(
  row: FindingRow,
  level: SecurityDetailLevel,
  duplicate: SecurityDuplicateHint | null,
  resolvedBy: string | null,
): SecurityFindingView {
  const base = {
    id: securityFindingLabel(row.number),
    verdict: row.verdict,
    severity: row.severity,
    state: row.state,
    urgent: isUrgent(row),
  };
  if (level === 'counts') {
    // Readers: titles only for resolved findings; an open one is an exploit write-up.
    return row.state === 'resolved'
      ? { ...base, title: row.title, resolution: row.resolution, revision: row.revision }
      : { ...base, revision: row.revision };
  }
  const detail =
    row.detail && typeof row.detail === 'object' && !Array.isArray(row.detail)
      ? (row.detail as Record<string, unknown>)
      : {};
  return {
    ...base,
    findingId: row.id,
    title: row.title,
    category: row.category,
    cwe: row.cwe,
    confidence: row.confidence,
    file: row.file,
    line: row.lineStart,
    lineEnd: row.lineEnd,
    resolution: row.resolution,
    resolvedAt: securityIso(row.resolvedAt),
    resolvedBy,
    notSeenInLatest: row.notSeenInLatest,
    possibleDuplicateOf: duplicate,
    reopenCount: row.reopenCount,
    revision: row.revision,
    outsideDiff: row.outsideDiff,
    source: row.source,
    // M30: `confirmed (runtime)` when a request to the scan's throwaway copy proved it.
    verdictSource: row.verdict === 'confirmed' ? row.verdictSource : null,
    runtimeProof: detail.runtime_proof ?? null,
    // `fixed` is proven only once a later clean scan did not report it again.
    fixChecked: row.fixChecked !== null,
    firstScanId: row.firstScanId,
    lastSeenScanId: row.lastSeenScanId,
    deploymentId: row.firstDeploymentId,
    firstSeenAt: securityIso(row.createdAt),
    updatedAt: securityIso(row.updatedAt),
    trace: detail.trace ?? null,
    evidence: detail.evidence ?? null,
    conditions: detail.conditions ?? null,
    fix: detail.fix ?? null,
  };
}

// ---------------------------------------------------------------------------
// List and show
// ---------------------------------------------------------------------------

export type SecurityFindingFilter = Readonly<{
  state: 'open' | 'resolved' | 'all';
  urgent: boolean;
  severity: SecuritySeverity | null;
}>;

async function loginsFor(
  db: DbOrTx,
  ids: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const out = new Map<string, string>();
  if (wanted.length === 0) {
    return out;
  }
  const rows = await db
    .select({ id: users.id, login: users.login })
    .from(users)
    .where(inArray(users.id, wanted));
  for (const row of rows) {
    out.set(row.id, row.login);
  }
  return out;
}

export async function listSecurityFindings(
  db: Db,
  projectId: string,
  level: SecurityDetailLevel,
  filter: SecurityFindingFilter,
  page: Readonly<{ limit: number; afterNumber: number | null }>,
): Promise<Readonly<{ findings: ReadonlyArray<SecurityFindingView>; nextCursor: string | null }>> {
  const conditions: Array<SQL | undefined> = [
    eq(securityFindings.project_id, projectId),
    filter.state === 'all' ? undefined : eq(securityFindings.state, filter.state),
    filter.urgent
      ? sql`${securityFindings.verdict} = 'confirmed' AND ${securityFindings.state} = 'open' AND COALESCE(${securityFindings.severity_override}, ${securityFindings.severity}) IN ('critical', 'high')`
      : undefined,
    filter.severity
      ? sql`COALESCE(${securityFindings.severity_override}, ${securityFindings.severity}) = ${filter.severity}`
      : undefined,
    page.afterNumber === null ? undefined : gt(securityFindings.number, page.afterNumber),
  ];
  const rows: ReadonlyArray<FindingRow> = await db
    .select(findingColumns)
    .from(securityFindings)
    .where(and(...conditions))
    .orderBy(asc(securityFindings.number))
    .limit(page.limit + 1);
  const more = rows.length > page.limit;
  const shown = more ? rows.slice(0, page.limit) : rows;
  const duplicates =
    level === 'full'
      ? await securityDuplicateHints(
          db,
          projectId,
          shown.flatMap((row) => (row.possibleDuplicateOf ? [row.possibleDuplicateOf] : [])),
        )
      : new Map<string, SecurityDuplicateHint>();
  const logins =
    level === 'full'
      ? await loginsFor(
          db,
          shown.map((row) => row.resolvedByUserId),
        )
      : new Map<string, string>();
  return {
    findings: shown.map((row) =>
      securityFindingView(
        row,
        level,
        row.possibleDuplicateOf ? (duplicates.get(row.possibleDuplicateOf) ?? null) : null,
        row.resolvedByUserId ? (logins.get(row.resolvedByUserId) ?? null) : null,
      ),
    ),
    nextCursor: more && shown.length > 0 ? String(shown.at(-1)!.number) : null,
  };
}

function refCondition(projectId: string, ref: string): SQL | undefined {
  const parsed = parseSecurityFindingRef(ref);
  return and(
    eq(securityFindings.project_id, projectId),
    'number' in parsed
      ? eq(securityFindings.number, parsed.number)
      : eq(securityFindings.id, parsed.id),
  );
}

export async function showSecurityFinding(
  db: Db,
  projectId: string,
  ref: string,
  level: SecurityDetailLevel,
) {
  const [row]: ReadonlyArray<FindingRow> = await db
    .select(findingColumns)
    .from(securityFindings)
    .where(refCondition(projectId, ref))
    .limit(1);
  if (!row) {
    throw new SecurityFindingNotFoundError();
  }
  const duplicates =
    level === 'full' && row.possibleDuplicateOf
      ? await securityDuplicateHints(db, projectId, [row.possibleDuplicateOf])
      : new Map<string, SecurityDuplicateHint>();
  let events: ReadonlyArray<Record<string, unknown>> = [];
  let resolvedBy: string | null = null;
  if (level === 'full') {
    const rows = await db
      .select({
        action: securityFindingEvents.action,
        actorKind: securityFindingEvents.actor_kind,
        actorRole: securityFindingEvents.actor_role,
        actorUserId: securityFindingEvents.actor_user_id,
        scanId: securityFindingEvents.scan_id,
        resolution: securityFindingEvents.resolution,
        comment: securityFindingEvents.comment,
        createdAt: securityFindingEvents.created_at,
      })
      .from(securityFindingEvents)
      .where(eq(securityFindingEvents.finding_id, row.id))
      .orderBy(asc(securityFindingEvents.created_at), asc(securityFindingEvents.id));
    const logins = await loginsFor(db, [
      row.resolvedByUserId,
      ...rows.map((event) => event.actorUserId),
    ]);
    resolvedBy = row.resolvedByUserId ? (logins.get(row.resolvedByUserId) ?? null) : null;
    events = rows.map((event) => ({
      action: event.action,
      actorKind: event.actorKind,
      actorRole: event.actorRole,
      // A removed member keeps their comment; the login is gone with the account.
      actor: event.actorUserId ? (logins.get(event.actorUserId) ?? null) : null,
      scanId: event.scanId,
      resolution: event.resolution,
      comment: event.comment,
      createdAt: securityIso(event.createdAt),
    }));
  }
  return {
    finding: securityFindingView(
      row,
      level,
      row.possibleDuplicateOf ? (duplicates.get(row.possibleDuplicateOf) ?? null) : null,
      resolvedBy,
    ),
    ...(level === 'full' ? { events } : {}),
  };
}

// ---------------------------------------------------------------------------
// Comment, resolve, reopen
// ---------------------------------------------------------------------------

/** A comment or reason text: a string, 1 to 4,000 characters once trimmed. */
export function parseSecurityComment(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw SecurityApiError.invalid(
      `${field} is required (1 to ${SECURITY_COMMENT_MAX_CHARS} characters).`,
    );
  }
  const text = value.trim();
  if ([...text].length > SECURITY_COMMENT_MAX_CHARS) {
    throw SecurityApiError.invalid(
      `${field} must be at most ${SECURITY_COMMENT_MAX_CHARS} characters.`,
    );
  }
  return text;
}

export async function commentOnSecurityFinding(
  db: Db,
  input: Readonly<{
    projectId: string;
    ref: string;
    userId: string;
    /** Ignored for an installation admin, who has no project role. */
    role: ProjectRole | null;
    text: string;
    /** An operator acting for the installation (`operator/security-routes.ts`). */
    actor?: SecurityFindingActor;
  }>,
) {
  const [row] = await db
    .select({ id: securityFindings.id, number: securityFindings.number })
    .from(securityFindings)
    .where(refCondition(input.projectId, input.ref))
    .limit(1);
  if (!row) {
    throw new SecurityFindingNotFoundError();
  }
  // The role was checked by the route, outside a transaction. A comment never changes state,
  // so a demotion landing mid-request can leave one comment with the older role. Accepted.
  await db.insert(securityFindingEvents).values({
    id: generateId('sfe'),
    finding_id: row.id,
    project_id: input.projectId,
    actor_kind: input.actor ?? 'user',
    actor_user_id: input.userId,
    actor_role: input.actor ? null : input.role,
    action: 'commented',
    comment: input.text,
  });
  return { ok: true as const, id: securityFindingLabel(row.number) };
}

/** What the finding is now, for the `finding changed` reply. */
async function changedError(
  tx: DbOrTx,
  row: Pick<FindingRow, 'id' | 'number' | 'state' | 'resolution' | 'revision' | 'updatedAt'>,
): Promise<SecurityApiError> {
  const [last] = await tx
    .select({ role: securityFindingEvents.actor_role, kind: securityFindingEvents.actor_kind })
    .from(securityFindingEvents)
    .where(
      and(
        eq(securityFindingEvents.finding_id, row.id),
        inArray(securityFindingEvents.action, ['resolved', 'reopened']),
      ),
    )
    .orderBy(desc(securityFindingEvents.created_at), desc(securityFindingEvents.id))
    .limit(1);
  const label = securityFindingLabel(row.number);
  const what =
    row.state === 'resolved'
      ? `resolved (${(row.resolution ?? 'resolved').replace('_', ' ')})`
      : 'open';
  return SecurityApiError.of(
    'findingChanged',
    `${label} changed while you were working on it: ${what}. Run void project security show ${label} to see it.`,
    {
      id: label,
      state: row.state,
      resolution: row.resolution,
      revision: row.revision,
      changedAt: securityIso(row.updatedAt),
      byRole: last?.role ?? null,
    },
  );
}

function parseRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw SecurityApiError.invalid(
      'expectedRevision must be the revision you read, a positive integer.',
    );
  }
  return value;
}

export function parseSecurityResolution(value: unknown): SecurityResolution {
  if (value === 'fixed' || value === 'false_positive' || value === 'accepted_risk') {
    return value;
  }
  throw SecurityApiError.invalid('reason must be fixed, false_positive or accepted_risk.');
}

/** Who changes a finding when it is not a project member. */
export type SecurityFindingActor = 'installation_admin';

type ChangeInput = Readonly<{
  projectId: string;
  ref: string;
  userId: string;
  /** An operator: no project role is needed or recorded. */
  actor?: SecurityFindingActor;
  comment: string;
  expectedRevision: unknown;
}>;

/**
 * Locks the project row (as the ingest does, so the two never interleave), checks the
 * caller still has `settings` (edge #22: an admin demoted mid-request gets 403), then
 * locks the finding and checks the revision (edge #21: the second of two admins gets
 * 409 `finding changed`).
 */
async function lockFindingForChange(tx: DbOrTx, input: ChangeInput) {
  await tx.execute(sql`SELECT id FROM projects WHERE id = ${input.projectId} FOR UPDATE`);
  const access = input.actor
    ? { role: null }
    : await requireProjectCapability(tx as Db, input.projectId, input.userId, 'settings');
  const parsed = parseSecurityFindingRef(input.ref);
  const [row]: ReadonlyArray<FindingRow & { sinkContentHash: string | null }> = await tx
    .select({ ...findingColumns, sinkContentHash: securityFindings.sink_content_hash })
    .from(securityFindings)
    .where(
      and(
        eq(securityFindings.project_id, input.projectId),
        'number' in parsed
          ? eq(securityFindings.number, parsed.number)
          : eq(securityFindings.id, parsed.id),
      ),
    )
    .for('update')
    .limit(1);
  if (!row) {
    throw new SecurityFindingNotFoundError();
  }
  return { access, row };
}

export async function resolveSecurityFinding(
  db: Db,
  input: ChangeInput & Readonly<{ resolution: SecurityResolution }>,
) {
  const revision = parseRevision(input.expectedRevision);
  return db.transaction(async (tx) => {
    const { access, row } = await lockFindingForChange(tx, input);
    if (row.revision !== revision || row.state !== 'open') {
      throw await changedError(tx, row);
    }
    const [updated] = await tx
      .update(securityFindings)
      .set({
        state: 'resolved',
        resolution: input.resolution,
        resolved_by_user_id: input.userId,
        resolved_at: sql`now()`,
        // The sink as it was when the human decided: a later change reopens (spec §9.3).
        resolved_sink_hash: row.sinkContentHash,
        resolved_severity: row.severity,
        // A new `fixed` claim is unproven until a later clean scan checks it.
        fix_checked_scan_id: null,
        revision: sql`${securityFindings.revision} + 1`,
        updated_at: sql`now()`,
      })
      .where(eq(securityFindings.id, row.id))
      .returning({ revision: securityFindings.revision });
    await tx.insert(securityFindingEvents).values({
      id: generateId('sfe'),
      finding_id: row.id,
      project_id: input.projectId,
      actor_kind: input.actor ?? 'user',
      actor_user_id: input.userId,
      actor_role: access.role,
      action: 'resolved',
      resolution: input.resolution,
      comment: input.comment,
    });
    return {
      ok: true as const,
      id: securityFindingLabel(row.number),
      state: 'resolved' as const,
      resolution: input.resolution,
      revision: updated!.revision,
    };
  });
}

export async function reopenSecurityFinding(db: Db, input: ChangeInput) {
  const revision = parseRevision(input.expectedRevision);
  return db.transaction(async (tx) => {
    const { access, row } = await lockFindingForChange(tx, input);
    if (row.revision !== revision || row.state !== 'resolved') {
      throw await changedError(tx, row);
    }
    const [updated] = await tx
      .update(securityFindings)
      .set({
        state: 'open',
        resolution: null,
        resolved_by_user_id: null,
        resolved_at: null,
        resolved_sink_hash: null,
        resolved_severity: null,
        fix_checked_scan_id: null,
        reopen_count: sql`${securityFindings.reopen_count} + 1`,
        revision: sql`${securityFindings.revision} + 1`,
        updated_at: sql`now()`,
      })
      .where(eq(securityFindings.id, row.id))
      .returning({ revision: securityFindings.revision });
    await tx.insert(securityFindingEvents).values({
      id: generateId('sfe'),
      finding_id: row.id,
      project_id: input.projectId,
      actor_kind: input.actor ?? 'user',
      actor_user_id: input.userId,
      actor_role: access.role,
      action: 'reopened',
      comment: input.comment,
    });
    // A human reopen of an urgent finding (confirmed critical or high) is emailed (M15).
    const urgent = row.verdict === 'confirmed' && isUrgentSeverity(row.severity);
    if (urgent) {
      await enqueueSecurityNotification(tx, {
        kind: 'reopen',
        projectId: input.projectId,
        findingId: row.id,
        reopenCount: row.reopenCount + 1,
      });
    }
    return {
      ok: true as const,
      id: securityFindingLabel(row.number),
      state: 'open' as const,
      resolution: null,
      revision: updated!.revision,
    };
  });
}
