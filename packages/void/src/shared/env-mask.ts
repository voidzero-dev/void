/**
 * Secret redaction helpers for env-validation output.
 *
 * Values are redacted (replaced with `<redacted>`) whenever they flow into
 * a user-visible string — `EnvValidationError` messages, CLI reports, the
 * dev-server warning block. The key name is never masked (the user needs
 * it to locate the offending entry).
 *
 * Server env values are production secrets by definition, so validator
 * messages redact the raw input unconditionally.
 *
 * Users can opt out of the guard for local debugging via
 * `VOID_ENV_UNMASK=1` in the environment; that path prints a one-shot
 * notice on stderr so the loosened output is visibly attributed.
 *
 * This module is a leaf — no imports from non-leaf modules, safe to reach
 * from both the runtime (worker bundle) and the CLI host.
 */

/** Sentinel emitted in place of a redacted value. */
export const REDACTED = '<redacted>';

/** Environment variable that disables redaction when set to `1`. */
export const UNMASK_ENV_VAR = 'VOID_ENV_UNMASK';

export type MaskOptions = {
  /** When true, the env unmask escape hatch has been honoured. */
  unmask?: boolean;
};

/** Replace raw input in validator messages, regardless of its name or shape. */
export function redactMessage(
  rawValue: unknown,
  message: string,
  options: MaskOptions = {},
): string {
  if (options.unmask) {
    return message;
  }
  if (typeof rawValue !== 'string' || rawValue.length === 0) {
    return message;
  }
  // Replace every literal occurrence of the raw value with the sentinel.
  // `split/join` avoids constructing a user-controlled regex.
  return message.split(rawValue).join(REDACTED);
}

let unmaskResolved: boolean | null = null;

/**
 * Resolve the effective unmask flag, consulting `process.env` exactly once
 * per process. On the first affirmative read, we print a one-shot notice to
 * stderr so CI logs clearly show the guard is off.
 */
export function isUnmaskActive(): boolean {
  if (unmaskResolved !== null) {
    return unmaskResolved;
  }
  try {
    // `process` may be missing in Worker bundles, and Deno throws without env permission.
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    unmaskResolved = proc?.env?.[UNMASK_ENV_VAR] === '1';
  } catch {
    unmaskResolved = false;
  }
  if (unmaskResolved) {
    // explicit operator warning.
    console.error(
      `[void/env] ${UNMASK_ENV_VAR}=1 is set — env validation errors will include raw values. Unset it before sharing logs.`,
    );
  }
  return unmaskResolved;
}

/** Test hook — resets the memoised unmask state. Not part of the public API. */
export function _resetUnmaskCacheForTests(): void {
  unmaskResolved = null;
}
