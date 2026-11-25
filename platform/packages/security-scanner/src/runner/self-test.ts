// Probe checks 2 and 3 from inside the scanner container (spec §5.2). The controller
// runs `node runner.mjs --self-test` as the `scanner` user and judges the JSON line it
// prints: the container started as non-root, the model route answers with the probe id
// the container never saw, the internet does not answer, and no credential is in env.
// Nothing here walks the file system: /run/cloudchamber holds procfs/sysfs views that
// block readers (spike S1).

/** Hosts the container must not reach. Each one fails, or ends in the controller's deny handler. */
const EGRESS_TARGETS = {
  httpExample: 'http://example.com/',
  httpsExample: 'https://example.com/',
  httpsBareIp: 'https://1.1.1.1/',
  httpUnknownHost: 'http://nx-void-scanner.invalid/',
};
const CREDENTIAL_WORDS = ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'AUTH', 'CREDENTIAL'];
const TIMEOUT_MS = 8000;

function errorName(error: unknown): string {
  const { cause, name } = (error ?? {}) as { cause?: { code?: unknown }; name?: unknown };
  if (typeof cause?.code === 'string') {
    return cause.code;
  }
  return typeof name === 'string' ? name : 'error';
}

async function probeEgress(url: string) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await response.text()).slice(0, 200);
    // The controller's deny handler answers 403 `egress denied: <host>`.
    const blocked = response.status === 403 && body.startsWith('egress denied');
    return { blocked, ms: Date.now() - started, status: response.status };
  } catch (error) {
    // No answer (refused, reset, TLS failure or timeout): nothing reached the host.
    return { blocked: true, ms: Date.now() - started, error: errorName(error) };
  }
}

async function probeModel(baseUrl: string) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/v1/self-test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
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

export async function runSelfTest(baseUrl: string) {
  const names = Object.keys(EGRESS_TARGETS);
  const [model, ...egress] = await Promise.all([
    probeModel(baseUrl),
    ...Object.values(EGRESS_TARGETS).map(probeEgress),
  ]);
  return {
    selfTest: 1,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    node: process.version,
    model,
    egress: Object.fromEntries(names.map((name, index) => [name, egress[index]])),
    // Names only, never values.
    envSuspicious: Object.keys(process.env)
      .filter((name) => CREDENTIAL_WORDS.some((word) => name.toUpperCase().includes(word)))
      .sort(),
  };
}
