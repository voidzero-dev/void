/**
 * Monthly scan budgets (spec §16): cap rules, month math and the spend meter writes.
 *
 *   scan start (scheduler, M9) ─► reserveSecurityScanBudget   spent + reserved + reserve ≤ cap
 *   each model call (proxy)    ─► holdSecurityModelCall        spent + this call's worst case ≤ cap
 *                               ─► settleSecurityModelCall      spent += real − worst case
 *   scan end (ingest/reaper)   ─► releaseSecurityScanReserve   reserved −= reserve (its own month)
 *
 * Every check runs in the `UPDATE … WHERE … RETURNING` that writes the row, so two
 * writers near a cap can never both pass (edge #51). Money is whole nano-dollars;
 * caps are whole cents (`policy.budgets` is USD with at most two decimals).
 */
import { securityModelCostNanoUsd, type SecurityModelId } from '@void/platform/security-models';
import type { SecurityPlanCap, SecurityPolicyBudgets } from '@void/platform/security-policy';
import { and, eq, gt, lt, sql, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db.ts';
import { SecurityApiError } from './errors.ts';
import { securitySpendMonth } from './policy.ts';
import { securityPlatformSpend, securityProjectSpend, securityScans } from './schema.ts';

export { securitySpendMonth };

export const NANO_USD_PER_CENT = 10_000_000;
export const NANO_USD_PER_USD = 1_000_000_000;

/** Alert thresholds, in percent of a cap (spec §16.3). */
export const SECURITY_BUDGET_THRESHOLDS = [80, 100] as const;
export type SecurityBudgetThreshold = (typeof SECURITY_BUDGET_THRESHOLDS)[number];

export function securityUsdToCents(usd: number): number {
  return Math.round(usd * 100);
}

export function securityCentsToNano(cents: number): number {
  return cents * NANO_USD_PER_CENT;
}

/** `$1,234.50`. Copy never shows more than cents. */
export function formatSecurityUsd(nanoUsd: number): string {
  const cents = Math.max(0, Math.round(nanoUsd / NANO_USD_PER_CENT));
  const dollars = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  return `$${dollars.toLocaleString('en-US')}.${rest}`;
}

/** A CLI `--usd` value: `150`, or `150.5` with cents. */
export function securityUsdArgument(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// Who sets what (spec §16.2)
// ---------------------------------------------------------------------------

/**
 * The cap columns of `project_security_settings` (a missing row is all `null`) and the
 * cap of the owner's plan (`plans:security-caps`, M27; `inherit` when it has none).
 */
export type SecurityProjectCapSettings = Readonly<{
  monthlyCapCents: number | null;
  capCeilingCents: number | null;
  planCap: SecurityPlanCap;
}>;

/** Where `ceiling(p)` comes from: this project's limit, its plan's cap, the policy default. */
export type SecurityCeilingSource = 'project' | 'plan' | 'default';

/**
 * `ceiling(p)` and where it comes from, in this order: the installation admin's limit
 * for this project, else the cap of the owner's plan (an amount, or `none` = no
 * ceiling), else the default project amount while project caps are on, else none.
 * A plan cap applies with project caps off too: it is set for that plan on purpose.
 */
export function securityProjectCeiling(
  settings: SecurityProjectCapSettings,
  budgets: SecurityPolicyBudgets,
): Readonly<{ cents: number; source: SecurityCeilingSource }> | null {
  if (settings.capCeilingCents !== null) {
    return { cents: settings.capCeilingCents, source: 'project' };
  }
  if (settings.planCap === 'none') {
    return null;
  }
  if (settings.planCap !== 'inherit') {
    return { cents: settings.planCap, source: 'plan' };
  }
  return budgets.projectCapsOn
    ? { cents: securityUsdToCents(budgets.projectDefaultMonthlyUsd), source: 'default' }
    : null;
}

/** `ceiling(p)` in cents; `null` = none (see `securityProjectCeiling`). */
export function securityProjectCeilingCents(
  settings: SecurityProjectCapSettings,
  budgets: SecurityPolicyBudgets,
): number | null {
  return securityProjectCeiling(settings, budgets)?.cents ?? null;
}

/** `effective(p)`: the lower of the ceiling and the project's own cap, ignoring a missing one. */
export function securityEffectiveProjectCapCents(
  settings: SecurityProjectCapSettings,
  budgets: SecurityPolicyBudgets,
): number | null {
  const ceiling = securityProjectCeilingCents(settings, budgets);
  const own = settings.monthlyCapCents;
  if (ceiling === null) {
    return own;
  }
  return own === null ? ceiling : Math.min(ceiling, own);
}

export function securityPlatformCapCents(budgets: SecurityPolicyBudgets): number | null {
  return budgets.platformCapOn ? securityUsdToCents(budgets.platformMonthlyUsd) : null;
}

/** Both caps that apply to one project's scans, in nano-dollars; `null` = no cap. */
export type SecuritySpendCaps = Readonly<{
  projectNano: number | null;
  platformNano: number | null;
}>;

export function securitySpendCaps(
  settings: SecurityProjectCapSettings,
  budgets: SecurityPolicyBudgets,
): SecuritySpendCaps {
  const project = securityEffectiveProjectCapCents(settings, budgets);
  const platform = securityPlatformCapCents(budgets);
  return {
    projectNano: project === null ? null : securityCentsToNano(project),
    platformNano: platform === null ? null : securityCentsToNano(platform),
  };
}

/**
 * A project admin may set their own cap from $0 up to the ceiling, or any amount
 * when there is none (edge #49). `null` (clear) is always allowed.
 */
export function assertSecurityProjectCapAllowed(
  requestedCents: number | null,
  ceiling: Readonly<{ cents: number; source: SecurityCeilingSource }> | null,
  projectSlug: string,
): void {
  if (requestedCents === null || ceiling === null || requestedCents <= ceiling.cents) {
    return;
  }
  const ceilingCents = ceiling.cents;
  const limiter =
    ceiling.source === 'plan'
      ? "This project's plan limits it"
      : 'The platform limits each project';
  throw SecurityApiError.of(
    'budgetAbovePlatformLimit',
    `${limiter} to ${formatSecurityUsd(securityCentsToNano(ceilingCents))} / month. Ask your platform admin to raise it for ${projectSlug}: void platform security budget --project ${projectSlug} --usd ${securityUsdArgument(requestedCents)}`,
    { ceilingUsd: ceilingCents / 100 },
  );
}

// ---------------------------------------------------------------------------
// Month math (UTC calendar month)
// ---------------------------------------------------------------------------

/** First day of the month after `month` (`YYYY-MM-01`). */
export function securityNextSpendMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 12 ? `${year + 1}-01-01` : `${year}-${String(index + 1).padStart(2, '0')}-01`;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** `Dec 1`: when the budget of the month that holds `now` resets. */
export function securityBudgetResetLabel(now: number): string {
  const next = securityNextSpendMonth(securitySpendMonth(now));
  return `${MONTH_NAMES[Number(next.slice(5, 7)) - 1]} 1`;
}

/** The thresholds `spentNano` has reached on a cap; empty with no cap or a $0 cap. */
export function securityBudgetThresholds(
  spentNano: number,
  capNano: number | null,
): ReadonlyArray<SecurityBudgetThreshold> {
  if (capNano === null || capNano <= 0) {
    return [];
  }
  return SECURITY_BUDGET_THRESHOLDS.filter((percent) => spentNano * 100 >= capNano * percent);
}

/** Worst-case cost of one scan at list price (spec §16.1); `null` for an unpriced model. */
export function securityScanReserveNano(
  model: SecurityModelId,
  limits: Readonly<{ maxInputTokens: number; maxOutputTokens: number }>,
): number | null {
  return securityModelCostNanoUsd(model, limits.maxInputTokens, limits.maxOutputTokens);
}

// ---------------------------------------------------------------------------
// Spend meter writes
// ---------------------------------------------------------------------------

function within(total: SQL, capNano: number | null): SQL | undefined {
  return capNano === null ? undefined : sql`${total} <= ${capNano}`;
}

async function ensureSpendRows(tx: DbOrTx, projectId: string, month: string): Promise<void> {
  await tx
    .insert(securityProjectSpend)
    .values({ project_id: projectId, month })
    .onConflictDoNothing();
  await tx.insert(securityPlatformSpend).values({ month }).onConflictDoNothing();
}

export type SecurityCapName = 'project' | 'platform';

export type SecurityBudgetRefusal = Readonly<{
  ok: false;
  cap: SecurityCapName;
  capNano: number;
  /** Metered spend of the month on that cap, for the copy. */
  spentNano: number;
}>;

class CapRefused extends Error {
  constructor(readonly cap: SecurityCapName) {
    super(`security ${cap} cap refused`);
  }
}

async function refusal(
  db: DbOrTx,
  cap: SecurityCapName,
  projectId: string,
  month: string,
  caps: SecuritySpendCaps,
): Promise<SecurityBudgetRefusal> {
  const rows =
    cap === 'project'
      ? await db
          .select({ spent: securityProjectSpend.spent_nano_usd })
          .from(securityProjectSpend)
          .where(
            and(
              eq(securityProjectSpend.project_id, projectId),
              eq(securityProjectSpend.month, month),
            ),
          )
          .limit(1)
      : await db
          .select({ spent: securityPlatformSpend.spent_nano_usd })
          .from(securityPlatformSpend)
          .where(eq(securityPlatformSpend.month, month))
          .limit(1);
  return {
    ok: false,
    cap,
    capNano: (cap === 'project' ? caps.projectNano : caps.platformNano) ?? 0,
    spentNano: rows[0]?.spent ?? 0,
  };
}

export type SecurityReserveResult =
  | Readonly<{ ok: true; month: string; reserveNano: number }>
  | SecurityBudgetRefusal
  /** The scan is no longer running at this attempt (canceled, reaped): nothing was written. */
  | Readonly<{ ok: false; gone: true }>;

class ScanGone extends Error {}

/**
 * Scan start: reserve the scan's worst case on both spend rows of this month, each
 * only if `spent + reserved + reserve ≤ cap`. A refusal writes nothing
 * (`skipped:budget`). Stores the reserve on the scan and sets `started_at` to now: the
 * reserve is released from the month of `started_at`. Fenced like every attempt write:
 * only the row running at `attempt` takes it, so a cancel that landed after the claim
 * leaves nothing reserved (`gone`). A scan that already holds a reserve is refused
 * (release it first), so a retry never reserves twice. The month's `scans` count only
 * goes up on the first attempt.
 */
export async function reserveSecurityScanBudget(
  db: Db,
  input: Readonly<{
    scanId: string;
    /** The attempt the claim set. */
    attempt: number;
    projectId: string;
    reserveNano: number;
    caps: SecuritySpendCaps;
    now?: number;
  }>,
): Promise<SecurityReserveResult> {
  const now = input.now ?? Date.now();
  const month = securitySpendMonth(now);
  const reserve = input.reserveNano;
  try {
    await db.transaction(async (tx) => {
      // Scan row first, then project, then platform: the order every meter write uses.
      const [scan] = await tx
        .update(securityScans)
        .set({ reserved_nano_usd: reserve, started_at: new Date(now).toISOString() })
        .where(
          and(
            eq(securityScans.id, input.scanId),
            eq(securityScans.status, 'running'),
            eq(securityScans.attempt, input.attempt),
            eq(securityScans.reserved_nano_usd, 0),
          ),
        )
        .returning({ id: securityScans.id });
      if (!scan) {
        const [row] = await tx
          .select({ status: securityScans.status, attempt: securityScans.attempt })
          .from(securityScans)
          .where(eq(securityScans.id, input.scanId))
          .limit(1);
        if (row?.status === 'running' && row.attempt === input.attempt) {
          throw new Error(`Security scan ${input.scanId} already holds a reserve.`);
        }
        throw new ScanGone();
      }
      await ensureSpendRows(tx, input.projectId, month);
      const project = await tx
        .update(securityProjectSpend)
        .set({
          reserved_nano_usd: sql`${securityProjectSpend.reserved_nano_usd} + ${reserve}`,
          scans: sql`${securityProjectSpend.scans} + ${input.attempt <= 1 ? 1 : 0}`,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(securityProjectSpend.project_id, input.projectId),
            eq(securityProjectSpend.month, month),
            within(
              sql`${securityProjectSpend.spent_nano_usd} + ${securityProjectSpend.reserved_nano_usd} + ${reserve}`,
              input.caps.projectNano,
            ),
          ),
        )
        .returning({ month: securityProjectSpend.month });
      if (project.length === 0) {
        throw new CapRefused('project');
      }
      const platform = await tx
        .update(securityPlatformSpend)
        .set({
          reserved_nano_usd: sql`${securityPlatformSpend.reserved_nano_usd} + ${reserve}`,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(securityPlatformSpend.month, month),
            within(
              sql`${securityPlatformSpend.spent_nano_usd} + ${securityPlatformSpend.reserved_nano_usd} + ${reserve}`,
              input.caps.platformNano,
            ),
          ),
        )
        .returning({ month: securityPlatformSpend.month });
      if (platform.length === 0) {
        throw new CapRefused('platform');
      }
    });
  } catch (error) {
    if (error instanceof CapRefused) {
      return refusal(db, error.cap, input.projectId, month, input.caps);
    }
    if (error instanceof ScanGone) {
      return { ok: false, gone: true };
    }
    throw error;
  }
  return { ok: true, month, reserveNano: reserve };
}

/**
 * Scan end: give the scan's reserve back to the month it was taken in (the month of
 * `started_at`), even when the scan ran past midnight UTC (edge #52). Safe to call
 * twice: the second call finds no reserve.
 */
export async function releaseSecurityScanReserve(db: Db, scanId: string): Promise<number> {
  return db.transaction((tx) => releaseSecurityScanReserveIn(tx, scanId));
}

/**
 * `releaseSecurityScanReserve` inside the caller's transaction, so the write that ends
 * or requeues an attempt and the release commit together: a row never ends with its
 * reserve still held. Lock order: scan row, then project, then platform.
 */
export async function releaseSecurityScanReserveIn(tx: DbOrTx, scanId: string): Promise<number> {
  const [scan] = await tx
    .select({
      projectId: securityScans.project_id,
      reserved: securityScans.reserved_nano_usd,
      startedAt: securityScans.started_at,
    })
    .from(securityScans)
    .where(eq(securityScans.id, scanId))
    .for('update')
    .limit(1);
  if (!scan || scan.reserved <= 0) {
    return 0;
  }
  const month = securitySpendMonth(scan.startedAt ? Date.parse(scan.startedAt) : Date.now());
  const reserved = scan.reserved;
  await tx
    .update(securityProjectSpend)
    .set({
      reserved_nano_usd: sql`GREATEST(0, ${securityProjectSpend.reserved_nano_usd} - ${reserved})`,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(securityProjectSpend.project_id, scan.projectId),
        eq(securityProjectSpend.month, month),
      ),
    );
  await tx
    .update(securityPlatformSpend)
    .set({
      reserved_nano_usd: sql`GREATEST(0, ${securityPlatformSpend.reserved_nano_usd} - ${reserved})`,
      updated_at: sql`now()`,
    })
    .where(eq(securityPlatformSpend.month, month));
  await tx.update(securityScans).set({ reserved_nano_usd: 0 }).where(eq(securityScans.id, scanId));
  return reserved;
}

/** Why a model call was refused before it was sent. */
export type SecurityCallRefusal =
  | Readonly<{ ok: false; reason: 'fence' }>
  | Readonly<{ ok: false; reason: 'scan_calls' }>
  | Readonly<{ ok: false; reason: 'tokens' }>
  | (SecurityBudgetRefusal & Readonly<{ reason: 'budget' }>);

export type SecurityCallHold = Readonly<{
  ok: true;
  month: string;
  holdNano: number;
  /** Count of this call in the scan. */
  modelCalls: number;
}>;

/**
 * Before a model call: in one transaction, count the call on the scan (current
 * attempt, running, inside its lease, under the call and token caps) and charge its
 * worst case to both spend rows of this month, each only if `spent + worst ≤ cap`.
 * The worst case stays charged until `settleSecurityModelCall` puts in the real cost,
 * so a call whose answer never arrives counts at its worst case.
 */
export async function holdSecurityModelCall(
  db: Db,
  input: Readonly<{
    scanId: string;
    attempt: number;
    projectId: string;
    worstNano: number;
    maxCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    caps: SecuritySpendCaps;
    now?: number;
  }>,
): Promise<SecurityCallHold | SecurityCallRefusal> {
  const now = input.now ?? Date.now();
  const month = securitySpendMonth(now);
  const worst = input.worstNano;
  try {
    return await db.transaction(async (tx) => {
      const [scan] = await tx
        .update(securityScans)
        .set({
          model_calls: sql`${securityScans.model_calls} + 1`,
          metered_nano_usd: sql`${securityScans.metered_nano_usd} + ${worst}`,
        })
        .where(
          and(
            eq(securityScans.id, input.scanId),
            eq(securityScans.attempt, input.attempt),
            eq(securityScans.status, 'running'),
            gt(securityScans.lease_until, new Date(now).toISOString()),
            lt(securityScans.model_calls, input.maxCalls),
            lt(securityScans.tokens_in, input.maxInputTokens),
            lt(securityScans.tokens_out, input.maxOutputTokens),
          ),
        )
        .returning({ modelCalls: securityScans.model_calls });
      if (!scan) {
        throw new CallRefused(await callRefusalReason(tx, input, now));
      }
      await ensureSpendRows(tx, input.projectId, month);
      const project = await tx
        .update(securityProjectSpend)
        .set({
          spent_nano_usd: sql`${securityProjectSpend.spent_nano_usd} + ${worst}`,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(securityProjectSpend.project_id, input.projectId),
            eq(securityProjectSpend.month, month),
            within(sql`${securityProjectSpend.spent_nano_usd} + ${worst}`, input.caps.projectNano),
          ),
        )
        .returning({ month: securityProjectSpend.month });
      if (project.length === 0) {
        throw new CapRefused('project');
      }
      const platform = await tx
        .update(securityPlatformSpend)
        .set({
          spent_nano_usd: sql`${securityPlatformSpend.spent_nano_usd} + ${worst}`,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(securityPlatformSpend.month, month),
            within(
              sql`${securityPlatformSpend.spent_nano_usd} + ${worst}`,
              input.caps.platformNano,
            ),
          ),
        )
        .returning({ month: securityPlatformSpend.month });
      if (platform.length === 0) {
        throw new CapRefused('platform');
      }
      return { ok: true, month, holdNano: worst, modelCalls: scan.modelCalls } as const;
    });
  } catch (error) {
    if (error instanceof CallRefused) {
      return { ok: false, reason: error.reason };
    }
    if (error instanceof CapRefused) {
      return {
        ...(await refusal(db, error.cap, input.projectId, month, input.caps)),
        reason: 'budget',
      };
    }
    throw error;
  }
}

class CallRefused extends Error {
  constructor(readonly reason: 'fence' | 'scan_calls' | 'tokens') {
    super(`security model call refused: ${reason}`);
  }
}

async function callRefusalReason(
  tx: DbOrTx,
  input: Readonly<{
    scanId: string;
    attempt: number;
    maxCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  }>,
  now: number,
): Promise<'fence' | 'scan_calls' | 'tokens'> {
  const [row] = await tx
    .select({
      attempt: securityScans.attempt,
      status: securityScans.status,
      leaseUntil: securityScans.lease_until,
      modelCalls: securityScans.model_calls,
      tokensIn: securityScans.tokens_in,
      tokensOut: securityScans.tokens_out,
    })
    .from(securityScans)
    .where(eq(securityScans.id, input.scanId))
    .limit(1);
  if (
    !row ||
    row.attempt !== input.attempt ||
    row.status !== 'running' ||
    !row.leaseUntil ||
    Date.parse(row.leaseUntil) <= now
  ) {
    return 'fence';
  }
  if (row.modelCalls >= input.maxCalls) {
    return 'scan_calls';
  }
  return 'tokens';
}

export type SecurityCallSettlement = Readonly<{
  projectSpentNano: number;
  platformSpentNano: number;
}>;

/**
 * After a model call: replace the held worst case with the real cost on the scan and
 * on both spend rows of the month the hold was taken in, and add the tokens. Runs
 * for every hold, also for a stale attempt: the money was spent either way. Returns
 * the month totals after the change, for the 80% / 100% alerts (M15).
 */
export async function settleSecurityModelCall(
  db: Db,
  input: Readonly<{
    scanId: string;
    projectId: string;
    month: string;
    holdNano: number;
    actualNano: number;
    inputTokens: number;
    outputTokens: number;
  }>,
): Promise<SecurityCallSettlement> {
  const delta = input.actualNano - input.holdNano;
  return db.transaction(async (tx) => {
    await tx
      .update(securityScans)
      .set({
        tokens_in: sql`${securityScans.tokens_in} + ${input.inputTokens}`,
        tokens_out: sql`${securityScans.tokens_out} + ${input.outputTokens}`,
        metered_nano_usd: sql`GREATEST(0, ${securityScans.metered_nano_usd} + ${delta})`,
      })
      .where(eq(securityScans.id, input.scanId));
    // A project deleted mid-call has no row left; the platform total still counts.
    const [project] = await tx
      .update(securityProjectSpend)
      .set({
        spent_nano_usd: sql`GREATEST(0, ${securityProjectSpend.spent_nano_usd} + ${delta})`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(securityProjectSpend.project_id, input.projectId),
          eq(securityProjectSpend.month, input.month),
        ),
      )
      .returning({ spent: securityProjectSpend.spent_nano_usd });
    const [platform] = await tx
      .update(securityPlatformSpend)
      .set({
        spent_nano_usd: sql`GREATEST(0, ${securityPlatformSpend.spent_nano_usd} + ${delta})`,
        updated_at: sql`now()`,
      })
      .where(eq(securityPlatformSpend.month, input.month))
      .returning({ spent: securityPlatformSpend.spent_nano_usd });
    return {
      projectSpentNano: project?.spent ?? 0,
      platformSpentNano: platform?.spent ?? 0,
    };
  });
}

/**
 * The runtime copy's cost (M30, spec §8.6 and §16): one Worker script and throwaway
 * stores, counted on the scan's meter and on both month rows. It is cents of a cent, so
 * it never waits on a cap; it only counts while this attempt runs.
 */
export async function chargeSecurityScanCopy(
  db: Db,
  input: Readonly<{
    scanId: string;
    attempt: number;
    projectId: string;
    nano: number;
    now?: number;
  }>,
): Promise<boolean> {
  const nano = Math.max(0, Math.round(input.nano));
  const month = securitySpendMonth(input.now ?? Date.now());
  return db.transaction(async (tx) => {
    const [scan] = await tx
      .update(securityScans)
      .set({ metered_nano_usd: sql`${securityScans.metered_nano_usd} + ${nano}` })
      .where(
        and(
          eq(securityScans.id, input.scanId),
          eq(securityScans.attempt, input.attempt),
          eq(securityScans.status, 'running'),
        ),
      )
      .returning({ id: securityScans.id });
    if (!scan) {
      return false;
    }
    await ensureSpendRows(tx, input.projectId, month);
    await tx
      .update(securityProjectSpend)
      .set({
        spent_nano_usd: sql`${securityProjectSpend.spent_nano_usd} + ${nano}`,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(securityProjectSpend.project_id, input.projectId),
          eq(securityProjectSpend.month, month),
        ),
      );
    await tx
      .update(securityPlatformSpend)
      .set({
        spent_nano_usd: sql`${securityPlatformSpend.spent_nano_usd} + ${nano}`,
        updated_at: sql`now()`,
      })
      .where(eq(securityPlatformSpend.month, month));
    return true;
  });
}
