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
// `ScannerController` runs Engine B on the managed image and streams the runner in.
// `ScannerControllerEngineA` / `ScannerControllerEngineC` run their engine image, which
// already holds the runner, the SDK and the MCP server; one container app per class.
//
// Spike S1 facts this file relies on: the hostname intercepts are registered before the
// catch-all (else the catch-all wins); HTTPS needs its own `interceptOutboundHttps('*')`
// deny, else a TLS client hangs ~8 s; scan code starts through stdin and a short argv;
// nothing reads /run/cloudchamber.

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
/// <reference path="./security-scanner-controller-modules.d.ts" />
import runnerSource from 'void:security-scanner-runner-source';
import { COPY_HEADER, COPY_HOST, runtimeCopyScriptName } from './security/runtime-copy-names.ts';

/** The only host the container may call besides its copy. The runner's base URL points here. */
export const MODEL_HOST = 'model.void.internal';
export const MANAGED_IMAGE = 'cloudflare/debian-trixie';
const SCANNER_USER = 'scanner';
export const RUNNER_PATH = '/opt/void-scanner/runner.mjs';
export const STATUS_PATH = '/scan/out/status.json';
export const FINDINGS_PATH = '/scan/out/findings.json';
/** The runner refuses a report above 5 MiB; one more byte tells the API it was cut. */
const FINDINGS_READ_LIMIT = 5 * 1024 * 1024 + 1;
const POLL_MS = 10_000;
/** After SIGTERM at the wall clock, the runner has this long to write `timed_out`. */
const STOP_GRACE_MS = 60_000;
const READY_TIMEOUT_MS = 120_000;
/** A probe's whole self-test (ready + setup + run, at most 210 s) ends before the API stops waiting (240 s). */
const PROBE_READY_TIMEOUT_MS = 90_000;
const SETUP_TIMEOUT_MS = 30_000;
const SELF_TEST_RUN_TIMEOUT_MS = 90_000;
/** Reading one result file, or sending SIGTERM, never holds an alarm longer than this. */
const READ_TIMEOUT_MS = 30_000;
/** The whole env of every command run in the container: no token, URL or project data. */
export const EXEC_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: '/scan',
});
/** A probe container is destroyed by this alarm even when the request was dropped. */
const PROBE_CLEANUP_MS = 10 * 60_000;
const CONTROL_TIMEOUT_MS = 30_000;
/** The API reads the deployment, past findings and secrets to build the input tar. */
const INPUT_TIMEOUT_MS = 120_000;
/** Making the runtime copy (stores, schema, upload; S13: about 10 s). */
const COPY_TIMEOUT_MS = 120_000;
const COPY_REQUEST_TIMEOUT_MS = 30_000;
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
type SecurityScanControlRpc = {
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

type ControllerEnv = {
  SCANNER: DurableObjectNamespace<ScannerController>;
  SCANNER_ENGINE_A?: DurableObjectNamespace<ScannerController>;
  SCANNER_ENGINE_C?: DurableObjectNamespace<ScannerController>;
  /** JSON `{engine: image ref}` of the engine images that are ready. */
  __VOID_SECURITY_SCANNER_IMAGES?: string;
  __VOID_SECURITY_SCAN_CONTROL: SecurityScanControlRpc;
  /** M30: this installation's runtime copies, and their name prefix. */
  __VOID_SECURITY_COPIES?: {
    get(name: string): { fetch(request: Request): Promise<Response> };
  };
  __VOID_SECURITY_COPY_PREFIX?: string;
};

export type ScannerEngine = 'void_loop' | 'agent_sdk' | 'codex_sdk';

/** The namespace that runs `engine`, or null when it cannot run here (an image engine needs its image). */
function scannerNamespace(
  env: ControllerEnv,
  engine: unknown,
): DurableObjectNamespace<ScannerController> | null {
  if (engine === 'void_loop') {
    return env.SCANNER;
  }
  if (engine !== 'agent_sdk' && engine !== 'codex_sdk') {
    return null;
  }
  let ref: unknown;
  try {
    ref = (
      JSON.parse(env.__VOID_SECURITY_SCANNER_IMAGES ?? '{}') as Record<string, unknown> | null
    )?.[engine];
  } catch {
    // Unreadable: no image engine runs.
  }
  if (typeof ref !== 'string' || ref.length === 0) {
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

type ScanState = {
  kind: 'scan';
  scanId: string;
  attempt: number;
  engine: string;
  phase: 'starting' | 'running' | 'stopping' | 'done';
  createdAt: number;
  wallDeadline: number;
  hardDeadline: number;
  stopDeadline?: number;
  pid?: number;
};
type State = ScanState | { kind: 'probe'; probeId: string; createdAt: number };

type ModelOutboundProps = { scanId: string; attempt: number } | { probeId: string };
type CopyOutboundProps = { scanId: string; attempt: number };
type ExportsLoopback = {
  ScanModelOutbound(options: { props: ModelOutboundProps }): Fetcher;
  CopyOutbound(options: { props: CopyOutboundProps }): Fetcher;
  DenyAll(options: { props: Record<string, never> }): Fetcher;
};

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    Array.from(value).every((char) => ID_CHARS.includes(char))
  );
}

function isAttempt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isDuration(value: unknown): value is number {
  return isAttempt(value) && value <= 6 * 3_600_000;
}

/** One container instance per scan attempt and per probe: never shared, never reused (edge #42). */
function scanInstanceName(scanId: string, attempt: number): string {
  return `scan:${scanId}:${attempt}`;
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

const SETUP_HEAD = [
  'const fs=require("node:fs"),cp=require("node:child_process");',
  `const user=${JSON.stringify(SCANNER_USER)},runner=${JSON.stringify(RUNNER_PATH)};`,
].join('');
const SCAN_DIR_SETUP =
  'fs.mkdirSync("/scan",{recursive:true});cp.execFileSync("chown",[user+":"+user,"/scan"]);fs.chmodSync("/scan",0o700);';

// Runs as root in an engine image (A/C) before the scan: the image already has the
// `scanner` user and the runner; this only makes /scan an empty folder that user owns.
// Exit 2: the image is not a scanner image.
const IMAGE_SETUP_SCRIPT = [
  SETUP_HEAD,
  'try{cp.execFileSync("id",["-u",user],{stdio:"ignore"})}catch{process.exit(2)}',
  'try{if(!fs.lstatSync(runner).isFile())process.exit(2)}catch{process.exit(2)}',
  SCAN_DIR_SETUP,
].join('');

// Runs as root before the scan: a non-root `scanner` user, an empty /scan it owns, and
// the runner bundle from stdin, read-only.
const SETUP_SCRIPT = [
  SETUP_HEAD,
  'try{cp.execFileSync("id",["-u",user],{stdio:"ignore"})}catch{cp.execFileSync("useradd",["--system","--no-create-home","--shell","/usr/sbin/nologin",user],{stdio:"ignore"})}',
  SCAN_DIR_SETUP,
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

/** Model route for one scan attempt. Identity comes from props the container never sees. */
export class ScanModelOutbound extends WorkerEntrypoint<ControllerEnv, ModelOutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    if ('probeId' in props) {
      // Probe check 3: the container reaches this handler and learns an id it never had.
      return new URL(request.url).pathname === '/v1/self-test'
        ? Response.json({ probe: props.probeId })
        : new Response('not found', { status: 404 });
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
 * attempt's copy only; nothing the container sends picks another copy. Every answer is
 * marked `dispatched` (the copy answered) or `unavailable` (no copy, or it failed).
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
    const headers = new Headers(request.headers);
    headers.delete(COPY_HEADER);
    const target = new URL(`${url.pathname}${url.search}`, `https://${COPY_HOST}`);
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

const INVALID = { ok: false, reason: 'invalid_request' } as const;

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
      return Response.json(INVALID, { status: 400 });
    }
    const { scanId, attempt, engine, wallClockMs, hardCapMs, probeId } = body;
    if (url.pathname === '/v1/scans/start') {
      if (
        !isId(scanId) ||
        !isAttempt(attempt) ||
        typeof engine !== 'string' ||
        !isDuration(wallClockMs) ||
        !isDuration(hardCapMs) ||
        hardCapMs < wallClockMs
      ) {
        return Response.json(INVALID, { status: 400 });
      }
      // No container app runs this engine yet (its image is not ready).
      const stub = scannerNamespace(this.env, engine)?.getByName(scanInstanceName(scanId, attempt));
      return Response.json(
        stub
          ? await stub.start({ scanId, attempt, engine, wallClockMs, hardCapMs })
          : { ok: false, reason: 'engine_unavailable' },
      );
    }
    if (url.pathname === '/v1/scans/cancel') {
      if (!isId(scanId) || !isAttempt(attempt)) {
        return Response.json(INVALID, { status: 400 });
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
      if (!isId(probeId)) {
        return Response.json(INVALID, { status: 400 });
      }
      const namespace = scannerNamespace(this.env, engine ?? 'void_loop');
      if (!namespace) {
        return Response.json({
          started: false,
          coldStartMs: null,
          report: null,
          error: 'engine_unavailable',
        } satisfies SelfTestResult);
      }
      // RPC types a result holding an `unknown` report as never; call it through the
      // class's own signature.
      const stub: Pick<ScannerController, 'selfTest'> = namespace.getByName(`probe:${probeId}`);
      return Response.json(await stub.selfTest(probeId));
    }
    return new Response('not found', { status: 404 });
  }
}

type ExecOptions = {
  user?: string;
  cwd?: string;
  stdin?: ReadableStream<Uint8Array>;
  timeoutMs: number;
};
/** Commands run as the scanner user start in its own folder. */
const AS_SCANNER = { user: SCANNER_USER, cwd: '/scan' } as const;

export class ScannerController extends DurableObject<ControllerEnv> {
  /** The engine this class runs. Engine B: the managed image, runner streamed in. */
  protected readonly engine: ScannerEngine = 'void_loop';

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) {
      throw new Error('The scanner Durable Object has no container.');
    }
    return container;
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

  /** Runs one command to its end with the fixed env and a time limit. */
  private async exec(argv: Array<string>, { timeoutMs, ...options }: ExecOptions) {
    const process = await this.container.exec(argv, {
      ...options,
      env: { ...EXEC_ENV },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return process.output();
  }

  /**
   * Egress lock, in the order S1 proved: the model host and the copy host first, then the
   * HTTP catch-all, then the HTTPS catch-all. Registered before `start`, so the container
   * never runs a moment without them.
   */
  private async lockEgress(props: ModelOutboundProps): Promise<void> {
    const container = this.container;
    const loopback = (this.ctx as DurableObjectState & { exports: ExportsLoopback }).exports;
    await container.interceptOutboundHttp(MODEL_HOST, loopback.ScanModelOutbound({ props }));
    if ('scanId' in props) {
      await container.interceptOutboundHttp(
        COPY_HOST,
        loopback.CopyOutbound({ props: { scanId: props.scanId, attempt: props.attempt } }),
      );
    }
    await container.interceptAllOutboundHttp(loopback.DenyAll({ props: {} }));
    await container.interceptOutboundHttps('*', loopback.DenyAll({ props: {} }));
  }

  /** Starts the container and waits until it runs a command; the wait in ms. */
  private async startContainer(instance: 'standard-1' | 'lite', timeoutMs: number) {
    // Engines A/C: the copied image their container app was uploaded with.
    const image = this.engine === 'void_loop' ? MANAGED_IMAGE : this.container.images.default;
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
    const started = Date.now();
    let lastError = 'not ready';
    while (Date.now() - started < timeoutMs) {
      try {
        const output = await (await this.container.exec(['true'])).output();
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
    if (this.engine !== 'void_loop') {
      // The engine image ships its own runner (with its SDK); only /scan is prepared.
      const output = await this.exec(['node', '-e', IMAGE_SETUP_SCRIPT], {
        user: 'root',
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      if (output.exitCode !== 0) {
        throw new Error(`Scanner image setup failed (exit ${output.exitCode}).`);
      }
      return;
    }
    if (!runnerSource) {
      throw new Error('The scanner controller is missing its runner bundle.');
    }
    const output = await this.exec(['node', '-e', SETUP_SCRIPT], {
      stdin: new Blob([runnerSource]).stream(),
      timeoutMs: SETUP_TIMEOUT_MS,
    });
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
      coldStartMs = await this.startContainer('lite', PROBE_READY_TIMEOUT_MS);
      await this.installRunner();
      const output = await this.exec(['node', RUNNER_PATH, '--self-test'], {
        ...AS_SCANNER,
        timeoutMs: SELF_TEST_RUN_TIMEOUT_MS,
      });
      try {
        return {
          started: true,
          coldStartMs,
          report: JSON.parse(decoder.decode(output.stdout).trim()),
        };
      } catch {
        return {
          started: true,
          coldStartMs,
          report: null,
          error: `self-test printed no report (exit ${output.exitCode})`,
        };
      }
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
      return (await bounded(this.control.heartbeat(state.scanId, state.attempt))).ok;
    } catch (error) {
      // The API is unreachable: keep going until the hard cap; the lease is the authority.
      console.error('[security-scanner] heartbeat failed', error);
      return true;
    }
  }

  private async report(state: ScanState, report: ScanResultReport): Promise<boolean> {
    try {
      return (await bounded(this.control.result(state.scanId, state.attempt, report))).ok;
    } catch (error) {
      console.error('[security-scanner] result report failed', error);
      return false;
    }
  }

  /** Reports a status the controller set, then ends the attempt. */
  private async end(state: ScanState, status: Record<string, string>): Promise<void> {
    await this.report(state, { status, findings: null });
    await this.finish();
  }

  /**
   * Scanned code runs as `scanner` and owns /scan, so it can put a symlink or a FIFO
   * where a result file should be. The read runs as `scanner` too, refuses anything
   * but a regular file and has a time limit. `null`: not there yet; `false`: refused.
   */
  private async readFile(path: string, limit: number): Promise<string | null | false> {
    const output = await this.exec(['node', '-e', READ_SCRIPT, path, String(limit)], {
      ...AS_SCANNER,
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (output.exitCode === 0) {
      return decoder.decode(output.stdout);
    }
    return output.exitCode === 1 ? null : false;
  }

  private async begin(state: ScanState): Promise<void> {
    if (!(await this.fence(state))) {
      // A newer attempt exists or the scan was canceled: never start a container.
      await this.finish();
      return;
    }
    await this.lockEgress({ scanId: state.scanId, attempt: state.attempt });
    await this.startContainer('standard-1', READY_TIMEOUT_MS);
    await this.installRunner();
    const input = await bounded(this.control.input(state.scanId, state.attempt), INPUT_TIMEOUT_MS);
    if (!input) {
      await this.end(state, {
        status: 'failed',
        reason: 'infrastructure',
        error_class: 'input_unavailable',
      });
      return;
    }
    const process = await this.container.exec(['node', RUNNER_PATH, '--stdin-tar'], {
      ...AS_SCANNER,
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
      await this.end(state, { status: 'timed_out', reason: 'hard_cap' });
      return;
    }
    if (!this.container.running) {
      await this.end(state, {
        status: 'failed',
        reason: 'infrastructure',
        error_class: 'container_exited',
      });
      return;
    }
    if (!(await this.fence(state))) {
      await this.finish();
      return;
    }
    const status = await this.readFile(STATUS_PATH, 64 * 1024);
    if (status !== null) {
      const unreadable = {
        status: 'failed',
        reason: 'bad_output',
        error_class: 'status_unreadable',
      };
      let result: ScanResultReport = { status: unreadable, findings: null };
      if (status !== false) {
        const read = await this.readFile(FINDINGS_PATH, FINDINGS_READ_LIMIT);
        const findings = typeof read === 'string' ? read : null;
        try {
          result = { status: JSON.parse(status), findings };
        } catch {
          result = { status: unreadable, findings };
        }
      }
      if (await this.report(state, result)) {
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
      await this.end(state, { status: 'timed_out', reason: 'wall_clock' });
      return;
    }
    if (state.phase === 'running' && now >= state.wallDeadline) {
      // The runner ends its session and writes `timed_out (wall_clock)` on SIGTERM.
      if (state.pid !== undefined) {
        // As `scanner`: the runner is its process, and nothing else is.
        await this.exec(['kill', '-TERM', String(state.pid)], {
          user: SCANNER_USER,
          timeoutMs: READ_TIMEOUT_MS,
        });
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
    if (state.kind === 'probe' || state.phase === 'done') {
      await this.destroyContainer().catch(() => {});
      return;
    }
    try {
      await (state.phase === 'starting' ? this.begin(state) : this.poll(state));
    } catch (error) {
      console.error('[security-scanner] scan attempt failed', error);
      await this.end(state, {
        status: 'failed',
        reason: 'infrastructure',
        error_class: 'controller_error',
      });
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
