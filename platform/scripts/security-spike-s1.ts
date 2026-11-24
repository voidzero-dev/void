/**
 * Security audits Phase 0 spike S1: container egress lock and cold start.
 *
 * Measures, on a real Cloudflare account:
 *   - A scratch controller Worker (`void-spike-sa-s1`) with a Durable Object that starts a
 *     Cloudflare Container (managed `cloudflare/debian-trixie` image, `lite` instance,
 *     `enableInternet: false`). Outbound HTTP goes through intercepts: the host
 *     `model.scan.internal` goes to `ScanModelOutbound` (the model-proxy stand-in, which
 *     reads the scan id from its own props), every other host goes to `DenyAll` (403).
 *   - Inside the container: the model call works and returns the scan id the container
 *     never saw; https://example.com, an unknown host, a bare IP, raw TCP and raw UDP DNS
 *     all fail; env and common writable dirs hold no token.
 *   - Cold start (request reaches the Durable Object -> first successful `exec`) over
 *     `--runs` fresh containers (default 5).
 *
 * Run (from the repo root):
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... NODE_USE_SYSTEM_CA=1 \
 *     node platform/scripts/security-spike-s1.ts [--runs 5] [--keep]
 *   The token needs Workers Scripts Edit and Containers Edit. Set WRANGLER_BIN to use a
 *   specific wrangler. Only `void-spike-sa-*` resources are created; all are deleted at
 *   the end (unless `--keep`) and the script checks the lists afterwards.
 *
 * Pass: model call works with the right scan id, every internet probe fails, no token in
 * env or files, max cold start < 60 s (with 5 runs, max is the p95). Prints one JSON report
 * and a PASS/FAIL line; exits 1 on FAIL.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

export const SPIKE_PREFIX = 'void-spike-sa-';
const COLD_START_LIMIT_MS = 60_000;

export type SpikeEnv = { accountId: string; token: string };

export function readSpikeEnv(): SpikeEnv {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.');
  }
  return { accountId, token };
}

export async function cfApi<T>(
  env: SpikeEnv,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; result: T; errors: unknown }> {
  const headers = new Headers(init.headers);
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${env.token}`);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.accountId}${path}`,
    { ...init, headers },
  );
  const text = await response.text();
  let body: { success?: boolean; result?: T; errors?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = { errors: text.slice(0, 500) };
  }
  return {
    ok: response.ok && body.success !== false,
    status: response.status,
    result: body.result as T,
    errors: body.errors,
  };
}

function wranglerBin(): string {
  if (process.env.WRANGLER_BIN) {
    return process.env.WRANGLER_BIN;
  }
  // The api package depends on wrangler; platform/scripts has no package of its own.
  const require = createRequire(new URL('../packages/api/package.json', import.meta.url));
  return join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
}

export function runWrangler(env: SpikeEnv, args: Array<string>, cwd: string) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [wranglerBin(), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: env.accountId,
      CLOUDFLARE_API_TOKEN: env.token,
      WRANGLER_SEND_METRICS: 'false',
    },
    timeout: 20 * 60_000,
  });
  return {
    status: result.status,
    ms: Date.now() - started,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

/** Deploy a scratch Worker from source + wrangler config; returns its workers.dev URL. */
export async function deploySpikeWorker(
  env: SpikeEnv,
  name: string,
  source: string,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<{ url: string; deployMs: number; output: string }> {
  if (!name.startsWith(SPIKE_PREFIX)) {
    throw new Error(`Refusing to deploy ${name}: spike resources must start with ${SPIKE_PREFIX}`);
  }
  const directory = mkdtempSync(join(tmpdir(), `${name}-`));
  try {
    writeFileSync(join(directory, 'index.js'), source);
    writeFileSync(
      join(directory, 'wrangler.json'),
      JSON.stringify(
        {
          name,
          main: 'index.js',
          compatibility_date: '2026-09-01',
          workers_dev: true,
          preview_urls: false,
          ...config,
        },
        null,
        2,
      ),
    );
    writeFileSync(join(directory, 'secrets.json'), JSON.stringify(secrets));
    const deployed = runWrangler(env, ['deploy', '--secrets-file', 'secrets.json'], directory);
    if (deployed.status !== 0) {
      throw new Error(`wrangler deploy ${name} failed:\n${deployed.output.slice(-4000)}`);
    }
    const subdomain = await cfApi<{ subdomain: string }>(env, '/workers/subdomain');
    if (!subdomain.ok) {
      throw new Error(`workers.dev subdomain lookup failed: ${JSON.stringify(subdomain.errors)}`);
    }
    return {
      url: `https://${name}.${subdomain.result.subdomain}.workers.dev`,
      deployMs: deployed.ms,
      output: deployed.output,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type ContainerApp = { id: string; name: string };

export async function listSpikeResources(env: SpikeEnv) {
  const scripts = await cfApi<Array<{ id: string }>>(env, '/workers/scripts');
  const apps = await cfApi<Array<ContainerApp>>(env, '/containers/applications');
  if (!scripts.ok || !apps.ok) {
    throw new Error(
      `Listing failed: scripts ${scripts.status} ${JSON.stringify(scripts.errors)}, apps ${apps.status} ${JSON.stringify(apps.errors)}`,
    );
  }
  return {
    workerCount: scripts.result.length,
    containerAppCount: apps.result.length,
    workers: scripts.result.map((s) => s.id).filter((id) => id.startsWith(SPIKE_PREFIX)),
    containerApps: apps.result.filter((a) => a.name.startsWith(SPIKE_PREFIX)),
  };
}

/** Delete the named spike Worker and every `void-spike-sa-*` container app, then re-list. */
export async function deleteSpikeResources(env: SpikeEnv, workerNames: Array<string>) {
  const log: Array<string> = [];
  for (const name of workerNames) {
    if (!name.startsWith(SPIKE_PREFIX)) {
      throw new Error(`Refusing to delete ${name}`);
    }
    const before = await listSpikeResources(env);
    if (!before.workers.includes(name)) {
      continue;
    }
    const deleted = runWrangler(env, ['delete', name, '--force'], tmpdir());
    log.push(`wrangler delete ${name}: exit ${deleted.status}`);
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const { containerApps } = await listSpikeResources(env);
    if (containerApps.length === 0) {
      break;
    }
    for (const app of containerApps) {
      const deleted = await cfApi(env, `/containers/applications/${app.id}`, { method: 'DELETE' });
      log.push(`DELETE container app ${app.name} (${app.id}): ${deleted.status}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 3000);
    });
  }
  const after = await listSpikeResources(env);
  return { log, after };
}

/** A fresh workers.dev route flaps between 200 and 404 for a while; wait for 5 x 200 in a row. */
export async function waitForWorker(url: string, key: string): Promise<number> {
  const started = Date.now();
  let streak = 0;
  while (Date.now() - started < 180_000) {
    try {
      const response = await fetch(`${url}/health`, { headers: { 'x-spike-key': key } });
      streak = response.status === 200 ? streak + 1 : 0;
      if (streak >= 5) {
        return Date.now() - started;
      }
    } catch {
      streak = 0;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
  }
  throw new Error(`${url} did not become reachable within 180 s`);
}

export function percentile(values: Array<number>, p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

// Runs inside the container (CommonJS via \`node -e\`). Each case runs in its own process
// so one hung or crashing check cannot hide the others; each prints one JSON line.
const PROBE_LIB = String.raw`
const net = require('node:net'), dns = require('node:dns').promises, dgram = require('node:dgram'), fs = require('node:fs'), path = require('node:path');
function why(e) { const c = e && e.cause; return String((c && (c.code || c.message)) || (e && (e.code || (e.name + ': ' + e.message))) || e); }
async function t(fn) { const s = Date.now(); let r; try { r = { ok: true, ...(await fn()) }; } catch (e) { r = { ok: false, error: why(e) }; } r.ms = Date.now() - s; console.log(JSON.stringify(r)); }
async function get(url, init) { const r = await fetch(url, { ...(init || {}), signal: AbortSignal.timeout(8000) }); return { status: r.status, body: (await r.text()).slice(0, 400) }; }
function tcp(host, port) { return new Promise((res, rej) => { const s = net.connect({ host, port }); const to = setTimeout(() => { s.destroy(); rej(new Error('timeout 5s')); }, 5000); s.on('connect', () => { clearTimeout(to); s.destroy(); res({ connected: true }); }); s.on('error', (e) => { clearTimeout(to); rej(e); }); }); }
// HTTPS that trusts the intercept CA: proves port 443 ends in the controller's handler.
function trusted(host, servername) { return new Promise((res, rej) => { let ca; try { ca = fs.readFileSync('/etc/cloudflare/certs/cloudflare-containers-ca.crt'); } catch (e) { return rej(e); } const r = require('node:https').get({ host, servername, path: '/', headers: { host: servername }, ca, timeout: 8000 }, (m) => { let b = ''; m.on('data', (d) => (b += d)); m.on('end', () => res({ status: m.statusCode, body: b.slice(0, 200) })); }); r.on('error', rej); r.on('timeout', () => r.destroy(new Error('timeout 8s'))); }); }
function udpDns(server) { return new Promise((res, rej) => { const q = Buffer.from('abcd01000001000000000000076578616d706c6503636f6d0000010001', 'hex'); const s = dgram.createSocket('udp4'); const to = setTimeout(() => { s.close(); rej(new Error('no reply in 3s')); }, 3000); s.on('message', (m) => { clearTimeout(to); s.close(); const answers = m.readUInt16BE(6); const a = m.length >= 4 ? [...m.subarray(m.length - 4)].join('.') : ''; res({ replyBytes: m.length, rcode: m[3] & 15, answers, lastA: a }); }); s.on('error', (e) => { clearTimeout(to); s.close(); rej(e); }); s.send(q, 53, server); }); }
// /proc, /sys and /run/cloudchamber (a procfs/sysfs view) hold blocking special files.
const SKIP = new Set(['/proc', '/sys', '/dev', '/run/cloudchamber']);
function scan(dir, marker, hits, depth) { if (depth > 6 || hits.length > 5 || SKIP.has(dir)) return; let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of entries) { const p = path.join(dir, e.name); if (e.isDirectory()) scan(p, marker, hits, depth + 1); else if (e.isFile()) { try { const st = fs.statSync(p); if (st.size < 1048576 && fs.readFileSync(p, 'latin1').includes(marker)) hits.push(p); } catch {} } } }
// Credential-like names. CLOUDFLARE_* runtime metadata (application, node, DO id) is listed separately.
const suspicious = (n) => ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'AUTH', 'CREDENTIAL', 'VOID'].some((w) => n.toUpperCase().includes(w));
function secrets() {
  let pid1 = ''; let pid1EnvError; try { pid1 = fs.readFileSync('/proc/1/environ', 'utf8'); } catch (e) { pid1EnvError = e.code; }
  let ociEnv = []; try { ociEnv = (JSON.parse(fs.readFileSync('/run/crun/cloudchamber/config.json', 'utf8')).process || {}).env || []; } catch {}
  const pid1Names = pid1.split('\0').map((s) => s.split('=')[0]).filter(Boolean);
  const ociNames = ociEnv.map((s) => s.split('=')[0]);
  const hits = []; for (const d of ['/etc', '/root', '/tmp', '/run', '/var', '/home', '/opt', '/srv', '/workspace', '/usr/local']) scan(d, 'vss' + 'k_', hits, 0);
  const envNames = Object.keys(process.env);
  return { envNames, envSuspicious: envNames.filter(suspicious), pid1EnvNames: pid1Names, pid1EnvSuspicious: pid1Names.filter(suspicious), ociEnvSuspicious: ociNames.filter(suspicious), pid1EnvError, keyMarkerFiles: hits, cloudflareCaPresent: fs.existsSync('/etc/cloudflare/certs/cloudflare-containers-ca.crt'), node: process.version };
}
`;

export const PROBE_CASES: Record<string, string> = {
  modelCall: `get('http://model.scan.internal/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"spike","messages":[]}' })`,
  httpExample: `get('http://example.com/')`,
  httpUnknownHost: `get('http://nx-void-spike-sa.invalid/')`,
  httpsExample: `get('https://example.com/')`,
  httpsUnknownHost: `get('https://nx-void-spike-sa.invalid/')`,
  httpsBareIp: `get('https://1.1.1.1/')`,
  dnsLookupExample: `dns.lookup('example.com').then((a) => ({ address: a.address }))`,
  httpsTrustedCaExample: `trusted('example.com', 'example.com')`,
  httpsTrustedCaIpWithSni: `trusted('1.1.1.1', 'one.one.one.one')`,
  tcp1111port443: `tcp('1.1.1.1', 443)`,
  tcp1111port22: `tcp('1.1.1.1', 22)`,
  udpDns8888: `udpDns('8.8.8.8')`,
  udpDnsTestNet: `udpDns('192.0.2.1')`,
  secrets: `Promise.resolve(secrets())`,
};

function controllerSource(): string {
  return `
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

// Model-proxy stand-in. The scan id comes from props set by the controller, never from
// the container, so the container cannot claim another scan's identity.
export class ScanModelOutbound extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.text();
    return Response.json({ proxy: 'model', host: url.hostname, path: url.pathname, method: request.method, scanId: this.ctx.props.scanId, bodyBytes: body.length });
  }
}

export class DenyAll extends WorkerEntrypoint {
  fetch(request) {
    return new Response('egress denied: ' + new URL(request.url).hostname, { status: 403 });
  }
}

const PROBE_LIB = ${JSON.stringify(PROBE_LIB)};
const PROBE_CASES = ${JSON.stringify(PROBE_CASES)};
const decode = (b) => new TextDecoder().decode(b);

export class ScanController extends DurableObject {
  async run(probe, httpsDeny) {
    const t0 = Date.now();
    const c = this.ctx.container;
    if (c.running) await c.destroy();
    const scanId = crypto.randomUUID();
    // Hostname intercept first, catch-all second (catch-all registered first would win).
    await c.interceptOutboundHttp('model.scan.internal', this.ctx.exports.ScanModelOutbound({ props: { scanId } }));
    await c.interceptAllOutboundHttp(this.ctx.exports.DenyAll({ props: {} }));
    // HTTPS catch-all: the container does not trust the intercept CA, so TLS fails at once
    // instead of hanging until the client times out.
    if (httpsDeny) await c.interceptOutboundHttps('*', this.ctx.exports.DenyAll({ props: {} }));
    const tIntercepts = Date.now();
    c.start({ image: 'cloudflare/debian-trixie', entrypoint: ['sleep', 'infinity'], enableInternet: false, instance: 'lite' });
    await c.setInactivityTimeout(120000);
    const tStart = Date.now();
    let ready = 0, attempts = 0, lastError = '';
    while (Date.now() - t0 < 180000) {
      attempts++;
      try {
        const p = await c.exec(['true']);
        const o = await p.output();
        if (o.exitCode === 0) { ready = Date.now(); break; }
        lastError = 'exit ' + o.exitCode;
      } catch (e) {
        lastError = String(e && e.message || e);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const result = { scanId, interceptsMs: tIntercepts - t0, startCallMs: tStart - t0, coldStartMs: ready ? ready - t0 : null, execAttempts: attempts, lastError: ready ? undefined : lastError };
    if (ready && probe) {
      result.probe = {};
      for (const [name, expr] of Object.entries(PROBE_CASES)) {
        const s = Date.now();
        try {
          const p = await c.exec(['node', '-e', PROBE_LIB + ';t(() => ' + expr + ');'], { signal: AbortSignal.timeout(30000) });
          const o = await p.output();
          const stdout = decode(o.stdout).trim();
          try { result.probe[name] = JSON.parse(stdout); } catch { result.probe[name] = { ok: false, error: 'bad output exit ' + o.exitCode + ': ' + stdout.slice(0, 300) + decode(o.stderr).slice(0, 500), ms: Date.now() - s }; }
        } catch (e) {
          result.probe[name] = { ok: false, execError: String(e && e.message || e), ms: Date.now() - s };
        }
      }
    }
    try { await c.destroy(); } catch (e) { result.destroyError = String(e); }
    return result;
  }
}

export default {
  async fetch(request, env) {
    if (request.headers.get('x-spike-key') !== env.SPIKE_KEY) return new Response('forbidden', { status: 403 });
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/run') {
      const name = url.searchParams.get('name') || 'default';
      const stub = env.SCAN.getByName(name);
      try {
        return Response.json(await stub.run(url.searchParams.get('probe') === '1', url.searchParams.get('httpsDeny') !== '0'));
      } catch (e) {
        return Response.json({ error: String(e && e.stack || e) }, { status: 500 });
      }
    }
    return new Response('not found', { status: 404 });
  },
};
`;
}

type RunResult = {
  scanId: string;
  coldStartMs: number | null;
  startCallMs: number;
  interceptsMs: number;
  execAttempts: number;
  lastError?: string;
  destroyError?: string;
  probe?: Record<string, ProbeItem>;
};

type ProbeItem = {
  ok: boolean;
  ms: number;
  status?: number;
  body?: string;
  error?: string;
  execError?: string;
  [key: string]: unknown;
};

const blocked = (item: ProbeItem | undefined) =>
  item !== undefined &&
  !item.execError &&
  (!item.ok || (item.status === 403 && (item.body ?? '').startsWith('egress denied')));

function judgeProbe(run: RunResult) {
  const failures: Array<string> = [];
  const probe = run.probe ?? {};
  for (const [name, item] of Object.entries(probe)) {
    if (item.execError || (item.error ?? '').startsWith('bad output')) {
      failures.push(`${name}: probe did not run: ${item.execError ?? item.error}`);
    }
  }
  const model = probe.modelCall;
  let modelBody: { scanId?: string } = {};
  try {
    modelBody = JSON.parse(model?.body ?? '') as typeof modelBody;
  } catch {
    // Not JSON: the check below reports the raw item.
  }
  if (!model?.ok || model.status !== 200 || modelBody.scanId !== run.scanId) {
    failures.push(`model call: ${JSON.stringify(model)}`);
  }
  // Blocked = the request errored, or the DenyAll handler answered 403.
  const denials = [
    'httpExample',
    'httpUnknownHost',
    'httpsExample',
    'httpsUnknownHost',
    'httpsBareIp',
    'tcp1111port443',
    'tcp1111port22',
    'udpDns8888',
  ];
  // Raw UDP to port 53 gets an answer from the container network's own resolver, not the
  // internet: TEST-NET 192.0.2.1 (never routed) answers too, with the same placeholder.
  const udp = probe.udpDns8888;
  const testNet = probe.udpDnsTestNet;
  const localResolver = udp?.ok === true && testNet?.ok === true && udp.lastA === testNet.lastA;
  // With the HTTPS catch-all, a raw TCP connect to any :443 succeeds, but it lands on the
  // intercept proxy: a client that trusts the intercept CA gets DenyAll's 403, even when
  // dialing a public IP directly.
  const portHttpsEndsInHandler = ['httpsTrustedCaExample', 'httpsTrustedCaIpWithSni'].every(
    (name) => probe[name]?.status === 403 && (probe[name]?.body ?? '').startsWith('egress denied'),
  );
  for (const name of denials) {
    if (name === 'udpDns8888' && localResolver) {
      continue;
    }
    if (name === 'tcp1111port443' && portHttpsEndsInHandler) {
      continue;
    }
    if (!blocked(probe[name])) {
      failures.push(`${name} was not blocked: ${JSON.stringify(probe[name])}`);
    }
  }
  const secrets = probe.secrets ?? { ok: false, ms: 0 };
  for (const key of ['envSuspicious', 'pid1EnvSuspicious', 'ociEnvSuspicious', 'keyMarkerFiles']) {
    const found = secrets[key];
    if (!Array.isArray(found) || found.length > 0) {
      failures.push(`${key}: ${JSON.stringify(found)}`);
    }
  }
  const slowDenials = denials
    .slice(0, 5)
    .flatMap((name) => ((probe[name]?.ms ?? 0) >= 2000 ? [`${name}: ${probe[name]?.ms} ms`] : []));
  return {
    failures,
    probe,
    slowDenials,
    udpAnsweredByLocalResolver: localResolver,
    port443EndsInHandler: portHttpsEndsInHandler,
  };
}

async function main() {
  const { values } = parseArgs({
    options: { runs: { type: 'string', default: '5' }, keep: { type: 'boolean', default: false } },
  });
  const runs = Number(values.runs);
  const env = readSpikeEnv();
  const worker = `${SPIKE_PREFIX}s1`;
  const key = `vssk_${crypto.randomUUID().replaceAll('-', '')}`;
  const report: Record<string, unknown> = { spike: 'S1', worker, runs };
  const failures: Array<string> = [];
  try {
    report.baseline = await listSpikeResources(env);
    const deployed = await deploySpikeWorker(
      env,
      worker,
      controllerSource(),
      {
        durable_objects: { bindings: [{ name: 'SCAN', class_name: 'ScanController' }] },
        migrations: [{ tag: 'v1', new_sqlite_classes: ['ScanController'] }],
        containers: [
          {
            class_name: 'ScanController',
            name: `${SPIKE_PREFIX}s1-app`,
            scheduling_policy: 'durable_object',
          },
        ],
      },
      { SPIKE_KEY: key },
    );
    report.deployMs = deployed.deployMs;
    report.reachableAfterMs = await waitForWorker(deployed.url, key);
    const results: Array<RunResult & { endToEndMs: number }> = [];
    for (let index = 0; index < runs; index++) {
      let started = Date.now();
      let response: Response;
      let text = '';
      // Retry only the workers.dev route 404 (the Worker itself never answers 404 on /run).
      for (let attempt = 0; ; attempt++) {
        started = Date.now();
        response = await fetch(
          `${deployed.url}/run?name=run-${Date.now()}-${index}&probe=${index < 2 ? 1 : 0}&httpsDeny=${index === 1 ? 0 : 1}`,
          { headers: { 'x-spike-key': key }, signal: AbortSignal.timeout(300_000) },
        );
        text = await response.text();
        if (response.status !== 404 || attempt >= 10) {
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 2000);
        });
      }
      if (!response.ok) {
        failures.push(`run ${index}: HTTP ${response.status} ${text.slice(0, 500)}`);
        continue;
      }
      const run = JSON.parse(text) as RunResult;
      results.push({ ...run, endToEndMs: Date.now() - started });
      if (run.coldStartMs === null) {
        failures.push(`run ${index}: container never became ready: ${run.lastError}`);
      }
    }
    // Run 0: HTTPS catch-all deny on (the planned setup). Run 1: HTTP intercepts only.
    const first = results[0];
    if (first?.probe) {
      const judged = judgeProbe(first);
      failures.push(...judged.failures);
      report.egress = judged.probe;
      report.slowDenials = judged.slowDenials;
      report.udpAnsweredByLocalResolver = judged.udpAnsweredByLocalResolver;
      report.port443EndsInHandler = judged.port443EndsInHandler;
    } else {
      failures.push('no probe result');
    }
    const second = results[1];
    if (second?.probe) {
      const judged = judgeProbe(second);
      failures.push(...judged.failures.map((failure) => `without HTTPS deny: ${failure}`));
      report.egressWithoutHttpsDeny = judged.probe;
      report.slowDenialsWithoutHttpsDeny = judged.slowDenials;
    }
    const cold = results.flatMap((r) => (r.coldStartMs === null ? [] : [r.coldStartMs]));
    report.runsDetail = results.map(({ probe: _probe, ...rest }) => rest);
    report.coldStartMs = cold.length
      ? {
          values: cold,
          p50: percentile(cold, 50),
          p95: percentile(cold, 95),
          max: Math.max(...cold),
        }
      : null;
    if (cold.length && Math.max(...cold) >= COLD_START_LIMIT_MS) {
      failures.push(`cold start max ${Math.max(...cold)} ms >= ${COLD_START_LIMIT_MS} ms`);
    }
  } catch (error) {
    failures.push(String(error instanceof Error ? error.message : error));
  } finally {
    if (!values.keep) {
      report.cleanup = await deleteSpikeResources(env, [worker]);
      const after = (
        report.cleanup as { after: { workers: Array<string>; containerApps: Array<unknown> } }
      ).after;
      if (after.workers.length || after.containerApps.length) {
        failures.push(`leftover spike resources: ${JSON.stringify(after)}`);
      }
    }
  }
  report.failures = failures;
  console.log(JSON.stringify(report, null, 2));
  console.log(failures.length ? 'S1 FAIL' : 'S1 PASS');
  process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.main) {
  await main();
}
