/**
 * Per-attempt model call state kept in the `SecurityScanScheduler` DO storage for the
 * model proxy (design doc 0095, M7):
 *
 *   - calls per agent session: Codex has no max-turns setting, so the proxy counts
 *     calls per session (spec §6.3). The session comes from the runner's
 *     `x-void-scan-session` header. It is a limit the runner keeps, not a wall: the
 *     per-scan call cap in Postgres is the hard bound.
 *   - the `@cf` rate guard: 10 calls per minute per model, a token bucket.
 *   - the last refused or failed call, which the runner asks for (Engine C sees a
 *     proxy stop only as a failed call, spec §8.4).
 *
 * Plain functions over a small storage interface so tests need no DO.
 */

/** The parts of `DurableObjectStorage` this uses. */
export type CallLedgerStorage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;

export const SECURITY_SESSION_CALL_LIMIT = 40;
/** Sessions in one scan: one hunt, at most ten verify sessions, with room to spare. */
export const SECURITY_MAX_SESSION_INDEX = 63;
export const SECURITY_CF_CALLS_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

export type ModelCallFailureReason =
  | 'session_calls'
  | 'scan_calls'
  | 'tokens'
  | 'budget'
  | 'credits'
  | 'not_allowed'
  | 'upstream'
  | 'rate_wait';

export type ModelCallFailure = Readonly<{
  reason: ModelCallFailureReason;
  httpStatus: number;
  at: number;
}>;

export type AdmitModelCall = Readonly<{
  scanId: string;
  attempt: number;
  /** `null` when the runner sent no session; only the per-scan cap applies then. */
  session: number | null;
  /** The `@cf` model to take a rate token for, or `null` for third-party models. */
  rateModel: string | null;
  now: number;
}>;

export type AdmitModelCallResult =
  | Readonly<{ ok: true; sessionCalls: number | null }>
  | Readonly<{ ok: false; reason: 'session_calls' }>
  | Readonly<{ ok: false; reason: 'rate'; waitMs: number }>;

type Bucket = { tokens: number; at: number };

function attemptPrefix(scanId: string, attempt: number): string {
  return `call:${scanId}:${attempt}:`;
}

function sessionKey(scanId: string, attempt: number, session: number): string {
  return `${attemptPrefix(scanId, attempt)}session:${session}`;
}

function failureKey(scanId: string, attempt: number): string {
  return `${attemptPrefix(scanId, attempt)}failure`;
}

function rateKey(model: string): string {
  return `rate:${model}`;
}

/** The bucket after refilling to `now`: 10 tokens a minute, at most 10 held. */
export function refillRateBucket(bucket: Bucket | undefined, now: number): Bucket {
  if (!bucket) {
    return { tokens: SECURITY_CF_CALLS_PER_MINUTE, at: now };
  }
  const elapsed = Math.max(0, now - bucket.at);
  const tokens = Math.min(
    SECURITY_CF_CALLS_PER_MINUTE,
    bucket.tokens + (elapsed * SECURITY_CF_CALLS_PER_MINUTE) / MINUTE_MS,
  );
  return { tokens, at: now };
}

/**
 * Counts one call for its session and takes one `@cf` rate token. Neither is taken
 * when the other refuses. DO storage calls in one method run without interleaving, so
 * the read and the write cannot race.
 */
export async function admitModelCall(
  storage: CallLedgerStorage,
  input: AdmitModelCall,
): Promise<AdmitModelCallResult> {
  let sessionCalls: number | null = null;
  if (input.session !== null) {
    const used =
      (await storage.get<number>(sessionKey(input.scanId, input.attempt, input.session))) ?? 0;
    if (used >= SECURITY_SESSION_CALL_LIMIT) {
      return { ok: false, reason: 'session_calls' };
    }
    sessionCalls = used + 1;
  }
  if (input.rateModel !== null) {
    const bucket = refillRateBucket(await storage.get<Bucket>(rateKey(input.rateModel)), input.now);
    if (bucket.tokens < 1) {
      const waitMs = Math.ceil(((1 - bucket.tokens) * MINUTE_MS) / SECURITY_CF_CALLS_PER_MINUTE);
      return { ok: false, reason: 'rate', waitMs };
    }
    await storage.put(rateKey(input.rateModel), { tokens: bucket.tokens - 1, at: input.now });
  }
  if (input.session !== null && sessionCalls !== null) {
    await storage.put(sessionKey(input.scanId, input.attempt, input.session), sessionCalls);
  }
  return { ok: true, sessionCalls };
}

export async function recordModelCallFailure(
  storage: CallLedgerStorage,
  scanId: string,
  attempt: number,
  failure: ModelCallFailure,
): Promise<void> {
  await storage.put(failureKey(scanId, attempt), failure);
}

export async function readModelCallFailure(
  storage: CallLedgerStorage,
  scanId: string,
  attempt: number,
): Promise<ModelCallFailure | null> {
  return (await storage.get<ModelCallFailure>(failureKey(scanId, attempt))) ?? null;
}

/** Drops an attempt's counters and its last failure, when the scan has ended. */
export async function forgetModelCalls(
  storage: CallLedgerStorage,
  scanId: string,
  attempt: number,
): Promise<number> {
  const keys = [...(await storage.list({ prefix: attemptPrefix(scanId, attempt) })).keys()];
  if (keys.length === 0) {
    return 0;
  }
  return storage.delete(keys);
}
