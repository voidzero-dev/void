/**
 * Error thrown when a promise wrapped by {@link withTimeout} does not settle
 * within its allotted time. The `label` identifies which awaited operation
 * timed out (e.g. `'kv:get'`, `'r2:head'`) for logging/observability.
 */
export class DispatchTimeoutError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(`Dispatch operation timed out: ${label}`);
    this.name = 'DispatchTimeoutError';
    this.label = label;
  }
}

/**
 * Bounds an awaited `promise` so the request path never blocks indefinitely.
 *
 * - When `ms` is not a positive finite number (`<= 0`, `NaN`, or `Infinity`),
 *   the original `promise` is returned unchanged (escape hatch — no timer).
 * - Otherwise the `promise` races a timer that rejects with a
 *   {@link DispatchTimeoutError} after `ms` milliseconds.
 * - The timer is cleared as soon as `promise` settles (resolve **or** reject),
 *   so it never fires late and leaves no dangling handle. A fast rejection
 *   propagates the ORIGINAL reason (not a timeout error).
 * - If the timer wins, the result rejects with a `DispatchTimeoutError`. The
 *   underlying `promise` keeps running to completion in the background; we do
 *   not attempt to cancel the in-flight KV/R2 work.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DispatchTimeoutError(label));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

type HedgedOutcome<T> =
  | Readonly<{ ok: true; value: T | null }>
  | Readonly<{ ok: false; error: unknown }>;

type DelayedHedgeOptions<T> = Readonly<{
  delayMs: number;
  timeoutMs: number;
  label: string;
  discard?: (value: T) => void | Promise<void>;
  onHedge?: () => void;
}>;

/**
 * Run one operation and launch at most one fresh attempt if the first remains
 * pending after `delayMs`.
 *
 * - Both attempts share one absolute `timeoutMs` deadline.
 * - A fast success or miss (`null`) preserves the one-attempt fast path.
 * - A fast rejection retries immediately.
 * - Once hedged, the first non-null success wins. A miss/rejection from one
 *   attempt waits for its peer instead of masking a usable result.
 * - `discard` cleans up every successful non-null loser, including results
 *   which arrive after the absolute timeout (for R2-backed Responses this
 *   cancels the unread body stream).
 * - Every attempt is internally settled, so late rejection cannot become
 *   unhandled after the winner or timeout returns.
 * - A non-positive/non-finite delay disables hedging. A non-positive/non-
 *   finite timeout disables the deadline.
 */
export async function withDelayedHedge<T>(
  operation: () => Promise<T | null>,
  options: DelayedHedgeOptions<T>,
): Promise<T | null> {
  const hedgeEnabled = options.delayMs > 0 && Number.isFinite(options.delayMs);
  const timeoutEnabled = options.timeoutMs > 0 && Number.isFinite(options.timeoutMs);
  const run = async (): Promise<HedgedOutcome<T>> => {
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      return { ok: false, error };
    }
  };

  type Attempt = Readonly<{ id: number; promise: Promise<HedgedOutcome<T>> }>;
  const attempts: Array<Attempt> = [];
  const startAttempt = (): Attempt => {
    const attempt = { id: attempts.length + 1, promise: run() };
    attempts.push(attempt);
    return attempt;
  };

  let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
  const hedgeSignal = hedgeEnabled
    ? new Promise<Readonly<{ kind: 'hedge' }>>((resolve) => {
        hedgeTimer = setTimeout(() => resolve({ kind: 'hedge' }), options.delayMs);
      })
    : null;

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutSignal = timeoutEnabled
    ? new Promise<Readonly<{ kind: 'timeout' }>>((resolve) => {
        timeoutTimer = setTimeout(() => resolve({ kind: 'timeout' }), options.timeoutMs);
      })
    : null;

  const clearTimers = (): void => {
    clearTimeout(hedgeTimer);
    clearTimeout(timeoutTimer);
  };
  const discardAttempt = (attempt: Attempt): void => {
    // The storage binding itself is not abortable. Keep a handled continuation
    // so a late body is canceled and a late rejection is always observed.
    void attempt.promise
      .then(async (outcome) => {
        if (outcome.ok && outcome.value !== null) {
          await options.discard?.(outcome.value);
        }
      })
      .catch(() => {});
  };
  const finish = (winnerId?: number): void => {
    clearTimers();
    for (const attempt of attempts) {
      if (attempt.id !== winnerId) {
        discardAttempt(attempt);
      }
    }
  };
  const timeout = (): never => {
    finish();
    throw new DispatchTimeoutError(options.label);
  };
  const waitForAttempt = (attempt: Attempt) =>
    attempt.promise.then((outcome) => ({
      kind: 'attempt' as const,
      attempt,
      outcome,
    }));

  const first = startAttempt();
  const initial = await Promise.race([
    waitForAttempt(first),
    ...(hedgeSignal ? [hedgeSignal] : []),
    ...(timeoutSignal ? [timeoutSignal] : []),
  ]);

  if (initial.kind === 'timeout') {
    return timeout();
  }

  if (initial.kind === 'attempt') {
    clearTimeout(hedgeTimer);
    if (initial.outcome.ok) {
      finish(first.id);
      return initial.outcome.value;
    }
    if (!hedgeEnabled) {
      finish();
      throw initial.outcome.error;
    }

    // Binding errors are often transient. Retry one fast rejection without
    // waiting for the hedge delay; the same absolute deadline still applies.
    options.onHedge?.();
    const retry = startAttempt();
    const retried = await Promise.race([
      waitForAttempt(retry),
      ...(timeoutSignal ? [timeoutSignal] : []),
    ]);
    if (retried.kind === 'timeout') {
      return timeout();
    }
    finish(retry.id);
    if (retried.outcome.ok) {
      return retried.outcome.value;
    }
    throw retried.outcome.error;
  }

  // The timer fired, so attempt one is still pending. Launch exactly one
  // independent read and prefer the first usable (non-null) result.
  options.onHedge?.();
  const second = startAttempt();
  const winner = await Promise.race([
    waitForAttempt(first),
    waitForAttempt(second),
    ...(timeoutSignal ? [timeoutSignal] : []),
  ]);

  if (winner.kind === 'timeout') {
    return timeout();
  }
  if (winner.outcome.ok && winner.outcome.value !== null) {
    finish(winner.attempt.id);
    return winner.outcome.value;
  }

  const peer = winner.attempt.id === first.id ? second : first;
  const peerResult = await Promise.race([
    waitForAttempt(peer),
    ...(timeoutSignal ? [timeoutSignal] : []),
  ]);
  if (peerResult.kind === 'timeout') {
    return timeout();
  }

  if (peerResult.outcome.ok && peerResult.outcome.value !== null) {
    finish(peer.id);
    return peerResult.outcome.value;
  }
  finish();
  if (winner.outcome.ok || peerResult.outcome.ok) {
    return null;
  }
  throw winner.outcome.error;
}

/**
 * Resolve the timeout budget (ms) from the raw `DISPATCH_TIMEOUT_MS` env value.
 *
 * - Unset (`undefined`) → the `fallback` default (10s).
 * - Any explicitly-provided value is passed through via `Number(...)` UNCHANGED —
 *   including `'0'`, negatives, empty string, and non-numeric strings (`NaN`). This
 *   preserves the escape hatch: {@link withTimeout} treats any non-positive/non-finite
 *   budget as "no timer", so an operator can disable the bounded paths by setting
 *   `DISPATCH_TIMEOUT_MS='0'` WITHOUT a redeploy. A blanket `|| fallback` would defeat
 *   this by collapsing every disabling value back to the default.
 */
export function resolveTimeoutMs(raw: string | undefined, fallback = 10_000): number {
  return raw === undefined ? fallback : Number(raw);
}
