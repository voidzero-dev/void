// Probe checks 2 and 3 from inside the scanner container (spec §5.2). The controller
// runs `node runner.mjs --self-test` as the `scanner` user and judges the JSON line it
// prints: the container started as non-root, the model route answers with the probe id
// the container never saw, the internet does not answer, and no credential is in env.
//
// Nothing here walks the file system: /run/cloudchamber holds procfs/sysfs views that
// block readers (spike S1).

import { MODEL_BASE_URL } from './engines/void-loop.ts';

/** Egress check name → the URL it fetches. */
export interface SelfTestEgressTargets {
  readonly [name: string]: string;
}

/** Hosts the container must not reach. Each one fails, or ends in the controller's deny handler. */
export const SELF_TEST_EGRESS_TARGETS: SelfTestEgressTargets = {
  httpExample: 'http://example.com/',
  httpsExample: 'https://example.com/',
  httpsBareIp: 'https://1.1.1.1/',
  httpUnknownHost: 'http://nx-void-scanner.invalid/',
};

/** The deny handler answers 403 with a body that starts with this. */
export const EGRESS_DENIED_PREFIX = 'egress denied';

const CREDENTIAL_WORDS = ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'AUTH', 'CREDENTIAL'];

export type EgressResult = Readonly<{
  blocked: boolean;
  ms: number;
  /** HTTP status when something answered. */
  status?: number;
  /** Error name or code when the request failed. */
  error?: string;
}>;

export type SelfTestReport = Readonly<{
  selfTest: 1;
  uid: number | null;
  node: string;
  model: Readonly<{ ok: boolean; status?: number; probe?: string; error?: string; ms: number }>;
  egress: Readonly<Record<string, EgressResult>>;
  /** Names only, never values. */
  envSuspicious: ReadonlyArray<string>;
}>;

export type SelfTestOptions = Readonly<{
  baseUrl?: string;
  targets?: SelfTestEgressTargets;
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  uid?: number | null;
  fetch?: typeof fetch;
}>;

function errorName(error: unknown): string {
  if (error && typeof error === 'object') {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === 'string') {
      return cause.code;
    }
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') {
      return name;
    }
  }
  return 'error';
}

export function suspiciousEnvNames(
  env: Readonly<Record<string, string | undefined>>,
): Array<string> {
  return Object.keys(env)
    .filter((name) => {
      const upper = name.toUpperCase();
      return CREDENTIAL_WORDS.some((word) => upper.includes(word));
    })
    .sort();
}

async function probeEgress(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<EgressResult> {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await response.text()).slice(0, 200);
    const denied = response.status === 403 && body.startsWith(EGRESS_DENIED_PREFIX);
    return { blocked: denied, ms: Date.now() - started, status: response.status };
  } catch (error) {
    // No answer (refused, reset, TLS failure or timeout): nothing reached the host.
    return { blocked: true, ms: Date.now() - started, error: errorName(error) };
  }
}

async function probeModel(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<SelfTestReport['model']> {
  const started = Date.now();
  try {
    const response = await fetchImpl(`${baseUrl}/v1/self-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let probe: string | undefined;
    try {
      const value = JSON.parse(text) as { probe?: unknown };
      probe = typeof value.probe === 'string' ? value.probe.slice(0, 64) : undefined;
    } catch {
      probe = undefined;
    }
    return {
      ok: response.status === 200 && probe !== undefined,
      status: response.status,
      probe,
      ms: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, error: errorName(error), ms: Date.now() - started };
  }
}

export async function runSelfTest(options: SelfTestOptions = {}): Promise<SelfTestReport> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const targets = options.targets ?? SELF_TEST_EGRESS_TARGETS;
  const [model, ...egress] = await Promise.all([
    probeModel(options.baseUrl ?? MODEL_BASE_URL, timeoutMs, fetchImpl),
    ...Object.values(targets).map((url) => probeEgress(url, timeoutMs, fetchImpl)),
  ]);
  const uid =
    options.uid !== undefined
      ? options.uid
      : typeof process.getuid === 'function'
        ? process.getuid()
        : null;
  return {
    selfTest: 1,
    uid,
    node: process.version,
    model,
    egress: Object.fromEntries(Object.keys(targets).map((name, index) => [name, egress[index]])),
    envSuspicious: suspiciousEnvNames(options.env ?? process.env),
  };
}
