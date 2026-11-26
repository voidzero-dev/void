// The frame Engines A and C share. They start a vendor CLI that sees a proxy stop (cap,
// budget, 402) only as a failed model call, so after a session that did not submit the
// runner asks the proxy why (`GET /v1/void/last-failure`, spec §8.4).

import { readProxyStopReason } from '../status.ts';
import type { OutcomeBody, ProxyStop } from '../status.ts';
import { emptyStats } from './types.ts';
import type { SessionOutcome, SessionSpec, SessionStats } from './types.ts';

export const LAST_FAILURE_PATH = '/v1/void/last-failure';
/** Lets HTTPS to any other host finish TLS against the controller's deny intercept. */
export const CONTAINER_CA_FILE = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';

type ProxyFailure = { reason: string; httpStatus: number; at: number };

/** The proxy's last refused or failed call for this scan attempt, or `null`. Never throws. */
async function readLastFailure(
  baseUrl: string,
  doFetch: typeof fetch,
  signal?: AbortSignal,
): Promise<ProxyFailure | null> {
  try {
    const timeout = AbortSignal.timeout(5000);
    const response = await doFetch(`${new URL(baseUrl).origin}${LAST_FAILURE_PATH}`, {
      method: 'GET',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const { failure } = (await response.json()) as { failure?: unknown };
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

export type SdkSessionOptions<Sdk> = {
  loadSdk: () => Promise<Sdk>;
  /** For the `engine_unavailable` detail: `Agent SDK`, `Codex SDK`. */
  sdkName: string;
  baseUrl: string;
  fetch: typeof fetch;
};

export type SdkSessionContext<Sdk> = {
  sdk: Sdk;
  stats: SessionStats;
  /** Fires when the session's signal stops. */
  abort: AbortController;
  /** The proxy failure that ended the session, unless the proxy held it before the session. */
  proxyStop: () => Promise<ProxyStop | null>;
};

/**
 * Loads the SDK (a scanner image without it ends `engine_unavailable`), runs one session,
 * then applies the stop signal. Each engine applies the session's report check itself.
 */
export async function runSdkSession<Sdk>(
  spec: SessionSpec,
  options: SdkSessionOptions<Sdk>,
  run: (context: SdkSessionContext<Sdk>) => Promise<OutcomeBody>,
): Promise<SessionOutcome> {
  const stats = emptyStats();
  const done = (outcome: OutcomeBody): SessionOutcome => ({ ...outcome, stats });
  if (spec.signal?.aborted) {
    return done({ kind: 'aborted' });
  }
  let sdk: Sdk;
  try {
    sdk = await options.loadSdk();
  } catch {
    return done({
      kind: 'infrastructure',
      errorClass: 'engine_unavailable',
      detail: `the ${options.sdkName} is not in this scanner image`,
    });
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  spec.signal?.addEventListener('abort', stop, { once: true });
  const lastFailure = () => readLastFailure(options.baseUrl, options.fetch, spec.signal);
  const before = await lastFailure();
  const proxyStop = async (): Promise<ProxyStop | null> => {
    const after = await lastFailure();
    if (
      after === null ||
      (before?.at === after.at &&
        before.reason === after.reason &&
        before.httpStatus === after.httpStatus)
    ) {
      return null;
    }
    return { httpStatus: after.httpStatus, reason: readProxyStopReason(after.reason) };
  };
  let outcome: OutcomeBody;
  try {
    outcome = await run({ sdk, stats, abort, proxyStop });
  } finally {
    spec.signal?.removeEventListener('abort', stop);
  }
  return done(spec.signal?.aborted ? { kind: 'aborted' } : outcome);
}
