/**
 * Security audits Phase 0 spike S4: Engine B quality on `@cf` models with T2 input.
 *
 * What it runs (plan "Phase 0 spikes", PRD §15.2, spec §20 S4):
 *   - T2 input (built-output diff) for each seeded app in
 *     platform/scripts/fixtures/security-seeded-apps/<app>/ (bugs.json + files/ overlay):
 *     the base playground app (`bugs.json` `base`) is copied to playground-local/, built
 *     with `vp build`, then the overlay is added and it is built again. Changed Worker
 *     modules (sha256) are mapped back to app sources through source-map
 *     `sourcesContent`; changed text assets and the deploy bindings (plain-text vars)
 *     are added. /scan/input holds every app-own server source; `changed_files` lists
 *     the changed ones. Third-party sources (node_modules, Void packages) are left out.
 *   - The committed M5 runner (platform/packages/security-scanner, `dist/runner.mjs`,
 *     Engine B) runs in a Cloudflare Container with the S1 egress lock, the same way the
 *     M6 controller starts it (managed `cloudflare/debian-trixie`, `standard-1`, user
 *     `scanner`, runner on stdin, input tar on stdin, `enableInternet: false`, model
 *     host -> ScanModelOutbound, all other HTTP/HTTPS -> DenyAll).
 *   - ScanModelOutbound is the model-proxy stand-in: it forwards chat completions to the
 *     Workers AI binding (`env.AI.run`), with the M7 per-scan caps (80 calls, 600k input /
 *     60k output tokens, 16k output per call) and the D24 rate guard (10 req/min per
 *     model, shared token bucket; the wait is not counted against the 20 min wall clock).
 *     No AI Gateway (the OAuth login has no gateway scope).
 *   - Two scans per model run at once (the most the D24 guard admits), the models in
 *     parallel. Each scan's findings are matched to the planted bugs (file + CWE or
 *     keyword); unmatched confirmed findings in changed or decoy files count as false
 *     positives, unmatched ones in base playground code are listed for review.
 *
 * Run (from the repo root):
 *   node platform/scripts/security-spike-s4.ts --local          (harness check, fake model)
 *   CLOUDFLARE_ACCOUNT_ID=... [CLOUDFLARE_API_TOKEN=...] NODE_USE_SYSTEM_CA=1 \
 *     WRANGLER_BIN=.../wrangler.js node platform/scripts/security-spike-s4.ts --live \
 *     [--models @cf/zai-org/glm-5.3,@cf/deepseek-ai/deepseek-v4.1-flash-1017] \
 *     [--apps react-d1,...] [--runs 1] [--budget-usd 10] [--out report.json] [--keep]
 *   Without CLOUDFLARE_API_TOKEN the wrangler OAuth login is used (`wrangler auth token`;
 *   needs workers_scripts, containers and ai scopes). Only `void-spike-sa-s4` (Worker,
 *   Durable Objects, container app) is created; it is deleted at the end and the lists
 *   are checked afterwards.
 *
 * Pass (per model; PRD §15.2): >= 7/10 planted crit/high found, <= 2 false confirmed,
 * >= 95% schema-valid runs, <= 80 calls per scan, p95 wall time < 20 min. Prints one JSON
 * report and one PASS/FAIL line per model; exits 1 if the default model fails.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_SECURITY_MODEL,
  getSecurityModel,
  isSecurityModelId,
  type SecurityModelId,
} from '../../packages/platform/src/security-models.ts';
import { startFakeModel } from '../packages/security-scanner/test/fake-model/server.ts';
import {
  SPIKE_PREFIX,
  deleteSpikeResources,
  deploySpikeWorker,
  listSpikeResources,
  percentile,
  waitForWorker,
  type SpikeEnv,
} from './security-spike-s1.ts';

export const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURES = join(REPO, 'platform/scripts/fixtures/security-seeded-apps');
const WORK = join(REPO, 'playground-local/security-spike');
const SCANNER_DIR = join(REPO, 'platform/packages/security-scanner');
const RUNNER_BUNDLE = join(SCANNER_DIR, 'dist/runner.mjs');

export const SPIKE_MODELS: Array<SecurityModelId> = [
  '@cf/zai-org/glm-5.3',
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
];

/** M7 / policy defaults (packages/platform/src/security-policy.ts, model-proxy.ts, D21, D24). */
export const LIMITS = {
  callsPerScan: 80,
  maxInputTokens: 1_200_000,
  maxOutputTokens: 120_000,
  callOutputTokens: 16_384,
  ratePerMinute: 10,
  rateWaitLimitMs: 120_000,
  pollMs: 10_000,
  stopGraceMs: 60_000,
  wallClockMs: 20 * 60_000,
  hardCapMs: 40 * 60_000,
} as const;

const TEXT_ASSET_EXTENSIONS = ['.js', '.mjs', '.html', '.json', '.css', '.txt'];
const TEXT_ASSET_MAX_BYTES = 256 * 1024;
const COPY_SKIP = new Set(['node_modules', 'dist', '.void', '.cloudflare', '.wrangler']);

// ---------- fixtures ----------

export type PlantedBug = {
  id: string;
  class: string;
  severity: string;
  file: string;
  alsoFiles?: Array<string>;
  cwe: Array<string>;
  keywords: Array<string>;
};

export type Fixture = {
  name: string;
  base: string;
  framework: string;
  kind: 'seeded' | 'clean';
  planted: Array<PlantedBug>;
  decoys: Array<{ file: string; note: string }>;
};

export function listFixtures(): Array<string> {
  return readdirSync(FIXTURES)
    .filter((name) => existsSync(join(FIXTURES, name, 'bugs.json')))
    .sort();
}

export function loadFixture(name: string): Fixture {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name, 'bugs.json'), 'utf8')) as Omit<
    Fixture,
    'name'
  >;
  return { name, ...raw };
}

// ---------- T2 input (built-output diff) ----------

/** One app build: a playground copy, minus `strip`, plus fixture overlays. */
export type AppVariant = {
  key: string;
  base: string;
  strip?: Array<string>;
  overlays?: Array<{ fixture: string; only?: Array<string> }>;
};

type BuildOutput = {
  modules: Map<string, { sha: string; text: string; sources: Array<string>; hasMap: boolean }>;
  sources: Map<string, string>;
  assets: Map<string, { sha: string; text: string }>;
  bindings: unknown;
  missingSourcesContent: number;
};

export type ScanInput = {
  files: Map<string, string>;
  changedFiles: Array<string>;
  /** Lines in changed files that are not in the base file (new files count whole). */
  diffLines: number;
  /** The same, app sources only (no assets, no deploy config). */
  sourceDiffLines: number;
  inputBytes: number;
  notes: Array<string>;
};

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

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

function endsWithAny(path: string, endings: ReadonlyArray<string>): boolean {
  return endings.some((ending) => path.endsWith(ending));
}

const buildCache = new Map<string, BuildOutput>();

export function buildVariant(variant: AppVariant): BuildOutput {
  const cached = buildCache.get(variant.key);
  if (cached) {
    return cached;
  }
  const source = join(REPO, 'playground', variant.base);
  const dir = join(WORK, variant.key);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(source, dir, {
    recursive: true,
    filter: (from) => {
      const first = toPosix(relative(source, from)).split('/')[0];
      return !COPY_SKIP.has(first);
    },
  });
  symlinkSync(realpathSync(join(source, 'node_modules')), join(dir, 'node_modules'), 'dir');
  for (const path of variant.strip ?? []) {
    rmSync(join(dir, path), { recursive: true, force: true });
  }
  for (const overlay of variant.overlays ?? []) {
    const files = join(FIXTURES, overlay.fixture, 'files');
    for (const file of walkFiles(files)) {
      const rel = toPosix(relative(files, file));
      if (overlay.only && !overlay.only.includes(rel.split('/')[0])) {
        continue;
      }
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      cpSync(file, join(dir, rel));
    }
  }
  const built = spawnSync(join(dir, 'node_modules/.bin/vp'), ['build'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 5 * 60_000,
  });
  if (built.status !== 0) {
    throw new Error(
      `vp build ${variant.key} failed:\n${`${built.stdout}\n${built.stderr}`.slice(-3000)}`,
    );
  }
  const output = readBuild(dir);
  buildCache.set(variant.key, output);
  return output;
}

function readBuild(dir: string): BuildOutput {
  const out = join(dir, '.cloudflare/output/v1/workers/default');
  const bundle = join(out, 'bundle');
  const result: BuildOutput = {
    modules: new Map(),
    sources: new Map(),
    assets: new Map(),
    bindings: {},
    missingSourcesContent: 0,
  };
  for (const file of walkFiles(bundle)) {
    if (!endsWithAny(file, ['.js', '.mjs'])) {
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const sources: Array<string> = [];
    const mapPath = `${file}.map`;
    if (existsSync(mapPath)) {
      const map = JSON.parse(readFileSync(mapPath, 'utf8')) as {
        sourceRoot?: string;
        sources: Array<string>;
        sourcesContent?: Array<string | null>;
      };
      map.sources.forEach((name, index) => {
        // Virtual modules (`virtual:…`, `\0…`) have no file.
        if (name.startsWith('\0') || name.includes(':')) {
          return;
        }
        const absolute = resolve(dirname(mapPath), map.sourceRoot ?? '', name);
        const rel = toPosix(relative(dir, absolute));
        if (rel.startsWith('..') || rel.startsWith('node_modules/')) {
          return;
        }
        const content = map.sourcesContent?.[index];
        if (typeof content !== 'string') {
          result.missingSourcesContent++;
          return;
        }
        result.sources.set(rel, content);
        sources.push(rel);
      });
    }
    result.modules.set(toPosix(relative(bundle, file)), {
      sha: sha256(text),
      text,
      sources,
      hasMap: existsSync(mapPath),
    });
  }
  const assets = join(out, 'assets');
  for (const file of walkFiles(assets)) {
    if (!endsWithAny(file, TEXT_ASSET_EXTENSIONS) || statSync(file).size > TEXT_ASSET_MAX_BYTES) {
      continue;
    }
    const text = readFileSync(file, 'utf8');
    result.assets.set(toPosix(relative(assets, file)), { sha: sha256(text), text });
  }
  const config = JSON.parse(readFileSync(join(out, 'worker.config.json'), 'utf8')) as {
    env?: unknown;
  };
  result.bindings = config.env ?? {};
  return result;
}

function addedLines(head: string, base: string | undefined): number {
  const lines = head.split('\n');
  if (base === undefined) {
    return lines.length;
  }
  const left = new Map<string, number>();
  for (const line of base.split('\n')) {
    left.set(line, (left.get(line) ?? 0) + 1);
  }
  let added = 0;
  for (const line of lines) {
    const count = left.get(line) ?? 0;
    if (count > 0) {
      left.set(line, count - 1);
    } else {
      added++;
    }
  }
  return added;
}

/** T2: changed Worker modules by sha256, back to sources; changed text assets; bindings. */
export function t2Input(base: BuildOutput, head: BuildOutput): ScanInput {
  const files = new Map<string, string>();
  const changed = new Set<string>();
  const notes: Array<string> = [];
  for (const [rel, content] of head.sources) {
    files.set(rel, content);
  }
  const baseModuleShas = new Set([...base.modules.values()].map((module) => module.sha));
  for (const [name, module] of head.modules) {
    if (baseModuleShas.has(module.sha)) {
      continue;
    }
    if (!module.hasMap) {
      // No source map: the bundled module itself is the input (spec §19 #10).
      files.set(`_bundle/${name}`, module.text);
      changed.add(`_bundle/${name}`);
      continue;
    }
    // A mapped module with no app source is third-party or virtual code: left out.
    for (const rel of module.sources) {
      if (base.sources.get(rel) !== head.sources.get(rel)) {
        changed.add(rel);
      }
    }
  }
  const baseAssetShas = new Set([...base.assets.values()].map((asset) => asset.sha));
  for (const [rel, asset] of head.assets) {
    if (!baseAssetShas.has(asset.sha)) {
      files.set(`_assets/${rel}`, asset.text);
      changed.add(`_assets/${rel}`);
    }
  }
  const bindings = `${JSON.stringify(head.bindings, null, 2)}\n`;
  files.set('_deploy/bindings.json', bindings);
  if (bindings !== `${JSON.stringify(base.bindings, null, 2)}\n`) {
    changed.add('_deploy/bindings.json');
  }
  if (head.missingSourcesContent > 0) {
    notes.push(`${head.missingSourcesContent} app sources had no sourcesContent`);
  }
  let diffLines = 0;
  let sourceDiffLines = 0;
  for (const rel of changed) {
    const baseText = rel.startsWith('_') ? undefined : base.sources.get(rel);
    const added = addedLines(files.get(rel) ?? '', baseText);
    diffLines += added;
    if (!rel.startsWith('_')) {
      sourceDiffLines += added;
    }
  }
  let inputBytes = 0;
  for (const text of files.values()) {
    inputBytes += Buffer.byteLength(text);
  }
  return {
    files,
    changedFiles: [...changed].sort(),
    diffLines,
    sourceDiffLines,
    inputBytes,
    notes,
  };
}

export function fixtureInput(fixture: Fixture): ScanInput {
  const base = buildVariant({ key: `base-${fixture.base}`, base: fixture.base });
  const head = buildVariant({
    key: `head-${fixture.name}`,
    base: fixture.base,
    overlays: [{ fixture: fixture.name }],
  });
  return t2Input(base, head);
}

// ---------- scan tar ----------

function tarHeader(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  block.write('00000000000\0', 136, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

function tarPad(data: Buffer): Buffer {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

/** Plain ustar; a pax `path` record carries names longer than 99 bytes. */
export function buildTar(entries: Array<{ name: string; data: string }>): Buffer {
  const parts: Array<Buffer> = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data, 'utf8');
    if (Buffer.byteLength(entry.name) > 99) {
      const body = ` path=${entry.name}\n`;
      let length = Buffer.byteLength(body) + 1;
      while (String(length).length + Buffer.byteLength(body) !== length) {
        length = String(length).length + Buffer.byteLength(body);
      }
      const pax = Buffer.from(`${length}${body}`, 'utf8');
      parts.push(tarHeader('PaxHeader', pax.length, 'x'), tarPad(pax));
    }
    parts.push(tarHeader(entry.name.slice(0, 99), data.length, '0'), tarPad(data));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function scanTar(input: ScanInput, scanId: string, model: string): Buffer {
  const task = {
    version: 1,
    scan_id: scanId,
    attempt: 1,
    engine: 'void_loop',
    model,
    tier: 'built_diff',
    changed_files: input.changedFiles,
  };
  return buildTar([
    { name: 'task.json', data: JSON.stringify(task) },
    ...[...input.files].map(([rel, data]) => ({ name: `input/${rel}`, data })),
  ]);
}

// ---------- runner bundle ----------

export function ensureRunner(): string {
  const newest = Math.max(
    ...walkFiles(join(SCANNER_DIR, 'src')).map((file) => statSync(file).mtimeMs),
  );
  if (!existsSync(RUNNER_BUNDLE) || statSync(RUNNER_BUNDLE).mtimeMs < newest) {
    const packed = spawnSync(join(SCANNER_DIR, 'node_modules/.bin/vp'), ['pack'], {
      cwd: SCANNER_DIR,
      encoding: 'utf8',
    });
    if (packed.status !== 0) {
      throw new Error(`vp pack failed:\n${packed.stdout}\n${packed.stderr}`);
    }
  }
  return readFileSync(RUNNER_BUNDLE, 'utf8');
}

// ---------- auth ----------

function wranglerBin(): string {
  if (process.env.WRANGLER_BIN) {
    return process.env.WRANGLER_BIN;
  }
  const require = createRequire(new URL('../packages/api/package.json', import.meta.url));
  return join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
}

/** An API token, or the wrangler OAuth token (wrangler refreshes it when it has expired). */
export function freshToken(): string {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return process.env.CLOUDFLARE_API_TOKEN;
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    WRANGLER_SEND_METRICS: 'false',
  };
  delete env.CLOUDFLARE_API_TOKEN;
  const result = spawnSync(process.execPath, [wranglerBin(), 'auth', 'token', '--json'], {
    encoding: 'utf8',
    env,
  });
  const text = result.stdout ?? '';
  const start = text.indexOf('{');
  if (result.status !== 0 || start === -1) {
    throw new Error(
      `wrangler auth token failed: ${text.slice(-500)} ${result.stderr?.slice(-500)}`,
    );
  }
  const parsed = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) as { token?: string };
  if (!parsed.token) {
    throw new Error('wrangler auth token printed no token');
  }
  return parsed.token;
}

export function spikeEnv(): SpikeEnv {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID.');
  }
  return { accountId, token: freshToken() };
}

// ---------- harness Worker (controller + model-proxy stand-in) ----------

// From platform/packages/api/src/security-scanner-controller-runtime.ts (M6).
const SETUP_SCRIPT = [
  'const fs=require("node:fs"),cp=require("node:child_process");',
  'const user="scanner",runner="/opt/void-scanner/runner.mjs";',
  'try{cp.execFileSync("id",["-u",user],{stdio:"ignore"})}catch{cp.execFileSync("useradd",["--system","--no-create-home","--shell","/usr/sbin/nologin",user],{stdio:"ignore"})}',
  'fs.mkdirSync("/scan",{recursive:true});cp.execFileSync("chown",[user+":"+user,"/scan"]);fs.chmodSync("/scan",0o700);',
  'fs.mkdirSync(require("node:path").dirname(runner),{recursive:true});',
  'const chunks=[];process.stdin.on("data",c=>chunks.push(c));',
  'process.stdin.on("end",()=>{const tmp=runner+".tmp";fs.writeFileSync(tmp,Buffer.concat(chunks),{mode:0o555});fs.renameSync(tmp,runner);});',
].join('');

const READ_SCRIPT = [
  'const fs=require("node:fs"),c=fs.constants,[path,limit]=process.argv.slice(1);',
  'const no=(e)=>process.exit(e&&e.code==="ENOENT"?1:3);',
  'try{if(!fs.lstatSync("/scan/out").isDirectory())no()}catch(e){no(e)}',
  'let fd;try{fd=fs.openSync(path,c.O_RDONLY|c.O_NOFOLLOW|c.O_NONBLOCK)}catch(e){no(e)}',
  'if(!fs.fstatSync(fd).isFile())no();',
  'const buf=Buffer.alloc(Number(limit));let n=0,r;',
  'while(n<buf.length&&(r=fs.readSync(fd,buf,n,buf.length-n,null))>0)n+=r;',
  'process.stdout.write(buf.subarray(0,n));',
].join('');

const HARNESS_SOURCE = String.raw`
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

const RUNNER_SOURCE = __RUNNER_SOURCE__;
const LIMITS = __LIMITS__;
const SETUP_SCRIPT = __SETUP_SCRIPT__;
const READ_SCRIPT = __READ_SCRIPT__;
const MODEL_HOST = 'model.void.internal';
const RUNNER_PATH = '/opt/void-scanner/runner.mjs';
const EXEC_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/scan' };
const decoder = new TextDecoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error) => String((error && (error.stack || error.message)) || error).slice(0, 1000);

function statusOf(error) {
  for (let current = error, depth = 0; current && depth < 4; depth++) {
    const status = current.status ?? current.statusCode;
    if (typeof status === 'number' && status >= 400 && status <= 599) return status;
    current = current.cause;
  }
  return null;
}

// Same as asChatCompletion in platform/packages/api/src/security/model-proxy.ts.
function asChatCompletion(model, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value.choices)) return value;
  const raw = Array.isArray(value.tool_calls) ? value.tool_calls : [];
  const toolCalls = raw.flatMap((call, index) => {
    if (!call || typeof call !== 'object') return [];
    if (call.function && typeof call.function === 'object') return [call];
    if (typeof call.name !== 'string') return [];
    return [{ id: typeof call.id === 'string' ? call.id : 'call_' + index, type: 'function', function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) } }];
  });
  return {
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: typeof value.response === 'string' ? value.response : null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop' }],
    ...(value.usage === undefined ? {} : { usage: value.usage }),
  };
}

// D24: 10 calls a minute per model, at most 10 held; a Workers AI 429 puts it in debt.
export class RateGuard extends DurableObject {
  async bucket() {
    const now = Date.now();
    const prev = (await this.ctx.storage.get('bucket')) ?? { tokens: LIMITS.ratePerMinute, at: now };
    return { tokens: Math.min(LIMITS.ratePerMinute, prev.tokens + ((now - prev.at) * LIMITS.ratePerMinute) / 60000), at: now };
  }
  async take() {
    const bucket = await this.bucket();
    if (bucket.tokens >= 1) {
      await this.ctx.storage.put('bucket', { tokens: bucket.tokens - 1, at: bucket.at });
      return 0;
    }
    await this.ctx.storage.put('bucket', bucket);
    return Math.ceil(((1 - bucket.tokens) * 60000) / LIMITS.ratePerMinute) + 50;
  }
  async backoff() {
    const bucket = await this.bucket();
    await this.ctx.storage.put('bucket', { tokens: Math.max(-LIMITS.ratePerMinute, Math.min(0, bucket.tokens) - 5), at: bucket.at });
  }
}

// Model-proxy stand-in: identity from props, M7 caps, D24 rate guard, Workers AI binding.
export class ScanModelOutbound extends WorkerEntrypoint {
  async fetch(request) {
    const { scan, model } = this.ctx.props;
    const control = this.env.SCAN.getByName(scan);
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
    let body;
    try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
    if (!body || typeof body !== 'object' || body.model !== model) {
      await control.note('model not allowed: ' + String(body && body.model).slice(0, 100));
      return new Response('model not allowed', { status: 403 });
    }
    // Spike diagnostics: why the runner refused a report (the repair message it sends back).
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages[messages.length - 1];
    if (last && last.role === 'tool' && typeof last.content === 'string' && last.content.startsWith('error: the report was not accepted')) {
      const asked = messages[messages.length - 2];
      const call = asked && Array.isArray(asked.tool_calls) ? asked.tool_calls.find((entry) => entry && entry.id === last.tool_call_id) : null;
      const args = call && call.function ? String(call.function.arguments) : '';
      await control.note('repair: ' + last.content.slice(0, 300) + ' | submitted: ' + args.slice(0, 600));
    }
    const gate = await control.admit();
    if (gate.stop) return new Response('scan stopped: ' + gate.stop, { status: 429, headers: { 'x-void-scan-stop': gate.stop } });
    const rate = this.env.RATE.getByName(model);
    let waited = 0;
    for (;;) {
      const wait = await rate.take();
      if (wait === 0) break;
      if (waited + wait > LIMITS.rateWaitLimitMs) {
        await control.logCall({ ok: false, status: 503, error: 'rate wait limit', waitMs: waited, ms: 0 });
        return new Response('rate wait limit', { status: 503 });
      }
      await sleep(wait);
      waited += wait;
    }
    const { model: _model, stream: _stream, ...inputs } = body;
    const asked = typeof inputs.max_tokens === 'number' ? inputs.max_tokens : LIMITS.callOutputTokens;
    inputs.max_tokens = Math.max(1, Math.min(asked, LIMITS.callOutputTokens, gate.outputLeft));
    const started = Date.now();
    let result;
    try {
      result = await this.env.AI.run(model, inputs);
    } catch (error) {
      const status = statusOf(error) ?? 502;
      if (status === 429) await rate.backoff();
      await control.logCall({ ok: false, status, error: errorText(error).slice(0, 300), waitMs: waited, ms: Date.now() - started });
      return new Response('upstream failed', { status });
    }
    const chat = asChatCompletion(model, result);
    const usage = (chat && chat.usage) || {};
    const choice = chat && Array.isArray(chat.choices) ? chat.choices[0] : null;
    const message = (choice && choice.message) || {};
    await control.logCall({
      ok: true, status: 200, waitMs: waited, ms: Date.now() - started,
      in: Number(usage.prompt_tokens) || 0, out: Number(usage.completion_tokens) || 0,
      cached: Number(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0,
      finish: choice ? choice.finish_reason : null,
      tools: Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => call && call.function && call.function.name) : [],
      contentChars: typeof message.content === 'string' ? message.content.length : 0,
    });
    return Response.json(chat);
  }
}

export class DenyAll extends WorkerEntrypoint {
  fetch(request) {
    return new Response('egress denied: ' + new URL(request.url).hostname, { status: 403 });
  }
}

// One scan per Durable Object, started like the M6 controller does it.
export class ScanController extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = null;
    ctx.blockConcurrencyWhile(async () => { this.s = (await ctx.storage.get('s')) ?? null; });
  }
  async save() {
    try { await this.ctx.storage.put('s', this.s); } catch (error) { console.error('save failed', errorText(error)); }
  }
  async admit() {
    const s = this.s;
    if (!s || s.phase === 'done') return { stop: 'scan_calls' };
    if (s.calls >= LIMITS.callsPerScan) { s.stops.push('scan_calls'); await this.save(); return { stop: 'scan_calls' }; }
    if (s.tokensIn >= LIMITS.maxInputTokens || s.tokensOut >= LIMITS.maxOutputTokens) { s.stops.push('tokens'); await this.save(); return { stop: 'tokens' }; }
    s.calls++;
    await this.save();
    return { stop: null, outputLeft: LIMITS.maxOutputTokens - s.tokensOut };
  }
  async logCall(entry) {
    const s = this.s;
    if (!s) return;
    entry.at = Date.now() - s.t0;
    s.log.push(entry);
    if (entry.ok) { s.tokensIn += entry.in; s.tokensOut += entry.out; s.cachedIn += entry.cached; }
    s.rateWaitMs += entry.waitMs || 0;
    s.modelMs += entry.ms || 0;
    await this.save();
  }
  async note(text) {
    if (!this.s) return;
    this.s.notes.push(text);
    await this.save();
  }
  async begin(args) {
    if (this.s) return { ok: false, error: 'already started' };
    const t0 = Date.now();
    this.s = { name: args.name, model: args.model, t0, phase: 'starting', calls: 0, tokensIn: 0, tokensOut: 0, cachedIn: 0, rateWaitMs: 0, modelMs: 0, log: [], stops: [], notes: [], wallClockMs: args.wallClockMs, hardCapMs: args.hardCapMs };
    await this.save();
    const c = this.ctx.container;
    try {
      if (c.running) await c.destroy();
      const props = { scan: args.name, model: args.model };
      // Hostname intercept first, then the catch-alls (S1).
      await c.interceptOutboundHttp(MODEL_HOST, this.ctx.exports.ScanModelOutbound({ props }));
      await c.interceptAllOutboundHttp(this.ctx.exports.DenyAll({ props: {} }));
      await c.interceptOutboundHttps('*', this.ctx.exports.DenyAll({ props: {} }));
      c.start({ image: 'cloudflare/debian-trixie', entrypoint: ['sleep', 'infinity'], enableInternet: false, env: {}, instance: 'standard-1' });
      let lastError = 'not ready';
      for (;;) {
        if (Date.now() - t0 > 120000) throw new Error('container not ready: ' + lastError);
        try {
          const probe = await c.exec(['true']);
          const output = await probe.output();
          if (output.exitCode === 0) break;
          lastError = 'exit ' + output.exitCode;
        } catch (error) {
          lastError = errorText(error).slice(0, 200);
        }
        await sleep(250);
      }
      this.s.readyMs = Date.now() - t0;
      // M6 runs setup with EXEC_ENV, whose PATH has no /usr/sbin: useradd is not found there (S4 live finding).
      const setup = await c.exec(['node', '-e', SETUP_SCRIPT], { env: { ...EXEC_ENV, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }, stdin: new Blob([RUNNER_SOURCE]).stream(), signal: AbortSignal.timeout(30000) });
      const setupOutput = await setup.output();
      if (setupOutput.exitCode !== 0) throw new Error('setup exit ' + setupOutput.exitCode + ': ' + decoder.decode(setupOutput.stderr).slice(0, 500));
      const runner = await c.exec(['node', RUNNER_PATH, '--stdin-tar'], { user: 'scanner', cwd: '/scan', env: { ...EXEC_ENV }, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
      this.s.pid = runner.pid;
      await new Blob([args.tar]).stream().pipeTo(runner.stdin);
      this.s.phase = 'running';
      this.s.runStartMs = Date.now() - t0;
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + LIMITS.pollMs);
      return { ok: true, readyMs: this.s.readyMs, runStartMs: this.s.runStartMs };
    } catch (error) {
      await this.finish({ infra: errorText(error) });
      return { ok: false, error: errorText(error) };
    }
  }
  async readFile(path, limit) {
    const process = await this.ctx.container.exec(['node', '-e', READ_SCRIPT, path, String(limit)], { user: 'scanner', cwd: '/scan', env: { ...EXEC_ENV }, signal: AbortSignal.timeout(30000) });
    const output = await process.output();
    if (output.exitCode === 0) return { kind: 'ok', text: decoder.decode(output.stdout) };
    return output.exitCode === 1 ? { kind: 'missing' } : { kind: 'refused' };
  }
  async poll() {
    const s = this.s;
    if (!s || s.phase === 'done' || s.phase === 'starting') return;
    const c = this.ctx.container;
    if (!c.running) return this.finish({ infra: 'container_exited' });
    const status = await this.readFile('/scan/out/status.json', 1048576);
    if (status.kind === 'ok') {
      const findings = await this.readFile('/scan/out/findings.json', 5 * 1024 * 1024 + 1);
      let parsed = null;
      try { parsed = JSON.parse(status.text); } catch { parsed = { unreadable: status.text.slice(0, 500) }; }
      return this.finish({ status: parsed, findingsText: findings.kind === 'ok' ? findings.text : null });
    }
    if (status.kind === 'refused') return this.finish({ infra: 'status_refused' });
    const now = Date.now() - s.t0;
    const elapsed = now - s.runStartMs;
    if (s.phase === 'running' && elapsed - s.rateWaitMs >= s.wallClockMs) {
      const kill = await c.exec(['kill', '-TERM', String(s.pid)], { user: 'scanner', env: { ...EXEC_ENV }, signal: AbortSignal.timeout(30000) });
      await kill.output();
      s.phase = 'stopping';
      s.stopAtMs = now;
      await this.save();
    } else if (s.phase === 'stopping' && now - s.stopAtMs > LIMITS.stopGraceMs) {
      return this.finish({ infra: 'no status after SIGTERM', timedOut: 'wall_clock' });
    }
    if (elapsed >= s.hardCapMs) return this.finish({ timedOut: 'hard_cap' });
  }
  async finish(result) {
    const s = this.s;
    s.result = result;
    s.phase = 'done';
    s.doneMs = Date.now() - s.t0;
    await this.save();
    try { if (this.ctx.container.running) await this.ctx.container.destroy(); } catch (error) { s.notes.push('destroy: ' + errorText(error).slice(0, 200)); }
  }
  async alarm() {
    try { await this.poll(); } catch (error) { if (this.s) { this.s.notes.push('poll: ' + errorText(error).slice(0, 200)); await this.save(); } }
    if (this.s && this.s.phase !== 'done') await this.ctx.storage.setAlarm(Date.now() + LIMITS.pollMs);
  }
  async report() {
    return this.s;
  }
  async stop() {
    if (this.s && this.s.phase !== 'done') await this.finish({ infra: 'stopped by the spike script' });
    else { try { if (this.ctx.container.running) await this.ctx.container.destroy(); } catch {} }
    return { stopped: true };
  }
}

export default {
  async fetch(request, env) {
    if (request.headers.get('x-spike-key') !== env.SPIKE_KEY) return new Response('forbidden', { status: 403 });
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    const name = url.searchParams.get('name') || '';
    if (!name) return new Response('name required', { status: 400 });
    const stub = env.SCAN.getByName(name);
    try {
      if (url.pathname === '/begin' && request.method === 'POST') {
        const tar = new Uint8Array(await request.arrayBuffer());
        return Response.json(await stub.begin({ name, model: url.searchParams.get('model'), wallClockMs: Number(url.searchParams.get('wall')), hardCapMs: Number(url.searchParams.get('hard')), tar }));
      }
      if (url.pathname === '/state') return Response.json(await stub.report());
      if (url.pathname === '/stop') return Response.json(await stub.stop());
    } catch (error) {
      return Response.json({ error: errorText(error) }, { status: 500 });
    }
    return new Response('not found', { status: 404 });
  },
};
`;

export function harnessSource(runnerSource: string): string {
  const values: Record<string, string> = {
    __RUNNER_SOURCE__: JSON.stringify(runnerSource),
    __LIMITS__: JSON.stringify(LIMITS),
    __SETUP_SCRIPT__: JSON.stringify(SETUP_SCRIPT),
    __READ_SCRIPT__: JSON.stringify(READ_SCRIPT),
  };
  let source = HARNESS_SOURCE;
  for (const [marker, value] of Object.entries(values)) {
    const at = source.indexOf(marker);
    source = source.slice(0, at) + value + source.slice(at + marker.length);
  }
  return source;
}

export type Harness = { url: string; key: string; worker: string };

export async function deployHarness(env: SpikeEnv, worker: string): Promise<Harness> {
  const key = `vssk_${crypto.randomUUID().replaceAll('-', '')}`;
  const deployed = await deploySpikeWorker(
    env,
    worker,
    harnessSource(ensureRunner()),
    {
      ai: { binding: 'AI' },
      durable_objects: {
        bindings: [
          { name: 'SCAN', class_name: 'ScanController' },
          { name: 'RATE', class_name: 'RateGuard' },
        ],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['ScanController', 'RateGuard'] }],
      containers: [
        {
          class_name: 'ScanController',
          name: `${worker}-app`,
          scheduling_policy: 'durable_object',
        },
      ],
    },
    { SPIKE_KEY: key },
  );
  await waitForWorker(deployed.url, key);
  return { url: deployed.url, key, worker };
}

// ---------- one scan ----------

type CallLog = {
  ok: boolean;
  status: number;
  ms: number;
  waitMs: number;
  at: number;
  in?: number;
  out?: number;
  cached?: number;
  finish?: string | null;
  tools?: Array<string>;
  error?: string;
};

type ScanState = {
  phase: string;
  t0: number;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cachedIn: number;
  rateWaitMs: number;
  modelMs: number;
  readyMs?: number;
  runStartMs?: number;
  doneMs?: number;
  log: Array<CallLog>;
  stops: Array<string>;
  notes: Array<string>;
  result?: {
    status?: RunnerStatus;
    findingsText?: string | null;
    infra?: string;
    timedOut?: string;
  };
};

type RunnerStatus = {
  status: string;
  reason: string | null;
  error_class: string | null;
  message: string | null;
  sessions: Array<{ phase: string; index: number; outcome: string; turns: number }>;
  model_calls: number;
  tokens_in: number;
  tokens_out: number;
  findings: { confirmed: number; needs_validation: number; rejected: number };
  started_at: string;
  finished_at: string;
};

export type Finding = {
  fingerprint: string;
  verdict: 'confirmed' | 'needs_validation' | 'rejected';
  severity: string | null;
  title: string;
  category: string;
  cwe: string | null;
  file: string;
  sink_path: string | null;
  trace: Array<{ file: string; line: number | null; note: string }>;
};

export type ScanRun = {
  app: string;
  model: SecurityModelId;
  run: number;
  ok: boolean;
  status: string;
  reason: string | null;
  errorClass: string | null;
  message: string | null;
  validOutput: boolean;
  sessions: RunnerStatus['sessions'];
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cachedIn: number;
  costUsd: number;
  costUsdCached: number;
  wallMs: number;
  activeMs: number;
  rateWaitMs: number;
  modelMs: number;
  readyMs: number | null;
  stops: Array<string>;
  failedCalls: Array<CallLog>;
  notes: Array<string>;
  findings: Array<Finding>;
};

const CACHED_INPUT_USD_PER_MILLION: Partial<Record<SecurityModelId, number>> = {
  // Workers AI catalog (ai/models/search), 2026-11-18. The meter uses list in/out only.
  '@cf/zai-org/glm-5.3': 0.26,
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017': 0.006,
};

export function scanCost(model: SecurityModelId, tokensIn: number, tokensOut: number, cached = 0) {
  const price = getSecurityModel(model).price;
  if (!price) {
    return { list: Number.NaN, cached: Number.NaN };
  }
  const list = (tokensIn * price.inputUsdPerMillion + tokensOut * price.outputUsdPerMillion) / 1e6;
  const cachedPrice = CACHED_INPUT_USD_PER_MILLION[model] ?? price.inputUsdPerMillion;
  const withCache =
    ((tokensIn - cached) * price.inputUsdPerMillion +
      cached * cachedPrice +
      tokensOut * price.outputUsdPerMillion) /
    1e6;
  return { list, cached: withCache };
}

/** The most one scan can cost under the caps (for the spend guard). */
export function maxScanCost(model: SecurityModelId): number {
  return scanCost(model, LIMITS.maxInputTokens + 120_000, LIMITS.maxOutputTokens + 16_384).list;
}

async function harnessFetch(harness: Harness, path: string, init: RequestInit = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${harness.url}${path}`, {
        ...init,
        headers: { 'x-spike-key': harness.key, ...init.headers },
        signal: AbortSignal.timeout(300_000),
      });
      const text = await response.text();
      // A fresh workers.dev route answers 404 for a while; the Worker never does on these paths.
      if ((response.status === 404 || response.status >= 520) && attempt < 10) {
        await sleep(3_000);
        continue;
      }
      return { status: response.status, text };
    } catch (error) {
      if (attempt >= 5) {
        throw error;
      }
      await sleep(5_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseFindings(text: string | null | undefined): Array<Finding> {
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as { findings?: Array<Finding> };
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch {
    return [];
  }
}

export async function runLiveScan(
  harness: Harness,
  input: ScanInput,
  app: string,
  model: SecurityModelId,
  run: number,
  log: (line: string) => void,
): Promise<ScanRun> {
  const name = `${app}-${model.split('/').pop()}-${run}-${Date.now()}`;
  const tar = scanTar(input, `spike-${name}`, model);
  const started = Date.now();
  const begin = await harnessFetch(
    harness,
    `/begin?name=${encodeURIComponent(name)}&model=${encodeURIComponent(model)}&wall=${LIMITS.wallClockMs}&hard=${LIMITS.hardCapMs}`,
    { method: 'POST', body: new Uint8Array(tar) },
  );
  log(`${name}: begin ${begin.status} ${begin.text.slice(0, 300)}`);
  let state: ScanState | null = null;
  let lastLine = '';
  while (Date.now() - started < LIMITS.hardCapMs + 10 * 60_000) {
    await sleep(20_000);
    try {
      const response = await harnessFetch(harness, `/state?name=${encodeURIComponent(name)}`);
      if (response.status !== 200) {
        log(`${name}: state ${response.status} ${response.text.slice(0, 200)}`);
        continue;
      }
      state = JSON.parse(response.text) as ScanState;
    } catch (error) {
      log(`${name}: state error ${String(error)}`);
      continue;
    }
    if (!state) {
      break;
    }
    const line = `${name}: ${state.phase} calls=${state.calls} in=${state.tokensIn} out=${state.tokensOut} wait=${Math.round(state.rateWaitMs / 1000)}s`;
    if (line !== lastLine) {
      log(line);
      lastLine = line;
    }
    if (state.phase === 'done') {
      break;
    }
  }
  if (!state || state.phase !== 'done') {
    await harnessFetch(harness, `/stop?name=${encodeURIComponent(name)}`).catch(() => undefined);
  }
  const status = state?.result?.status;
  const cost = scanCost(model, state?.tokensIn ?? 0, state?.tokensOut ?? 0, state?.cachedIn ?? 0);
  const wallMs = state?.doneMs ?? Date.now() - started;
  const runStatus = status?.status ?? (state?.result?.timedOut ? 'timed_out' : 'failed');
  return {
    app,
    model,
    run,
    ok: Boolean(status),
    status: runStatus,
    reason: status ? status.reason : (state?.result?.timedOut ?? 'infrastructure'),
    errorClass: status?.error_class ?? null,
    message: status?.message ?? state?.result?.infra ?? null,
    validOutput: status !== undefined && status.reason !== 'bad_output',
    sessions: status?.sessions ?? [],
    calls: state?.calls ?? 0,
    tokensIn: state?.tokensIn ?? 0,
    tokensOut: state?.tokensOut ?? 0,
    cachedIn: state?.cachedIn ?? 0,
    costUsd: round(cost.list, 4),
    costUsdCached: round(cost.cached, 4),
    wallMs,
    activeMs: wallMs - (state?.rateWaitMs ?? 0),
    rateWaitMs: state?.rateWaitMs ?? 0,
    modelMs: state?.modelMs ?? 0,
    readyMs: state?.readyMs ?? null,
    stops: state?.stops ?? [],
    failedCalls: (state?.log ?? []).filter((entry) => !entry.ok),
    notes: state?.notes ?? [],
    findings: parseFindings(state?.result?.findingsText),
  };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

// ---------- local harness check (fake model, runner on this machine) ----------

/** Runs the real runner bundle locally against a scripted model that "finds" the planted bugs. */
export async function runLocalScan(input: ScanInput, fixture: Fixture): Promise<ScanRun> {
  ensureRunner();
  const reply = (toolCalls: Array<{ name: string; args: unknown }>) => ({
    json: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: toolCalls.map((call, index) => ({
              id: `call_${index}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    },
  });
  const record = (bug: PlantedBug, verdict: string) => ({
    fingerprint: bug.id,
    verdict,
    severity: verdict === 'confirmed' ? bug.severity : null,
    confidence: 'medium',
    title: `${bug.class} in ${bug.file}`,
    category: bug.class,
    cwe: bug.cwe[0],
    file: bug.file,
    line_start: null,
    line_end: null,
    sink_path: bug.file,
    outside_diff: false,
    trace: [{ file: bug.file, line: null, note: 'fake' }],
    evidence: 'fake',
    conditions: '',
    fix: 'fake',
    reason: '',
  });
  const model = await startFakeModel((request) => {
    const body = request.body as { messages: Array<{ role: string; content: string | null }> };
    const prompt = body.messages[1]?.content ?? '';
    const turns = body.messages.filter((message) => message.role === 'assistant').length;
    if (turns === 0) {
      return reply([{ name: 'list_files', args: { recursive: true } }]);
    }
    if (prompt.startsWith('Verify phase')) {
      const bug = fixture.planted.find((entry) => prompt.includes(`"fingerprint": "${entry.id}"`));
      return reply([
        {
          name: 'submit_findings',
          args: { run_status: 'complete', findings: bug ? [record(bug, 'confirmed')] : [] },
        },
      ]);
    }
    return reply([
      {
        name: 'submit_findings',
        args: {
          run_status: 'complete',
          findings: fixture.planted.map((bug) => record(bug, 'needs_validation')),
        },
      },
    ]);
  });
  const root = mkdtempSync(join(tmpdir(), 'void-spike-s4-'));
  const started = Date.now();
  try {
    const child = spawn(
      process.execPath,
      [RUNNER_BUNDLE, '--stdin-tar', '--root', root, '--model-base-url', model.url],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdin.end(scanTar(input, `local-${fixture.name}`, DEFAULT_SECURITY_MODEL));
    const code = await new Promise<number | null>((done) => child.on('close', done));
    const statusPath = join(root, 'out/status.json');
    const status = existsSync(statusPath)
      ? (JSON.parse(readFileSync(statusPath, 'utf8')) as RunnerStatus)
      : undefined;
    const findingsPath = join(root, 'out/findings.json');
    const wallMs = Date.now() - started;
    return {
      app: fixture.name,
      model: DEFAULT_SECURITY_MODEL,
      run: 0,
      ok: code === 0 && status !== undefined,
      status: status?.status ?? 'failed',
      reason: status?.reason ?? 'infrastructure',
      errorClass: status?.error_class ?? null,
      message: status?.message ?? null,
      validOutput: status !== undefined && status.reason !== 'bad_output',
      sessions: status?.sessions ?? [],
      calls: model.requests.length,
      tokensIn: status?.tokens_in ?? 0,
      tokensOut: status?.tokens_out ?? 0,
      cachedIn: 0,
      costUsd: 0,
      costUsdCached: 0,
      wallMs,
      activeMs: wallMs,
      rateWaitMs: 0,
      modelMs: 0,
      readyMs: null,
      stops: [],
      failedCalls: [],
      notes: [],
      findings: parseFindings(existsSync(findingsPath) ? readFileSync(findingsPath, 'utf8') : null),
    };
  } finally {
    await model.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------- scoring ----------

function normPath(path: string | null | undefined): string {
  let value = path ?? '';
  for (const prefix of ['/scan/input/', 'scan/input/', './']) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
    }
  }
  return value;
}

function filesOf(finding: Finding): Set<string> {
  return new Set(
    [finding.file, finding.sink_path, ...(finding.trace ?? []).map((step) => step.file)]
      .map(normPath)
      .filter((path) => path.length > 0),
  );
}

function matchesBug(finding: Finding, bug: PlantedBug): boolean {
  const files = filesOf(finding);
  if (![bug.file, ...(bug.alsoFiles ?? [])].some((file) => files.has(file))) {
    return false;
  }
  if (finding.cwe && bug.cwe.includes(finding.cwe.toUpperCase())) {
    return true;
  }
  const text = `${finding.title} ${finding.category} ${finding.fingerprint}`.toLowerCase();
  return bug.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

export type BugResult = {
  id: string;
  app: string;
  verdict: 'confirmed' | 'needs_validation' | 'missed';
  severity: string | null;
  title: string | null;
};

export type ScanScore = {
  bugs: Array<BugResult>;
  /** Unplanted critical/high confirmed findings in changed or decoy files (the S4 bar). */
  falseConfirmed: Array<{ title: string; file: string; severity: string | null; where: string }>;
  /** Unplanted medium/low/informational confirmed findings there: listed, not counted. */
  otherConfirmed: Array<{ title: string; file: string; severity: string | null; where: string }>;
  baseCodeConfirmed: Array<{ title: string; file: string; severity: string | null }>;
};

export function scoreScan(run: ScanRun, fixture: Fixture, input: ScanInput): ScanScore {
  const used = new Set<Finding>();
  const bugs: Array<BugResult> = fixture.planted.map((bug) => {
    const matches = run.findings.filter(
      (finding) => finding.verdict !== 'rejected' && matchesBug(finding, bug),
    );
    for (const finding of matches) {
      used.add(finding);
    }
    const best =
      matches.find((finding) => finding.verdict === 'confirmed') ??
      matches.find((finding) => finding.verdict === 'needs_validation');
    return {
      id: bug.id,
      app: fixture.name,
      verdict: best ? (best.verdict === 'confirmed' ? 'confirmed' : 'needs_validation') : 'missed',
      severity: best?.severity ?? null,
      title: best?.title ?? null,
    };
  });
  const overlay = new Set(
    walkFiles(join(FIXTURES, fixture.name, 'files')).map((file) =>
      toPosix(relative(join(FIXTURES, fixture.name, 'files'), file)),
    ),
  );
  const decoys = new Set(fixture.decoys.map((decoy) => decoy.file));
  const changed = new Set(input.changedFiles);
  const falseConfirmed: ScanScore['falseConfirmed'] = [];
  const otherConfirmed: ScanScore['otherConfirmed'] = [];
  const baseCodeConfirmed: ScanScore['baseCodeConfirmed'] = [];
  for (const finding of run.findings) {
    if (finding.verdict !== 'confirmed' || used.has(finding)) {
      continue;
    }
    const file = normPath(finding.file);
    const entry = { title: finding.title, file, severity: finding.severity };
    const urgent = finding.severity === 'critical' || finding.severity === 'high';
    const list = urgent ? falseConfirmed : otherConfirmed;
    if (decoys.has(file)) {
      list.push({ ...entry, where: 'decoy' });
    } else if (overlay.has(file) || changed.has(file)) {
      list.push({ ...entry, where: 'changed' });
    } else {
      baseCodeConfirmed.push(entry);
    }
  }
  return { bugs, falseConfirmed, otherConfirmed, baseCodeConfirmed };
}

// ---------- summary ----------

export function summarize(runs: Array<ScanRun & { score?: ScanScore }>) {
  const scans = runs.length;
  const valid = runs.filter((run) => run.validOutput).length;
  const costs = runs.map((run) => run.costUsd);
  const wall = runs.map((run) => run.wallMs);
  const active = runs.map((run) => run.activeMs);
  const calls = runs.map((run) => run.calls);
  const median = (values: Array<number>) => (values.length ? percentile(values, 50) : null);
  const p95 = (values: Array<number>) => (values.length ? percentile(values, 95) : null);
  const minutes = (value: number | null) => (value === null ? null : round(value / 60_000, 2));
  return {
    scans,
    validRuns: valid,
    validRate: scans ? round(valid / scans, 3) : null,
    statuses: Object.fromEntries(
      [...new Set(runs.map((run) => `${run.status}${run.reason ? `/${run.reason}` : ''}`))].map(
        (key) => [
          key,
          runs.filter((run) => `${run.status}${run.reason ? `/${run.reason}` : ''}` === key).length,
        ],
      ),
    ),
    calls: {
      median: median(calls),
      p95: p95(calls),
      max: calls.length ? Math.max(...calls) : null,
    },
    tokensIn: {
      median: median(runs.map((run) => run.tokensIn)),
      max: Math.max(0, ...runs.map((run) => run.tokensIn)),
    },
    tokensOut: {
      median: median(runs.map((run) => run.tokensOut)),
      max: Math.max(0, ...runs.map((run) => run.tokensOut)),
    },
    costUsd: {
      total: round(
        costs.reduce((a, b) => a + b, 0),
        4,
      ),
      median: median(costs),
      p95: p95(costs),
      max: costs.length ? Math.max(...costs) : null,
    },
    costUsdWithCacheDiscount: round(
      runs.reduce((sum, run) => sum + run.costUsdCached, 0),
      4,
    ),
    wallMinutes: {
      median: minutes(median(wall)),
      p95: minutes(p95(wall)),
      max: minutes(wall.length ? Math.max(...wall) : null),
    },
    activeMinutes: { median: minutes(median(active)), p95: minutes(p95(active)) },
    rateWaitMinutesTotal: minutes(runs.reduce((sum, run) => sum + run.rateWaitMs, 0)),
  };
}

// ---------- main ----------

async function main() {
  const { values } = parseArgs({
    options: {
      local: { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
      models: { type: 'string', default: SPIKE_MODELS.join(',') },
      apps: { type: 'string', default: 'all' },
      runs: { type: 'string', default: '1' },
      concurrency: { type: 'string', default: '2' },
      'budget-usd': { type: 'string', default: '10' },
      out: { type: 'string' },
      keep: { type: 'boolean', default: false },
    },
  });
  if (values.local === values.live) {
    throw new Error('Pass exactly one of --local or --live.');
  }
  const models = values.models.split(',').map((id) => {
    if (!isSecurityModelId(id)) {
      throw new Error(`Unknown model ${id}`);
    }
    return id;
  });
  const appNames = values.apps === 'all' ? listFixtures() : values.apps.split(',');
  const fixtures = appNames.map(loadFixture);
  const runs = Number(values.runs);
  const budget = Number(values['budget-usd']);
  const log = (line: string) =>
    console.error(`[s4 ${new Date().toISOString().slice(11, 19)}] ${line}`);

  const inputs = new Map<string, ScanInput>();
  for (const fixture of fixtures) {
    const input = fixtureInput(fixture);
    inputs.set(fixture.name, input);
    log(
      `${fixture.name}: ${input.files.size} files, ${input.changedFiles.length} changed, ${input.diffLines} diff lines (${input.sourceDiffLines} source), ${input.inputBytes} bytes`,
    );
  }
  const report: Record<string, unknown> = {
    spike: 'S4',
    mode: values.local ? 'local' : 'live',
    limits: LIMITS,
    apps: fixtures.map((fixture) => {
      const input = inputs.get(fixture.name)!;
      return {
        name: fixture.name,
        base: fixture.base,
        kind: fixture.kind,
        planted: fixture.planted.map((bug) => bug.id),
        files: input.files.size,
        changedFiles: input.changedFiles,
        diffLines: input.diffLines,
        sourceDiffLines: input.sourceDiffLines,
        inputBytes: input.inputBytes,
        notes: input.notes,
      };
    }),
  };
  const results: Array<ScanRun & { score: ScanScore }> = [];
  const failures: Array<string> = [];

  if (values.local) {
    for (const fixture of fixtures) {
      const input = inputs.get(fixture.name)!;
      const run = await runLocalScan(input, fixture);
      results.push({ ...run, score: scoreScan(run, fixture, input) });
    }
    const missed = results.flatMap((run) =>
      run.score.bugs.filter((bug) => bug.verdict !== 'confirmed'),
    );
    if (results.some((run) => run.status !== 'succeeded') || missed.length > 0) {
      failures.push(
        `local harness: ${JSON.stringify(results.map((run) => [run.app, run.status, run.reason, run.message]))} missed ${JSON.stringify(missed)}`,
      );
    }
    report.local = results.map((run) => ({
      app: run.app,
      status: run.status,
      calls: run.calls,
      bugs: run.score.bugs,
    }));
    report.failures = failures;
    console.log(JSON.stringify(report, null, 2));
    console.log(failures.length ? 'S4 local FAIL' : 'S4 local PASS');
    process.exitCode = failures.length ? 1 : 0;
    return;
  }

  const env = spikeEnv();
  const worker = `${SPIKE_PREFIX}s4`;
  let spent = 0;
  let reserved = 0;
  try {
    report.baseline = await listSpikeResources(env);
    log(`deploying ${worker}`);
    const harness = await deployHarness(env, worker);
    log(`harness at ${harness.url}`);
    const pipelines = models.map(async (model) => {
      const queue = fixtures.flatMap((fixture) =>
        Array.from({ length: runs }, (_, run) => ({ fixture, run })),
      );
      const worker = async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) {
            return;
          }
          const reserve = maxScanCost(model);
          if (spent + reserved + reserve > budget) {
            log(
              `skip ${next.fixture.name} on ${model}: budget ($${round(spent, 2)} spent, $${round(reserved, 2)} running)`,
            );
            continue;
          }
          reserved += reserve;
          const input = inputs.get(next.fixture.name)!;
          try {
            const run = await runLiveScan(harness, input, next.fixture.name, model, next.run, log);
            spent += run.costUsd;
            const score = scoreScan(run, next.fixture, input);
            results.push({ ...run, score });
            log(
              `${next.fixture.name} ${model}: ${run.status}/${run.reason} calls=${run.calls} $${run.costUsd} ${round(run.wallMs / 60_000, 1)} min bugs=${JSON.stringify(score.bugs.map((bug) => [bug.id, bug.verdict]))} fp=${score.falseConfirmed.length}`,
            );
          } finally {
            reserved -= reserve;
          }
        }
      };
      await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
    });
    await Promise.all(pipelines);
  } catch (error) {
    failures.push(String(error instanceof Error ? error.stack : error));
  } finally {
    if (!values.keep) {
      env.token = freshToken();
      report.cleanup = await deleteSpikeResources(env, [worker]);
      const after = (
        report.cleanup as { after: { workers: Array<string>; containerApps: Array<unknown> } }
      ).after;
      if (after.workers.length || after.containerApps.length) {
        failures.push(`leftover spike resources: ${JSON.stringify(after)}`);
      }
    }
  }

  const perModel: Record<string, unknown> = {};
  const verdicts: Array<string> = [];
  for (const model of models) {
    const runsFor = results.filter((run) => run.model === model);
    const seeded = runsFor.filter((run) => loadFixture(run.app).kind === 'seeded');
    const bugs = seeded.flatMap((run) => run.score.bugs);
    const found = bugs.filter((bug) => bug.verdict !== 'missed').length;
    const confirmed = bugs.filter((bug) => bug.verdict === 'confirmed').length;
    const falseConfirmed = runsFor.flatMap((run) =>
      run.score.falseConfirmed.map((entry) => ({ app: run.app, ...entry })),
    );
    const summary = summarize(runsFor);
    const planted = bugs.length;
    const recall = planted ? found / planted : 0;
    const p95Wall = summary.wallMinutes.p95 ?? Number.POSITIVE_INFINITY;
    const checks = {
      recall: `${found}/${planted} found (${confirmed} confirmed) >= 70%: ${recall >= 0.7}`,
      falseConfirmed: `${falseConfirmed.length} <= ${2 * Math.max(1, runs)}: ${falseConfirmed.length <= 2 * Math.max(1, runs)}`,
      validRuns: `${summary.validRuns}/${summary.scans} >= 95%: ${(summary.validRate ?? 0) >= 0.95}`,
      calls: `max ${summary.calls.max} <= 80: ${(summary.calls.max ?? 0) <= 80}`,
      p95Wall: `${p95Wall} min < 20: ${p95Wall < 20}`,
    };
    const pass =
      planted > 0 &&
      recall >= 0.7 &&
      falseConfirmed.length <= 2 * Math.max(1, runs) &&
      (summary.validRate ?? 0) >= 0.95 &&
      (summary.calls.max ?? 0) <= 80 &&
      p95Wall < 20;
    perModel[model] = {
      ...summary,
      planted,
      found,
      confirmed,
      checks,
      pass,
      bugs: bugs.map(
        (bug) => `${bug.app}/${bug.id}: ${bug.verdict}${bug.severity ? ` (${bug.severity})` : ''}`,
      ),
      falseConfirmed,
      otherConfirmed: runsFor.flatMap((run) =>
        run.score.otherConfirmed.map((entry) => ({ app: run.app, ...entry })),
      ),
      baseCodeConfirmed: runsFor.flatMap((run) =>
        run.score.baseCodeConfirmed.map((entry) => ({ app: run.app, ...entry })),
      ),
      leads: runsFor.reduce(
        (sum, run) =>
          sum + run.findings.filter((finding) => finding.verdict === 'needs_validation').length,
        0,
      ),
    };
    verdicts.push(`S4 ${model}: ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass && model === DEFAULT_SECURITY_MODEL) {
      failures.push(`default model ${model} misses the S4 bar: ${JSON.stringify(checks)}`);
    }
  }
  report.models = perModel;
  report.runs = results.map(({ findings, ...run }) => ({
    ...run,
    findings: findings.map((finding) => ({
      verdict: finding.verdict,
      severity: finding.severity,
      title: finding.title,
      file: finding.file,
      cwe: finding.cwe,
    })),
  }));
  report.spentUsd = round(spent, 4);
  report.failures = failures;
  const text = JSON.stringify(report, null, 2);
  if (values.out) {
    writeFileSync(values.out, text);
  }
  console.log(text);
  for (const line of verdicts) {
    console.log(line);
  }
  console.log(failures.length ? 'S4 FAIL' : 'S4 PASS');
  process.exitCode = failures.length ? 1 : 0;
}

if (import.meta.main) {
  await main();
}
