// The security scanner controller Worker (design doc 0095, spec §15). The API uploads
// this fixed bundle once per installation; it holds no token, no database URL and no
// project data. One `ScannerController` Durable Object runs one scan attempt (or one
// probe self-test) in its own container and is never reused.
//
//   API ──DISPATCH gate──► ScannerService.fetch ──► ScannerController (scan:<id>:<attempt>)
//                                                     │ intercept model.void.internal → ScanModelOutbound
//                                                     │ intercept copy.void.internal  → CopyOutbound (M30)
//                                                     │ intercept all HTTP / all HTTPS → DenyAll
//                                                     │ start({ enableInternet: false, env: {} })
//                                                     │ every exec: env = { PATH, HOME } only
//                                                     │ stdin: control.input(...) tar ──► runner (user scanner)
//                                                     ▼ alarm: heartbeat, poll /scan/out/status.json
//   API ◄──── SecurityScanControl (service binding, props = installation identity) ────┘
//
// Engines (M13b): `ScannerController` runs Engine B on the managed image and streams the
// runner in. `ScannerControllerEngineA` / `ScannerControllerEngineC` run the Engine A / C
// image (copied by digest into the account registry; `images.default` of their container
// app), which already holds the runner, the SDK and the MCP server. One container app per
// class. An engine whose image is not in `__VOID_SECURITY_SCANNER_IMAGES` is refused.
//
// Runtime copy (M30, spike S13): once the runner runs, the controller asks the API for
// this attempt's copy (`control.copy`). `CopyOutbound` dispatches the container's
// requests to that copy only; the copy namespace's outbound Worker blocks the copy's own
// fetches. The copy name comes from the attempt, never from the container.
//
// Spike S1 facts this file relies on: the hostname intercept is registered before the
// catch-all (else the catch-all wins); HTTPS needs its own `interceptOutboundHttps('*')`
// deny, else a TLS client hangs ~8 s; scan code starts through stdin and a short argv;
// nothing reads /run/cloudchamber.

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
/// <reference path="./security-scanner-controller-modules.d.ts" />
import runnerSource from 'void:security-scanner-runner-source';
import { COPY_HEADER, COPY_HOST, runtimeCopyScriptName } from './security/runtime-copy-names.ts';

/** The only host the container may call. The runner's base URL points here. */
export const MODEL_HOST = 'model.void.internal';
export const MANAGED_IMAGE = 'cloudflare/debian-trixie';
export const SCANNER_USER = 'scanner';
export const RUNNER_PATH = '/opt/void-scanner/runner.mjs';
export const STATUS_PATH = '/scan/out/status.json';
export const FINDINGS_PATH = '/scan/out/findings.json';
/** The runner refuses a report above 5 MiB; one more byte tells the API it was cut. */
export const FINDINGS_READ_LIMIT = 5 * 1024 * 1024 + 1;
export const POLL_MS = 10_000;
/** After SIGTERM at the wall clock, the runner has this long to write `timed_out`. */
export const STOP_GRACE_MS = 60_000;
export const READY_TIMEOUT_MS = 120_000;
/**
 * A probe waits less for the container, so the controller's whole self-test
 * (ready + setup + run, at most 210 s) ends before the API stops waiting (240 s).
 */
export const PROBE_READY_TIMEOUT_MS = 90_000;
export const SETUP_TIMEOUT_MS = 30_000;
export const SELF_TEST_RUN_TIMEOUT_MS = 90_000;
/** Reading one result file, or sending SIGTERM, never holds an alarm longer than this. */
export const READ_TIMEOUT_MS = 30_000;
/**
 * The whole env of every command the controller runs in the container: enough to find
 * `node` and a home, nothing else. No token, URL or project data.
 */
export const EXEC_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: '/scan',
});
/** A probe container is destroyed by this alarm even when the request was dropped. */
export const PROBE_CLEANUP_MS = 10 * 60_000;
const SCAN_INSTANCE = 'standard-1';
const PROBE_INSTANCE = 'lite';
const CONTROL_TIMEOUT_MS = 30_000;
/** The API reads the deployment, past findings and secrets to build the input tar. */
export const INPUT_TIMEOUT_MS = 120_000;
/** Making the runtime copy (stores, schema, upload; S13: about 10 s). */
export const COPY_TIMEOUT_MS = 120_000;
/** One container request to the copy, at most. */
export const COPY_REQUEST_TIMEOUT_MS = 30_000;
const STATE_KEY = 'state';

export type ScanFence =
  | Readonly<{ ok: true; leaseUntil: string }>
  | Readonly<{ ok: false; reason: 'stale' | 'canceled' | 'unavailable' }>;

export type ScanResultReport = Readonly<{
  /** `status.json` as the runner wrote it, or a status the controller set. */
  status: unknown;
  /** `findings.json` text (at most `FINDINGS_READ_LIMIT` bytes), or null. */
  findings: string | null;
}>;

/** `SecurityScanControl` in the API Worker, reached through the service binding. */
export type SecurityScanControlRpc = {
  heartbeat(scanId: string, attempt: number): Promise<ScanFence>;
  input(scanId: string, attempt: number): Promise<ReadableStream<Uint8Array> | null>;
  model(scanId: string, attempt: number, request: Request): Promise<Response>;
  result(scanId: string, attempt: number, report: ScanResultReport): Promise<{ ok: boolean }>;
  /** M30: makes this attempt's runtime copy. An older API has no such method. */
  copy?(
    scanId: string,
    attempt: number,
  ): Promise<{ ok: true; script: string; ms: number } | { ok: false; reason: string }>;
};

/** The copy namespace binding (M30). */
export type CopyNamespace = {
  get(
    name: string,
    args?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): { fetch(request: Request): Promise<Response> };
};

export type ControllerEnv = {
  SCANNER: DurableObjectNamespace<ScannerController>;
  SCANNER_ENGINE_A?: DurableObjectNamespace<ScannerController>;
  SCANNER_ENGINE_C?: DurableObjectNamespace<ScannerController>;
  /** JSON `{engine: image ref}` of the engine images that are ready. */
  __VOID_SECURITY_SCANNER_IMAGES?: string;
  __VOID_SECURITY_SCAN_CONTROL: SecurityScanControlRpc;
  /** M30: this installation's runtime copies, and their name prefix. */
  __VOID_SECURITY_COPIES?: CopyNamespace;
  __VOID_SECURITY_COPY_PREFIX?: string;
};

/** The engines this controller knows, and the class that runs each. */
export type ScannerEngine = 'void_loop' | 'agent_sdk' | 'codex_sdk';

/** The engine images the API uploaded this controller with (bad data means none). */
export function readyImageEngines(env: Pick<ControllerEnv, '__VOID_SECURITY_SCANNER_IMAGES'>) {
  const ready = new Set<ScannerEngine>();
  try {
    const value = JSON.parse(env.__VOID_SECURITY_SCANNER_IMAGES ?? '{}') as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const engine of ['agent_sdk', 'codex_sdk'] as const) {
        const ref = (value as Record<string, unknown>)[engine];
        if (typeof ref === 'string' && ref.length > 0) {
          ready.add(engine);
        }
      }
    }
  } catch {
    // Unreadable: no image engine runs.
  }
  return ready;
}

/** The Durable Object namespace that runs `engine`, or null when it cannot run here. */
export function scannerNamespace(
  env: ControllerEnv,
  engine: unknown,
): DurableObjectNamespace<ScannerController> | null {
  if (engine === 'void_loop') {
    return env.SCANNER;
  }
  if (engine !== 'agent_sdk' && engine !== 'codex_sdk') {
    return null;
  }
  if (!readyImageEngines(env).has(engine)) {
    return null;
  }
  return (engine === 'agent_sdk' ? env.SCANNER_ENGINE_A : env.SCANNER_ENGINE_C) ?? null;
}

export type StartScanRequest = Readonly<{
  scanId: string;
  attempt: number;
  engine: string;
  wallClockMs: number;
  hardCapMs: number;
}>;

export type StartResult = Readonly<{ ok: true } | { ok: false; reason: string }>;

export type SelfTestResult = Readonly<{
  started: boolean;
  coldStartMs: number | null;
  /** The JSON line `runner.mjs --self-test` printed, as parsed. */
  report: unknown;
  error?: string;
}>;

type ScanPhase = 'starting' | 'running' | 'stopping' | 'done';
type ScanState = {
  kind: 'scan';
  scanId: string;
  attempt: number;
  engine: string;
  phase: ScanPhase;
  createdAt: number;
  wallDeadline: number;
  hardDeadline: number;
  stopDeadline?: number;
  pid?: number;
};
type ProbeState = { kind: 'probe'; probeId: string; createdAt: number };
type State = ScanState | ProbeState;

type ModelOutboundProps = { scanId: string; attempt: number } | { probeId: string };
type CopyOutboundProps = { scanId: string; attempt: number };
type ExportsLoopback = {
  ScanModelOutbound(options: { props: ModelOutboundProps }): Fetcher;
  CopyOutbound(options: { props: CopyOutboundProps }): Fetcher;
  DenyAll(options: { props: Record<string, never> }): Fetcher;
};

function isId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return false;
  }
  for (const char of value) {
    const ok =
      (char >= 'a' && char <= 'z') ||
      (char >= 'A' && char <= 'Z') ||
      (char >= '0' && char <= '9') ||
      char === '_' ||
      char === '-';
    if (!ok) {
      return false;
    }
  }
  return true;
}

function isAttempt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isDuration(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 6 * 3_600_000
  );
}

/** One container instance per scan attempt and per probe: never shared, never reused (edge #42). */
export function scanInstanceName(scanId: string, attempt: number): string {
  return `scan:${scanId}:${attempt}`;
}

export function probeInstanceName(probeId: string): string {
  return `probe:${probeId}`;
}

async function bounded<T>(operation: Promise<T>, ms = CONTROL_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('security scan control timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const decoder = new TextDecoder();

// Runs as root in an engine image (A/C) before the scan: the image already has the
// `scanner` user and the runner; this only makes /scan an empty folder that user owns.
// Exit 2: the image is not a scanner image.
const IMAGE_SETUP_SCRIPT = [
  'const fs=require("node:fs"),cp=require("node:child_process");',
  `const user=${JSON.stringify(SCANNER_USER)},runner=${JSON.stringify(RUNNER_PATH)};`,
  'try{cp.execFileSync("id",["-u",user],{stdio:"ignore"})}catch{process.exit(2)}',
  'try{if(!fs.lstatSync(runner).isFile())process.exit(2)}catch{process.exit(2)}',
  'fs.mkdirSync("/scan",{recursive:true});cp.execFileSync("chown",[user+":"+user,"/scan"]);fs.chmodSync("/scan",0o700);',
].join('');

// Runs as root before the scan: a non-root `scanner` user, an empty /scan it owns, and
// the runner bundle from stdin, read-only. Short argv; the bundle comes on stdin.
const SETUP_SCRIPT = [
  'const fs=require("node:fs"),cp=require("node:child_process");',
  `const user=${JSON.stringify(SCANNER_USER)},runner=${JSON.stringify(RUNNER_PATH)};`,
  'try{cp.execFileSync("id",["-u",user],{stdio:"ignore"})}catch{cp.execFileSync("useradd",["--system","--no-create-home","--shell","/usr/sbin/nologin",user],{stdio:"ignore"})}',
  'fs.mkdirSync("/scan",{recursive:true});cp.execFileSync("chown",[user+":"+user,"/scan"]);fs.chmodSync("/scan",0o700);',
  'fs.mkdirSync(require("node:path").dirname(runner),{recursive:true});',
  'const chunks=[];process.stdin.on("data",c=>chunks.push(c));',
  'process.stdin.on("end",()=>{const tmp=runner+".tmp";fs.writeFileSync(tmp,Buffer.concat(chunks),{mode:0o555});fs.renameSync(tmp,runner);});',
].join('');

// Reads one result file as `scanner` (never root): argv is the path and the byte limit.
// /scan/out must be a real directory and the file a regular file opened without
// following a symlink (O_NONBLOCK so a FIFO cannot block the open). Exit 0 prints the
// bytes, 1 means not there yet, 3 means refused.
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

type FileRead = Readonly<{ kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'refused' }>;

/** Model route for one scan attempt. Identity comes from props the container never sees. */
export class ScanModelOutbound extends WorkerEntrypoint<ControllerEnv, ModelOutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    if ('probeId' in props) {
      // Probe check 3: the container reaches this handler and learns an id it never had.
      if (new URL(request.url).pathname === '/v1/self-test') {
        return Response.json({ probe: props.probeId });
      }
      return new Response('not found', { status: 404 });
    }
    return this.env.__VOID_SECURITY_SCAN_CONTROL.model(props.scanId, props.attempt, request);
  }
}

function copyUnavailable(detail: string): Response {
  return new Response(`runtime copy unavailable: ${detail}`, {
    status: 503,
    headers: { [COPY_HEADER]: 'unavailable' },
  });
}

/**
 * Copy route for one scan attempt (M30): `http://copy.void.internal/<path>` goes to this
 * attempt's copy as `https://copy.void.internal/<path>`. Identity comes from the props;
 * nothing the container sends picks another copy. Every answer is marked: `dispatched`
 * (the copy answered) or `unavailable` (no copy, or it failed).
 */
export class CopyOutbound extends WorkerEntrypoint<ControllerEnv, CopyOutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const { scanId, attempt } = this.ctx.props;
    const namespace = this.env.__VOID_SECURITY_COPIES;
    const prefix = this.env.__VOID_SECURITY_COPY_PREFIX;
    if (!namespace || !prefix) {
      return copyUnavailable('this controller has no copy namespace');
    }
    const url = new URL(request.url);
    const target = new URL(`${url.pathname}${url.search}`, `https://${COPY_HOST}`);
    const headers = new Headers(request.headers);
    headers.delete(COPY_HEADER);
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(COPY_REQUEST_TIMEOUT_MS),
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }
    let response: Response;
    try {
      const copy = namespace.get(runtimeCopyScriptName(prefix, scanId, attempt));
      response = await copy.fetch(new Request(target, init));
    } catch (error) {
      return copyUnavailable(error instanceof Error ? error.message.slice(0, 200) : 'error');
    }
    const out = new Response(response.body, response);
    out.headers.set(COPY_HEADER, 'dispatched');
    return out;
  }
}

/** Every other host, HTTP or HTTPS. */
export class DenyAll extends WorkerEntrypoint<ControllerEnv> {
  fetch(request: Request): Response {
    return new Response(`egress denied: ${new URL(request.url).hostname}`, { status: 403 });
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json<unknown>();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The API's way in, through the gate script in the platform dispatch namespace.
 * No workers.dev route, no public hostname.
 */
export default class ScannerService extends WorkerEntrypoint<ControllerEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') {
      return new Response('not found', { status: 404 });
    }
    const body = await readJson(request);
    if (!body) {
      return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400 });
    }
    if (url.pathname === '/v1/scans/start') {
      const { scanId, attempt, engine, wallClockMs, hardCapMs } = body;
      if (
        !isId(scanId) ||
        !isAttempt(attempt) ||
        typeof engine !== 'string' ||
        !isDuration(wallClockMs) ||
        !isDuration(hardCapMs) ||
        hardCapMs < wallClockMs
      ) {
        return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400 });
      }
      const namespace = scannerNamespace(this.env, engine);
      if (!namespace) {
        // No container app runs this engine yet (its image is not ready).
        return Response.json({ ok: false, reason: 'engine_unavailable' });
      }
      const stub = namespace.getByName(scanInstanceName(scanId, attempt));
      return Response.json(await stub.start({ scanId, attempt, engine, wallClockMs, hardCapMs }));
    }
    if (url.pathname === '/v1/scans/cancel') {
      const { scanId, attempt, engine } = body;
      if (!isId(scanId) || !isAttempt(attempt)) {
        return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400 });
      }
      // The scheduler sends no engine; a cancel reaches every class that could hold it.
      const namespaces =
        engine === undefined
          ? [this.env.SCANNER, this.env.SCANNER_ENGINE_A, this.env.SCANNER_ENGINE_C]
          : [scannerNamespace(this.env, engine)];
      // All at once: one class that fails must not keep the cancel from the others.
      const results = await Promise.allSettled(
        namespaces.map((namespace) =>
          namespace?.getByName(scanInstanceName(scanId, attempt)).cancel(),
        ),
      );
      if (results.some((result) => result.status === 'rejected')) {
        return Response.json({ ok: false, reason: 'cancel_failed' }, { status: 500 });
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/v1/self-test') {
      const { probeId } = body;
      const engine = body.engine ?? 'void_loop';
      if (!isId(probeId)) {
        return Response.json({ ok: false, reason: 'invalid_request' }, { status: 400 });
      }
      const namespace = scannerNamespace(this.env, engine);
      if (!namespace) {
        return Response.json({
          started: false,
          coldStartMs: null,
          report: null,
          error: 'engine_unavailable',
        } satisfies SelfTestResult);
      }
      // RPC types a result holding an `unknown` report as never; the stub still returns
      // the method's promise, so call it through the class's own signature.
      const stub: Pick<ScannerController, 'selfTest'> = namespace.getByName(
        probeInstanceName(probeId),
      );
      return Response.json(await stub.selfTest(probeId));
    }
    return new Response('not found', { status: 404 });
  }
}

export class ScannerController extends DurableObject<ControllerEnv> {
  /** The engine this class runs. Engine B: the managed image, runner streamed in. */
  protected readonly engine: ScannerEngine = 'void_loop';

  private get usesManagedImage(): boolean {
    return this.engine === 'void_loop';
  }

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) {
      throw new Error('The scanner Durable Object has no container.');
    }
    return container;
  }

  private get loopback(): ExportsLoopback {
    return (this.ctx as DurableObjectState & { exports: ExportsLoopback }).exports;
  }

  private get control(): SecurityScanControlRpc {
    return this.env.__VOID_SECURITY_SCAN_CONTROL;
  }

  private async state(): Promise<State | undefined> {
    return this.ctx.storage.get<State>(STATE_KEY);
  }

  private async save(state: State): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  /**
   * Egress lock, in the order S1 proved: the model host first, then the HTTP
   * catch-all, then the HTTPS catch-all. Registered before `start`, so the container
   * never runs a moment without them.
   */
  private async lockEgress(props: ModelOutboundProps): Promise<void> {
    const container = this.container;
    await container.interceptOutboundHttp(MODEL_HOST, this.loopback.ScanModelOutbound({ props }));
    if ('scanId' in props) {
      // M30: the scan's own copy, before the catch-alls (else they win).
      await container.interceptOutboundHttp(
        COPY_HOST,
        this.loopback.CopyOutbound({ props: { scanId: props.scanId, attempt: props.attempt } }),
      );
    }
    await container.interceptAllOutboundHttp(this.loopback.DenyAll({ props: {} }));
    await container.interceptOutboundHttps('*', this.loopback.DenyAll({ props: {} }));
  }

  private startContainer(instance: typeof SCAN_INSTANCE | typeof PROBE_INSTANCE): void {
    // Engines A/C: the copied image their container app was uploaded with.
    const image = this.usesManagedImage ? MANAGED_IMAGE : this.container.images.default;
    if (!image) {
      throw new Error('The scanner engine has no image.');
    }
    this.container.start({
      image,
      entrypoint: ['sleep', 'infinity'],
      enableInternet: false,
      // Explicit and empty: the container gets no token, no URL, no project data.
      env: {},
      instance,
    });
  }

  private async waitReady(timeoutMs: number): Promise<number> {
    const started = Date.now();
    let lastError = 'not ready';
    while (Date.now() - started < timeoutMs) {
      try {
        const process = await this.container.exec(['true']);
        const output = await process.output();
        if (output.exitCode === 0) {
          return Date.now() - started;
        }
        lastError = `exit ${output.exitCode}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
    throw new Error(`The scanner container did not start: ${lastError}`);
  }

  private async installRunner(): Promise<void> {
    if (!this.usesManagedImage) {
      // The engine image ships its own runner (with its SDK); only /scan is prepared.
      const process = await this.container.exec(['node', '-e', IMAGE_SETUP_SCRIPT], {
        user: 'root',
        env: { ...EXEC_ENV },
        signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
      });
      const output = await process.output();
      if (output.exitCode !== 0) {
        throw new Error(`Scanner image setup failed (exit ${output.exitCode}).`);
      }
      return;
    }
    if (!runnerSource) {
      throw new Error('The scanner controller is missing its runner bundle.');
    }
    const process = await this.container.exec(['node', '-e', SETUP_SCRIPT], {
      env: { ...EXEC_ENV },
      stdin: new Blob([runnerSource]).stream(),
      signal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
    });
    const output = await process.output();
    if (output.exitCode !== 0) {
      throw new Error(`Scanner setup failed (exit ${output.exitCode}).`);
    }
  }

  private async destroyContainer(): Promise<void> {
    if (this.container.running) {
      await this.container.destroy();
    }
  }

  private async finish(): Promise<void> {
    await this.destroyContainer().catch((error: unknown) => {
      console.error('[security-scanner] container destroy failed', error);
    });
    const state = await this.state();
    if (state?.kind === 'scan') {
      await this.save({ ...state, phase: 'done' });
    }
    await this.ctx.storage.deleteAlarm();
  }

  /** Starts one scan attempt. A controller instance starts at most once. */
  async start(request: StartScanRequest): Promise<StartResult> {
    if (await this.state()) {
      return { ok: false, reason: 'already_started' };
    }
    if (request.engine !== this.engine) {
      // Each engine has its own class and container app.
      return { ok: false, reason: 'engine_unavailable' };
    }
    const now = Date.now();
    await this.save({
      kind: 'scan',
      scanId: request.scanId,
      attempt: request.attempt,
      engine: request.engine,
      phase: 'starting',
      createdAt: now,
      wallDeadline: now + request.wallClockMs,
      hardDeadline: now + request.hardCapMs,
    });
    // The container starts in the alarm, so this call returns at once.
    await this.ctx.storage.setAlarm(now);
    return { ok: true };
  }

  /** Stops the attempt now; nothing is reported. */
  async cancel(): Promise<void> {
    const state = await this.state();
    if (state?.kind === 'scan' && state.phase !== 'done') {
      await this.finish();
    }
  }

  /** Probe checks 2 and 3. Synchronous: the probe waits for the answer. */
  async selfTest(probeId: string): Promise<SelfTestResult> {
    if (await this.state()) {
      return { started: false, coldStartMs: null, report: null, error: 'probe id already used' };
    }
    await this.save({ kind: 'probe', probeId, createdAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + PROBE_CLEANUP_MS);
    let coldStartMs: number | null = null;
    try {
      await this.lockEgress({ probeId });
      this.startContainer(PROBE_INSTANCE);
      coldStartMs = await this.waitReady(PROBE_READY_TIMEOUT_MS);
      await this.installRunner();
      const process = await this.container.exec(['node', RUNNER_PATH, '--self-test'], {
        user: SCANNER_USER,
        cwd: '/scan',
        env: { ...EXEC_ENV },
        signal: AbortSignal.timeout(SELF_TEST_RUN_TIMEOUT_MS),
      });
      const output = await process.output();
      const text = decoder.decode(output.stdout).trim();
      let report: unknown = null;
      try {
        report = JSON.parse(text);
      } catch {
        return {
          started: true,
          coldStartMs,
          report: null,
          error: `self-test printed no report (exit ${output.exitCode})`,
        };
      }
      return { started: true, coldStartMs, report };
    } catch (error) {
      return {
        started: coldStartMs !== null,
        coldStartMs,
        report: null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await this.destroyContainer().catch(() => {});
    }
  }

  private async fence(state: ScanState): Promise<boolean> {
    try {
      const fence = await bounded(this.control.heartbeat(state.scanId, state.attempt));
      return fence.ok;
    } catch (error) {
      // The API is unreachable: keep going until the hard cap; the lease is the authority.
      console.error('[security-scanner] heartbeat failed', error);
      return true;
    }
  }

  private async report(state: ScanState, report: ScanResultReport): Promise<boolean> {
    try {
      const result = await bounded(this.control.result(state.scanId, state.attempt, report));
      return result.ok;
    } catch (error) {
      console.error('[security-scanner] result report failed', error);
      return false;
    }
  }

  /**
   * Scanned code runs as `scanner` and owns /scan, so it can put a symlink or a FIFO
   * where a result file should be. The read runs as `scanner` too, refuses anything
   * but a regular file and has a time limit.
   */
  private async readFile(path: string, limit: number): Promise<FileRead> {
    const process = await this.container.exec(['node', '-e', READ_SCRIPT, path, String(limit)], {
      user: SCANNER_USER,
      cwd: '/scan',
      env: { ...EXEC_ENV },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    const output = await process.output();
    if (output.exitCode === 0) {
      return { kind: 'ok', text: decoder.decode(output.stdout) };
    }
    return output.exitCode === 1 ? { kind: 'missing' } : { kind: 'refused' };
  }

  private async begin(state: ScanState): Promise<void> {
    if (!(await this.fence(state))) {
      // A newer attempt exists or the scan was canceled: never start a container.
      await this.finish();
      return;
    }
    await this.lockEgress({ scanId: state.scanId, attempt: state.attempt });
    this.startContainer(SCAN_INSTANCE);
    await this.waitReady(READY_TIMEOUT_MS);
    await this.installRunner();
    const input = await bounded(this.control.input(state.scanId, state.attempt), INPUT_TIMEOUT_MS);
    if (!input) {
      await this.report(state, {
        status: { status: 'failed', reason: 'infrastructure', error_class: 'input_unavailable' },
        findings: null,
      });
      await this.finish();
      return;
    }
    const process = await this.container.exec(['node', RUNNER_PATH, '--stdin-tar'], {
      user: SCANNER_USER,
      cwd: '/scan',
      env: { ...EXEC_ENV },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await this.save({ ...state, phase: 'running', pid: process.pid });
    if (!process.stdin) {
      throw new Error('The scanner runner has no stdin.');
    }
    // Wait for the whole tar: the runner keeps running after this alarm returns,
    // and later alarms only read its result files.
    await input.pipeTo(process.stdin as WritableStream<Uint8Array>);
    // The hunt takes minutes; the copy is ready long before verify needs it.
    await this.makeCopy(state);
    await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
  }

  /** Asks the API for the runtime copy. A failure only leaves the scan static-only. */
  private async makeCopy(state: ScanState): Promise<void> {
    try {
      const control = this.control;
      // An RPC stub answers every name; a plain object (an older API in tests) may not.
      if (typeof control.copy !== 'function') {
        return;
      }
      const result = await bounded(control.copy(state.scanId, state.attempt), COPY_TIMEOUT_MS);
      if (!result.ok) {
        console.log('[security-scanner] no runtime copy', { reason: result.reason });
      }
    } catch (error) {
      console.error('[security-scanner] runtime copy failed', error);
    }
  }

  private async poll(state: ScanState): Promise<void> {
    const now = Date.now();
    if (now >= state.hardDeadline) {
      await this.report(state, {
        status: { status: 'timed_out', reason: 'hard_cap' },
        findings: null,
      });
      await this.finish();
      return;
    }
    if (!this.container.running) {
      await this.report(state, {
        status: { status: 'failed', reason: 'infrastructure', error_class: 'container_exited' },
        findings: null,
      });
      await this.finish();
      return;
    }
    if (!(await this.fence(state))) {
      await this.finish();
      return;
    }
    const status = await this.readFile(STATUS_PATH, 64 * 1024);
    if (status.kind !== 'missing') {
      const unreadable = {
        status: 'failed',
        reason: 'bad_output',
        error_class: 'status_unreadable',
      };
      let parsed: unknown = unreadable;
      let findings: string | null = null;
      if (status.kind === 'ok') {
        try {
          parsed = JSON.parse(status.text);
        } catch {
          parsed = unreadable;
        }
        const read = await this.readFile(FINDINGS_PATH, FINDINGS_READ_LIMIT);
        findings = read.kind === 'ok' ? read.text : null;
      }
      if (await this.report(state, { status: parsed, findings })) {
        await this.finish();
        return;
      }
      // Keep the container (and its files) until the API takes the result or the hard cap.
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
      return;
    }
    if (
      state.phase === 'stopping' &&
      state.stopDeadline !== undefined &&
      now >= state.stopDeadline
    ) {
      await this.report(state, {
        status: { status: 'timed_out', reason: 'wall_clock' },
        findings: null,
      });
      await this.finish();
      return;
    }
    if (state.phase === 'running' && now >= state.wallDeadline) {
      // The runner ends its session and writes `timed_out (wall_clock)` on SIGTERM.
      if (state.pid !== undefined) {
        // As `scanner`: the runner is its process, and nothing else is.
        const kill = await this.container.exec(['kill', '-TERM', String(state.pid)], {
          user: SCANNER_USER,
          env: { ...EXEC_ENV },
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        await kill.output();
      }
      await this.save({ ...state, phase: 'stopping', stopDeadline: now + STOP_GRACE_MS });
    }
    await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
  }

  async alarm(): Promise<void> {
    const state = await this.state();
    if (!state) {
      return;
    }
    if (state.kind === 'probe') {
      await this.destroyContainer().catch(() => {});
      return;
    }
    if (state.phase === 'done') {
      await this.destroyContainer().catch(() => {});
      return;
    }
    try {
      if (state.phase === 'starting') {
        await this.begin(state);
      } else {
        await this.poll(state);
      }
    } catch (error) {
      console.error('[security-scanner] scan attempt failed', error);
      await this.report(state, {
        status: { status: 'failed', reason: 'infrastructure', error_class: 'controller_error' },
        findings: null,
      });
      await this.finish();
    }
  }
}

/** Engine A (`anthropic/*`): the Agent SDK image. */
export class ScannerControllerEngineA extends ScannerController {
  protected override readonly engine: ScannerEngine = 'agent_sdk';
}

/** Engine C (`openai/*`): the Codex SDK image. */
export class ScannerControllerEngineC extends ScannerController {
  protected override readonly engine: ScannerEngine = 'codex_sdk';
}
