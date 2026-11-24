// Engines A and C start a vendor CLI that sees a proxy stop (cap, budget, 402) only as a
// failed model call. After a session that did not submit, the runner asks the proxy why
// (`GET /v1/void/last-failure`, spec §8.4) and uses that reason, not the CLI's error text.

import { readProxyStopReason } from '../status.ts';
import type { ProxyStopReason } from '../status.ts';

export const LAST_FAILURE_PATH = '/v1/void/last-failure';

export type ProxyFailure = { reason: string; httpStatus: number; at: number };

/** The proxy's last refused or failed call for this scan attempt, or `null`. Never throws. */
export async function readLastFailure(
  baseUrl: string,
  doFetch: typeof fetch,
  signal?: AbortSignal,
): Promise<ProxyFailure | null> {
  try {
    const response = await doFetch(`${new URL(baseUrl).origin}${LAST_FAILURE_PATH}`, {
      method: 'GET',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = (await response.json()) as { failure?: unknown };
    const failure = body.failure;
    if (typeof failure !== 'object' || failure === null) {
      return null;
    }
    const { reason, httpStatus, at } = failure as Record<string, unknown>;
    return typeof reason === 'string' && typeof httpStatus === 'number' && typeof at === 'number'
      ? { reason, httpStatus, at }
      : null;
  } catch {
    return null;
  }
}

/**
 * The stop that ended a session: the failure the proxy holds now, when it is not the one
 * it held before the session started.
 */
export function stopSince(
  before: ProxyFailure | null,
  after: ProxyFailure | null,
): { httpStatus: number; reason: ProxyStopReason | null } | null {
  if (after === null) {
    return null;
  }
  if (
    before !== null &&
    before.at === after.at &&
    before.reason === after.reason &&
    before.httpStatus === after.httpStatus
  ) {
    return null;
  }
  return { httpStatus: after.httpStatus, reason: readProxyStopReason(after.reason) };
}
