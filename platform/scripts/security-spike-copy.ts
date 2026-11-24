/**
 * Security audits Phase 0 spike S13: a throwaway runtime copy of a deployed app.
 *
 * What it runs (plan "Phase 0 spikes" row S13, spec §20 S13 and §8.6, input for M30):
 *   - Fixtures, made once per run (not per scan): a Workers for Platforms dispatch namespace
 *     `void-spike-sa-s13-ns-<run>`; a sandbox Worker `void-spike-sa-s13-box-<run>` (no
 *     workers.dev) that is the namespace's outbound Worker (every global `fetch()` of a
 *     copy ends there and gets 403) and also serves the AI / email / queue stubs and a call
 *     log; a scratch controller `void-spike-sa-s13-ctl-<run>` (workers.dev, key header),
 *     the only way into a copy: `/copy/<script>/<path>` dispatches to the copy as
 *     `https://copy.void.internal/<path>`.
 *   - Per copy (what M30 does per scan): a seeded app (platform/scripts/fixtures/
 *     security-seeded-apps, built with the S4 helper) is uploaded unchanged into the
 *     namespace with a fresh empty D1 / KV / R2 for each of its bindings, the app's
 *     `db/migrations/*.sql` applied, fake values for its secrets (and for text vars whose
 *     name looks secret), AI / email / queue bindings pointed at the stubs, and no cron or
 *     queue-consumer trigger. Two modules are added. The copy guard (M30 keeps it; off with
 *     `--no-guard`) loads before the app and sends every global `fetch()` to the sandbox
 *     through a service binding and refuses outbound WebSockets: the outbound Worker does
 *     not see requests from Durable Objects. The spike probe (M30 would not add it) is the
 *     main module: it answers `/__spike/probe` (outbound fetch, WebSocket and `connect()`
 *     from the Worker and from a Durable Object, stubs, empty stores, fake secrets) and
 *     passes every other request to the app's own entry.
 *   - Checks: the copy serves the app's routes (and, with test rows seeded through the D1
 *     API, the planted bugs answer like bugs); every outbound path fails; the copy is not
 *     reachable from the internet (no workers.dev, not an account script, controller needs
 *     the key); time from the first create call to the first 200 (< 60 s), cold (assets
 *     new) and warm (a second copy of the same build); delete time; no `void-spike-sa-s13`
 *     resource left (list calls); cost from the counted operations at list prices.
 *
 * Run (from the repo root):
 *   CLOUDFLARE_ACCOUNT_ID=... [CLOUDFLARE_API_TOKEN=...] NODE_USE_SYSTEM_CA=1 \
 *     WRANGLER_BIN=.../wrangler.js node platform/scripts/security-spike-copy.ts \
 *     [--apps react-d1,api-plain,solid-r2] [--warm react-d1] [--no-guard] [--out report.json]
 *     [--keep]
 *   Without CLOUDFLARE_API_TOKEN the wrangler OAuth login is used (needs workers_scripts,
 *   d1, workers_kv and R2 access). Only `void-spike-sa-s13-*` resources are created and
 *   deleted; other `void-spike-sa-*` resources (other spikes) are never touched.
 *
 * Pass (spec §20 S13): every copy serves its routes, every outbound probe fails, the copy
 * is unreachable from the internet, every ready time < 60 s, nothing left after delete.
 * Prints one JSON report and a PASS/FAIL line; exits 1 on FAIL.
 */
import { randomBytes, createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { cfApi, deploySpikeWorker, runWrangler } from './security-spike-s1.ts';
import type { SpikeEnv } from './security-spike-s1.ts';
import {
  FIXTURES,
  REPO,
  buildVariant,
  freshToken,
  loadFixture,
  spikeEnv,
} from './security-spike-s4.ts';

const PREFIX = 'void-spike-sa-s13-';
const READY_LIMIT_MS = 60_000;
const COPY_HOST = 'copy.void.internal';
const FAKE_PREFIX = 'void-copy-fake-';
const SECRET_WORDS = ['SECRET', 'KEY', 'TOKEN', 'PASSWORD', 'CREDENTIAL', 'PRIVATE'];

/** List prices used for the per-copy cost (Workers Paid, 2026-11). */
const PRICES = {
  wfpScriptMonthUsd: 0.02,
  wfpRequestUsdPerMillion: 0.3,
  d1RowsWrittenUsdPerMillion: 1,
  d1RowsReadUsdPerMillion: 0.001,
  kvWriteUsdPerMillion: 5,
  r2ClassAUsdPerMillion: 4.5,
};

// ---------- small helpers ----------

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function walkFiles(root: string): Array<string> {
  const out: Array<string> = [];
  if (!existsSync(root)) {
    return out;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function looksSecret(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_WORDS.some((word) => upper.includes(word));
}

/** `env.NAME` references (NAME in upper case) in app sources, without a regex. */
function envNamesIn(text: string): Set<string> {
  const names = new Set<string>();
  let from = 0;
  for (;;) {
    const at = text.indexOf('env.', from);
    if (at === -1) {
      return names;
    }
    from = at + 4;
    const before = at === 0 ? '' : text[at - 1];
    if (before && (isIdentChar(before) || before === '.')) {
      continue;
    }
    let end = from;
    while (end < text.length && isIdentChar(text[end])) {
      end++;
    }
    const name = text.slice(from, end);
    if (name.length > 1 && name === name.toUpperCase() && isUpperStart(name)) {
      names.add(name);
    }
  }
}

function isIdentChar(char: string): boolean {
  return (
    (char >= 'a' && char <= 'z') ||
    (char >= 'A' && char <= 'Z') ||
    (char >= '0' && char <= '9') ||
    char === '_' ||
    char === '$'
  );
}

function isUpperStart(name: string): boolean {
  return name[0] >= 'A' && name[0] <= 'Z';
}

const blake3 = createRequire(new URL('../packages/api/package.json', import.meta.url))(
  'blake3-jit',
) as { createHasher(): { update(data: Uint8Array): void; finalize(): Uint8Array } };

/** Cloudflare asset hash: BLAKE3 of base64(content) + extension, first 32 hex chars. */
function assetHash(bytes: Buffer, path: string): string {
  const hasher = blake3.createHasher();
  hasher.update(new TextEncoder().encode(bytes.toString('base64')));
  hasher.update(new TextEncoder().encode(extname(path).slice(1)));
  return Array.from(hasher.finalize(), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// ---------- counted Cloudflare calls ----------

type Counters = {
  apiCalls: number;
  d1RowsWritten: number;
  d1RowsRead: number;
  kvWrites: number;
  r2ClassA: number;
  copyRequests: number;
};

function newCounters(): Counters {
  return {
    apiCalls: 0,
    d1RowsWritten: 0,
    d1RowsRead: 0,
    kvWrites: 0,
    r2ClassA: 0,
    copyRequests: 0,
  };
}

async function api<T>(
  env: SpikeEnv,
  counters: Counters,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  counters.apiCalls++;
  const result = await cfApi<T>(env, path, init);
  if (!result.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${path}: ${result.status} ${JSON.stringify(result.errors)}`,
    );
  }
  return result.result;
}

/** A multipart request to the Cloudflare API (cfApi sets a JSON content type). */
async function apiForm<T>(
  env: SpikeEnv,
  counters: Counters,
  url: string,
  form: FormData,
  method: string,
  bearer = env.token,
): Promise<T> {
  counters.apiCalls++;
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${bearer}` },
    body: form,
  });
  const text = await response.text();
  let body: { success?: boolean; result?: T; errors?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    body = { errors: text.slice(0, 500) };
  }
  if (!response.ok || body.success === false) {
    throw new Error(`${method} ${url}: ${response.status} ${JSON.stringify(body.errors)}`);
  }
  return body.result as T;
}

// ---------- Worker sources ----------

// The outbound Worker of the namespace, the binding stubs and their call log.
const SANDBOX_SOURCE = String.raw`
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

export class CallLog extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS log (at INTEGER, kind TEXT, copy TEXT, detail TEXT)');
  }
  add(kind, copy, detail) {
    this.ctx.storage.sql.exec('INSERT INTO log VALUES (?, ?, ?, ?)', Date.now(), kind, copy, JSON.stringify(detail).slice(0, 2000));
  }
  read() {
    return this.ctx.storage.sql.exec('SELECT at, kind, copy, detail FROM log ORDER BY at').toArray();
  }
}

const callLog = (env) => env.LOG.get(env.LOG.idFromName('log'));

export class AiStub extends WorkerEntrypoint {
  async run(model, input) {
    await callLog(this.env).add('ai', this.ctx.props?.copy ?? null, { model, keys: Object.keys(input ?? {}) });
    return { response: 'stubbed answer from the void copy sandbox', stub: true };
  }
}

export class EmailStub extends WorkerEntrypoint {
  async send(message) {
    await callLog(this.env).add('email', this.ctx.props?.copy ?? null, { to: message?.to ?? null });
    return { messageId: 'stub-' + Date.now() };
  }
}

export class QueueStub extends WorkerEntrypoint {
  async send(body) {
    await callLog(this.env).add('queue', this.ctx.props?.copy ?? null, { messages: 1 });
  }
  async sendBatch(messages) {
    await callLog(this.env).add('queue', this.ctx.props?.copy ?? null, { messages: messages?.length ?? 0 });
  }
}

export class LogReader extends WorkerEntrypoint {
  read() {
    return callLog(this.env).read();
  }
}

// Outbound Worker: every global fetch() of a dispatched copy arrives here. Nothing leaves.
export default {
  async fetch(request, env) {
    const auth = request.headers.get('authorization');
    await callLog(env).add('outbound', env.copy ?? null, {
      method: request.method,
      url: request.url,
      guard: request.headers.get('x-void-copy-guard') === '1',
      authorization: auth === null ? null : auth.includes('${FAKE_PREFIX}') ? 'fake' : 'other',
    });
    return new Response('blocked by the void copy sandbox', { status: 403, headers: { 'x-void-copy-blocked': '1' } });
  },
};
`;

// The scratch controller: the only way into a copy (stands in for the scan's controller).
const CONTROLLER_SOURCE = String.raw`
export default {
  async fetch(request, env) {
    if (request.headers.get('x-spike-key') !== env.SPIKE_KEY) {
      return new Response('forbidden', { status: 403 });
    }
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/log') return Response.json(await env.SANDBOX_LOG.read());
    const parts = url.pathname.split('/');
    if (parts[1] !== 'copy' || !parts[2]) return new Response('not found', { status: 404 });
    const script = parts[2];
    const target = new URL('/' + parts.slice(3).join('/') + url.search, 'https://${COPY_HOST}');
    const headers = new Headers(request.headers);
    headers.delete('x-spike-key');
    const init = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();
    try {
      const copy = env.DISPATCHER.get(script, {}, { outbound: { copy: script } });
      const response = await copy.fetch(new Request(target, init));
      const out = new Response(response.body, response);
      out.headers.set('x-void-copy-dispatched', '1');
      return out;
    } catch (error) {
      return new Response('dispatch failed: ' + String(error && error.message || error), { status: 502 });
    }
  },
};
`;

// Copy guard (a module M30 would add): loaded before the app, it sends every global fetch()
// to the sandbox through a service binding and refuses outbound WebSockets. It covers code
// the outbound Worker does not see, such as Durable Objects (measured in the first run).
const GUARD_MODULE = String.raw`
import { env } from 'cloudflare:workers';

const blocked = () => new Response('blocked by the void copy guard', { status: 403, headers: { 'x-void-copy-blocked': '1' } });
async function guardedFetch(input, init) {
  const request = new Request(input, init);
  if (!env.__COPY_EGRESS) return blocked();
  const headers = new Headers(request.headers);
  headers.set('x-void-copy-guard', '1');
  return env.__COPY_EGRESS.fetch(new Request(request, { headers }));
}
class BlockedWebSocket {
  constructor() { throw new Error('outbound WebSocket blocked by the void copy guard'); }
}
for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) BlockedWebSocket[name] = value;
for (const [name, value] of Object.entries({ fetch: guardedFetch, WebSocket: BlockedWebSocket })) {
  Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });
}
`;

// Spike-only main module of a copy: the probe route, then the app's own entry.
const PROBE_ENTRY = String.raw`
import App from './index.js';
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
export * from './index.js';

async function attempt(fn) {
  const started = Date.now();
  try {
    return { ok: true, ...(await fn()), ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).slice(0, 300), ms: Date.now() - started };
  }
}

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = await response.text();
  return { status: response.status, blocked: response.headers.get('x-void-copy-blocked') === '1', body: body.slice(0, 80) };
}

async function ws(url) {
  const socket = new WebSocket(url);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout 5s')), 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); socket.close(); resolve({ opened: true }); });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('error event')); });
  });
}

async function tcp(hostname, port) {
  const socket = connect({ hostname, port });
  await Promise.race([socket.opened, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 5s')), 5000))]);
  await socket.close();
  return { connected: true };
}

async function egress(controllerUrl) {
  return {
    fetchHttps: await attempt(() => get('https://example.com/')),
    fetchHttp: await attempt(() => get('http://example.com/')),
    fetchIp: await attempt(() => get('http://1.1.1.1/')),
    fetchCloudflareApi: await attempt(() => get('https://api.cloudflare.com/client/v4/')),
    fetchController: await attempt(() => get(controllerUrl + '/health')),
    connectTcp: await attempt(() => tcp('example.com', 80)),
    connectIp: await attempt(() => tcp('1.1.1.1', 53)),
    webSocket: await attempt(() => ws('wss://echo.websocket.org/')),
  };
}

export class SpikeEgressProbe extends DurableObject {
  async probe(controllerUrl) {
    return egress(controllerUrl);
  }
}

// A Durable Object of a just-uploaded copy sometimes answers its first call with
// "internal error"; one retry, with the first error kept.
async function doProbe(stub, controllerUrl) {
  const first = await attempt(() => stub.probe(controllerUrl));
  if (first.ok) return first;
  const second = await attempt(() => stub.probe(controllerUrl));
  return { ...second, firstError: first.error };
}

async function probe(env, ctx) {
  const config = JSON.parse(env.__SPIKE_PROBE_CONFIG);
  const stub = env.__SPIKE_PROBE_DO.get(env.__SPIKE_PROBE_DO.idFromName('probe'));
  const later = new Promise((resolve) => ctx.waitUntil(attempt(() => get('https://example.com/?waitUntil')).then(resolve)));
  const out = {
    worker: await egress(config.controllerUrl),
    durableObject: await doProbe(stub, config.controllerUrl),
    waitUntilFetch: await later,
    stubs: {
      ai: await attempt(async () => ({ result: await env.__SPIKE_AI.run('@cf/any/model', { prompt: 'hi' }) })),
      email: await attempt(async () => ({ result: await env.__SPIKE_EMAIL.send({ to: 'someone@example.com', from: 'app@example.com', subject: 'x', text: 'x' }) })),
      queue: await attempt(async () => { await env.__SPIKE_QUEUE.send({ hello: 1 }); return { sent: true }; }),
    },
    stores: {},
    secrets: {},
  };
  for (const name of config.d1) {
    out.stores[name] = await attempt(async () => ({ tables: (await env[name].prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).results.map((row) => row.name) }));
  }
  for (const name of config.kv) {
    out.stores[name] = await attempt(async () => ({ keys: (await env[name].list()).keys.map((key) => key.name) }));
  }
  for (const name of config.r2) {
    out.stores[name] = await attempt(async () => ({ objects: (await env[name].list()).objects.length }));
  }
  for (const name of config.secrets) {
    const value = env[name];
    out.secrets[name] = typeof value === 'string' && value.startsWith('${FAKE_PREFIX}') ? 'fake' : typeof value;
  }
  return Response.json(out);
}

export default class extends App {
  async fetch(request) {
    if (new URL(request.url).pathname === '/__spike/probe') return probe(this.env, this.ctx);
    return super.fetch(request);
  }
}
`;

// ---------- fixtures (namespace, sandbox, controller) ----------

type Fixtures = {
  run: string;
  namespace: string;
  namespaceId: string;
  sandbox: string;
  controller: string;
  controllerUrl: string;
  key: string;
  setupMs: Record<string, number>;
};

/** wrangler deploy sometimes reports a just-uploaded Worker as missing (code 10007): retry. */
async function deployWithRetry(
  ...args: Parameters<typeof deploySpikeWorker>
): ReturnType<typeof deploySpikeWorker> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await deploySpikeWorker(...args);
    } catch (error) {
      if (attempt >= 3 || !String(error).includes('10007')) {
        throw error;
      }
      await sleep(5000 * attempt);
    }
  }
}

async function createFixtures(env: SpikeEnv, counters: Counters, run: string): Promise<Fixtures> {
  const namespace = `${PREFIX}ns-${run}`;
  const sandbox = `${PREFIX}box-${run}`;
  const controller = `${PREFIX}ctl-${run}`;
  const key = randomBytes(24).toString('hex');
  const setupMs: Record<string, number> = {};
  let started = Date.now();
  const created = await api<{ namespace_id: string }>(
    env,
    counters,
    '/workers/dispatch/namespaces',
    {
      method: 'POST',
      body: JSON.stringify({ name: namespace }),
    },
  );
  setupMs.namespace = Date.now() - started;
  started = Date.now();
  await deployWithRetry(
    env,
    sandbox,
    SANDBOX_SOURCE,
    {
      workers_dev: false,
      durable_objects: { bindings: [{ name: 'LOG', class_name: 'CallLog' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['CallLog'] }],
    },
    {},
  );
  setupMs.sandbox = Date.now() - started;
  started = Date.now();
  const deployed = await deployWithRetry(
    env,
    controller,
    CONTROLLER_SOURCE,
    {
      dispatch_namespaces: [
        {
          binding: 'DISPATCHER',
          namespace,
          outbound: { service: sandbox, parameters: ['copy'] },
        },
      ],
      services: [{ binding: 'SANDBOX_LOG', service: sandbox, entrypoint: 'LogReader' }],
    },
    { SPIKE_KEY: key },
  );
  setupMs.controller = Date.now() - started;
  return {
    run,
    namespace,
    namespaceId: created.namespace_id,
    sandbox,
    controller,
    controllerUrl: deployed.url,
    key,
    setupMs,
  };
}

async function waitForController(fixtures: Fixtures): Promise<void> {
  let streak = 0;
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    const response = await fetch(`${fixtures.controllerUrl}/health`, {
      headers: { 'x-spike-key': fixtures.key },
    }).catch(() => null);
    streak = response?.status === 200 ? streak + 1 : 0;
    if (streak >= 3) {
      return;
    }
    await sleep(1000);
  }
  throw new Error(`${fixtures.controllerUrl} did not become reachable within 180 s`);
}

async function viaController(
  fixtures: Fixtures,
  counters: Counters,
  script: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  counters.copyRequests++;
  const headers = new Headers(init.headers);
  if (!headers.has('x-spike-key')) {
    headers.set('x-spike-key', fixtures.key);
  }
  const response = await fetch(`${fixtures.controllerUrl}/copy/${script}${path}`, {
    redirect: 'manual',
    ...init,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

// ---------- one copy ----------

type BuildConfig = {
  compatibilityDate: string;
  compatibilityFlags?: Array<string>;
  assets?: { notFoundHandling?: string; runWorkerFirst?: Array<string> | boolean };
  env: Record<string, { type: string; [key: string]: unknown }>;
  exports?: Record<string, { type: string; storage?: string }>;
  triggers?: Array<{ type: string }>;
  manifest: { mainModule: string; modules: Record<string, { type: string }> };
};

type AppSeed = {
  sql?: Array<string>;
  kv?: Record<string, string>;
};

type CopyResources = {
  script: string;
  d1: Array<{ binding: string; name: string; id: string }>;
  kv: Array<{ binding: string; title: string; id: string }>;
  r2: Array<{ binding: string; name: string }>;
};

type CopyResult = {
  app: string;
  script: string;
  warm: boolean;
  bindings: Record<string, string>;
  dropped: Array<string>;
  fakeSecrets: Array<string>;
  migrations: Array<string>;
  assets: { files: number; uploaded: number; buckets: number };
  modules: number;
  uploadBytes: number;
  timings: Record<string, number>;
  readyMs: number;
  firstStatus: number | null;
  routes: Array<{ name: string; status: number; ok: boolean; note: string }>;
  probe: unknown;
  outboundLog: Array<unknown>;
  unreachable: Record<string, { ok: boolean; detail: string }>;
  deleteMs: number | null;
  counters: Counters;
  costUsd: number;
  failures: Array<string>;
};

const MODULE_TYPES: Record<string, string> = {
  esm: 'application/javascript+module',
  commonjs: 'application/javascript',
  text: 'text/plain',
  data: 'application/octet-stream',
  wasm: 'application/wasm',
  sourcemap: 'application/source-map',
};

function appDir(app: string): string {
  const fixture = loadFixture(app);
  buildVariant({ key: `copy-${app}`, base: fixture.base, overlays: [{ fixture: app }] });
  return join(REPO, 'playground-local/security-spike', `copy-${app}`);
}

/** App secrets: `env.NAME` used in the app's own sources that is not a binding or var. */
function secretNames(dir: string, config: BuildConfig, app: string): Array<string> {
  const used = new Set<string>();
  const roots = ['routes', 'lib', 'middleware', 'pages', 'crons', 'src', 'server'];
  for (const root of roots) {
    for (const file of walkFiles(join(dir, root))) {
      if (!['.ts', '.tsx', '.js', '.mjs', '.vue', '.svelte'].includes(extname(file))) {
        continue;
      }
      for (const name of envNamesIn(readFileSync(file, 'utf8'))) {
        used.add(name);
      }
    }
  }
  const fixtureFiles = walkFiles(join(FIXTURES, app, 'files'));
  for (const file of fixtureFiles) {
    for (const name of envNamesIn(readFileSync(file, 'utf8'))) {
      used.add(name);
    }
  }
  return [...used].filter((name) => !(name in config.env) && !name.startsWith('VOID_')).sort();
}

function fakeValue(name: string): string {
  return `${FAKE_PREFIX}${name.toLowerCase()}-${randomBytes(12).toString('hex')}`;
}

/** Test rows the scanner would need (seeded through the D1 / KV APIs, not app code). */
function seedFor(
  app: string,
  secrets: Record<string, string>,
): {
  seed: AppSeed;
  cookie?: string;
} {
  if (app === 'react-d1') {
    const body = Buffer.from(
      JSON.stringify({ id: 1, email: 'member@example.com', role: 'member' }),
    ).toString('base64url');
    const signature = createHmac('sha256', secrets.SESSION_SECRET ?? '')
      .update(body)
      .digest('base64url');
    return {
      cookie: `inv_session=${body}.${signature}`,
      seed: {
        sql: [
          "CREATE TABLE invoices (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, number TEXT, customer TEXT, customer_email TEXT, billing_address TEXT, total_cents INTEGER, status TEXT, created_at TEXT DEFAULT (datetime('now')))",
          "INSERT INTO invoices (id, owner_id, number, customer, customer_email, billing_address, total_cents, status) VALUES (1, 1, 'INV-1', 'Acme', 'ap@acme.test', '1 Main St', 1200, 'sent'), (2, 2, 'INV-2', 'Globex', 'ap@globex.test', '2 Side St', 9900, 'sent')",
        ],
      },
    };
  }
  if (app === 'api-plain') {
    const sid = randomBytes(32).toString('hex');
    return {
      cookie: `sid=${sid}`,
      seed: {
        sql: [
          'CREATE TABLE billing (user_id INTEGER PRIMARY KEY, customer_id TEXT, balance_cents INTEGER)',
          "INSERT INTO billing VALUES (1, 'cus_test_1', 500)",
        ],
        // void/kv `kv.map('sid:')` stores under `${prefix}:${key}`, so the key is `sid::<sid>`.
        kv: { [`sid::${sid}`]: JSON.stringify({ userId: 1, email: 'member@example.com' }) },
      },
    };
  }
  return { seed: {} };
}

const snippet = (_status: number, text: string) => text.replaceAll('\n', ' ').slice(0, 140);

async function createCopy(
  env: SpikeEnv,
  fixtures: Fixtures,
  app: string,
  warm: boolean,
  resources: Array<CopyResources>,
  guard: boolean,
): Promise<CopyResult> {
  const counters = newCounters();
  const failures: Array<string> = [];
  const dir = appDir(app);
  const out = join(dir, '.cloudflare/output/v1/workers/default');
  const config = JSON.parse(readFileSync(join(out, 'worker.config.json'), 'utf8')) as BuildConfig;
  const id = `${app}-${Date.now().toString(36)}`;
  const script = `${PREFIX}${id}`;
  const tracked: CopyResources = { script, d1: [], kv: [], r2: [] };
  resources.push(tracked);
  const timings: Record<string, number> = {};
  const bindingsSummary: Record<string, string> = {};
  const dropped: Array<string> = [];

  // Inputs prepared before the clock starts (M30 reads them from the stored deployment).
  const secrets = secretNames(dir, config, app);
  const fake: Record<string, string> = Object.fromEntries(secrets.map((n) => [n, fakeValue(n)]));
  const migrationsDir = join(dir, 'db/migrations');
  const migrations = existsSync(migrationsDir)
    ? readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql'))
        .sort()
    : [];
  const assetFiles = walkFiles(join(out, 'assets')).map((file) => {
    const bytes = readFileSync(file);
    const path = `/${toPosix(relative(join(out, 'assets'), file))}`;
    return { path, bytes, hash: assetHash(bytes, path) };
  });
  const { seed, cookie } = seedFor(app, fake);

  const started = Date.now();
  const mark = (name: string, from: number) => {
    timings[name] = Date.now() - from;
  };

  // 1. Empty stores, in parallel.
  const storeStart = Date.now();
  const tasks: Array<Promise<void>> = [];
  for (const [name, binding] of Object.entries(config.env)) {
    const resourceName = `${PREFIX}${id}-${name.toLowerCase().replaceAll('_', '-')}`.slice(0, 63);
    if (binding.type === 'd1') {
      tasks.push(
        api<{ uuid: string }>(env, counters, '/d1/database', {
          method: 'POST',
          body: JSON.stringify({ name: resourceName }),
        }).then((db) => {
          tracked.d1.push({ binding: name, name: resourceName, id: db.uuid });
        }),
      );
    } else if (binding.type === 'kv') {
      tasks.push(
        api<{ id: string }>(env, counters, '/storage/kv/namespaces', {
          method: 'POST',
          body: JSON.stringify({ title: resourceName }),
        }).then((ns) => {
          tracked.kv.push({ binding: name, title: resourceName, id: ns.id });
        }),
      );
    } else if (binding.type === 'r2') {
      tasks.push(
        api(env, counters, '/r2/buckets', {
          method: 'POST',
          body: JSON.stringify({ name: resourceName }),
        }).then(() => {
          counters.r2ClassA++;
          tracked.r2.push({ binding: name, name: resourceName });
        }),
      );
    }
  }
  await Promise.all(tasks);
  mark('stores', storeStart);

  // 2. Migrations, then the test rows (D1 + KV), in parallel with the asset upload.
  const dataStart = Date.now();
  const data = (async () => {
    for (const db of tracked.d1) {
      for (const file of migrations) {
        const sql = readFileSync(join(migrationsDir, file), 'utf8');
        const result = await api<Array<{ meta?: { rows_written?: number; rows_read?: number } }>>(
          env,
          counters,
          `/d1/database/${db.id}/query`,
          { method: 'POST', body: JSON.stringify({ sql }) },
        );
        for (const entry of result ?? []) {
          counters.d1RowsWritten += entry.meta?.rows_written ?? 0;
          counters.d1RowsRead += entry.meta?.rows_read ?? 0;
        }
      }
      mark('migrations', dataStart);
      for (const sql of seed.sql ?? []) {
        const result = await api<Array<{ meta?: { rows_written?: number } }>>(
          env,
          counters,
          `/d1/database/${db.id}/query`,
          { method: 'POST', body: JSON.stringify({ sql }) },
        );
        for (const entry of result ?? []) {
          counters.d1RowsWritten += entry.meta?.rows_written ?? 0;
        }
      }
    }
    for (const ns of tracked.kv) {
      for (const [key, value] of Object.entries(seed.kv ?? {})) {
        counters.kvWrites++;
        counters.apiCalls++;
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/storage/kv/namespaces/${ns.id}/values/${encodeURIComponent(key)}`,
          { method: 'PUT', headers: { Authorization: `Bearer ${env.token}` }, body: value },
        );
        if (!response.ok) {
          throw new Error(`KV seed failed: ${response.status} ${await response.text()}`);
        }
      }
    }
    mark('data', dataStart);
  })();

  // 3. Assets: upload session for the copy script, then only the buckets Cloudflare asks for.
  const assetStart = Date.now();
  const assets = (async () => {
    if (!config.env.ASSETS && assetFiles.length === 0) {
      return { jwt: null as string | null, uploaded: 0, buckets: 0 };
    }
    const manifest = Object.fromEntries(
      assetFiles.map((file) => [file.path, { hash: file.hash, size: file.bytes.length }]),
    );
    const session = await api<{ jwt: string; buckets?: Array<Array<string>> }>(
      env,
      counters,
      `/workers/dispatch/namespaces/${fixtures.namespace}/scripts/${script}/assets-upload-session`,
      { method: 'POST', body: JSON.stringify({ manifest }) },
    );
    const buckets = session.buckets ?? [];
    let jwt = session.jwt;
    let uploaded = 0;
    const byHash = new Map(assetFiles.map((file) => [file.hash, file]));
    // Buckets go up in parallel (wrangler and the platform do the same); the last one done
    // answers with the completion token.
    const uploadBucket = async (bucket: Array<string>) => {
      const form = new FormData();
      for (const hash of bucket) {
        const file = byHash.get(hash);
        if (!file) {
          throw new Error(`asset session asked for unknown hash ${hash}`);
        }
        form.append(
          hash,
          new File([file.bytes.toString('base64')], hash, {
            type: CONTENT_TYPES[extname(file.path)] ?? 'application/octet-stream',
          }),
        );
        uploaded++;
      }
      const result = await apiForm<{ jwt?: string }>(
        env,
        counters,
        `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/workers/assets/upload?base64=true`,
        form,
        'POST',
        session.jwt,
      );
      if (result?.jwt) {
        jwt = result.jwt;
      }
    };
    await Promise.all(buckets.map(uploadBucket));
    mark('assets', assetStart);
    return { jwt, uploaded, buckets: buckets.length };
  })();

  const [assetResult] = await Promise.all([assets, data]);

  // 4. Upload the copy script (bindings rewired to the copy's stores, stubs and fakes).
  const uploadStart = Date.now();
  const bindings: Array<Record<string, unknown>> = [];
  const doClasses: Array<string> = ['SpikeEgressProbe'];
  for (const [name, binding] of Object.entries(config.env)) {
    switch (binding.type) {
      case 'd1': {
        const db = tracked.d1.find((entry) => entry.binding === name)!;
        bindings.push({ type: 'd1', name, id: db.id });
        bindingsSummary[name] = `d1 -> empty ${db.name}`;
        break;
      }
      case 'kv': {
        const ns = tracked.kv.find((entry) => entry.binding === name)!;
        bindings.push({ type: 'kv_namespace', name, namespace_id: ns.id });
        bindingsSummary[name] = `kv -> empty ${ns.title}`;
        break;
      }
      case 'r2': {
        const bucket = tracked.r2.find((entry) => entry.binding === name)!;
        bindings.push({ type: 'r2_bucket', name, bucket_name: bucket.name });
        bindingsSummary[name] = `r2 -> empty ${bucket.name}`;
        break;
      }
      case 'durable-object': {
        const className = String(binding.exportName);
        bindings.push({ type: 'durable_object_namespace', name, class_name: className });
        if (config.exports?.[className]) {
          doClasses.push(className);
        }
        bindingsSummary[name] = `durable object ${className} (new, empty)`;
        break;
      }
      case 'assets':
        bindings.push({ type: 'assets', name });
        bindingsSummary[name] = 'assets (copy of the build)';
        break;
      case 'text': {
        const value = String(binding.value ?? '');
        if (looksSecret(name)) {
          const fakeText = fakeValue(name);
          fake[name] = fakeText;
          bindings.push({ type: 'secret_text', name, text: fakeText });
          bindingsSummary[name] = 'text var with a secret name -> fake value';
        } else {
          bindings.push({ type: 'plain_text', name, text: value });
          bindingsSummary[name] = 'plain text var (kept)';
        }
        break;
      }
      case 'ai':
        bindings.push({ type: 'service', name, service: fixtures.sandbox, entrypoint: 'AiStub' });
        bindingsSummary[name] = 'ai -> stub';
        break;
      case 'send-email':
      case 'email':
        bindings.push({
          type: 'service',
          name,
          service: fixtures.sandbox,
          entrypoint: 'EmailStub',
        });
        bindingsSummary[name] = 'email -> stub';
        break;
      case 'queue':
        bindings.push({
          type: 'service',
          name,
          service: fixtures.sandbox,
          entrypoint: 'QueueStub',
        });
        bindingsSummary[name] = 'queue producer -> stub';
        break;
      default:
        dropped.push(`${name} (${binding.type})`);
    }
  }
  for (const name of secrets) {
    bindings.push({ type: 'secret_text', name, text: fake[name] });
    bindingsSummary[name] = 'secret -> fake value';
  }
  // Spike probe bindings (not part of an M30 copy).
  const probeConfig = {
    controllerUrl: fixtures.controllerUrl,
    d1: tracked.d1.map((db) => db.binding),
    kv: tracked.kv.map((ns) => ns.binding),
    r2: tracked.r2.map((bucket) => bucket.binding),
    secrets: Object.keys(fake),
  };
  bindings.push(
    { type: 'plain_text', name: '__SPIKE_PROBE_CONFIG', text: JSON.stringify(probeConfig) },
    { type: 'durable_object_namespace', name: '__SPIKE_PROBE_DO', class_name: 'SpikeEgressProbe' },
    { type: 'service', name: '__SPIKE_AI', service: fixtures.sandbox, entrypoint: 'AiStub' },
    { type: 'service', name: '__SPIKE_EMAIL', service: fixtures.sandbox, entrypoint: 'EmailStub' },
    { type: 'service', name: '__SPIKE_QUEUE', service: fixtures.sandbox, entrypoint: 'QueueStub' },
    { type: 'service', name: '__COPY_EGRESS', service: fixtures.sandbox },
  );
  if (config.triggers?.length) {
    dropped.push(`triggers: ${config.triggers.map((trigger) => trigger.type).join(', ')}`);
  }

  const metadata: Record<string, unknown> = {
    main_module: '__spike_entry.mjs',
    compatibility_date: config.compatibilityDate,
    compatibility_flags: config.compatibilityFlags ?? [],
    bindings,
    migrations: { new_tag: 'v1', new_sqlite_classes: doClasses },
    observability: { enabled: false },
  };
  if (assetResult.jwt) {
    metadata.assets = {
      jwt: assetResult.jwt,
      config: {
        not_found_handling: config.assets?.notFoundHandling ?? 'none',
        run_worker_first: config.assets?.runWorkerFirst ?? true,
      },
    };
  }
  const entry = guard ? `import './__void_copy_guard.mjs';\n${PROBE_ENTRY}` : PROBE_ENTRY;
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(
    '__spike_entry.mjs',
    new File([entry], '__spike_entry.mjs', { type: MODULE_TYPES.esm }),
  );
  let uploadBytes = Buffer.byteLength(entry);
  if (guard) {
    form.append(
      '__void_copy_guard.mjs',
      new File([GUARD_MODULE], '__void_copy_guard.mjs', { type: MODULE_TYPES.esm }),
    );
    uploadBytes += Buffer.byteLength(GUARD_MODULE);
  }
  for (const [name, module] of Object.entries(config.manifest.modules)) {
    const bytes = readFileSync(join(out, 'bundle', name));
    uploadBytes += bytes.length;
    form.append(
      name,
      new File([bytes], name, { type: MODULE_TYPES[module.type] ?? 'application/octet-stream' }),
    );
  }
  await apiForm(
    env,
    counters,
    `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/workers/dispatch/namespaces/${fixtures.namespace}/scripts/${script}`,
    form,
    'PUT',
  );
  mark('upload', uploadStart);

  // 5. Ready: the first 200 from the copy through the controller.
  const readyStart = Date.now();
  let firstStatus: number | null = null;
  let lastText = '';
  while (Date.now() - started < 5 * 60_000) {
    const response = await viaController(fixtures, counters, script, '/').catch(
      (error: unknown) => ({
        status: 0,
        text: String(error),
        headers: new Headers(),
      }),
    );
    lastText = response.text.slice(0, 200);
    if (response.status === 200) {
      firstStatus = 200;
      break;
    }
    firstStatus = response.status;
    await sleep(500);
  }
  mark('firstRequest', readyStart);
  const readyMs = Date.now() - started;
  if (firstStatus !== 200) {
    failures.push(`${app}: copy never answered 200 on / (last ${firstStatus}: ${lastText})`);
  }
  if (readyMs >= READY_LIMIT_MS) {
    failures.push(`${app}: ready after ${readyMs} ms (limit ${READY_LIMIT_MS})`);
  }

  // 6. Routes (app code against the empty, migrated, seeded copy).
  const routes: CopyResult['routes'] = [];
  const check = async (
    name: string,
    path: string,
    init: RequestInit,
    expect: (status: number, text: string) => boolean,
    note: (status: number, text: string) => string,
  ) => {
    const response = await viaController(fixtures, counters, script, path, init);
    const ok = expect(response.status, response.text);
    routes.push({ name, status: response.status, ok, note: note(response.status, response.text) });
    if (!ok) {
      failures.push(`${app} route ${name}: ${response.status} ${response.text.slice(0, 200)}`);
    }
  };
  await check(
    'GET / (app page)',
    '/',
    {},
    (status, text) => status === 200 && text.toLowerCase().includes('<html'),
    snippet,
  );
  const jsAsset = assetFiles.find((file) => file.path.endsWith('.js'));
  if (jsAsset) {
    await check(
      `GET ${jsAsset.path} (static asset)`,
      jsAsset.path,
      {},
      (status) => status === 200,
      (_status, text) => `${text.length} bytes`,
    );
  }
  if (app === 'react-d1') {
    await check(
      // The fixture throws a Response; Void does not catch it, so the copy throws and the
      // dispatcher sees "#<Response>" (a native deploy fails the same way).
      'search without a session -> rejected',
      '/api/invoices/search?q=Acme',
      {},
      (status, text) => status === 401 || (status === 502 && text.includes('#<Response>')),
      snippet,
    );
    await check(
      'search with a cookie signed by the fake secret -> own invoice',
      '/api/invoices/search?q=Acme',
      { headers: { cookie: cookie! } },
      (status, text) => status === 200 && text.includes('INV-1') && !text.includes('INV-2'),
      snippet,
    );
    await check(
      'planted SQL injection: other owner rows come back',
      `/api/invoices/search?q=${encodeURIComponent("%' OR owner_id != 1 --")}`,
      { headers: { cookie: cookie! } },
      (status, text) => status === 200 && text.includes('INV-2'),
      snippet,
    );
    await check(
      'planted IDOR: invoice of owner 2 as user 1',
      '/api/invoices/2',
      { headers: { cookie: cookie! } },
      (status, text) => status === 200 && text.includes('Globex'),
      snippet,
    );
  }
  if (app === 'api-plain') {
    // A KV key written through the API can take up to a minute to be visible to the copy:
    // wait until the seeded session is accepted (the route then fails on the blocked fetch).
    for (let attempt = 0; attempt < 18; attempt++) {
      const response = await viaController(fixtures, counters, script, '/api/billing/charge', {
        method: 'POST',
        headers: { cookie: cookie!, origin: `https://${COPY_HOST}` },
      });
      if (!response.text.includes('#<Response>')) {
        timings.kvSeedVisible = Date.now() - started;
        break;
      }
      await sleep(5000);
    }
    await check(
      'charge (app fetch to the payments API) -> blocked, app errors',
      '/api/billing/charge',
      { method: 'POST', headers: { cookie: cookie!, origin: `https://${COPY_HOST}` } },
      // The handler throws `charge failed: 403`; the sandbox log check below names the call.
      (status, text) => status >= 500 && !text.includes('#<Response>'),
      snippet,
    );
  }

  // 7. Spike probe: egress, stubs, stores, secrets.
  const probeResponse = await viaController(fixtures, counters, script, '/__spike/probe');
  let probe: unknown = probeResponse.text.slice(0, 2000);
  try {
    probe = JSON.parse(probeResponse.text);
  } catch {
    failures.push(
      `${app}: probe answered ${probeResponse.status} ${probeResponse.text.slice(0, 300)}`,
    );
  }
  failures.push(...judgeProbe(app, probe, migrations.length > 0, seed));

  // 8. Not reachable from the internet.
  const unreachable = await reachability(env, counters, fixtures, script);
  for (const [name, entry] of Object.entries(unreachable)) {
    if (!entry.ok) {
      failures.push(`${app}: reachable check ${name} failed: ${entry.detail}`);
    }
  }

  const logResponse = await fetch(`${fixtures.controllerUrl}/log`, {
    headers: { 'x-spike-key': fixtures.key },
  });
  const outboundLog = (
    (await logResponse.json()) as Array<{ copy: string | null; detail: string }>
  ).filter((entry) => entry.copy === null || entry.copy === script);
  if (app === 'api-plain') {
    const charge = outboundLog.find((entry) => entry.detail.includes('api.payments.example.com'));
    if (!charge || !charge.detail.includes('"authorization":"fake"')) {
      failures.push(
        `${app}: the app payments call is not in the sandbox log with the fake key: ${charge?.detail}`,
      );
    }
  }

  return {
    app,
    script,
    warm,
    bindings: bindingsSummary,
    dropped,
    fakeSecrets: Object.keys(fake),
    migrations,
    assets: {
      files: assetFiles.length,
      uploaded: assetResult.uploaded,
      buckets: assetResult.buckets,
    },
    modules: Object.keys(config.manifest.modules).length + 1,
    uploadBytes,
    timings,
    readyMs,
    firstStatus,
    routes,
    probe,
    outboundLog,
    unreachable,
    deleteMs: null,
    counters,
    costUsd: 0,
    failures,
  };
}

type Attempt = { ok: boolean; error?: string; status?: number; blocked?: boolean };

/** Every egress probe must fail or be answered by the outbound Worker (403, blocked). */
function judgeProbe(app: string, probe: unknown, migrated: boolean, seed: AppSeed): Array<string> {
  const failures: Array<string> = [];
  if (!probe || typeof probe !== 'object') {
    return [`${app}: no probe result`];
  }
  const result = probe as {
    worker: Record<string, Attempt>;
    durableObject: Attempt & Record<string, Attempt>;
    waitUntilFetch: Attempt;
    stubs: Record<string, Attempt>;
    stores: Record<
      string,
      Attempt & { tables?: Array<string>; keys?: Array<string>; objects?: number }
    >;
    secrets: Record<string, string>;
  };
  const escaped = (entry: Attempt | undefined) =>
    entry !== undefined && entry.ok && !(entry.blocked === true && entry.status === 403);
  for (const [name, entry] of Object.entries(result.worker ?? {})) {
    if (escaped(entry)) {
      failures.push(`${app}: Worker egress ${name} got out: ${JSON.stringify(entry)}`);
    }
  }
  if (escaped(result.waitUntilFetch)) {
    failures.push(`${app}: waitUntil fetch got out: ${JSON.stringify(result.waitUntilFetch)}`);
  }
  if (!result.durableObject?.ok) {
    failures.push(`${app}: Durable Object probe failed: ${result.durableObject?.error}`);
  } else {
    for (const [name, entry] of Object.entries(result.durableObject)) {
      if (entry && typeof entry === 'object' && escaped(entry)) {
        failures.push(`${app}: Durable Object egress ${name} got out: ${JSON.stringify(entry)}`);
      }
    }
  }
  for (const [name, entry] of Object.entries(result.stubs ?? {})) {
    if (!entry.ok) {
      failures.push(`${app}: stub ${name} failed: ${entry.error}`);
    }
  }
  for (const [name, entry] of Object.entries(result.stores ?? {})) {
    if (!entry.ok) {
      failures.push(`${app}: store ${name} failed: ${entry.error}`);
      continue;
    }
    if (entry.tables && migrated && !entry.tables.includes('users')) {
      failures.push(`${app}: ${name} misses the migrated users table: ${entry.tables.join(',')}`);
    }
    if (entry.keys && entry.keys.length !== Object.keys(seed.kv ?? {}).length) {
      failures.push(`${app}: ${name} holds keys other than the test rows`);
    }
    if (entry.objects !== undefined && entry.objects !== 0) {
      failures.push(`${app}: ${name} is not empty`);
    }
  }
  for (const [name, value] of Object.entries(result.secrets ?? {})) {
    if (value !== 'fake') {
      failures.push(`${app}: secret ${name} is ${value}, not the fake value`);
    }
  }
  return failures;
}

async function reachability(
  env: SpikeEnv,
  counters: Counters,
  fixtures: Fixtures,
  script: string,
): Promise<CopyResult['unreachable']> {
  const out: CopyResult['unreachable'] = {};
  const subdomain = await api<{ subdomain: string }>(env, counters, '/workers/subdomain');
  const direct = `https://${script}.${subdomain.subdomain}.workers.dev/`;
  const response = await fetch(direct, { redirect: 'manual' }).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  if (response instanceof Error) {
    out.workersDev = { ok: true, detail: `${direct}: ${response.message}` };
  } else {
    const text = await response.text();
    out.workersDev = {
      ok: response.status >= 400,
      detail: `${direct}: ${response.status} ${text.slice(0, 80).replaceAll('\n', ' ')}`,
    };
  }
  const accountScript = await cfApi(env, `/workers/scripts/${script}/subdomain`);
  counters.apiCalls++;
  out.notAnAccountScript = {
    ok: !accountScript.ok,
    detail: `GET /workers/scripts/${script}/subdomain: ${accountScript.status} ${JSON.stringify(accountScript.errors).slice(0, 120)}`,
  };
  const noKey = await fetch(`${fixtures.controllerUrl}/copy/${script}/`, { redirect: 'manual' });
  out.controllerWithoutKey = {
    ok: noKey.status === 403,
    detail: `controller without key: ${noKey.status} ${(await noKey.text()).slice(0, 40)}`,
  };
  const wrongKey = await fetch(`${fixtures.controllerUrl}/copy/${script}/`, {
    redirect: 'manual',
    headers: { 'x-spike-key': 'wrong' },
  });
  out.controllerWrongKey = {
    ok: wrongKey.status === 403,
    detail: `controller with a wrong key: ${wrongKey.status}`,
  };
  return out;
}

function copyCost(counters: Counters, lifetimeMs: number): number {
  const month = 30 * 24 * 3600 * 1000;
  return (
    PRICES.wfpScriptMonthUsd * (lifetimeMs / month) +
    (counters.copyRequests * PRICES.wfpRequestUsdPerMillion) / 1e6 +
    (counters.d1RowsWritten * PRICES.d1RowsWrittenUsdPerMillion) / 1e6 +
    (counters.d1RowsRead * PRICES.d1RowsReadUsdPerMillion) / 1e6 +
    (counters.kvWrites * PRICES.kvWriteUsdPerMillion) / 1e6 +
    (counters.r2ClassA * PRICES.r2ClassAUsdPerMillion) / 1e6
  );
}

// ---------- delete and list ----------

async function deleteCopy(
  env: SpikeEnv,
  namespace: string,
  copy: CopyResources,
): Promise<Array<string>> {
  const log: Array<string> = [];
  const del = async (label: string, path: string) => {
    const result = await cfApi(env, path, { method: 'DELETE' });
    log.push(
      `${label}: ${result.status}${result.ok ? '' : ` ${JSON.stringify(result.errors).slice(0, 160)}`}`,
    );
  };
  await del(
    `script ${copy.script}`,
    `/workers/dispatch/namespaces/${namespace}/scripts/${copy.script}?force=true`,
  );
  await Promise.all([
    ...copy.d1.map((db) => del(`d1 ${db.name}`, `/d1/database/${db.id}`)),
    ...copy.kv.map((ns) => del(`kv ${ns.title}`, `/storage/kv/namespaces/${ns.id}`)),
    ...copy.r2.map((bucket) => del(`r2 ${bucket.name}`, `/r2/buckets/${bucket.name}`)),
  ]);
  return log;
}

/** Every `void-spike-sa-s13-*` resource on the account (other spikes are ignored). */
export async function listS13Resources(env: SpikeEnv) {
  const named = (values: Array<string>) => values.filter((name) => name.startsWith(PREFIX));
  const namespaces = await cfApi<Array<{ namespace_name: string }>>(
    env,
    '/workers/dispatch/namespaces',
  );
  const scripts = await cfApi<Array<{ id: string }>>(env, '/workers/scripts');
  const d1 = await cfApi<Array<{ name: string }>>(env, `/d1/database?name=${PREFIX}&per_page=100`);
  const kv: Array<string> = [];
  for (let page = 1; ; page++) {
    const result = await cfApi<Array<{ title: string }>>(
      env,
      `/storage/kv/namespaces?per_page=100&page=${page}`,
    );
    if (!result.ok) {
      throw new Error(`KV list failed: ${JSON.stringify(result.errors)}`);
    }
    kv.push(...result.result.map((ns) => ns.title));
    if (result.result.length < 100) {
      break;
    }
  }
  const r2 = await cfApi<{ buckets: Array<{ name: string }> }>(env, '/r2/buckets?per_page=1000');
  for (const [label, result] of Object.entries({ namespaces, scripts, d1, r2 })) {
    if (!result.ok) {
      throw new Error(`${label} list failed: ${result.status} ${JSON.stringify(result.errors)}`);
    }
  }
  const leftoverScripts: Array<string> = [];
  for (const ns of namespaces.result.filter((entry) => entry.namespace_name.startsWith(PREFIX))) {
    const inside = await cfApi<Array<{ id: string }>>(
      env,
      `/workers/dispatch/namespaces/${ns.namespace_name}/scripts`,
    );
    leftoverScripts.push(
      ...(inside.result ?? []).map((entry) => `${ns.namespace_name}/${entry.id}`),
    );
  }
  return {
    counts: {
      dispatchNamespaces: namespaces.result.length,
      workers: scripts.result.length,
      d1Matching: d1.result.length,
      kv: kv.length,
      r2: r2.result.buckets.length,
    },
    dispatchNamespaces: named(namespaces.result.map((ns) => ns.namespace_name)),
    namespaceScripts: leftoverScripts,
    workers: named(scripts.result.map((script) => script.id)),
    d1: named(d1.result.map((db) => db.name)),
    kv: named(kv),
    r2: named(r2.result.buckets.map((bucket) => bucket.name)),
  };
}

function leftovers(list: Awaited<ReturnType<typeof listS13Resources>>): Array<string> {
  return [
    ...list.dispatchNamespaces,
    ...list.namespaceScripts,
    ...list.workers,
    ...list.d1,
    ...list.kv,
    ...list.r2,
  ];
}

async function deleteFixtures(env: SpikeEnv, fixtures: Partial<Fixtures> & { run: string }) {
  const log: Array<string> = [];
  for (const name of [`${PREFIX}ctl-${fixtures.run}`, `${PREFIX}box-${fixtures.run}`]) {
    const deleted = runWrangler(env, ['delete', name, '--force'], REPO);
    log.push(`wrangler delete ${name}: exit ${deleted.status}`);
  }
  const ns = await cfApi(env, `/workers/dispatch/namespaces/${PREFIX}ns-${fixtures.run}`, {
    method: 'DELETE',
  });
  log.push(`namespace ${PREFIX}ns-${fixtures.run}: ${ns.status}`);
  return log;
}

// ---------- main ----------

const log = (line: string) =>
  console.error(`[s13 ${new Date().toISOString().slice(11, 19)}] ${line}`);

async function main() {
  const { values } = parseArgs({
    options: {
      apps: { type: 'string', default: 'react-d1,api-plain,solid-r2' },
      warm: { type: 'string', default: 'react-d1' },
      out: { type: 'string' },
      keep: { type: 'boolean', default: false },
      'no-guard': { type: 'boolean', default: false },
    },
  });
  const apps = values.apps.split(',').filter(Boolean);
  const warm = values.warm.split(',').filter(Boolean);
  const env = spikeEnv();
  const run = Date.now().toString(36);
  const failures: Array<string> = [];
  const report: Record<string, unknown> = { spike: 'S13', run, readyLimitMs: READY_LIMIT_MS };
  const resources: Array<CopyResources> = [];
  const copies: Array<CopyResult> = [];
  const fixtureCounters = newCounters();

  for (const app of new Set([...apps, ...warm])) {
    log(`building ${app}`);
    appDir(app);
  }
  report.baseline = await listS13Resources(env);
  let fixtures: Fixtures | null = null;
  try {
    log('creating namespace, sandbox and controller');
    fixtures = await createFixtures(env, fixtureCounters, run);
    await waitForController(fixtures);
    report.fixtures = {
      namespace: fixtures.namespace,
      sandbox: fixtures.sandbox,
      controller: fixtures.controller,
      setupMs: fixtures.setupMs,
    };
    const plan = [
      ...apps.map((app) => ({ app, warm: false })),
      ...warm.map((app) => ({ app, warm: true })),
    ];
    for (const step of plan) {
      log(`copy ${step.app}${step.warm ? ' (warm)' : ''}`);
      const copyStart = Date.now();
      try {
        const copy = await createCopy(
          env,
          fixtures,
          step.app,
          step.warm,
          resources,
          !values['no-guard'],
        );
        const tracked = resources.find((entry) => entry.script === copy.script)!;
        const deleteStart = Date.now();
        const deleteLog = values.keep ? [] : await deleteCopy(env, fixtures.namespace, tracked);
        if (!values.keep) {
          resources.splice(resources.indexOf(tracked), 1);
          copy.deleteMs = Date.now() - deleteStart;
        }
        copy.costUsd = round(copyCost(copy.counters, Date.now() - copyStart), 6);
        copies.push(copy);
        failures.push(...copy.failures);
        log(
          `${step.app}: ready ${copy.readyMs} ms ${JSON.stringify(copy.timings)} routes ${copy.routes.filter((route) => route.ok).length}/${copy.routes.length} failures ${copy.failures.length} delete ${copy.deleteMs} ms ${deleteLog.join('; ')}`,
        );
      } catch (error) {
        failures.push(`${step.app}: ${String(error instanceof Error ? error.stack : error)}`);
        log(`${step.app} failed: ${String(error)}`);
      }
      env.token = freshToken();
    }
  } catch (error) {
    failures.push(String(error instanceof Error ? error.stack : error));
  } finally {
    if (!values.keep) {
      env.token = freshToken();
      const cleanup: Array<string> = [];
      for (const copy of resources) {
        cleanup.push(...(await deleteCopy(env, `${PREFIX}ns-${run}`, copy)));
      }
      cleanup.push(...(await deleteFixtures(env, fixtures ?? { run })));
      let after = await listS13Resources(env);
      for (let attempt = 0; attempt < 5 && leftovers(after).length > 0; attempt++) {
        await sleep(5000);
        after = await listS13Resources(env);
      }
      report.cleanup = { log: cleanup, after };
      if (leftovers(after).length > 0) {
        failures.push(`leftover resources: ${leftovers(after).join(', ')}`);
      }
    }
  }

  const ready = copies.map((copy) => copy.readyMs);
  report.copies = copies;
  report.summary = {
    copies: copies.length,
    readyMs: {
      cold: copies.flatMap((copy) => (copy.warm ? [] : [[copy.app, copy.readyMs]])),
      warm: copies.flatMap((copy) => (copy.warm ? [[copy.app, copy.readyMs]] : [])),
      max: ready.length ? Math.max(...ready) : null,
    },
    deleteMs: copies.map((copy) => [copy.app, copy.deleteMs]),
    routesOk: copies.reduce((sum, copy) => sum + copy.routes.filter((route) => route.ok).length, 0),
    routes: copies.reduce((sum, copy) => sum + copy.routes.length, 0),
    costUsdPerCopy: copies.map((copy) => [copy.app, copy.costUsd]),
    fixtureApiCalls: fixtureCounters.apiCalls,
  };
  report.failures = failures;
  const text = JSON.stringify(report, null, 2);
  if (values.out) {
    writeFileSync(values.out, text);
  }
  console.log(text);
  console.log(failures.length ? 'S13 FAIL' : 'S13 PASS');
  process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.main) {
  await main();
}
