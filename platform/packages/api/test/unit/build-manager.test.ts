import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderCapturedLog } from './log-tail-helpers.ts';

// Stub the `@cloudflare/containers` Container base class with a minimal shape the manager relies on: ctx/env wiring plus
// `start`/`stop`/`fetch` (the latter as the "forward to container" fallback).
//
// The real base Container OWNS the single DO alarm to drive its monitor loop +
// onStop dispatch. The manager must NOT override `alarm()`; instead it arms the
// timeout via the base `schedule(seconds, methodName)` API, and the base alarm
// loop invokes that named method when due. The stub mirrors exactly that: it
// records scheduled callbacks, and `_runDueSchedules()` invokes them the way
// the base alarm loop would (see container.js:1441-1463). `alarm()` here is the
// base-owned handler — the manager never overrides it, so a base alarm before
// the deadline is a no-op for build state.
const containerCalls = {
  started: 0,
  stopped: 0,
  destroyed: 0,
  baseAlarms: 0,
};
type ScheduledTask = { whenSeconds: number; callback: string };

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('@cloudflare/containers', () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    envVars: Record<string, string> = {};
    defaultPort?: number;
    enableInternet?: boolean;
    sleepAfter?: string | number;
    _schedules: Array<ScheduledTask> = [];
    // Tracks whether the container has been LAUNCHED. The base `start()` launches
    // the container in `startContainerIfNotRunning` and only THEN runs onStart, so
    // a post-launch onStart reject leaves a LIVE container — modeled by this flag
    // staying true after start() rejects.
    _containerRunning = false;
    // Settable per-test: backs `container.getTcpPort(port).fetch(url, init)` (the
    // non-starting port fetch pollLogs uses). Called as (url, port, init) to match
    // the assertions in the pollLogs suite. `init` is forwarded (not dropped) so a
    // test can assert the abort signal that timeboxes every pull.
    _portFetch: ((url: string, port: number, init?: RequestInit) => Promise<Response>) | null =
      null;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    // Mirrors the real base `this.container = ctx.container`. `.running` reflects the
    // launched/stopped flag the stub already tracks (set by start()/stop()/destroy()).
    // `getTcpPort().fetch()` is the NON-starting port fetch — it never auto-starts,
    // modeling that the real raw port fetch FAILS (rather than starting) when the
    // container is down.
    get container() {
      return {
        running: this._containerRunning,
        getTcpPort: (port: number) => ({
          fetch: (url: string, init?: RequestInit) => {
            if (!this._portFetch) {
              throw new Error('container port fetch not stubbed');
            }
            return this._portFetch(url, port, init);
          },
        }),
      };
    }
    // Faithful model of the base `start()` (container.js:554-570): it LAUNCHES the
    // container (`startContainerIfNotRunning`, ~1321) and THEN runs onStart inside
    // `ctx.blockConcurrencyWhile` (567-569) BEFORE start() resolves. So onStart
    // runs after the container is live but before start() returns, and an onStart
    // throw rejects start() while the container is already running. Modeling this
    // is what makes the startBuild catch's post-launch teardown testable: a bare
    // counter-only stub could never distinguish a PRE-launch failure (capacity /
    // token mint) from a POST-launch onStart reject.
    async start(): Promise<void> {
      containerCalls.started += 1;
      this._containerRunning = true;
      await (this as unknown as { onStart(): Promise<void> }).onStart();
    }
    async stop(): Promise<void> {
      containerCalls.stopped += 1;
      this._containerRunning = false;
    }
    // SIGKILL escalation. The real base only SIGTERMs in stop(); destroy() is the
    // sole SIGKILL and is what guarantees a SIGTERM-ignoring container is killed.
    async destroy(): Promise<void> {
      containerCalls.destroyed += 1;
      this._containerRunning = false;
    }
    async fetch(): Promise<Response> {
      return new Response('container', { status: 200 });
    }
    // Public base scheduler. Stores the task; the base alarm loop (modeled by
    // `_runDueSchedules`) invokes the named method when due.
    async schedule(whenSeconds: number, callback: string): Promise<void> {
      this._schedules.push({ whenSeconds, callback });
    }
    // Base-owned alarm handler. The manager never overrides it; a fire before
    // any schedule is due must not touch build state. Returns the base bookkeep.
    async alarm(): Promise<void> {
      containerCalls.baseAlarms += 1;
    }
    // Test helper: invoke every scheduled callback whose delay has elapsed,
    // exactly as the base alarm loop would when the deadline arrives.
    async _runDueSchedules(): Promise<void> {
      const due = this._schedules;
      this._schedules = [];
      for (const task of due) {
        const fn = (this as unknown as Record<string, () => Promise<void>>)[task.callback];
        await fn.call(this);
      }
    }
  },
}));

// db.ts — capture every status write so the state machine can be asserted.
type StatusWrite = {
  id: string;
  status: string;
  opts?: {
    error?: string;
    exitCode?: number;
    deploymentId?: string | null;
    instanceType?: string | null;
  };
};
const ACTIVE_BUILD_STATUSES = ['starting', 'building', 'deploying'];
const dbState = {
  writes: [] as Array<StatusWrite>,
  // Authoritative per-build DB status, so the CAS helpers
  // (markBuildBuildingIfStarting / markBuildTerminalIfActive) can model the real
  // `UPDATE ... WHERE status = ?` guard: a write that doesn't match the guard is
  // a no-op (records no write and returns false), exactly like Postgres.
  status: new Map<string, string>(),
  // deployment returned by getDeploymentByProjectAndCommit
  deployment: null as { id: string } | null,
  // `created_at` (ISO string) returned by getBuild for the build row. Drives the
  // freshness-recheck age bound: a null-comparison on a FRESH build requeues, on
  // an OLD build (older than FRESHNESS_VERIFY_MAX_AGE_MS) fails. Defaults to now.
  createdAt: new Date().toISOString(),
  // records every build returned to `queued` via the guarded requeue CAS so the
  // freshness-recheck null path can be asserted.
  requeued: [] as Array<string>,
  // Drives `installationCoversRepo`: the JIT App-installation coverage recheck
  // in startBuild. Default true so the happy path proceeds to mint + start; the
  // coverage tests flip it false (uninstall/suspension/repo-removal raced the
  // queue wait) to assert the build fails closed (cancelled, no mint, no start).
  installationCovered: true,
};
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  // Unconditional write — mirrors the real `updateBuildStatus` (no status guard).
  updateBuildStatus: vi.fn(async (_db: unknown, id: string, status: string, opts?: unknown) => {
    dbState.status.set(id, status);
    dbState.writes.push({ id, status, opts: opts as StatusWrite['opts'] });
  }),
  // CAS: `starting -> building` ONLY if the row is still `starting`. Returns
  // whether it updated (true) so onStart can avoid resurrecting a terminal row.
  markBuildBuildingIfStarting: vi.fn(
    async (_db: unknown, id: string, opts?: { instanceType?: string | null }) => {
      if (dbState.status.get(id) !== 'starting') {
        return false;
      }
      dbState.status.set(id, 'building');
      dbState.writes.push({ id, status: 'building', opts: opts as StatusWrite['opts'] });
      return true;
    },
  ),
  // CAS: apply a terminal status ONLY if the row is currently active. Returns
  // whether it updated (true). A second/late terminal write is a no-op.
  markBuildTerminalIfActive: vi.fn(
    async (_db: unknown, id: string, status: string, opts?: unknown) => {
      const current = dbState.status.get(id);
      if (current === undefined || !ACTIVE_BUILD_STATUSES.includes(current)) {
        return false;
      }
      dbState.status.set(id, status);
      dbState.writes.push({ id, status, opts: opts as StatusWrite['opts'] });
      return true;
    },
  ),
  // CAS: apply a non-terminal progress status ONLY if the row is currently
  // active. Returns whether it updated (true). A forged/late progress report
  // against a row a concurrent terminalizer already drove terminal is a no-op
  // (records no write, returns false) — exactly like the real
  // `UPDATE ... WHERE status IN (active)` guard.
  markBuildProgressIfActive: vi.fn(async (_db: unknown, id: string, status: string) => {
    const current = dbState.status.get(id);
    if (current === undefined || !ACTIVE_BUILD_STATUSES.includes(current)) {
      return false;
    }
    dbState.status.set(id, status);
    dbState.writes.push({ id, status, opts: undefined });
    return true;
  }),
  getDeploymentByProjectAndCommit: vi.fn(async () => dbState.deployment),
  // Returns the build row so startBuild's rechecks can read it: `created_at`
  // age-bounds a persistently-null branch comparison (freshness path), and
  // `status` drives the JIT cancellation recheck. `status` reflects the
  // authoritative dbState map so a concurrent cancel committed before this read
  // is observed. Returns null when no row exists for the id.
  getBuild: vi.fn(async (_db: unknown, id: string) => {
    const status = dbState.status.get(id);
    if (status === undefined) {
      return null;
    }
    return { id, created_at: dbState.createdAt, status };
  }),
  // Guarded CAS `starting -> queued`: the freshness recheck requeues a build it
  // could not verify (transient GitHub API failure) so the next alarm retries.
  // Records the id so the null path can be asserted.
  requeueBuildIfStarting: vi.fn(async (_db: unknown, id: string) => {
    if (dbState.status.get(id) !== 'starting') {
      return false;
    }
    dbState.status.set(id, 'queued');
    dbState.requeued.push(id);
    return true;
  }),
  // JIT App-installation coverage recheck (fresh, non-locking Postgres read).
  // Fails closed on a missing connection or repository id, exactly like the real
  // helper.
  installationCoversRepo: vi.fn(
    async (
      _db: unknown,
      connectionId: string | undefined,
      _projectId: string,
      _installationId: string,
      _repositoryId: string,
    ) => {
      if (!connectionId) {
        return false;
      }
      return dbState.installationCovered;
    },
  ),
}));

// Token mints — deterministic fakes so startBuild can be exercised offline.
// The mock is declared inline in the factory (vi.mock is hoisted, so it can't
// close over an outer variable); its call args (incl. the optional opts) are
// inspected later via `vi.mocked(signDeployToken)` for the TTL sizing.
vi.mock('../../src/auth/deploy-token.ts', () => ({
  signDeployToken: vi.fn(
    async (
      _ident: { projectId: string; userId: string; login: string; buildId?: string },
      _secret: string,
      _opts?: { ttlSeconds?: number },
    ) => 'deploy-token',
  ),
  // Hard ceiling on the build's wall-clock timeout (and deploy-token life) —
  // mirrors the real constant so the always-armed timeout cap holds.
  DEPLOY_TOKEN_HARD_MAX_MINUTES: 60,
  // Real (pure) TTL formula — the manager calls this to size the token. Mirror
  // the implementation in deploy-token.ts so the sizing assertions hold.
  deployTokenTtlSecondsForBuildMinutes: (timeoutMinutes: number) => {
    const buildMinutes = timeoutMinutes > 0 ? timeoutMinutes : Infinity;
    const cappedMinutes = Math.min(buildMinutes, 60);
    return cappedMinutes * 60 + 5 * 60;
  },
}));
vi.mock('../../src/github/installation-token.ts', () => ({
  // Real constants (the module is mocked wholesale): the log-tail suite routes
  // completeCheckRun to the REAL implementation, which builds its PATCH URL and
  // version header from these.
  GITHUB_API_BASE: 'https://api.github.com',
  GITHUB_API_VERSION: '2026-03-10',
  getInstallationToken: vi.fn(async () => 'install-token'),
  generateSourceTarballUrl: vi.fn(
    (repo: string, sha: string) => `https://api.github.com/repos/${repo}/tarball/${sha}`,
  ),
  // JIT branch-head freshness recheck. Default 'identical' so every existing
  // happy-path test proceeds to mint + start unchanged; the freshness-recheck tests override
  // it per-case ('ahead'/'behind'/'diverged' → cancel, null → requeue/age-fail).
  getBranchHeadComparisonStatus: vi.fn(async () => 'identical'),
}));
// check-run.ts is mocked here so startBuild's BEST-EFFORT check-run create is INERT
// in this suite — it must not make outbound `fetch` calls or consume a
// `getInstallationToken` mock. `createCheckRun` returns null by default (no run
// created → finalizers no-op).
// The real create/finalize wiring is covered by test/integration/api-check-runs.test.ts.
// Partial mock: stub the two network calls, keep everything else REAL. The module
// also exports `VOID_BUILD_CHECK_RUN_NAME`, which `startBuild` reads — spelling it
// out again here would let the check-run name drift from the one
// `check_run:rerequested` matches on, and that name is the only thing making
// GitHub's "Re-run" button work.
vi.mock('../../src/github/check-run.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/github/check-run.ts')>()),
  createCheckRun: vi.fn(async () => null),
  completeCheckRun: vi.fn(async () => false),
}));

// eslint-disable-next-line import/no-relative-packages -- intentional cross-package contract reference
import voidPackageJson from '../../../../../packages/void/package.json' with { type: 'json' };
// Helpers from the container build agent. Importing the .mjs only pulls in its
// exported helpers — the entrypoint guard keeps `main()` from running the
// control server / spawning anything on import. Types come from the sibling
// build-agent.d.mts (NodeNext pairs it with the .mjs).
import {
  BUILDER_GID,
  BUILDER_HOME,
  BUILDER_UID,
  builderCacheEnv,
  childSpawnOptions,
  DEFAULT_VOID_CLI_VERSION,
  clearBufferedLogLines,
  closeControlServer,
  getAckedLogSeq,
  getBufferedLogLines,
  getPendingLogLineCount,
  getServedLogSeq,
  installShutdownHandlers,
  LOG_DRAIN_ABSOLUTE_TIMEOUT_MS,
  LOG_DRAIN_IDLE_TIMEOUT_MS,
  MAX_BUFFERED_LOG_BYTES,
  MAX_BUFFERED_LOG_LINES,
  MAX_PARTIAL_LINE_CHARS,
  MAX_LOG_RESPONSE_BYTES,
  MAX_LOG_RESPONSE_LINES,
  MAX_PENDING_LOG_LINES,
  nonInteractiveEnv,
  parseProcStatusUid,
  pipeStream,
  record,
  runBuild,
  SCRUBBED_ENV_VARS,
  sanitizeChildEnv,
  startControlServer,
  waitForLogDrain,
} from '../../container/build-agent.mjs';
import { signDeployToken } from '../../src/auth/deploy-token.ts';
import {
  BuildManager,
  CHECK_RUN_LOG_TAIL_LINES,
  CHECK_RUN_LOG_TAIL_MAX_BYTES,
  CHECK_RUN_OUTPUT_TEXT_MAX_BYTES,
  formatLogTailMarkdown,
  LOG_DRAIN_BUDGET_MS,
  LOG_DRAIN_GRACE_SECONDS,
  LOG_PULL_TIMEOUT_MS,
  LOG_SINK_OP_PAYLOAD_BYTES,
  LOG_TERMINAL_DRAIN_RETRY_WINDOW_MS,
  MAX_LOG_PULL_PAGES,
  MAX_LOG_SINK_OPS_PER_DRAIN,
  MAX_STORED_LOG_LINES,
  PINNED_VOID_CLI_VERSION,
  TERMINAL_RENDER_COLUMNS,
  TERMINAL_RENDER_MAX_INPUT_CODE_UNITS,
  TERMINAL_RENDER_MAX_PARAMETER_WORK,
  TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS,
  TERMINAL_TAIL_MAX_INPUT_CODE_UNITS,
  TERMINAL_WRITE_TIMEOUT_MS,
} from '../../src/build-manager.ts';
import type { BuildConfig } from '../../src/build-types.ts';
import {
  getBuild,
  getDeploymentByProjectAndCommit,
  installationCoversRepo,
  markBuildBuildingIfStarting,
  markBuildTerminalIfActive,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { completeCheckRun } from '../../src/github/check-run.ts';
import {
  getBranchHeadComparisonStatus,
  getInstallationToken,
} from '../../src/github/installation-token.ts';

// --- in-memory SQLite + storage + websocket fakes ---

type LogRow = {
  seq: number;
  line: string;
  stream: string;
  ts: number;
  lineEnding?: 'cr' | 'lf' | 'crlf' | 'none' | null;
};

function makeStubCtx(options: { legacyLogSchema?: boolean; initialLogs?: Array<LogRow> } = {}) {
  const kv = new Map<string, unknown>();
  let alarmTime: number | null = null;
  const logs: Array<LogRow> = options.initialLogs?.map((row) => ({ ...row })) ?? [];
  let seq = logs.reduce((max, row) => Math.max(max, row.seq), 0);
  let hasLineEndingColumn = !options.legacyLogSchema;
  const sqlQueries: Array<string> = [];
  const sockets: Array<FakeWebSocket> = [];

  const sql = {
    exec(query: string, ...bindings: Array<unknown>) {
      sqlQueries.push(query);
      if (query.startsWith('CREATE TABLE')) {
        return { toArray: () => [] };
      }
      if (query.startsWith('PRAGMA table_info')) {
        return {
          toArray: () => [
            { name: 'seq' },
            { name: 'line' },
            { name: 'stream' },
            { name: 'ts' },
            ...(hasLineEndingColumn ? [{ name: 'line_ending' }] : []),
          ],
        };
      }
      if (query.startsWith('ALTER TABLE logs ADD COLUMN line_ending')) {
        hasLineEndingColumn = true;
        for (const row of logs) {
          row.lineEnding ??= null;
        }
        return { toArray: () => [] };
      }
      if (query.startsWith('INSERT INTO logs')) {
        seq += 1;
        logs.push({
          seq,
          line: bindings[0] as string,
          stream: bindings[1] as string,
          ts: bindings[2] as number,
          lineEnding: bindings[3] as LogRow['lineEnding'],
        });
        return { toArray: () => [] };
      }
      if (query.startsWith('DELETE FROM logs')) {
        // Mirror `DELETE FROM logs WHERE seq <= (SELECT MAX(seq) FROM logs) - ?`:
        // keep only the most-recent N rows by seq. Without modeling this, the cap
        // would silently no-op in tests (cf. the rowCount/PGlite lesson).
        const keep = bindings[0] as number;
        if (logs.length > 0) {
          const maxSeq = logs.reduce((m, r) => (r.seq > m ? r.seq : m), 0);
          const threshold = maxSeq - keep;
          for (let i = logs.length - 1; i >= 0; i--) {
            if (logs[i].seq <= threshold) {
              logs.splice(i, 1);
            }
          }
        }
        return { toArray: () => [] };
      }
      if (query.startsWith('SELECT MAX(seq)')) {
        // Mirror `SELECT MAX(seq) AS max FROM logs`: NULL (→ JS null) when empty.
        const max = logs.length > 0 ? logs.reduce((m, r) => (r.seq > m ? r.seq : m), 0) : null;
        return { toArray: () => [{ max }] };
      }
      if (query.startsWith('SELECT COUNT(*)')) {
        // Mirror `SELECT COUNT(*) AS count FROM logs` (check-run log-tail total).
        return { toArray: () => [{ count: logs.length }] };
      }
      if (query.startsWith('SELECT line, line_ending AS lineEnding')) {
        // Mirror the check-run log tail query: newest-first, bounded. Must be
        // modeled BEFORE the generic SELECT branch, which would misread the
        // LIMIT binding as a `seq > ?` bound.
        const limit = bindings[0] as number;
        return {
          toArray: () =>
            logs
              .slice()
              .sort((a, b) => b.seq - a.seq)
              .slice(0, limit)
              .map((r) => ({ line: r.line, lineEnding: r.lineEnding ?? null })),
        };
      }
      if (query.startsWith('SELECT')) {
        // Honor a `WHERE seq > ?` bound when present (the GET /logs poll read);
        // without modeling the filter it would silently no-op in tests (cf. the
        // rowCount/PGlite lesson). The WS-replay SELECT carries no binding, so
        // `since` defaults to -Infinity and every row passes.
        const since = bindings.length > 0 ? (bindings[0] as number) : Number.NEGATIVE_INFINITY;
        return {
          toArray: () =>
            logs
              .slice()
              .sort((a, b) => a.seq - b.seq)
              .filter((r) => r.seq > since)
              .map(({ seq, line, stream, ts }) => ({ seq, line, stream, ts })),
        };
      }
      return { toArray: () => [] };
    },
  };

  return {
    _logs: logs,
    _sockets: sockets,
    _kv: kv,
    _sqlQueries: sqlQueries,
    storage: {
      sql,
      get: vi.fn(async (k: string) => kv.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        kv.set(k, v);
      }),
      getAlarm: vi.fn(async () => alarmTime),
      setAlarm: vi.fn(async (t: number) => {
        alarmTime = t;
      }),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null;
      }),
    },
    acceptWebSocket: vi.fn((ws: FakeWebSocket) => {
      sockets.push(ws);
    }),
    getWebSockets: vi.fn(() => sockets),
  };
}

class FakeWebSocket {
  sent: Array<string> = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

function makeEnv() {
  const schedulerStub = { fetch: vi.fn(async () => new Response('ok')) };
  return {
    HYPERDRIVE: { connectionString: 'postgres://fake' },
    JWT_SECRET: 'secret',
    PLATFORM_ENV: undefined,
    BUILD_SCHEDULER: {
      idFromName: vi.fn((n: string) => ({ name: n })),
      get: vi.fn(() => schedulerStub),
    },
  } as unknown as ApiEnv['Bindings'] & {
    BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> };
  };
}

function makeConfig(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    buildId: 'b1',
    projectId: 'p1',
    projectSlug: 'my-app',
    userId: 'u1',
    login: 'octocat',
    commitSha: 'sha1',
    branch: 'main',
    repoFullName: 'owner/repo',
    installationId: 'inst1',
    connectionId: 'connection-1',
    repositoryId: 'repo1',
    instanceType: 'standard-1',
    timeoutMinutes: 10,
    ...overrides,
  };
}

function makeManager(ctx: ReturnType<typeof makeStubCtx>, env: ApiEnv['Bindings']) {
  return new BuildManager(ctx as unknown as ConstructorParameters<typeof BuildManager>[0], env);
}

/** Read the timeout tasks the manager armed via the base `schedule()` API. */
function scheduledTasks(m: BuildManager): Array<ScheduledTask> {
  return (m as unknown as { _schedules: Array<ScheduledTask> })._schedules;
}

/** Fire the base alarm loop so any due scheduled callbacks run (timeout path). */
async function runDueSchedules(m: BuildManager): Promise<void> {
  await (m as unknown as { _runDueSchedules: () => Promise<void> })._runDueSchedules();
}

function lastWrite(status: string): StatusWrite | undefined {
  return [...dbState.writes].reverse().find((w) => w.status === status);
}

/** Read the per-build agent secret the manager stored at startBuild(). */
function agentToken(ctx: ReturnType<typeof makeStubCtx>): string {
  return ctx._kv.get('agentToken') as string;
}

/** Build an authenticated agent control request (Bearer agent token). */
function agentRequest(
  ctx: ReturnType<typeof makeStubCtx>,
  url: string,
  init: RequestInit = {},
): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${agentToken(ctx)}` },
  });
}

// Provide WebSocketPair as a global for the upgrade path.
class FakeWebSocketPair {
  0 = new FakeWebSocket();
  1 = new FakeWebSocket();
}

// The CF Workers runtime accepts `new Response(null, { status: 101, webSocket })`
// for WebSocket upgrades, but the Node/undici `Response` used in unit tests
// rejects status 101. Shim a lenient Response that records status + webSocket so
// the upgrade path (real CF code) can be exercised here.
class FakeUpgradeResponse {
  status: number;
  webSocket: unknown;
  constructor(_body: unknown, init?: { status?: number; webSocket?: unknown }) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
  }
}
const RealResponse = globalThis.Response;

beforeEach(() => {
  dbState.writes = [];
  // Model the scheduler's claim: `claimBuildForStartWithinLimit` flips the row
  // `queued -> starting` BEFORE calling startBuild, so the DB row is already
  // `starting` when the DO runs. Every test uses buildId 'b1' (makeConfig).
  dbState.status = new Map<string, string>([['b1', 'starting']]);
  dbState.deployment = null;
  dbState.createdAt = new Date().toISOString();
  dbState.requeued = [];
  dbState.installationCovered = true;
  containerCalls.started = 0;
  containerCalls.stopped = 0;
  containerCalls.destroyed = 0;
  containerCalls.baseAlarms = 0;
  vi.clearAllMocks();
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = FakeWebSocketPair;
  // Patch Response to tolerate status 101 (WebSocket upgrade) while delegating
  // every other construction to the real implementation.
  (globalThis as unknown as { Response: unknown }).Response = new Proxy(RealResponse, {
    construct(target, args) {
      const init = args[1] as { status?: number } | undefined;
      if (init?.status === 101) {
        return new FakeUpgradeResponse(args[0], init as { webSocket?: unknown });
      }
      return Reflect.construct(target, args, target);
    },
    get(target, prop, receiver) {
      return Reflect.get(target, prop, receiver);
    },
  });
});

afterEach(() => {
  (globalThis as unknown as { Response: unknown }).Response = RealResponse;
});

describe('BuildManager.startBuild', () => {
  it('persists config, sets env vars, starts the container, arms timeout — and does NOT write starting', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(containerCalls.started).toBe(1);
    // Build env-var contract handed to the container agent.
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.BUILD_ID).toBe('b1');
    expect(envVars.PROJECT_ID).toBe('p1');
    expect(envVars.PROJECT_SLUG).toBe('my-app');
    expect(envVars.VOID_PROJECT).toBe('my-app');
    expect(envVars.VOID_TOKEN).toBe('deploy-token');
    expect(envVars.SOURCE_TOKEN).toBe('install-token');
    expect(envVars.SOURCE_TARBALL_URL).toBe('https://api.github.com/repos/owner/repo/tarball/sha1');
    expect(envVars.VOID_API_URL).toBe('https://api.void.cloud');
    // The fallback Void CLI version is PINNED (never `latest`) so a moving npm
    // dist-tag can't change deploy behavior with no repo diff.
    expect(envVars.VOID_CLI_VERSION).toBeDefined();
    expect(envVars.VOID_CLI_VERSION).not.toBe('latest');
    expect(envVars.VOID_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(envVars.DO_LOG_URL).toBe('https://manager/logs');
    // Commit/source metadata forwarded so `void deploy` stamps the deployment's
    // commit (the tarball has no `.git`; the CLI reads GITHUB_SHA first). Without
    // these the deployment records a NULL commit and onStop can't link the build.
    expect(envVars.GITHUB_SHA).toBe('sha1');
    expect(envVars.GITHUB_REPOSITORY).toBe('owner/repo');
    expect(envVars.GITHUB_REF).toBe('refs/heads/main');
    // Timeout armed via the base scheduler (10 min = 600s), NOT a raw setAlarm:
    // the base Container owns the single DO alarm to drive its monitor/onStop
    // loop, so the manager must never write the alarm directly.
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
    // onStart arms the log pull-loop (first tick at 1s) before startBuild arms the
    // timeout (10 min = 600s); both go through the base scheduler, never setAlarm.
    expect(scheduledTasks(m)).toEqual([
      { whenSeconds: 1, callback: 'pollLogs' },
      { whenSeconds: 10 * 60 + LOG_DRAIN_GRACE_SECONDS, callback: 'enforceTimeout' },
    ]);
    // The deploy token is bound to THIS build so the deploy endpoint can reject
    // it once the build is no longer active (superseded/cancelled by a newer push).
    const ident = vi.mocked(signDeployToken).mock.calls[0]?.[0];
    expect(ident?.buildId).toBe('b1');
    expect(ident?.projectId).toBe('p1');
    // startBuild must NOT write `starting` to Postgres: the scheduler's claim
    // (`claimBuildForStartWithinLimit`) already set it. A redundant post-start
    // `starting` write could downgrade a row a fast onStart/onStop already moved
    // past `starting`, stranding it and leaking a concurrency slot.
    expect(dbState.writes.some((w) => w.status === 'starting')).toBe(false);
    // The only write startBuild makes is onStart's `starting -> building` CAS,
    // which runs INSIDE the base `start()` (before it resolves) — its sole persist
    // point for the instance_type (the claim flips status without it).
    expect(lastWrite('building')?.opts?.instanceType).toBe('standard-1');
  });

  it('uses the staging API URL when PLATFORM_ENV=staging', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    // Staging requires the CF Access service token (see fail-fast below), so set
    // it for the happy-path URL assertion.
    Object.assign(env as object, {
      PLATFORM_ENV: 'staging',
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      CF_ACCESS_CLIENT_SECRET_STAGING: 'svc-secret',
    });
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.VOID_API_URL).toBe('https://api.staging.void.cloud');
  });

  it('forwards the staging CF Access service token into the container (staging hosts are Access-gated)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    Object.assign(env as object, {
      PLATFORM_ENV: 'staging',
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      CF_ACCESS_CLIENT_SECRET_STAGING: 'svc-secret',
      PROXY_URL: 'https://proxy.staging.void.cloud',
    });
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    // The CLI reads the un-suffixed names; the worker holds the *_STAGING secrets.
    expect(envVars.CF_ACCESS_CLIENT_ID).toBe('svc-id.access');
    expect(envVars.CF_ACCESS_CLIENT_SECRET).toBe('svc-secret');
    expect(envVars.VOID_PROXY_URL).toBe('https://proxy.staging.void.cloud');
  });

  it('does NOT forward CF Access creds on production builds (api.void.cloud is not Access-gated)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    // Production env, but the secrets happen to be set: they must NOT leak in.
    Object.assign(env as object, {
      PLATFORM_ENV: undefined,
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      CF_ACCESS_CLIENT_SECRET_STAGING: 'svc-secret',
    });
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.CF_ACCESS_CLIENT_ID).toBeUndefined();
    expect(envVars.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
  });

  it('fails fast (does NOT start) on staging when the service token is unconfigured', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    (env as unknown as { PLATFORM_ENV?: string }).PLATFORM_ENV = 'staging';
    const m = makeManager(ctx, env);
    // Staging is Access-gated and the container can't auth without the service
    // token, so an unconfigured staging worker is a platform misconfiguration:
    // fail the build up front rather than burning a slot to fail at the Access edge.
    await expect(m.startBuild(makeConfig())).rejects.toThrow(/staging build misconfigured/);
    expect(containerCalls.started).toBe(0);
    const failed = lastWrite('failed');
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toMatch(/CF_ACCESS_CLIENT_ID_STAGING/);
    // Slot freed: the scheduler was poked and the row is not left active.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('fails fast on staging when the service token is half-configured (id without secret)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    Object.assign(env as object, {
      PLATFORM_ENV: 'staging',
      CF_ACCESS_CLIENT_ID_STAGING: 'svc-id.access',
      // CF_ACCESS_CLIENT_SECRET_STAGING intentionally absent — a half pair is as
      // broken as none (cfAccessHeaders requires both).
    });
    const m = makeManager(ctx, env);
    await expect(m.startBuild(makeConfig())).rejects.toThrow(/staging build misconfigured/);
    expect(containerCalls.started).toBe(0);
    expect(lastWrite('failed')?.id).toBe('b1');
  });

  it('arms the hard-max timeout when timeoutMinutes is 0 (unlimited)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig({ timeoutMinutes: 0 }));
    // Even an "unlimited" custom plan gets a hard ceiling: the base `sleepAfter`
    // idle-stop never fires for a busy container, so an orphaned build could
    // otherwise run unbounded. Falls back to DEPLOY_TOKEN_HARD_MAX_MINUTES (60).
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
    expect(scheduledTasks(m)).toContainEqual({
      whenSeconds: 60 * 60 + LOG_DRAIN_GRACE_SECONDS,
      callback: 'enforceTimeout',
    });
  });

  it('caps the timeout at the hard max when timeoutMinutes exceeds it', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig({ timeoutMinutes: 120 }));
    // A plan timeout above the hard max (60) is clamped to it.
    expect(scheduledTasks(m)).toContainEqual({
      whenSeconds: 60 * 60 + LOG_DRAIN_GRACE_SECONDS,
      callback: 'enforceTimeout',
    });
  });

  // The deploy token is minted *before* download + install + deploy, so its
  // TTL must cover the whole build (plan timeout + margin).
  it('sizes the deploy token TTL to the plan build timeout + margin', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // sponsored plan: 20-min build timeout. Token must outlive it.
    await m.startBuild(makeConfig({ timeoutMinutes: 20 }));

    const opts = vi.mocked(signDeployToken).mock.calls[0]?.[2];
    expect(opts?.ttlSeconds).toBe(20 * 60 + 5 * 60); // 25 min
    // Strictly longer than a fixed 15-min TTL.
    expect(opts?.ttlSeconds).toBeGreaterThan(15 * 60);
  });

  // The plan budget bounds build EXECUTION. The agent's exit-time drain barrier runs
  // AFTER that, with the container still `running` and the DO status still
  // `deploying` — the agent cannot report a terminal status by design. So an
  // `enforceTimeout` coming due inside the barrier wins its CAS and overwrites a
  // SUCCESSFUL, already-live deploy with 'build timed out'.
  it('arms the wall-clock timeout PAST the build budget, so the agent drain cannot trip it', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ timeoutMinutes: 10 }));

    // If broken: armed at exactly 10*60, so a build returning in the final
    // seconds of its budget gets killed mid-drain and reported as a timeout.
    // Asserts the SLACK rather than the literal, so the relation survives a retune
    // of either constant.
    const armed = scheduledTasks(m).find((t) => t.callback === 'enforceTimeout');
    expect(armed?.whenSeconds).toBeGreaterThanOrEqual(
      10 * 60 + LOG_DRAIN_ABSOLUTE_TIMEOUT_MS / 1000,
    );
  });

  it('keeps the drain grace inside the deploy token TTL — a build still cannot outlive its token', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ timeoutMinutes: 10 }));

    // Guard-rail against an over-large grace: read the TTL off the spy rather than
    // importing DEPLOY_TOKEN_MARGIN_SECONDS, which the deploy-token mock does not
    // re-export (it would be undefined).
    const armed = scheduledTasks(m).find((t) => t.callback === 'enforceTimeout');
    const ttlSeconds = vi.mocked(signDeployToken).mock.calls[0]?.[2]?.ttlSeconds;
    expect(ttlSeconds).toBeGreaterThan(0);
    expect(armed?.whenSeconds).toBeLessThan(ttlSeconds ?? 0);
  });

  it('grants enough grace to cover the agent drain barrier — two processes, one relation, so a test holds it', () => {
    // `container/build-agent.mjs` is plain JS copied into the image and cannot
    // import from `src/`, so the DO's grace and the agent's barrier deadline are two
    // separate literals. `>=` not `===`: the grace also has to cover the final
    // closeControlServer that runs after the barrier. (The exit path deliberately
    // does NOT flush — see `finishBuildLogging`; that push has no route to the DO
    // and awaiting it could only spend this grace.)
    expect(LOG_DRAIN_GRACE_SECONDS * 1000).toBeGreaterThanOrEqual(
      LOG_DRAIN_ABSOLUTE_TIMEOUT_MS + 5_000,
    );
  });

  it('keeps the agent alive past one full paginated drain and its acknowledgement tick', () => {
    // Worst alignment starts just after a poll: one second until the next callback,
    // up to LOG_DRAIN_BUDGET_MS inside it, then one second until a follow-up request
    // can acknowledge the cursor if that callback exhausted its budget. Equality
    // has no scheduling/ingest slack and lets the agent close on the boundary.
    expect(LOG_DRAIN_IDLE_TIMEOUT_MS).toBeGreaterThan(LOG_DRAIN_BUDGET_MS + 2_000);
    expect(LOG_DRAIN_ABSOLUTE_TIMEOUT_MS).toBeGreaterThan(
      MAX_LOG_PULL_PAGES * (LOG_PULL_TIMEOUT_MS + 1_000),
    );
    expect(LOG_TERMINAL_DRAIN_RETRY_WINDOW_MS + 1_000).toBeLessThanOrEqual(
      LOG_DRAIN_IDLE_TIMEOUT_MS,
    );
  });

  it('caps the deploy token TTL at the hard max for unlimited (timeoutMinutes=0) builds', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // custom plan: 0 = unlimited wall-clock. The token must still be bounded.
    await m.startBuild(makeConfig({ timeoutMinutes: 0 }));

    const opts = vi.mocked(signDeployToken).mock.calls[0]?.[2];
    // HARD_MAX (60 min) + margin (5 min) = 65 min, and never unbounded.
    expect(opts?.ttlSeconds).toBe(60 * 60 + 5 * 60);
  });

  it('fails the build (freeing the concurrency slot) when start-up throws before the timeout alarm is armed', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // A pre-alarm failure: token mint rejects. onError/onStop never fire here
    // (the container isn't running yet), so startBuild itself must fail the row
    // and free the slot — otherwise it stays `starting` forever.
    vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error('token mint failed'));

    // (a) the RPC rejects so the scheduler's defense-in-depth catch also engages.
    await expect(m.startBuild(makeConfig())).rejects.toThrow('token mint failed');

    // (b) the row was marked failed with the error message.
    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toBe('token mint failed');

    // (c) the scheduler was poked so the queue scan re-arms.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    // (d) the row is not left in an active status (would leak a concurrency slot).
    const activeWrite = dbState.writes.find((w) =>
      ['starting', 'building', 'deploying'].includes(w.status),
    );
    expect(activeWrite).toBeUndefined();

    // (e) a PRE-start failure must NOT stop() — the container never started,
    // so there's nothing to stop. start() itself was never reached either.
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
  });

  // A failure AFTER a successful this.start() (arming the timeout schedule) must stop
  // the already-running container before finalizing — otherwise it keeps running
  // the real `void deploy` CLI with a live token and can publish a deployment
  // while Postgres records the build as `failed`. The row must still be marked
  // failed and the scheduler poked, and stop() must not mask the original error.
  it('stops the container when a step AFTER start() throws, then still fails + pokes', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Arming the timeout schedule throws — this runs AFTER this.start() has
    // launched the container. The catch then issues
    // markBuildTerminalIfActive('failed'), which must succeed against the still-
    // active 'starting' row (default mock impl records it).
    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('postgres write failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('postgres write failed');
    expect(scheduleSpy).toHaveBeenCalled();

    // (a) the container was started, then stopped because the post-start step threw.
    expect(containerCalls.started).toBe(1);
    expect(containerCalls.stopped).toBe(1);

    // (b) the build is recorded failed with the original error (stop() didn't mask it).
    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toBe('postgres write failed');

    // (c) the scheduler was poked so the slot frees + the queue scan re-arms.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    scheduleSpy.mockRestore();
  });

  // Slot-safe finalization: if the terminal Postgres write in the startBuild catch
  // ITSELF hits a transient outage, pokeScheduler must STILL fire (it lives in a
  // `finally`) so the queue scan re-arms — otherwise the row is stranded `starting`
  // and pins the user's slot until the stale reaper. Mirrors onStop/onError/timeout.
  it('still pokes the scheduler when the terminal write throws in the startBuild catch (slot-safe)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Enter the catch via a post-start failure, then make the terminal CAS write
    // ALSO throw (the transient-outage-on-finalize case the finally must survive).
    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('postgres write failed'));
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('terminal write failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow();

    // Poked despite the terminal-write throw → the slot frees + the queue scan
    // re-arms instead of stranding the row until the reaper.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    scheduleSpy.mockRestore();
  });

  // Third teardown site, same invariant as enforceTimeout/cancelBuild: `builds.status`
  // is the deploy token's authority, and the teardown now drains logs for up to
  // 2x LOG_DRAIN_BUDGET_MS before it signals. While the row is still
  // `starting`/`building`, a runner already at final publish passes both
  // `middleware/auth.ts` and the go-live transaction's re-check and ships — even
  // though this manager has already decided startup failed.
  it('revokes the build row BEFORE draining logs in the startBuild catch', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const order: Array<string> = [];
    vi.mocked(markBuildTerminalIfActive).mockImplementationOnce(async () => {
      order.push('revoke');
      return true;
    });
    // Enter the catch AFTER the container launched, so the teardown drains.
    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('schedule arming failed'));
    const fetchFn = vi.fn(async () => {
      order.push('drain');
      return new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    await expect(m.startBuild(makeConfig())).rejects.toThrow('schedule arming failed');

    // If broken: ['drain', 'revoke'] — the token stays honored across the drain.
    expect(order).toEqual(['revoke', 'drain']);

    scheduleSpy.mockRestore();
  });

  // even if stop() itself throws on the post-start failure path, the ORIGINAL
  // error must propagate (stop() is best-effort and must not mask it), and the
  // build must still be finalized as failed.
  it('does not let a stop() failure mask the original post-start error', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Force the post-start schedule step to throw, and make stop() also throw.
    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('postgres write failed'));
    const stopSpy = vi
      .spyOn(m as unknown as { stop: () => Promise<void> }, 'stop')
      .mockRejectedValueOnce(new Error('container stop failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('postgres write failed');
    expect(stopSpy).toHaveBeenCalled();

    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toBe('postgres write failed');

    scheduleSpy.mockRestore();
    stopSpy.mockRestore();
  });

  // Load-shedding: when the global BuildManager fleet is at its `max_instances`
  // cap, `@cloudflare/containers` throws its capacity error out of start(). That
  // is transient platform pressure, NOT a build failure — the manager must NOT
  // mark the row failed (which would race the scheduler's requeue) and must NOT
  // stop() (nothing started). It re-throws so the scheduler's catch requeues it.
  it('does NOT fail or stop on the container-capacity error from start(); re-throws (load shed)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockRejectedValueOnce(
        new Error('there is no container instance that can be provided to this durable object'),
      );

    await expect(m.startBuild(makeConfig())).rejects.toThrow(/no container instance/);
    expect(startSpy).toHaveBeenCalled();

    // (a) the row was NOT marked failed — only the `starting` config persist from
    // startBuild's head ran; no status write reached Postgres.
    expect(lastWrite('failed')).toBeUndefined();
    expect(dbState.writes).toEqual([]);
    // The DB row is left exactly as the scheduler claimed it (`starting`).
    expect(dbState.status.get('b1')).toBe('starting');

    // (b) nothing was started, so nothing was stopped.
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);

    // (c) the scheduler was NOT poked from the capacity path — the scheduler's own
    // catch handles the requeue, and a poke would only churn the alarm.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).not.toHaveBeenCalled();

    startSpy.mockRestore();
  });

  // The container LAUNCHES, then onStart's `markBuildBuildingIfStarting` (a
  // Hyperdrive/Postgres write) throws — so the base start() rejects AFTER the
  // container is already live (modeled by the stub start() running onStart before
  // resolving). The catch must FORCE the live container down (SIGTERM→SIGKILL),
  // not leak it running the real `void deploy` CLI with a live token while
  // Postgres records the build `failed` and a fleet slot is pinned until the idle
  // net. If `containerStarted` only flipped after a resolved start(), this
  // onStart-reject would be treated as pre-launch and skip the teardown
  // (stopped/destroyed stay 0).
  it('force-stops the live container + fails + pokes when onStart throws inside start()', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // onStart's CAS write throws. The stub start() has already marked the
    // container running by the time it calls onStart, so this rejects start()
    // with the container live.
    vi.mocked(markBuildBuildingIfStarting).mockRejectedValueOnce(
      new Error('postgres write failed'),
    );

    await expect(m.startBuild(makeConfig())).rejects.toThrow('postgres write failed');

    // (a) the container DID launch and was then force-stopped (SIGTERM + SIGKILL).
    expect(containerCalls.started).toBe(1);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);

    // (b) the build is recorded failed (CAS, against the still-`starting` row that
    //     onStart never moved) with the original error.
    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toBe('postgres write failed');
    expect(dbState.status.get('b1')).toBe('failed');

    // (c) slot freed: scheduler poked so the queue scan re-arms.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  // A genuine PRE-launch failure (token mint throws BEFORE `containerStarted`
  // flips, above `await this.start()`): the manager fails the row + pokes but
  // must NOT stop()/destroy() a container that never launched. (Case (c).)
  it('does NOT tear down anything on a pre-launch failure (token mint throws before start())', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Token mint rejects — this runs ABOVE the `containerStarted = true` line, so
    // the catch sees `containerStarted === false` and skips teardown entirely.
    vi.mocked(getInstallationToken).mockRejectedValueOnce(new Error('token mint failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('token mint failed');

    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toBe('token mint failed');
    // Nothing launched, nothing torn down.
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    expect(containerCalls.destroyed).toBe(0);
    // Slot freed: scheduler poked so the queue scan re-arms.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  // the startBuild catch finalizes via the CAS `markBuildTerminalIfActive`,
  // NOT an unconditional write. If a concurrent cancel committed 'cancelled'
  // out-of-band (terminateBuildsForProject → cancelBuild RPC) while startBuild
  // was failing, an unconditional updateBuildStatus('failed') would clobber it.
  // The CAS must no-op on the already-terminal row (status stays 'cancelled'),
  // and pokeScheduler must still fire (the slot is already freed).
  it('does NOT clobber a concurrently-cancelled row in the startBuild catch', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // start() throws a non-capacity error; the concurrent cancel commits
    // 'cancelled' to the DB row before the catch's terminal write runs.
    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockImplementationOnce(async () => {
        dbState.status.set('b1', 'cancelled');
        throw new Error('image pull failed');
      });

    await expect(m.startBuild(makeConfig())).rejects.toThrow('image pull failed');

    // The CAS no-opped against the already-terminal row: status stays 'cancelled',
    // and the catch recorded NO 'failed' write (it would have clobbered the cancel).
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(dbState.writes.some((w) => w.status === 'failed')).toBe(false);
    // The scheduler is still poked so the freed slot is reclaimed.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();

    startSpy.mockRestore();
  });

  // `sleepAfter` is an IDLE safety-net, not the wall-clock cap. It must sit
  // ABOVE the deploy-token hard max so a legitimately busy build that runs up to
  // the hard max is never idle-stopped before `enforceTimeout` fires (a fixed
  // '30m' sleepAfter would stop a 60-min custom-plan build at 30m).
  it('sizes sleepAfter ABOVE the deploy-token hard max', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Effective sleepAfter (minutes) parsed from the configured '<n>m' string.
    const sleepAfter = (m as unknown as { sleepAfter: string }).sleepAfter;
    expect(sleepAfter).toMatch(/^\d+m$/);
    const sleepAfterMinutes = Number.parseInt(sleepAfter, 10);
    // DEPLOY_TOKEN_HARD_MAX_MINUTES is mocked to 60 above; the idle net must be
    // strictly larger so it can never cut a build at the hard max short.
    expect(sleepAfterMinutes).toBeGreaterThan(60);
  });

  // the scheduler claimed the row (`queued -> starting`) potentially ~30min
  // ago; a disconnect / branch-executor change could have cancelled it out-of-
  // band in that window. startBuild must re-read builds.status AFTER the branch-
  // head + coverage rechecks and BEFORE minting the deploy token: a non-'starting'
  // row mints no token, starts no container, syncs the local terminal status, and
  // pokes the scheduler — mirroring the non-identical freshness branch.
  it('mints no token + starts no container when the row was cancelled after the claim', async () => {
    // Freshness + coverage both pass (defaults), but the build row is already
    // 'cancelled' by the time startBuild re-reads it.
    dbState.status.set('b1', 'cancelled');
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    // NO deploy token minted and NO container started.
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    // The row was NOT re-terminalized (the canceller already wrote it); status
    // stays 'cancelled' and no new terminal write was recorded by startBuild.
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(dbState.writes).toEqual([]);
    // The local DO status was synced to the terminal status so a later onStart/
    // onStop can't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
    // The scheduler was poked so the freed slot is reclaimed.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('does not launch after cancellation completes while the source token is awaiting', async () => {
    const tokenStarted = createDeferred<void>();
    const releaseToken = createDeferred<void>();
    vi.mocked(getInstallationToken).mockImplementationOnce(async () => {
      tokenStarted.resolve(undefined);
      await releaseToken.promise;
      return 'late-install-token';
    });

    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    const starting = m.startBuild(makeConfig());
    await tokenStarted.promise;

    await m.cancelBuild('build superseded');
    expect(dbState.status.get('b1')).toBe('cancelled');
    releaseToken.resolve(undefined);
    await starting;

    // The cancelled build-bound deploy token stays revoked and the continuation
    // holding the newly returned source token never consumes fleet capacity.
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    expect(dbState.writes.some((write) => write.status === 'building')).toBe(false);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
    expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('does not mint a source token when cancellation finishes during deploy-token signing', async () => {
    const signing = createDeferred<void>();
    const releaseToken = createDeferred<string>();
    vi.mocked(signDeployToken).mockImplementationOnce(async () => {
      signing.resolve(undefined);
      return releaseToken.promise;
    });
    const ctx = makeStubCtx();
    const m = makeManager(ctx, makeEnv());
    const starting = m.startBuild(makeConfig());
    await signing.promise;
    await m.cancelBuild('build superseded');
    releaseToken.resolve('late-deploy-token');
    await starting;

    expect(getInstallationToken).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
  });

  it('coalesces duplicate scheduler deliveries and allows a fresh capacity retry', async () => {
    const tokenStarted = createDeferred<void>();
    const releaseToken = createDeferred<string>();
    vi.mocked(getInstallationToken).mockImplementationOnce(async () => {
      tokenStarted.resolve(undefined);
      return releaseToken.promise;
    });
    const m = makeManager(makeStubCtx(), makeEnv());
    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockRejectedValueOnce(
        new Error('there is no container instance that can be provided to this durable object'),
      );
    const first = m.startBuild(makeConfig());
    const firstResult = expect(first).rejects.toThrow('no container instance');
    await tokenStarted.promise;
    const duplicate = m.startBuild(makeConfig());
    const duplicateResult = expect(duplicate).rejects.toThrow('no container instance');
    releaseToken.resolve('install-token');
    await Promise.all([firstResult, duplicateResult]);
    expect(getInstallationToken).toHaveBeenCalledOnce();
    expect(startSpy).toHaveBeenCalledOnce();
    expect(dbState.status.get('b1')).toBe('starting');

    // The scheduler reclaims the requeued row before its next RPC. The rejected
    // attempt must release the coalescing gate and its aborted generation.
    startSpy.mockRestore();
    await m.startBuild(makeConfig());
    expect(getInstallationToken).toHaveBeenCalledTimes(2);
    expect(containerCalls.started).toBe(1);
    expect(dbState.status.get('b1')).toBe('building');
  });

  it('kills a producer launched after cancellation saw no container, before completing its logs', async () => {
    const preparingLaunch = createDeferred<void>();
    const releaseLaunch = createDeferred<void>();
    const ctx = makeStubCtx();
    ctx._kv.set('checkRunId', '99001');
    const m = makeManager(ctx, makeEnv());
    const startSpy = vi
      .spyOn(
        m as unknown as {
          start: (options?: unknown, wait?: { signal?: AbortSignal }) => Promise<void>;
        },
        'start',
      )
      .mockImplementationOnce(async (_options, wait) => {
        // The real base awaits scheduleNextAlarm/refreshOutboundInterception
        // before container.start(), and checks abort only during readiness.
        preparingLaunch.resolve(undefined);
        await releaseLaunch.promise;
        containerCalls.started += 1;
        (m as unknown as { _containerRunning: boolean })._containerRunning = true;
        expect(wait?.signal?.aborted).toBe(true);
        throw new Error('Aborted waiting for container to start');
      });
    const starting = m.startBuild(makeConfig());
    await preparingLaunch.promise;
    await m.cancelBuild('build superseded');
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'open' });
    expect(completeCheckRun).not.toHaveBeenCalled();

    releaseLaunch.resolve(undefined);
    await starting;

    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(false);
    expect(ctx._logs.filter((row) => row.line.includes('container terminated'))).toEqual([
      expect.objectContaining({
        line: '[build-manager] container terminated: build superseded',
      }),
    ]);
    expect(ctx._kv.get('logDrainState')).toMatchObject({
      state: 'complete',
      finalSeq: ctx._logs.at(-1)?.seq,
    });
    expect(completeCheckRun).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({
      conclusion: 'cancelled',
      text: expect.stringContaining('container terminated: build superseded'),
    });
    expect(scheduledTasks(m).some((task) => task.callback === 'enforceTimeout')).toBe(false);
    startSpy.mockRestore();
  });

  it.each(['cancelled', 'failed', 'complete', 'queued', null])(
    'tears down an unclaimed launch when onStart finds an out-of-band %s row',
    async (status) => {
      const tokenStarted = createDeferred<void>();
      const releaseToken = createDeferred<string>();
      vi.mocked(getInstallationToken).mockImplementationOnce(async () => {
        tokenStarted.resolve(undefined);
        return releaseToken.promise;
      });
      const ctx = makeStubCtx();
      ctx._kv.set('checkRunId', '99001');
      const m = makeManager(ctx, makeEnv());
      const starting = m.startBuild(makeConfig());
      await tokenStarted.promise;
      // The transaction committed, but its best-effort cancel RPC has not
      // arrived. Only the onStart CAS can detect this remote winner.
      if (status === null) {
        dbState.status.delete('b1');
      } else {
        dbState.status.set('b1', status);
      }
      releaseToken.resolve('install-token');
      await starting;

      expect(containerCalls.started).toBe(1);
      expect(containerCalls.stopped).toBe(1);
      expect(containerCalls.destroyed).toBe(1);
      expect(dbState.status.get('b1')).toBe(status ?? undefined);
      expect(dbState.writes).toEqual([]);
      expect(ctx._logs.filter((row) => row.line.includes('container terminated'))).toHaveLength(1);
      expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
      expect(scheduledTasks(m).some((task) => task.callback === 'enforceTimeout')).toBe(false);
      if (status === 'cancelled' || status === 'failed' || status === 'complete') {
        expect(completeCheckRun).toHaveBeenCalledOnce();
        expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({
          conclusion:
            status === 'complete' ? 'success' : status === 'failed' ? 'failure' : 'cancelled',
        });
      }
    },
  );

  it('bounds a hung startup CAS and tears down before its late result can restore authority', async () => {
    vi.useFakeTimers();
    const claimed = createDeferred<void>();
    const releaseClaim = createDeferred<void>();
    vi.mocked(markBuildBuildingIfStarting).mockImplementationOnce(async (_db, id) => {
      claimed.resolve(undefined);
      await releaseClaim.promise;
      // Model the real guarded UPDATE when it finally acquires its row lock.
      if (dbState.status.get(id) !== 'starting') {
        return false;
      }
      dbState.status.set(id, 'building');
      return true;
    });
    const ctx = makeStubCtx();
    const m = makeManager(ctx, makeEnv());
    try {
      const starting = m.startBuild(makeConfig());
      const result = expect(starting).rejects.toThrow('startup claim did not settle');
      await claimed.promise;
      await vi.advanceTimersByTimeAsync(TERMINAL_WRITE_TIMEOUT_MS);
      await result;
      expect(dbState.status.get('b1')).toBe('failed');
      expect(containerCalls.stopped).toBe(1);
      expect(containerCalls.destroyed).toBe(1);
      releaseClaim.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(dbState.status.get('b1')).toBe('failed');
      expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
    } finally {
      releaseClaim.resolve(undefined);
      vi.useRealTimers();
    }
  });

  it('tears down a cancelled launch when the real-class start order reaches onStart late', async () => {
    const launched = createDeferred<void>();
    const releaseOnStart = createDeferred<void>();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    const startSpy = vi
      .spyOn(
        m as unknown as {
          start: (options?: unknown, wait?: { signal?: AbortSignal }) => Promise<void>;
        },
        'start',
      )
      .mockImplementationOnce(async (_options, wait) => {
        // Match @cloudflare/containers: launch first, await readiness, then call
        // onStart before resolving. Cancellation lands in that middle window.
        containerCalls.started += 1;
        (m as unknown as { _containerRunning: boolean })._containerRunning = true;
        launched.resolve(undefined);
        await releaseOnStart.promise;
        expect(wait?.signal?.aborted).toBe(true);
        await m.onStart();
      });

    const starting = m.startBuild(makeConfig());
    await launched.promise;
    await m.cancelBuild('build superseded');
    releaseOnStart.resolve(undefined);
    await starting;

    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(dbState.writes.some((write) => write.status === 'building')).toBe(false);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(false);
    expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
    expect(ctx._logs.filter((row) => row.line.includes('container terminated'))).toHaveLength(1);
    expect(scheduledTasks(m).some((task) => task.callback === 'enforceTimeout')).toBe(false);
    startSpy.mockRestore();
  });

  it('still tears down a cancelled launch when the Postgres revocation fails', async () => {
    const launched = createDeferred<void>();
    const releaseOnStart = createDeferred<void>();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(
      new Error('postgres cancellation failed'),
    );
    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockImplementationOnce(async () => {
        containerCalls.started += 1;
        (m as unknown as { _containerRunning: boolean })._containerRunning = true;
        launched.resolve(undefined);
        await releaseOnStart.promise;
        await m.onStart();
      });

    const starting = m.startBuild(makeConfig());
    await launched.promise;
    await expect(m.cancelBuild('build superseded')).rejects.toThrow('postgres cancellation failed');
    releaseOnStart.resolve(undefined);
    await starting;

    // Database uncertainty never gates fleet cleanup, and the aborted late
    // onStart callback cannot restore `building` authority afterward.
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(false);
    expect(dbState.writes.some((write) => write.status === 'building')).toBe(false);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    startSpy.mockRestore();
  });
});

// The container build agent uses SOURCE_TOKEN only as the Bearer to download
// the ONE repo's tarball, but it is injected into the container env where a
// malicious dependency `postinstall` could read it. To cap that blast radius,
// startBuild always mints the source token REPO-SCOPED + read-only; a build
// without a repository id is cancelled before any token is minted.
describe('BuildManager.startBuild source-token scoping', () => {
  it('mints a repo-scoped, read-only source token when repositoryId is non-null', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ repositoryId: 'repo1' }));

    // The SOURCE_TOKEN mint is scoped to exactly this repo with contents:read.
    // Signature: getInstallationToken(env, installationId, opts).
    expect(vi.mocked(getInstallationToken)).toHaveBeenCalledWith(expect.anything(), 'inst1', {
      repositoryIds: ['repo1'],
      permissions: { contents: 'read' },
    });
    // The build still starts (the scope is additive; the happy path is unchanged).
    expect(containerCalls.started).toBe(1);
    const envVars = (m as unknown as { envVars: Record<string, string> }).envVars;
    expect(envVars.SOURCE_TOKEN).toBe('install-token');
  });

  it('passes the connection repositoryId straight through to the scope', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ repositoryId: 'repo-42' }));

    expect(vi.mocked(getInstallationToken)).toHaveBeenCalledWith(expect.anything(), 'inst1', {
      repositoryIds: ['repo-42'],
      permissions: { contents: 'read' },
    });
  });
});

// The container executor starts from the queued row's stored commit_sha
// with NO freshness recheck. The push webhook checks at ENQUEUE, but a
// missed/delayed newer-push webhook can leave a stale queued build the scheduler
// runs and publishes. startBuild must do a JIT branch-head recheck BEFORE
// minting VOID_TOKEN (mirroring the OIDC path): only 'identical' proceeds;
// ahead/behind/diverged cancels; null requeues (or age-fails) — and in every
// non-identical case NO token is minted and NO container is started.
describe('BuildManager.startBuild freshness recheck', () => {
  for (const comparison of ['ahead', 'behind', 'diverged'] as const) {
    it(`cancels (no mint, no start) when the branch head is '${comparison}' (stale commit)`, async () => {
      vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(comparison);
      const ctx = makeStubCtx();
      const env = makeEnv();
      const m = makeManager(ctx, env);

      await m.startBuild(makeConfig());

      // The build was cancelled via the CAS — the commit is no longer the head.
      const cancelled = lastWrite('cancelled');
      expect(cancelled).toBeDefined();
      expect(cancelled?.id).toBe('b1');
      expect(cancelled?.opts?.error).toMatch(/no longer the branch head/);
      expect(dbState.status.get('b1')).toBe('cancelled');
      // NO deploy token was minted and NO container was started.
      expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
      expect(containerCalls.started).toBe(0);
      expect(containerCalls.stopped).toBe(0);
      // The scheduler was poked so the freed slot is reclaimed.
      expect(
        (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
          .get,
      ).toHaveBeenCalled();
    });
  }

  it('requeues a FRESH build (no mint, no start) when the head comparison is unverifiable (null)', async () => {
    // GitHub compare API unreachable → null. A recently-created build is bounced
    // back to `queued` (guarded CAS) so the next alarm retries it.
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    dbState.createdAt = new Date().toISOString(); // fresh
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    // Requeued via the guarded CAS — not failed, not cancelled.
    expect(dbState.requeued).toEqual(['b1']);
    expect(dbState.status.get('b1')).toBe('queued');
    expect(lastWrite('failed')).toBeUndefined();
    expect(lastWrite('cancelled')).toBeUndefined();
    // NO mint, NO start.
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    // Scheduler poked so the alarm retries.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('fails an OLD build (older than the max age) when the head comparison stays unverifiable (null)', async () => {
    // A persistently-null comparison can't loop forever: no container is started
    // on this path, so nothing would ever reap it. Past the max age, fail it.
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    // 31 min old > FRESHNESS_VERIFY_MAX_AGE_MS (30 min).
    dbState.createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.id).toBe('b1');
    expect(failed?.opts?.error).toMatch(/could not verify branch head/);
    expect(dbState.status.get('b1')).toBe('failed');
    // Not requeued — it was terminalized instead.
    expect(dbState.requeued).toEqual([]);
    // NO mint, NO start.
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it("proceeds to mint + start when the branch head is 'identical' (default)", async () => {
    // The default mock returns 'identical', so startBuild proceeds exactly as the
    // happy-path tests expect: token minted, container started, timeout armed.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(vi.mocked(signDeployToken)).toHaveBeenCalledOnce();
    expect(containerCalls.started).toBe(1);
    expect(scheduledTasks(m)).toContainEqual({
      whenSeconds: 10 * 60 + LOG_DRAIN_GRACE_SECONDS,
      callback: 'enforceTimeout',
    });
  });
});

// startBuild mints the deploy + source tokens AFTER a queue wait (seconds to
// ~30min under capacity backoff). The enqueue-time `installationCoversRepoInTx`
// check is stale by then: a TOCTOU where an uninstall / App-suspension /
// repo-removal webhook commits its `github_installations` update during that
// window must NOT result in a deploy after access was revoked. startBuild does
// a fresh, non-locking Postgres coverage re-read BEFORE minting — only a covered
// install proceeds; an uncovered (or null-repo-id) install fails closed
// (cancelled), with NO token minted and NO container started.
describe('BuildManager.startBuild installation coverage recheck (TOCTOU)', () => {
  it('cancels (no mint, no start) when the App installation no longer covers the repo', async () => {
    // An uninstall/suspension/repo-removal raced the queue wait — the row is no
    // longer covered. The freshness gate still says 'identical' (default mock).
    dbState.installationCovered = false;
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    // Cancelled via the CAS — coverage was revoked.
    const cancelled = lastWrite('cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled?.id).toBe('b1');
    expect(cancelled?.opts?.error).toMatch(/reconnect the repository/i);
    expect(dbState.status.get('b1')).toBe('cancelled');
    // NO deploy token minted and NO container started.
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
    expect(containerCalls.stopped).toBe(0);
    // The coverage helper was consulted with this build's installation + repo id.
    expect(vi.mocked(installationCoversRepo)).toHaveBeenCalledWith(
      expect.anything(),
      'connection-1',
      'p1',
      'inst1',
      'repo1',
    );
    // Scheduler poked so the freed slot is reclaimed.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('fails closed (cancels) when a stored build config has no connection id', async () => {
    // Durable Object state written before the connection id was recorded can
    // still be replayed once; it must cancel rather than crash or start.
    dbState.installationCovered = true;
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ connectionId: undefined }));

    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(lastWrite('cancelled')?.opts?.error).toMatch(/reconnect the repository/i);
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(containerCalls.started).toBe(0);
  });

  it('proceeds to mint + start when the installation still covers the repo (happy path)', async () => {
    dbState.installationCovered = true;
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(vi.mocked(installationCoversRepo)).toHaveBeenCalledWith(
      expect.anything(),
      'connection-1',
      'p1',
      'inst1',
      'repo1',
    );
    expect(vi.mocked(signDeployToken)).toHaveBeenCalledOnce();
    expect(containerCalls.started).toBe(1);
    expect(scheduledTasks(m)).toContainEqual({
      whenSeconds: 10 * 60 + LOG_DRAIN_GRACE_SECONDS,
      callback: 'enforceTimeout',
    });
  });
});

describe('BuildManager.onStop', () => {
  it('exit code 0 → complete and links the deployment', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = []; // ignore the startBuild write
    dbState.deployment = { id: 'dpl_123' };

    await m.onStop({ exitCode: 0, reason: 'exit' });

    const complete = lastWrite('complete');
    expect(complete).toBeDefined();
    expect(complete?.opts?.exitCode).toBe(0);
    expect(complete?.opts?.deploymentId).toBe('dpl_123');
    // Scheduler poked so the next queued build can start.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('non-zero exit code → failed with the exit code and reason', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    await m.onStop({ exitCode: 137, reason: 'runtime_signal' });

    const failed = lastWrite('failed');
    expect(failed).toBeDefined();
    expect(failed?.opts?.exitCode).toBe(137);
    expect(failed?.opts?.error).toMatch(/137/);
  });

  it('does not overwrite an already-terminal status (timeout then onStop)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    // Timeout fires first → failed (via the base scheduler invoking enforceTimeout).
    await runDueSchedules(m);
    dbState.writes = [];

    // The container's own onStop fires afterward with a signal exit.
    await m.onStop({ exitCode: 137, reason: 'runtime_signal' });

    // No new status write — the timeout outcome stands.
    expect(dbState.writes.filter((w) => w.status === 'complete' || w.status === 'failed')).toEqual(
      [],
    );
  });

  // `markBuildTerminalIfActive` has no internal try/catch, so a transient
  // Postgres throw on the exit-0 terminal write must NOT skip pokeScheduler() —
  // otherwise the row stays ACTIVE and pins the concurrency slot until the 75m
  // idle reaper even though the container exited and the deploy is live. Mirrors
  // enforceTimeout / cancelBuild: setStatus first, then try/finally(poke).
  it('still pokes the scheduler when the exit-0 terminal DB write throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    // The terminal write rejects (and surfaces), but the slot must already be
    // freed: pokeScheduler ran in the `finally` despite the rejection.
    await expect(m.onStop({ exitCode: 0, reason: 'exit' })).rejects.toThrow(
      'postgres write failed',
    );

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    // Local DO status was set terminal BEFORE the failing write, so a later guard
    // won't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'complete' });
  });

  it('still terminalizes and releases the scheduler when log completion persistence fails', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();
    dbState.writes = [];

    const originalPut = ctx.storage.put.getMockImplementation()!;
    ctx.storage.put.mockImplementation(async (key: string, value: unknown) => {
      if (
        key === 'logDrainState' &&
        typeof value === 'object' &&
        value !== null &&
        (value as { state?: string }).state === 'complete'
      ) {
        throw new Error('sqlite metadata unavailable');
      }
      await originalPut(key, value);
    });

    await expect(m.onStop({ exitCode: 0, reason: 'exit' })).resolves.toBeUndefined();

    expect(lastWrite('complete')).toBeDefined();
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  // failure branch: same decoupling for a non-zero exit — a Postgres throw
  // on the 'failed' terminal write must not strand the freed slot.
  it('still pokes the scheduler when the non-zero terminal DB write throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    await expect(m.onStop({ exitCode: 137, reason: 'runtime_signal' })).rejects.toThrow(
      'postgres write failed',
    );

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
  });

  // The exit-0 deployment lookup is BEST-EFFORT and runs AFTER
  // `void deploy` has already exited 0. A transient Hyperdrive/Postgres throw on
  // it must NOT strand the build — onStop must still finalize 'complete' (with a
  // null link) and poke the scheduler. Otherwise the row stays ACTIVE and the
  // slot is pinned until the 75m idle reaper while the deploy is already live.
  it('finalizes complete + pokes the scheduler when the exit-0 deployment lookup throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];
    dbState.deployment = { id: 'dpl_123' };
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    // Lookup rejects once, AFTER the exit-0 (deploy already succeeded).
    vi.mocked(getDeploymentByProjectAndCommit).mockRejectedValueOnce(
      new Error('hyperdrive lookup failed'),
    );

    // Does NOT reject — the lookup error is swallowed.
    await m.onStop({ exitCode: 0, reason: 'exit' });

    // The build is still finalized 'complete', just without the deployment link.
    const complete = lastWrite('complete');
    expect(complete).toBeDefined();
    expect(complete?.opts?.exitCode).toBe(0);
    expect(complete?.opts?.deploymentId).toBeNull();
    // Slot freed — the next queued build can start.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    // Local DO status is terminal so a later guard won't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'complete' });
  });
});

describe('BuildManager.onError', () => {
  it('records failed with the error message', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];
    // The container is still live here, so onError drains before it finalizes. An
    // unstubbed port fetch would throw and burn the whole retry window on real
    // timers; answer immediately with nothing to pull.
    (m as unknown as { _portFetch: () => Promise<Response> })._portFetch = async () =>
      new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    await m.onError(new Error('boom'));

    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toBe('boom');
  });

  // `onError` is the ONE terminalizer that does not force-stop, so nothing else has
  // drained when it finalizes. `pollLogs`' terminal branch does pull, but up to
  // POLL_SECONDS later — after the check run is already completed — so its tail
  // reaches the log APIs while being permanently absent from the check run a reader
  // actually opens. That is the "check run that ends with no cause" this whole area
  // exists to eliminate.
  it('drains the log tail BEFORE completing the check run', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    // Finalize resolves the run id from DO storage (create is inert in this file).
    ctx._kv.set('checkRunId', '99001');

    const order: Array<string> = [];
    const fetchFn = vi.fn(async () => {
      order.push('drain');
      return new RealResponse(
        JSON.stringify({
          lines: [{ seq: 4, line: 'FATAL: out of memory', stream: 'stderr', ts: 4 }],
          lastSeq: 4,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    vi.mocked(completeCheckRun).mockImplementationOnce(async () => {
      order.push('finalize');
      return false;
    });

    await m.onError(new Error('container crashed'));

    // If broken: ['finalize'] only — the diagnostic never reaches the check run.
    expect(order).toEqual(['drain', 'finalize']);
    expect(ctx._logs.map((r) => r.line)).toContain('FATAL: out of memory');
  });

  it('retries a transient terminal pull before completing the check run', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    ctx._kv.set('checkRunId', '99001');

    const order: Array<string> = [];
    let fetchAttempt = 0;
    const fetchFn = vi.fn(async (_url: string, _port: number, _init?: RequestInit) => {
      fetchAttempt += 1;
      const attempt = fetchAttempt;
      if (attempt === 1) {
        order.push('pull-failed');
        throw new Error('agent port temporarily unavailable');
      }
      if (attempt === 2) {
        order.push('pull-tail');
        return new RealResponse(
          JSON.stringify({
            lines: [{ seq: 7, line: 'FATAL: recovered tail', stream: 'stderr', ts: 7 }],
            lastSeq: 7,
            hasMore: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      order.push('pull-ack');
      return new RealResponse(JSON.stringify({ lines: [], lastSeq: 7, hasMore: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    vi.mocked(completeCheckRun).mockImplementationOnce(async () => {
      order.push('finalize');
      return false;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.useFakeTimers();
    try {
      const run = m.onError(new Error('container crashed'));
      await vi.advanceTimersByTimeAsync(LOG_TERMINAL_DRAIN_RETRY_WINDOW_MS);
      await run;
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      'http://manager/logs?since=0',
      'http://manager/logs?since=0',
      'http://manager/logs?since=7',
    ]);
    expect(ctx._logs.map((row) => row.line)).toContain('FATAL: recovered tail');
    expect(order).toEqual(['pull-failed', 'pull-tail', 'pull-ack', 'finalize']);
  });

  it('does not start a fresh onError pull while a concurrent teardown owns the tail', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    ctx._kv.set('checkRunId', '99001');
    vi.mocked(completeCheckRun).mockClear();

    let releaseTerminalWrite!: () => void;
    const terminalWriteGate = new Promise<void>((resolve) => {
      releaseTerminalWrite = resolve;
    });
    let markTerminalWriteEntered!: () => void;
    const terminalWriteEntered = new Promise<void>((resolve) => {
      markTerminalWriteEntered = resolve;
    });
    vi.mocked(markBuildTerminalIfActive).mockImplementationOnce(async () => {
      // The write has committed authoritatively, but onError has not resumed yet.
      dbState.status.set('b1', 'failed');
      markTerminalWriteEntered();
      await terminalWriteGate;
      return true;
    });

    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let markStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      markStopEntered = resolve;
    });
    (m as unknown as { stop: () => Promise<void> }).stop = vi.fn(async () => {
      containerCalls.stopped += 1;
      markStopEntered();
      await stopGate;
      (m as unknown as { _containerRunning: boolean })._containerRunning = false;
    });

    const fetchFn = vi.fn(
      async () =>
        new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    const onError = m.onError(new Error('container crashed'));
    await terminalWriteEntered;
    const cancel = m.cancelBuild('build superseded');
    await stopEntered;

    releaseTerminalWrite();
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    // The teardown already took the only final snapshot. onError joins it instead
    // of opening a second request during stop(), and therefore cannot finalize yet.
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();

    releaseStop();
    await Promise.all([onError, cancel]);

    expect(fetchFn).toHaveBeenCalledOnce();
    // Both surviving terminalizers may issue the same idempotent PATCH: cancel must
    // recover when onError was lost, while onError still finalizes when it survives.
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalled();
  });

  it('joins a teardown that begins during a successful onError pull', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    ctx._kv.set('checkRunId', '99001');
    vi.mocked(completeCheckRun).mockClear();

    let releaseOnErrorPull!: () => void;
    const onErrorPullGate = new Promise<void>((resolve) => {
      releaseOnErrorPull = resolve;
    });
    let markOnErrorPullEntered!: () => void;
    const onErrorPullEntered = new Promise<void>((resolve) => {
      markOnErrorPullEntered = resolve;
    });
    let releaseTeardownPull!: () => void;
    const teardownPullGate = new Promise<void>((resolve) => {
      releaseTeardownPull = resolve;
    });
    let markTeardownPullEntered!: () => void;
    const teardownPullEntered = new Promise<void>((resolve) => {
      markTeardownPullEntered = resolve;
    });

    let fetchAttempt = 0;
    const fetchFn = vi.fn(async (_url: string, _port: number, _init?: RequestInit) => {
      fetchAttempt += 1;
      if (fetchAttempt === 1) {
        markOnErrorPullEntered();
        await onErrorPullGate;
      } else {
        markTeardownPullEntered();
        await teardownPullGate;
      }
      return new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    const onError = m.onError(new Error('container crashed'));
    await onErrorPullEntered;
    const cancel = m.cancelBuild('build superseded');

    // The cancel joins this already-frozen snapshot, then owns a fresh teardown
    // pull. onError must notice that gate after its successful await and join it.
    releaseOnErrorPull();
    await teardownPullEntered;
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();

    releaseTeardownPull();
    await Promise.all([onError, cancel]);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalled();
  });

  // A transient Postgres throw on onError's terminal write must not skip
  // setStatus('failed') and pokeScheduler(), or the row stays ACTIVE and the slot
  // is pinned until the 75m reaper. Mirrors onStop / enforceTimeout: local status
  // first, DB write in a try whose finally always pokes.
  it('still pokes the scheduler + sets local failed when the onError terminal DB write throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));
    (m as unknown as { _portFetch: (url: string) => Promise<Response> })._portFetch = vi.fn(
      async () =>
        new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    // The terminal write rejects (and surfaces), but the slot must already be
    // freed: pokeScheduler ran in the finally despite the rejection.
    await expect(m.onError(new Error('boom'))).rejects.toThrow('postgres write failed');

    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    // Local DO status was set terminal BEFORE the failing write, so a later guard
    // won't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
  });
});

// Lifecycle status races: the base `start()`
// runs onStart inside `blockConcurrencyWhile` BEFORE resolving, and a
// fast-exiting container's onStop can fire too. The DB row must never be
// resurrected to `starting`/`building` after a terminal outcome, and a duplicate
// terminal write must never clobber the first. The authoritative guard is the
// compare-and-set in db.ts (markBuildBuildingIfStarting / markBuildTerminalIfActive),
// not the in-memory `config.status` early-returns (which only see the DO copy).
describe('BuildManager lifecycle status-race CAS guards', () => {
  it.each(['building', 'deploying'])(
    'preserves a legitimate late onStart callback for %s',
    async (status) => {
      const ctx = makeStubCtx();
      const m = makeManager(ctx, makeEnv());
      await m.startBuild(makeConfig());
      dbState.status.set('b1', status);
      dbState.writes = [];

      await m.onStart();

      expect(dbState.status.get('b1')).toBe(status);
      expect(ctx._kv.get('buildConfig')).toMatchObject({ status });
      expect(containerCalls.stopped).toBe(0);
      expect(containerCalls.destroyed).toBe(0);
      expect(dbState.writes).toEqual([]);
      expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'open' });
    },
  );

  it('a fast-exit onStop right after startBuild lands a terminal row that is never reset to starting', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // The DB row is `starting` (scheduler claim). startBuild does not write
    // status, so a fast-exit onStop fires immediately after start().
    await m.startBuild(makeConfig());
    await m.onStop({ exitCode: 0, reason: 'exit' });

    // The terminal outcome stands in the DB — there is no later `starting`
    // write in startBuild that could downgrade it. The row ends
    // `complete`, and `starting` was never (re)written by startBuild.
    expect(dbState.status.get('b1')).toBe('complete');
    expect(dbState.writes.some((w) => w.status === 'starting')).toBe(false);
    expect(lastWrite('complete')).toBeDefined();
  });

  it('onStart does NOT resurrect a row a fast-exit onStop already drove terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Simulate the fast-exit onStop having already finalized the DB row, then a
    // delayed second onStart firing. The in-memory config still says active
    // ('building' from the startBuild onStart), so the in-memory guard would NOT
    // catch this — only the DB-level CAS does.
    dbState.status.set('b1', 'failed');
    dbState.writes = [];

    await m.onStart();

    // markBuildBuildingIfStarting is a no-op: the row stays terminal, no write.
    expect(dbState.status.get('b1')).toBe('failed');
    expect(dbState.writes).toEqual([]);
  });

  it('a duplicate/late terminal write does not clobber the first terminal outcome', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // First terminal outcome: a clean exit → complete, linked to a deployment.
    dbState.deployment = { id: 'dpl_first' };
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(dbState.status.get('b1')).toBe('complete');
    dbState.writes = [];

    // A duplicate/late onStop arrives with a different (failure) outcome. The
    // in-memory guard catches the obvious replay; force-prove the DB CAS too by
    // calling the terminal helper directly with the row already terminal.
    await m.onStop({ exitCode: 137, reason: 'runtime_signal' });
    const { markBuildTerminalIfActive } = await import('../../src/db.ts');
    const moved = await markBuildTerminalIfActive(
      {} as unknown as Parameters<typeof markBuildTerminalIfActive>[0],
      'b1',
      'failed',
      { exitCode: 137 },
    );

    // No clobber: the row is still `complete`, the CAS returned false, and no new
    // terminal write was recorded.
    expect(moved).toBe(false);
    expect(dbState.status.get('b1')).toBe('complete');
    expect(dbState.writes).toEqual([]);
  });
});

describe('BuildManager timeout integration (base-owned alarm + scheduled enforceTimeout)', () => {
  it('does NOT override alarm() — the base Container owns the DO alarm loop', () => {
    // A manager-level alarm() override would treat every base
    // monitor tick as a timeout (failing healthy builds) AND starve the base
    // loop that dispatches onStop. The manager must inherit the base alarm.
    const proto = Object.getPrototypeOf(BuildManager.prototype) as Record<string, unknown>;
    expect(Object.hasOwn(BuildManager.prototype, 'alarm')).toBe(false);
    // The inherited alarm is the base one (defined on the parent prototype).
    expect(typeof proto.alarm).toBe('function');
  });

  it('a base alarm BEFORE the deadline does not fail a healthy build, and onStop still finalizes', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    // Base alarm fires for its own monitor cadence (no schedule is due yet).
    // It must NOT touch build state — the build stays active. After startBuild the
    // status is 'building' (onStart ran inside the base start(), as in production).
    await m.alarm();
    expect(containerCalls.baseAlarms).toBe(1);
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });

    // The base lifecycle still finalizes the build via onStop on a clean exit.
    dbState.deployment = { id: 'dpl_ok' };
    await m.onStop({ exitCode: 0, reason: 'exit' });
    const complete = lastWrite('complete');
    expect(complete).toBeDefined();
    expect(complete?.opts?.deploymentId).toBe('dpl_ok');
    // No timeout failure was recorded.
    expect(dbState.writes.some((w) => w.opts?.error === 'build timed out')).toBe(false);
  });

  it('crossing the deadline fails the build, stops the container, and frees the slot', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    // The base alarm loop invokes the scheduled enforceTimeout callback when due.
    await runDueSchedules(m);

    expect(containerCalls.stopped).toBe(1);
    const failed = lastWrite('failed');
    expect(failed?.opts?.error).toMatch(/timed out/);
    // Slot freed: scheduler poked so the next queued build can start.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('force-kills the container via destroy() (SIGKILL) on timeout, not just stop() (SIGTERM)', async () => {
    // The real base `stop()` only SIGTERMs; a build whose PID-1 agent ignores
    // SIGTERM (or a wedged install child) survives it and pins a global fleet
    // slot forever, since the STALE reaper only re-cancels rows still ACTIVE and
    // this row is already terminal. enforceTimeout must escalate to destroy()
    // (SIGKILL). Discriminator: drop the destroy() in forceStopContainer and
    // `destroyed` stays 0.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    await runDueSchedules(m);

    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('enforceTimeout is a no-op once the build is already terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await m.onStop({ exitCode: 0, reason: 'exit' });
    // A real onStop callback means the producer is already gone. The unit stub
    // calls the hook directly, so model that base-class liveness transition.
    (m as unknown as { _containerRunning: boolean })._containerRunning = false;
    dbState.writes = [];
    containerCalls.stopped = 0;

    await m.enforceTimeout();

    expect(containerCalls.stopped).toBe(0);
    expect(dbState.writes).toEqual([]);
  });

  it('recovers a live producer even when local cancellation was already persisted', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');

    // Model an interrupted cancellation invocation: local durable state reached
    // terminal, but the producer is still live and Postgres is still active.
    await ctx.storage.put('buildConfig', {
      ...makeConfig(),
      status: 'cancelled',
    });
    dbState.status.set('b1', 'building');
    dbState.writes = [];
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    await m.enforceTimeout();

    // Recovery revokes the build-bound token before teardown, releases the
    // global container slot, publishes the producer barrier, and re-arms queue
    // progress rather than returning until sleepAfter.
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(lastWrite('cancelled')).toBeDefined();
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
    expect(completeCheckRun).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({
      conclusion: 'cancelled',
      text: expect.stringContaining('container terminated'),
    });
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'])(
    'recovers a locally %s producer when its Postgres revocation rejects',
    async (status) => {
      const ctx = makeStubCtx();
      const env = makeEnv();
      const m = makeManager(ctx, env);
      await m.startBuild(makeConfig());
      // Interruption between a real terminal path's local write and its signal.
      await ctx.storage.put('buildConfig', { ...makeConfig(), status });
      vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres offline'));
      const portFetch = vi.fn();
      (m as unknown as { _portFetch: unknown })._portFetch = portFetch;

      await expect(m.enforceTimeout()).rejects.toThrow('postgres offline');

      expect(dbState.status.get('b1')).toBe('building');
      expect(containerCalls.stopped).toBe(1);
      expect(containerCalls.destroyed).toBe(1);
      // An uncertain revocation must not open another log fetch with live token
      // authority. The durable reconciler observes any later terminal write.
      expect(portFetch).not.toHaveBeenCalled();
      expect(ctx._kv.get('logDrainState')).toMatchObject({ state: 'complete' });
      expect(scheduledTasks(m).some((task) => task.callback === 'reconcileTerminalWrite')).toBe(
        true,
      );
      expect(
        (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
          .get,
      ).toHaveBeenCalled();
    },
  );

  it('stops the container AND pokes the scheduler even when the terminal DB write throws', async () => {
    // `markBuildTerminalIfActive` has no internal try/catch: a Hyperdrive/Postgres
    // throw must NOT skip container teardown (a timed-out container would keep
    // running with a still-honored deploy token) or the scheduler poke (the freed
    // slot would be stranded). The local setStatus + stop() + poke are decoupled
    // from the DB write.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    // The timeout fires; the DB write rejects (and the error surfaces so the
    // caller can react), but enforceTimeout must have already torn down + poked
    // BEFORE the write — the rejection does not skip them.
    await expect(runDueSchedules(m)).rejects.toThrow('postgres write failed');

    expect(containerCalls.stopped).toBe(1);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    // The local DO status is terminal so a subsequent onStop won't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
  });

  // The throw above is only half the exposure, and the cheaper half. `createDb()`
  // is a bare `drizzle(connectionString)` over a `pg.Pool` with no
  // `connectionTimeoutMillis` and no `query_timeout`, so a revocation can PEND
  // instead of rejecting — and then the catch never runs, `forceStopContainer()`
  // is never reached, and the timed-out container keeps its still-honored deploy
  // token and its fleet slot. Nothing cheap recovers it either: the retry after
  // the runtime kills the invocation hits `enforceTimeout`'s own terminal guard
  // (setStatus already wrote 'failed') and returns immediately, so teardown falls
  // to the hourly stale reaper. A deadline collapses this into the throw path.
  it('stops the container AND pokes the scheduler when the terminal DB write never settles', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    // Pends forever — the Hyperdrive-stall shape, not the Hyperdrive-throw shape.
    vi.mocked(markBuildTerminalIfActive).mockReturnValueOnce(new Promise<boolean>(() => {}));

    vi.useFakeTimers();
    try {
      const run = runDueSchedules(m);
      const settled = expect(run).rejects.toThrow('did not settle');
      await vi.advanceTimersByTimeAsync(TERMINAL_WRITE_TIMEOUT_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }

    expect(containerCalls.stopped).toBe(1);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
  });
});

// cancelBuild RPC: the trusted DO→DO / API→DO cancel path the API (github.ts)
// invokes when a project is disconnected or its branch/executor changes,
// orphaning this build. No agent secret is required (unlike POST /cancel) — the
// stub container's startBuild stored the row `starting`, so the CAS engages.
describe('BuildManager.cancelBuild (internal RPC)', () => {
  // The reaper's rescue path. Once a hung `enforceTimeout` has already written the
  // DO-local 'failed', `cancelBuild` skips its own revocation entirely and goes
  // straight to teardown — but a cancel that arrives FIRST owns the revocation, and
  // must not inherit the same stall.
  it('stops the container AND pokes the scheduler when its own terminal write never settles', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockReturnValueOnce(new Promise<boolean>(() => {}));

    vi.useFakeTimers();
    try {
      const run = m.cancelBuild('project disconnected');
      const settled = expect(run).rejects.toThrow('did not settle');
      await vi.advanceTimersByTimeAsync(TERMINAL_WRITE_TIMEOUT_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }

    expect(containerCalls.stopped).toBe(1);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
  });

  it('stops the container, records cancelled via the CAS, and pokes the scheduler', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    // Called WITHOUT any agent header — the RPC path is trusted, like startBuild.
    await m.cancelBuild('project disconnected');

    expect(containerCalls.stopped).toBe(1);
    const cancelled = lastWrite('cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled?.id).toBe('b1');
    expect(cancelled?.opts?.error).toBe('project disconnected');
    // The CAS landed the terminal row.
    expect(dbState.status.get('b1')).toBe('cancelled');
    // Scheduler poked so the freed concurrency slot is reclaimed.
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
  });

  it('force-kills the container via destroy() (SIGKILL) on cancel, not just stop() (SIGTERM)', async () => {
    // Same escalation as the timeout path: an orphaned build whose agent ignores
    // SIGTERM must still be SIGKILLed so the freed slot is genuinely reclaimed.
    // Discriminator: drop the destroy() in forceStopContainer and `destroyed`
    // stays 0.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    await m.cancelBuild('project disconnected');

    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('defaults the reason to "build cancelled" when none is given', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    await m.cancelBuild();

    expect(lastWrite('cancelled')?.opts?.error).toBe('build cancelled');
  });

  it('is a no-op (no clobber) once the build is already terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    // First finalize the build cleanly.
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(dbState.status.get('b1')).toBe('complete');
    dbState.writes = [];
    containerCalls.stopped = 0;

    // A late cancel (project disconnected after the build already completed)
    // must NOT overwrite the recorded outcome — the CAS + in-memory guard hold.
    await m.cancelBuild('project disconnected');

    expect(dbState.status.get('b1')).toBe('complete');
    expect(dbState.writes.some((w) => w.status === 'cancelled')).toBe(false);
    // stop() is still best-effort safe to call, but no terminal write occurs.
    expect(dbState.writes).toEqual([]);
  });

  it('reconciles a check run when local terminal state still has an active DB row', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');
    vi.mocked(completeCheckRun).mockClear();

    // Model an invocation lost after the durable local write but before its
    // authoritative terminal write/check-run completion reached Postgres/GitHub.
    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('failed');
    dbState.status.set('b1', 'building');
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await m.cancelBuild('build superseded');

    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();
    expect(
      scheduledTasks(m).filter((task) => task.callback === 'reconcileTerminalWrite'),
    ).toHaveLength(1);

    // The late write or stale reaper eventually terminalizes the authoritative row;
    // the armed reconciliation must finish the otherwise-orphaned check run.
    dbState.status.set('b1', 'failed');
    await runDueSchedules(m);

    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({ conclusion: 'failure' });
    expect(scheduledTasks(m).some((task) => task.callback === 'reconcileTerminalWrite')).toBe(
      false,
    );
  });

  it('finalizes a terminal DB row found behind local terminal state', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');
    vi.mocked(completeCheckRun).mockClear();

    // The earlier invocation committed Postgres but was lost before its check PATCH.
    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('failed');
    dbState.status.set('b1', 'failed');
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await m.cancelBuild('build superseded');

    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({ conclusion: 'failure' });
    expect(ctx._logs.map((row) => row.line)).toContain(
      '[build-manager] container terminated: build terminated out of band',
    );
    expect(ctx._logs.map((row) => row.line)).not.toContain(
      '[build-manager] container terminated: build superseded',
    );
    expect(scheduledTasks(m).some((task) => task.callback === 'reconcileTerminalWrite')).toBe(
      false,
    );
  });

  it('stops the container AND pokes the scheduler even when the terminal DB write throws', async () => {
    // Same decoupling invariant as enforceTimeout: a Hyperdrive throw on the
    // terminal write must NOT skip container teardown (orphaned container) or the
    // scheduler poke (stranded slot). The local setStatus + stop() + poke run
    // independent of the DB write.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    (
      env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }
    ).BUILD_SCHEDULER.get.mockClear();

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('postgres write failed'));

    // The DB write rejects (and surfaces), but stop() + poke already ran before
    // it — the rejection does not skip container teardown or the slot release.
    await expect(m.cancelBuild('project disconnected')).rejects.toThrow('postgres write failed');

    expect(containerCalls.stopped).toBe(1);
    expect(
      (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
        .get,
    ).toHaveBeenCalled();
    // The local DO status is terminal so a subsequent onStop won't resurrect it.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
    expect(ctx._logs.map((row) => row.line)).toContain(
      '[build-manager] container terminated: build terminated out of band',
    );
  });
});

describe('BuildManager log ingest + WebSocket replay', () => {
  it('appends ingested log lines to SQLite and replays them on WS upgrade', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Seed via ingestLines (the pull-loop sink), the sole producer.
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'installing deps', stream: 'stdout', ts: 1 } as unknown as LogRow,
      { line: 'build done', stream: 'stdout', ts: 2 } as unknown as LogRow,
    ]);
    expect(ctx._logs).toHaveLength(2);

    // WS upgrade → replays stored logs then a caught_up marker.
    const upgrade = await m.fetch(
      new Request('https://manager/', { headers: { Upgrade: 'websocket' } }),
    );
    expect(upgrade.status).toBe(101);
    const server = ctx._sockets[0];
    expect(server).toBeDefined();
    const messages = server.sent.map((s) => JSON.parse(s));
    expect(messages[0]).toMatchObject({ type: 'log', line: 'installing deps' });
    expect(messages[1]).toMatchObject({ type: 'log', line: 'build done' });
    expect(messages[2]).toEqual({ type: 'caught_up' });
  });

  it('caps stored logs at MAX_STORED_LOG_LINES so storage + replay stay bounded', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Push MORE than the cap; the oldest must be evicted and the table bounded.
    const total = MAX_STORED_LOG_LINES + 250;
    const batch: Array<{ line: string; stream: string; ts: number }> = [];
    for (let i = 1; i <= total; i++) {
      batch.push({ line: `line ${i}`, stream: 'stdout', ts: i });
    }
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines(
      batch as unknown as Array<LogRow>,
    );

    // Table is bounded to the cap, retaining the NEWEST lines (tail), dropping the
    // oldest (head). Pre-fix it held all `total` rows.
    expect(ctx._logs.length).toBe(MAX_STORED_LOG_LINES);
    expect(ctx._logs.some((r) => r.line === `line ${total}`)).toBe(true);
    expect(ctx._logs.some((r) => r.line === 'line 1')).toBe(false);

    // WS replay loads the bounded table (not an unbounded set).
    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    const logMsgs = server.sent.map((s) => JSON.parse(s)).filter((msg) => msg.type === 'log');
    expect(logMsgs.length).toBe(MAX_STORED_LOG_LINES);
  });

  it('broadcasts new log lines to attached sockets', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Attach a socket first (no prior logs to replay).
    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = []; // drop the caught_up marker

    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'live line', stream: 'stderr', ts: 3 } as unknown as LogRow,
    ]);

    const live = server.sent.map((s) => JSON.parse(s));
    expect(live.some((msg) => msg.type === 'log' && msg.line === 'live line')).toBe(true);
  });

  it('POST /cancel stops the container and records cancelled', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(agentRequest(ctx, 'https://manager/cancel', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(containerCalls.stopped).toBe(1);
    expect(lastWrite('cancelled')).toBeDefined();
  });
});

// The admin worker (which holds the DO binding) polls the DO's stored logs over a
// plain, unauthenticated `GET /logs?since=N`. It is READ-ONLY: no inserts, no
// status writes, no broadcast — it just reads the SQLite `logs` table and returns
// JSON `{ lines: Array<{seq,line,stream,ts}>, lastSeq }` (rows with seq > N, asc).
// It must COEXIST with the WS upgrade (which branches first on the `Upgrade`
// header). Logs reach the store only via the pull-loop sink (`ingestLines`).
describe('BuildManager.fetch GET /logs?since=N (admin poll read)', () => {
  /** Seed a batch of lines through the pull-loop sink (`ingestLines`). */
  async function seedLogs(
    _ctx: ReturnType<typeof makeStubCtx>,
    m: BuildManager,
    lines: Array<{ line: string; stream: string; ts: number }>,
  ): Promise<void> {
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines(
      lines as unknown as Array<LogRow>,
    );
  }

  it('since=0 returns all stored rows (seq+line+stream+ts) and the max seq as lastSeq', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await seedLogs(ctx, m, [
      { line: 'installing deps', stream: 'stdout', ts: 10 },
      { line: 'build done', stream: 'stdout', ts: 20 },
    ]);

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{ seq: number; line: string; stream: string; ts: number }>;
      lastSeq: number;
      logsComplete: boolean | null;
    };
    expect(body.lines).toEqual([
      { seq: 1, line: 'installing deps', stream: 'stdout', ts: 10 },
      { seq: 2, line: 'build done', stream: 'stdout', ts: 20 },
    ]);
    expect(body.lastSeq).toBe(2);
    expect(body.logsComplete).toBe(false);
  });

  it('keeps terminal reads incomplete until delayed diagnostics are drained and the producer stops', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    let releaseTerminalWrite!: () => void;
    const terminalWriteGate = new Promise<void>((resolve) => {
      releaseTerminalWrite = resolve;
    });
    let terminalWriteEntered!: () => void;
    const terminalWriteStarted = new Promise<void>((resolve) => {
      terminalWriteEntered = resolve;
    });
    vi.mocked(markBuildTerminalIfActive).mockImplementationOnce(async () => {
      terminalWriteEntered();
      await terminalWriteGate;
      dbState.status.set('b1', 'failed');
      return true;
    });
    (m as unknown as { _portFetch: (url: string) => Promise<Response> })._portFetch = vi.fn(
      async () =>
        new RealResponse(
          JSON.stringify({
            lines: [{ seq: 1, line: 'delayed diagnostic', stream: 'stderr', ts: 1 }],
            lastSeq: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const failing = m.onError(new Error('container runtime error'));
    await terminalWriteStarted;

    const pending = (await (await m.fetch(new Request('https://manager/logs?since=0'))).json()) as {
      lines: Array<LogRow>;
      terminal: boolean;
      logsComplete: boolean | null;
    };
    expect(pending).toMatchObject({ lines: [], terminal: true, logsComplete: false });

    releaseTerminalWrite();
    await failing;
    const drained = (await (await m.fetch(new Request('https://manager/logs?since=0'))).json()) as {
      lines: Array<LogRow>;
      logsComplete: boolean | null;
    };
    expect(drained.lines.map((line) => line.line)).toEqual(['delayed diagnostic']);
    expect(drained.logsComplete).toBe(false);

    // onError deliberately leaves the container to the base lifecycle. Its later
    // onStop is the producer barrier that makes the drained snapshot final.
    (m as unknown as { _containerRunning: boolean })._containerRunning = false;
    await m.onStop({ exitCode: 1, reason: 'exit' });
    const complete = (await (
      await m.fetch(new Request('https://manager/logs?since=1'))
    ).json()) as { lines: Array<LogRow>; lastSeq: number; logsComplete: boolean | null };
    expect(complete).toMatchObject({ lines: [], lastSeq: 1, logsComplete: true });
  });

  it('since=K returns ONLY rows with seq > K (asc), with lastSeq = max seq', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await seedLogs(ctx, m, [
      { line: 'a', stream: 'stdout', ts: 1 },
      { line: 'b', stream: 'stdout', ts: 2 },
      { line: 'c', stream: 'stderr', ts: 3 },
    ]);

    const res = await m.fetch(new Request('https://manager/logs?since=1', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{ seq: number; line: string; stream: string; ts: number }>;
      lastSeq: number;
    };
    // seq 1 ('a') is excluded; only seq > 1 returned.
    expect(body.lines).toEqual([
      { seq: 2, line: 'b', stream: 'stdout', ts: 2 },
      { seq: 3, line: 'c', stream: 'stderr', ts: 3 },
    ]);
    expect(body.lastSeq).toBe(3);
  });

  it('empty table returns { lines: [], lastSeq: <since> } (cursor held at the request)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // No logs ingested. since=0 → empty list, lastSeq echoes the requested 0.
    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: Array<unknown>; lastSeq: number };
    expect(body.lines).toEqual([]);
    expect(body.lastSeq).toBe(0);

    // A non-zero cursor against an empty table echoes that cursor (never moves back).
    const res2 = await m.fetch(new Request('https://manager/logs?since=7', { method: 'GET' }));
    const body2 = (await res2.json()) as { lines: Array<unknown>; lastSeq: number };
    expect(body2.lines).toEqual([]);
    expect(body2.lastSeq).toBe(7);
  });

  it('treats a missing/NaN since as 0 (returns everything)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await seedLogs(ctx, m, [{ line: 'only', stream: 'stdout', ts: 1 }]);

    // No `since` param at all → defaults to 0.
    const missing = await m.fetch(new Request('https://manager/logs', { method: 'GET' }));
    const missingBody = (await missing.json()) as {
      lines: Array<{ seq: number }>;
      lastSeq: number;
    };
    expect(missingBody.lines.map((r) => r.seq)).toEqual([1]);
    expect(missingBody.lastSeq).toBe(1);

    // A non-numeric `since` → NaN → defaults to 0.
    const nan = await m.fetch(new Request('https://manager/logs?since=abc', { method: 'GET' }));
    const nanBody = (await nan.json()) as { lines: Array<{ seq: number }>; lastSeq: number };
    expect(nanBody.lines.map((r) => r.seq)).toEqual([1]);
    expect(nanBody.lastSeq).toBe(1);
  });

  it('is READ-ONLY: no status write, no new rows, no broadcast to attached sockets', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await seedLogs(ctx, m, [{ line: 'x', stream: 'stdout', ts: 1 }]);

    // Attach a socket and drop the replayed history so any GET-triggered send shows.
    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = [];
    dbState.writes = [];
    const rowsBefore = ctx._logs.length;

    await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));

    expect(ctx._logs.length).toBe(rowsBefore); // no inserts
    expect(dbState.writes).toEqual([]); // no status writes
    expect(server.sent).toEqual([]); // no broadcast
  });

  it('surfaces the DO-local status + terminal from config (non-terminal while running)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    // Pin a deterministic non-terminal status (startBuild → onStart may flip
    // 'starting' → 'building'); the point is terminal:false while running.
    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('building');

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    const body = (await res.json()) as { status: string | null; terminal: boolean };
    expect(body.status).toBe('building');
    expect(body.terminal).toBe(false);
  });

  it('surfaces terminal:true once the DO config reaches a terminal status (DO-authoritative)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Drive the DO-local status terminal (mirrors a completion path's setStatus).
    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('complete');

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    const body = (await res.json()) as { status: string | null; terminal: boolean };
    expect(body.status).toBe('complete');
    expect(body.terminal).toBe(true);
  });

  it('returns status:null, terminal:false when no build config exists yet', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    // No startBuild → no stored config.

    const res = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    const body = (await res.json()) as {
      status: string | null;
      terminal: boolean;
      logsComplete: boolean | null;
    };
    expect(body.status).toBeNull();
    expect(body.terminal).toBe(false);
    expect(body.logsComplete).toBeNull();
  });

  it('read-only infers completion for a legacy terminal config with a stopped container', async () => {
    const ctx = makeStubCtx({
      initialLogs: [{ seq: 1, line: 'legacy tail', stream: 'stdout', ts: 1 }],
    });
    ctx._kv.set('buildConfig', { ...makeConfig(), status: 'complete' });
    const m = makeManager(ctx, makeEnv());
    ctx.storage.put.mockClear();

    const body = (await (await m.fetch(new Request('https://manager/logs?since=0'))).json()) as {
      lines: Array<LogRow>;
      logsComplete: boolean | null;
    };

    expect(body.logsComplete).toBe(true);
    expect(body.lines.map((line) => line.line)).toEqual(['legacy tail']);
    expect(ctx.storage.put).not.toHaveBeenCalled();
  });

  it('does NOT collide with the WS upgrade: a GET WITHOUT the Upgrade header reads logs', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    await seedLogs(ctx, m, [{ line: 'log', stream: 'stdout', ts: 1 }]);

    // GET /logs (no Upgrade) → JSON read (status 200), NOT a 101 upgrade.
    const read = await m.fetch(new Request('https://manager/logs?since=0', { method: 'GET' }));
    expect(read.status).toBe(200);
    expect(ctx._sockets.length).toBe(0); // no socket accepted

    // The WS path still works: a GET WITH the Upgrade header upgrades (101).
    const upgrade = await m.fetch(
      new Request('https://manager/logs', { headers: { Upgrade: 'websocket' } }),
    );
    expect(upgrade.status).toBe(101);
    expect(ctx._sockets.length).toBe(1);
  });
});

// The DO pulls build-log lines from the in-container agent (`GET /logs?since=N`)
// over the NON-starting raw port fetch (`container.getTcpPort(port).fetch(url)`),
// ingests them into the SQLite `logs` table + WS fan-out, advances an in-memory
// cursor, and re-arms itself via the base scheduler — the same
// `schedule(seconds, 'method')` mechanism `enforceTimeout` uses. The non-starting
// port fetch (NOT the auto-starting `containerFetch`) means a poll racing a
// just-exited container can never resurrect it. The stub's `container` getter routes
// `getTcpPort(port).fetch(url)` to a settable `_portFetch`, so each test stubs it.
describe('BuildManager.pollLogs (DO log pull-loop)', () => {
  /**
   * Stub the non-starting port fetch (`container.getTcpPort(port).fetch(url)`) on the
   * manager to return canned `GET /logs` responses. Backed by the stub's `_portFetch`,
   * invoked as `(url, port)` so the existing `(url, port)` assertions still hold.
   */
  function stubPortFetch(
    m: BuildManager,
    responses: Array<{ lines: Array<LogRow>; lastSeq: number } | Error>,
  ): ReturnType<typeof vi.fn> {
    let call = 0;
    const fn = vi.fn(async (_url: string, _port?: number) => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (next instanceof Error) {
        throw next;
      }
      return new RealResponse(JSON.stringify(next), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fn })._portFetch = fn;
    return fn;
  }

  /** Read the in-memory log cursor the loop advances. */
  function logCursor(m: BuildManager): number {
    return (m as unknown as { logCursor: number }).logCursor;
  }

  it('pulls two batches: ingests lines, advances the cursor, and re-arms', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Attach a socket so the broadcast side of ingest is observable; drop replay.
    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = [];

    // Drive pollLogs directly across two batches (not via runDueSchedules — that
    // would also fire the 600s enforceTimeout armed at startBuild). Clear the
    // schedule first so each re-arm is observed in isolation.
    const fetchFn = stubPortFetch(m, [
      {
        lines: [
          { seq: 1, line: 'installing deps', stream: 'stdout', ts: 1 },
          { seq: 2, line: 'compiling', stream: 'stdout', ts: 2 },
        ],
        lastSeq: 2,
      },
      {
        lines: [{ seq: 3, line: 'uploading', stream: 'stdout', ts: 3 }],
        lastSeq: 3,
      },
    ]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    // First poll: requests with the initial cursor (0) on port 4000.
    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('http://manager/logs?since=0');
    expect(fetchFn.mock.calls[0][1]).toBe(4000);

    // Lines ingested into SQLite (seq stripped before insert) + broadcast over WS.
    expect(ctx._logs.map((r) => r.line)).toEqual(['installing deps', 'compiling']);
    const broadcast = server.sent.map((s) => JSON.parse(s));
    expect(broadcast.some((m) => m.type === 'log' && m.line === 'installing deps')).toBe(true);
    expect(broadcast.some((m) => m.type === 'log' && m.line === 'compiling')).toBe(true);

    // Cursor advanced to lastSeq; the loop re-armed itself.
    expect(logCursor(m)).toBe(2);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(true);

    // Second poll continues from the advanced cursor (since=2).
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    expect(fetchFn.mock.calls[1][0]).toBe('http://manager/logs?since=2');
    expect(ctx._logs.map((r) => r.line)).toEqual(['installing deps', 'compiling', 'uploading']);
    expect(logCursor(m)).toBe(3);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(true);
  });

  it('returns without rescheduling when the build status is terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const fetchFn = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);

    // Drive the build terminal (mirrors a completed container).
    dbState.status.set('b1', 'building');
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'complete' });
    // `onStop` fires BECAUSE the container exited, so the container is gone by
    // definition here. The base stub only flips `_containerRunning` in
    // stop()/destroy(), so state it explicitly — otherwise this "completed
    // container" case would model a terminal build with a still-LIVE container,
    // which is the cancel/timeout case covered by its own test below.
    (m as unknown as { _containerRunning: boolean })._containerRunning = false;

    // Clear the schedule armed at startBuild so we observe ONLY pollLogs' decision.
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    // Self-terminated: no agent poll, no re-arm.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(false);
  });

  it('issues ONE final pull (no re-arm) when the status went terminal while the container is still running', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Drive a REAL production path into `terminal status + LIVE container` instead
    // of poking setStatus. onError drains once before finalizing but does not stop;
    // this terminal backstop catches a line produced after that snapshot.
    dbState.writes = [];
    stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);
    await m.onError(new Error('container runtime error'));
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(true);

    const fetchFn = stubPortFetch(m, [
      { lines: [{ seq: 7, line: 'vite build failed', stream: 'stderr', ts: 7 }], lastSeq: 7 },
    ]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('http://manager/logs?since=0');
    expect(ctx._logs.map((r) => r.line)).toContain('vite build failed');
    expect(logCursor(m)).toBe(7);
    // Still self-terminating: exactly ONE last pull, never a re-arm.
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(false);
  });

  it('swallows a throw from the final terminal-status pull (must not escape the alarm)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('cancelled');

    const fetchFn = stubPortFetch(m, [new Error('container gone mid-teardown')]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await expect(
      (m as unknown as { pollLogs: () => Promise<void> }).pollLogs(),
    ).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(false);
  });

  it('never uses the auto-starting containerFetch for the final terminal-status pull', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('cancelled');

    const autoStart = vi.fn(async () => new RealResponse('{}', { status: 200 }));
    (m as unknown as { containerFetch: typeof autoStart }).containerFetch = autoStart;
    const portFetch = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(portFetch).toHaveBeenCalledTimes(1);
    expect(autoStart).not.toHaveBeenCalled();
  });

  it('does not pull (clean early-out) once the container has exited, even if status is not yet terminal', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const fetchFn = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);

    // The container exited between polls but onStop hasn't run yet, so the
    // persisted status is still `building` (non-terminal). The running guard must
    // skip the fetch entirely and end the loop (onStop finalizes the build).
    (m as unknown as { _containerRunning: boolean })._containerRunning = false;

    // Clear the schedule armed at startBuild so we observe ONLY pollLogs' decision.
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    // No port fetch and no re-arm — the loop stopped so onStop can finalize the build.
    expect(fetchFn).not.toHaveBeenCalled();
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(false);
  });

  it('swallows a port-fetch throw (no unhandled throw) and re-arms', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const fetchFn = stubPortFetch(m, [new Error('container mid-start')]);

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    // Must not throw out of pollLogs even though the port fetch rejects.
    await expect(
      (m as unknown as { pollLogs: () => Promise<void> }).pollLogs(),
    ).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Nothing ingested; the loop still re-armed (the container may come up next tick).
    expect(ctx._logs).toHaveLength(0);
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(true);
  });

  it('leaves the cursor UNADVANCED when a 200 body cannot be parsed — the agent reads this cursor as its drain ack', async () => {
    // The agent's exit barrier treats a later `since=N` as proof the DO stored
    // everything below N. That only holds because `logCursor` is written strictly
    // AFTER `res.json()` and `ingestLines()` succeed. Pin the ordering: a 200 whose
    // body is not JSON must ingest nothing and must NOT move the cursor, so the
    // next poll re-requests the same lines instead of the agent exiting on a lie.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const fetchFn = vi.fn(
      async () => new RealResponse('not json at all', { status: 200 }),
    ) as ReturnType<typeof vi.fn>;
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await expect(
      (m as unknown as { pollLogs: () => Promise<void> }).pollLogs(),
    ).resolves.toBeUndefined();

    expect(ctx._logs).toHaveLength(0);
    expect(logCursor(m)).toBe(0);
    // Re-armed, and the retry asks from the SAME cursor — nothing is skipped.
    expect(scheduledTasks(m).some((t) => t.callback === 'pollLogs')).toBe(true);
    expect(fetchFn.mock.calls[0][0]).toBe('http://manager/logs?since=0');
  });

  it('uses the non-starting port fetch (never the auto-starting containerFetch) so a poll cannot resurrect the container', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig()); // running=true, status building

    // Spy on the auto-starting containerFetch — it must NEVER be called by pollLogs.
    const autoStart = vi.fn(async () => new RealResponse('{}', { status: 200 }));
    (m as unknown as { containerFetch: typeof autoStart }).containerFetch = autoStart;

    const portFetch = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(portFetch).toHaveBeenCalledTimes(1); // pulled via the non-starting path
    expect(autoStart).not.toHaveBeenCalled(); // never the auto-starting path
  });

  it('arms the first pollLogs tick in startBuild (after the CAS to building)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Both the timeout AND the log poll loop are armed via the base scheduler.
    expect(scheduledTasks(m)).toContainEqual({ whenSeconds: 1, callback: 'pollLogs' });
    expect(scheduledTasks(m).some((t) => t.callback === 'enforceTimeout')).toBe(true);
  });

  it('timeboxes every pull with an abort signal so a wedged agent cannot stall the alarm chain or a teardown', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // An agent that accepts the TCP connection but never answers would otherwise
    // hang the pull forever: on the poll path that stalls the alarm chain, and on
    // the teardown path it stalls the cancel/timeout SIGTERM+SIGKILL itself,
    // pinning one of the fleet's global instance slots — the exact capacity
    // starvation the destroy() escalation exists to prevent.
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchFn = stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    const init = fetchFn.mock.calls[0][2] as RequestInit | undefined;
    const signal = init?.signal as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    expect(timeoutSpy).toHaveBeenCalledWith(LOG_PULL_TIMEOUT_MS);
    // A budget generous enough to be useless as a bound would defeat the point:
    // a healthy in-container buffer read is sub-millisecond.
    expect(LOG_PULL_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    timeoutSpy.mockRestore();
  });

  /**
   * Stub the port fetch AND record how far the container teardown had progressed at
   * the moment each pull was issued. Ordering is the assertion for the teardown
   * drain, not merely "a fetch happened": a drain that runs after the signals is a
   * drain that reaches a dead agent.
   */
  /** Serve a backlog as N capped pages, mimicking the agent's paged /logs. */
  function stubPagedPortFetch(m: BuildManager, pages: Array<Array<LogRow>>) {
    let call = 0;
    const fetchFn = vi.fn(async (_url: string, _port?: number, _init?: RequestInit) => {
      const page = pages[call] ?? [];
      const more = call < pages.length - 1;
      call++;
      return new RealResponse(
        JSON.stringify({
          lines: page,
          lastSeq: page[page.length - 1]?.seq ?? 0,
          hasMore: more,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    return fetchFn;
  }

  function stubOrderedPortFetch(m: BuildManager, lines: Array<LogRow>) {
    const teardownAtPull: Array<{ stopped: number; destroyed: number }> = [];
    const fetchFn = vi.fn(async (_url: string, _port?: number, _init?: RequestInit) => {
      teardownAtPull.push({
        stopped: containerCalls.stopped,
        destroyed: containerCalls.destroyed,
      });
      return new RealResponse(
        JSON.stringify({ lines, lastSeq: lines[lines.length - 1]?.seq ?? 0 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    return { fetchFn, teardownAtPull };
  }

  // `forceStopContainer` pulls ONCE before its SIGTERM, covering all three teardown
  // sites (cancelBuild / enforceTimeout / the startBuild catch). It has to: the
  // agent's exit-time `waitForLogDrain()` barrier never runs on this path, because
  // SIGTERM lands in `onShutdownSignal`, which ends in `process.exit(1)` and so
  // skips main()'s `finally` entirely. And pollLogs cannot cover for it — its next
  // tick is up to POLL_SECONDS away (schedule() floors to a second boundary), by
  // which point destroy() has resolved and the `running` guard early-outs without
  // fetching. So without this pull, a cancelled or timed-out build silently loses
  // everything the agent recorded since the previous tick — up to a full second of
  // tail, and on a fast failure that is the entire error output.
  //
  // What the pull does NOT retain (and no pull could): the agent's own
  // `[build-agent] received SIGTERM…` line. `onShutdownSignal` generates it only
  // once our SIGTERM lands — i.e. strictly AFTER this pull — and `process.exit(1)`
  // then takes it to the grave. The DO's own `[build-manager] container
  // terminated: …` marker replaces it (asserted below).
  it('cancelBuild drains the log tail BEFORE the SIGTERM/SIGKILL teardown', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    const { fetchFn, teardownAtPull } = stubOrderedPortFetch(m, [
      { seq: 4, line: 'vp build failed: Unexpected token', stream: 'stderr', ts: 4 },
    ]);

    await m.cancelBuild('build superseded');

    // If broken: drop the pull from forceStopContainer and this is 0 calls.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('http://manager/logs?since=0');
    expect(fetchFn.mock.calls[0][1]).toBe(4000);
    // The pull reached a LIVE agent: neither signal had been sent yet.
    expect(teardownAtPull).toEqual([{ stopped: 0, destroyed: 0 }]);
    // ...and the teardown still ran in full afterwards (SIGTERM then SIGKILL).
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    // The tail actually reached the sink.
    expect(ctx._logs.map((r) => r.line)).toContain('vp build failed: Unexpected token');
    expect(logCursor(m)).toBe(4);
  });

  it('enforceTimeout drains the log tail BEFORE the SIGTERM/SIGKILL teardown', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    const { fetchFn, teardownAtPull } = stubOrderedPortFetch(m, [
      { seq: 9, line: 'still installing deps at the 10m mark', stream: 'stdout', ts: 9 },
    ]);

    await m.enforceTimeout();

    // If broken: drop the pull from forceStopContainer and this is 0 calls.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(teardownAtPull).toEqual([{ stopped: 0, destroyed: 0 }]);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
    expect(ctx._logs.map((r) => r.line)).toContain('still installing deps at the 10m mark');
    expect(logCursor(m)).toBe(9);
  });

  // `builds.status` is the deploy token's authority — `middleware/auth.ts` honors a
  // build-bound token while the row is in ACTIVE_BUILD_STATUSES, and
  // `routes/deploy.ts` re-checks the same set inside its go-live transaction. The
  // drain pull put up to 2x LOG_DRAIN_BUDGET_MS in front of the SIGTERM, so leaving
  // the row ACTIVE across it lets a `void deploy` at its go-live step write routing
  // KV and commit the deployment 'live', to then be recorded 'build timed out'.
  it('revokes the build row in Postgres BEFORE draining logs, so the deploy token cannot outlive the timeout', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    const order: Array<string> = [];
    vi.mocked(markBuildTerminalIfActive).mockImplementationOnce(async () => {
      order.push('revoke');
      return true;
    });
    const fetchFn = vi.fn(async () => {
      order.push('drain');
      return new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    await m.enforceTimeout();

    // If broken: ['drain', 'revoke'] — the token stays honored for the whole
    // drain. The drain must still happen (it is the only thing that saves the tail),
    // just behind the revocation.
    expect(order).toEqual(['revoke', 'drain']);
    expect(containerCalls.stopped).toBe(1);
  });

  it('still tears the container down when the Postgres revocation throws', async () => {
    // The revocation runs in FRONT of the teardown, so it must not be able to gate
    // it: a Hyperdrive blip would otherwise leave a timed-out container alive on a
    // pinned fleet slot.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('hyperdrive blip'));
    stubOrderedPortFetch(m, []);

    // The throw still surfaces — it did before too — but only after teardown ran.
    await expect(m.enforceTimeout()).rejects.toThrow('hyperdrive blip');
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('does not pull during teardown when the container is already gone', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // A cancel that races an already-exited container: the agent is gone, its
    // natural-exit `waitForLogDrain()` already handed the tail over, and a pull here
    // would only be a doomed fetch in front of two no-op signals.
    (m as unknown as { _containerRunning: boolean })._containerRunning = false;
    const { fetchFn } = stubOrderedPortFetch(m, []);

    await m.cancelBuild('build superseded');

    expect(fetchFn).not.toHaveBeenCalled();
    // ...and no terminated marker either: the log already ends where the agent
    // ended it, so there is nothing to explain.
    expect(ctx._logs).toHaveLength(0);
  });

  it('does not mark a natural exit that lands while the teardown drain is in progress', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    const fetchFn = vi.fn(async () => {
      // The agent reaches natural exit while the manager is awaiting its final
      // pull. Its own barrier owns this ending; later container controls would be
      // successful no-ops and must not manufacture a cancellation marker.
      (m as unknown as { _containerRunning: boolean })._containerRunning = false;
      return new RealResponse(
        JSON.stringify({
          lines: [{ seq: 1, line: 'void deploy exited with code 0', stream: 'stdout', ts: 1 }],
          lastSeq: 1,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    await m.cancelBuild('build superseded');

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(containerCalls.stopped).toBe(0);
    expect(containerCalls.destroyed).toBe(0);
    expect(ctx._logs.map((row) => row.line)).toEqual(['void deploy exited with code 0']);
  });

  // The agent's own `[build-agent] received SIGTERM…` line is generated only once
  // our SIGTERM lands — strictly AFTER the drain pull above — and `process.exit(1)`
  // then takes it to the grave, so no pull can ever retain it. The DO writes its
  // own marker instead: same information (why the output stops), no container
  // dependency. It must land AFTER the drained tail so it reads as the last line.
  it('appends a terminated marker after the drained tail, naming the cancel reason', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    stubOrderedPortFetch(m, [
      { seq: 4, line: 'vp build failed: Unexpected token', stream: 'stderr', ts: 4 },
    ]);

    await m.cancelBuild('build superseded');

    // If broken: drop the marker ingest and the second row is missing.
    expect(ctx._logs.map((r) => r.line)).toEqual([
      'vp build failed: Unexpected token',
      '[build-manager] container terminated: build superseded',
    ]);
    // stderr, so a live tail renders it as the abnormal end it is.
    expect(ctx._logs[1].stream).toBe('stderr');
    // ...and it survives into the check-run tail (sanitize + fence) unchanged.
    expect(
      await (
        m as unknown as { readLogTailMarkdown: () => Promise<string | null> }
      ).readLogTailMarkdown(),
    ).toContain('[build-manager] container terminated: build superseded');
  });

  it('does not claim the container terminated when both control signals fail', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    stubOrderedPortFetch(m, []);

    const stop = vi
      .spyOn(m as unknown as { stop: () => Promise<void> }, 'stop')
      .mockRejectedValueOnce(new Error('SIGTERM control failed'));
    const destroy = vi
      .spyOn(m as unknown as { destroy: () => Promise<void> }, 'destroy')
      .mockRejectedValueOnce(new Error('SIGKILL control failed'));

    await m.cancelBuild('build superseded');

    expect(stop).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(true);
    expect(ctx._logs.map((row) => row.line)).not.toContain(
      '[build-manager] container terminated: build superseded',
    );
    // The failed owner releases both its signal gate and marker claim, so a later
    // successful retry can emit the first truthful marker instead of being
    // silenced forever. `mockRejectedValueOnce` falls through to the real methods
    // on this second call.
    await m.cancelBuild('project deleted');
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(false);
    expect(ctx._logs.map((row) => row.line)).toContain(
      '[build-manager] container terminated: build terminated out of band',
    );
  });

  // Each teardown site passes its OWN reason: a timeout is not a cancellation, and
  // a marker that claimed otherwise would be exactly the kind of confidently false
  // statement this marker exists to replace.
  it('names the timeout (not a cancellation) in the terminated marker', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.status.set('b1', 'building');

    stubOrderedPortFetch(m, [
      { seq: 9, line: 'still installing deps at the 10m mark', stream: 'stdout', ts: 9 },
    ]);

    await m.enforceTimeout();

    expect(ctx._logs.map((r) => r.line)).toEqual([
      'still installing deps at the 10m mark',
      '[build-manager] container terminated: build timed out',
    ]);
  });

  // FINDING B. `pullLogsOnce` READS `logCursor` to build the URL and WRITES it
  // three awaits later, and a `fetch()` is NOT storage I/O — only `ctx.storage`
  // operations hold the DO input gate — so a `cancelBuild` RPC (push-supersede,
  // disconnect, branch/executor change, project delete, the stale reaper) lands
  // while a scheduled `pollLogs` sits mid-fetch. Both then request the SAME stale
  // `since` and ingest the SAME lines: nothing downstream dedupes (the source
  // `seq` is stripped at ingest and the `logs` table is keyed only by its own
  // AUTOINCREMENT), so duplicates are stored, re-broadcast, and spend the
  // MAX_STORED_LOG_LINES / check-run-tail budgets, evicting genuine history.
  //
  // Joining the in-flight pull would lose the tail instead, because the agent
  // freezes a response body at receipt and there is no later poll on the teardown
  // path. So teardown AWAITS the in-flight pull and then takes a fresh snapshot:
  // the await removes the duplicate (it advances the cursor first), and the fresh
  // pull keeps the tail. The three tests below pin the three halves —
  // no duplicate, no loss, and no unbounded chain of pulls.
  it('sequences a teardown pull behind an already in-flight scheduled pull', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    // Hold the scheduled pull open AT the fetch await — the exact window the DO
    // input gate does not cover — so the cancel path genuinely overlaps it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const firstPullEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    // Faithful model of the agent's handler: it snapshots AT RECEIPT
    // (`lastSeq = logSeq`, `logBuffer.filter(e => e.seq > since)`), so the body
    // depends on `since` and on when the request arrived. A stub that ignores
    // `since` would hide both the duplicate and the staleness this pins.
    const buffer: Array<{ seq: number; line: string; stream: string; ts: number }> = [
      { seq: 3, line: 'ERR_MODULE_NOT_FOUND', stream: 'stderr', ts: 3 },
    ];
    let calls = 0;
    const fetchFn = vi.fn(async (url: string, _port?: number, _init?: RequestInit) => {
      const since = Number(new URL(url).searchParams.get('since') ?? '0');
      const lines = buffer.filter((entry) => entry.seq > since);
      const lastSeq = buffer[buffer.length - 1]?.seq ?? since;
      calls += 1;
      if (calls === 1) {
        markEntered();
        await gate;
      }
      return new RealResponse(JSON.stringify({ lines, lastSeq }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    const poll = (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    await firstPullEntered;

    const cancel = m.cancelBuild('build superseded');
    // Give cancelBuild every chance to reach its own pull (getConfig + setStatus
    // are awaits) BEFORE the in-flight fetch answers — that is the race.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release();
    await Promise.all([poll, cancel]);

    // The teardown pull is SEQUENCED behind the in-flight one, never concurrent with
    // it, so it asks from the ADVANCED cursor and cannot re-ingest what the first
    // carried. What enforces that is `forceStopContainer`'s explicit
    // `await this.pullInFlight` — NOT the `??=` gate, which by itself would have let
    // teardown join the stale request and lose the tail instead (see the sibling
    // FRESH-snapshot test). The gate's remaining job is bounding CONCURRENT
    // teardowns; that is pinned separately below, and removing it fails that test,
    // not this one.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][0]).toBe('http://manager/logs?since=0');
    expect(fetchFn.mock.calls[1][0]).toBe('http://manager/logs?since=3');
    expect(ctx._logs.filter((r) => r.line === 'ERR_MODULE_NOT_FOUND')).toHaveLength(1);
    expect(logCursor(m)).toBe(3);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('joins an active pull even when terminal-write failure forbids a fresh drain', async () => {
    const ctx = makeStubCtx();
    const m = makeManager(ctx, makeEnv());
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    let releaseJson!: () => void;
    const jsonGate = new Promise<void>((resolve) => {
      releaseJson = resolve;
    });
    let markJsonEntered!: () => void;
    const jsonEntered = new Promise<void>((resolve) => {
      markJsonEntered = resolve;
    });
    const fetchFn = vi.fn(async () => {
      return {
        ok: true,
        json: async () => {
          markJsonEntered();
          await jsonGate;
          return {
            lines: [{ seq: 1, line: 'active tail', stream: 'stderr', ts: 1 }],
            lastSeq: 1,
          };
        },
      } as Response;
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    const container = (
      m as unknown as {
        rawContainer: () => { getTcpPort: (port: number) => { fetch: typeof fetchFn } };
      }
    ).rawContainer();
    const activePull = (
      m as unknown as {
        pullLogsOnce: (target: {
          getTcpPort: (port: number) => { fetch: typeof fetchFn };
        }) => Promise<void>;
      }
    ).pullLogsOnce(container);
    await jsonEntered;

    const teardown = (
      m as unknown as {
        forceStopContainer: (
          reason: string,
          markerAuthoritative?: boolean,
          drainFirst?: boolean,
        ) => Promise<void>;
      }
    ).forceStopContainer('terminal write failed', true, false);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    // `drainFirst=false` forbids only a new request. The response already in the
    // DO must finish parsing and ingesting before signals or the final marker.
    expect(containerCalls.stopped).toBe(0);
    expect(containerCalls.destroyed).toBe(0);
    expect(ctx._logs).toHaveLength(0);

    releaseJson();
    await Promise.all([activePull, teardown]);

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(ctx._logs.map((row) => row.line)).toEqual([
      'active tail',
      '[build-manager] container terminated: terminal write failed',
    ]);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('takes a FRESH snapshot after joining an in-flight pull, so lines written during it are not killed with the container', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const firstPullEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });

    const buffer: Array<{ seq: number; line: string; stream: string; ts: number }> = [
      { seq: 1, line: 'vite building for production', stream: 'stdout', ts: 1 },
    ];
    let calls = 0;
    const stoppedAtPull: Array<number> = [];
    const fetchFn = vi.fn(async (url: string, _port?: number, _init?: RequestInit) => {
      const since = Number(new URL(url).searchParams.get('since') ?? '0');
      // Snapshot at RECEIPT, like the agent — a line recorded while this request is
      // open cannot appear in its body.
      const lines = buffer.filter((entry) => entry.seq > since);
      const lastSeq = buffer[buffer.length - 1]?.seq ?? since;
      stoppedAtPull.push(containerCalls.stopped);
      calls += 1;
      if (calls === 1) {
        markEntered();
        await gate;
      }
      return new RealResponse(JSON.stringify({ lines, lastSeq }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    const poll = (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    await firstPullEntered;

    // The build's real diagnosis, written AFTER the in-flight pull froze its body.
    buffer.push({
      seq: 2,
      line: 'ERROR: Unexpected token in vite.config.ts',
      stream: 'stderr',
      ts: 2,
    });

    const cancel = m.cancelBuild('build superseded');
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release();
    await Promise.all([poll, cancel]);

    // If broken: if joining the in-flight pull counts as the teardown drain,
    // only one request goes out (`since=0`), the ERROR line is never fetched,
    // and `process.exit(1)` in the agent's SIGTERM handler loses it — the agent's own exit-time barrier does not run on that path.
    expect(ctx._logs.map((r) => r.line)).toEqual([
      'vite building for production',
      'ERROR: Unexpected token in vite.config.ts',
      '[build-manager] container terminated: build superseded',
    ]);
    expect(fetchFn.mock.calls[1][0]).toBe('http://manager/logs?since=1');
    expect(logCursor(m)).toBe(2);
    // Both pulls reached a LIVE agent — the drain is entirely in front of the signals.
    expect(stoppedAtPull).toEqual([0, 0]);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });

  it('coalesces two concurrent teardowns onto ONE fresh pull, so the bound stays per-teardown', async () => {
    // Guards against "improving" the join into a serialized chain: N concurrent
    // cancels (webhook supersede + the stale reaper + the agent's POST /cancel) would
    // then cost N x LOG_PULL_TIMEOUT_MS before the SIGKILL — the unbounded teardown
    // the timebox exists to prevent.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const firstPullEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });

    let calls = 0;
    const fetchFn = vi.fn(async (url: string, _port?: number, _init?: RequestInit) => {
      const since = Number(new URL(url).searchParams.get('since') ?? '0');
      calls += 1;
      if (calls === 1) {
        markEntered();
        await gate;
      }
      return new RealResponse(JSON.stringify({ lines: [], lastSeq: since }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    const poll = (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    await firstPullEntered;

    const cancelA = m.cancelBuild('build superseded');
    const cancelB = m.cancelBuild('project deleted');
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    release();
    await Promise.all([poll, cancelA, cancelB]);

    // One scheduled pull + exactly ONE fresh teardown pull, however many teardowns
    // raced. Never three.
    expect(fetchFn).toHaveBeenCalledTimes(2);

    // If broken: both reasons appear, so the reader and the check-run tail get
    // two authoritative-looking, contradictory explanations for one termination. Only
    // the caller that won the terminal CAS may claim it.
    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toHaveLength(1);
  });

  it('does not start a late drain after the shared teardown has entered container control', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let markStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      markStopEntered = resolve;
    });
    (m as unknown as { stop: () => Promise<void> }).stop = vi.fn(async () => {
      containerCalls.stopped += 1;
      markStopEntered();
      await stopGate;
    });

    let releaseLatePull!: () => void;
    const latePullGate = new Promise<void>((resolve) => {
      releaseLatePull = resolve;
    });
    let fetches = 0;
    const fetchFn = vi.fn(async (url: string) => {
      fetches += 1;
      if (fetches === 1) {
        return new RealResponse(
          JSON.stringify({
            lines: [{ seq: 1, line: 'first tail', stream: 'stderr', ts: 1 }],
            lastSeq: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      await latePullGate;
      return new RealResponse(
        JSON.stringify({
          lines: [{ seq: 2, line: 'late line', stream: 'stderr', ts: 2 }],
          lastSeq: 2,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    const forceStop = (
      m as unknown as {
        forceStopContainer: (
          reason: string,
          markerAuthoritative?: boolean,
          drainFirst?: boolean,
        ) => Promise<void>;
      }
    ).forceStopContainer.bind(m);

    const first = forceStop('build superseded', true, true);
    await stopEntered;
    const second = forceStop('peer teardown', false, true);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    const fetchesBeforeSignal = fetches;

    releaseStop();
    await first;
    releaseLatePull();
    await second;

    // If broken: caller two starts fetch #2 after caller one has drained
    // but while its stop/destroy calls are still pending. Its response can then
    // ingest after the terminal marker and after check-run finalization.
    expect(fetchesBeforeSignal).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(ctx._logs.map((row) => row.line)).toEqual([
      'first tail',
      '[build-manager] container terminated: build superseded',
    ]);
  });

  it('does not let a scheduled terminal backstop pull escape an active teardown', async () => {
    const ctx = makeStubCtx();
    const m = makeManager(ctx, makeEnv());
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let markStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      markStopEntered = resolve;
    });
    (m as unknown as { stop: () => Promise<void> }).stop = vi.fn(async () => {
      containerCalls.stopped += 1;
      markStopEntered();
      await stopGate;
    });

    let releaseLatePull!: () => void;
    const latePullGate = new Promise<void>((resolve) => {
      releaseLatePull = resolve;
    });
    let fetches = 0;
    const fetchFn = vi.fn(async () => {
      fetches += 1;
      if (fetches === 1) {
        return new RealResponse(
          JSON.stringify({
            lines: [{ seq: 1, line: 'first tail', stream: 'stderr', ts: 1 }],
            lastSeq: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      await latePullGate;
      return new RealResponse(
        JSON.stringify({
          lines: [{ seq: 2, line: 'late line', stream: 'stderr', ts: 2 }],
          lastSeq: 2,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    const cancel = m.cancelBuild('build superseded');
    await stopEntered;
    const poll = (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    const fetchesDuringTeardown = fetches;

    releaseStop();
    await cancel;
    releaseLatePull();
    await poll;

    // The fresh teardown drain is the sole final snapshot. A terminal scheduler
    // tick during stop/destroy neither joins nor starts a second request.
    expect(fetchesDuringTeardown).toBe(1);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(ctx._logs.map((row) => row.line)).toEqual([
      'first tail',
      '[build-manager] container terminated: build superseded',
    ]);
  });

  it('keeps the first caller drain policy for the entire shared teardown', async () => {
    const ctx = makeStubCtx();
    const m = makeManager(ctx, makeEnv());
    await m.startBuild(makeConfig());

    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let markStopEntered!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      markStopEntered = resolve;
    });
    (m as unknown as { stop: () => Promise<void> }).stop = vi.fn(async () => {
      markStopEntered();
      await stopGate;
    });
    const fetchFn = vi.fn(
      async () =>
        new RealResponse(JSON.stringify({ lines: [], lastSeq: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;
    const forceStop = (
      m as unknown as {
        forceStopContainer: (
          reason: string,
          markerAuthoritative?: boolean,
          drainFirst?: boolean,
        ) => Promise<void>;
      }
    ).forceStopContainer.bind(m);

    const first = forceStop('startup failed before revocation', false, false);
    await stopEntered;
    const second = forceStop('peer requested a drain', false, true);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(fetchFn).not.toHaveBeenCalled();

    releaseStop();
    await Promise.all([first, second]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('emits no marker from a cancel whose peer teardown already claimed it', async () => {
    // The other overlap shape: a startup-failure teardown has already driven the row
    // terminal and is still draining a LIVE container when a cancel arrives. Having
    // no CAS to lose must not read as authority, or both teardowns append a different
    // authoritative-looking reason for the same termination.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;

    // BOTH halves of what a startup-failure teardown leaves. It claims the marker
    // synchronously at the TOP of the catch, before `setStatus` — modelling only the
    // status half built a state no teardown can produce (terminal, live container,
    // marker unclaimed) and then asserted silence for it, which is the `onError` hole
    // covered by the test below. Exclusion here comes from the claim, not the status.
    (m as unknown as { claimTerminationMarker: () => boolean }).claimTerminationMarker();
    await (m as unknown as { setStatus: (s: string) => Promise<void> }).setStatus('failed');
    stubOrderedPortFetch(m, []);

    await m.cancelBuild('project deleted');

    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual([]);
    // The teardown itself still runs — suppressing the marker must not skip the kill.
    expect(containerCalls.stopped).toBe(1);
  });

  it('emits the marker when a cancel kills the live container onError left behind', async () => {
    // `onError` is a terminal transition that deliberately does NOT stop the container
    // ("left to the base class") and never reserves the marker. A cancel arriving after
    // it therefore sees `shouldTerminalize === false`. Gating the claim on that status
    // meant this teardown SIGTERM+SIGKILLed a container that was still producing output
    // and wrote no explanation — the reader sees the log simply stop.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;

    // Real production path, not a poked status: terminal row, container still LIVE,
    // marker unclaimed. Asserted, because the whole hole depends on that combination.
    stubPortFetch(m, [{ lines: [], lastSeq: 0 }]);
    await m.onError(new Error('container runtime error'));
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'failed' });
    expect((m as unknown as { _containerRunning: boolean })._containerRunning).toBe(true);
    ctx._logs.length = 0;
    const { fetchFn } = stubOrderedPortFetch(m, []);

    await m.cancelBuild('project deleted');

    // If broken: `shouldTerminalize && claim()` short-circuits, so the kill goes
    // unexplained.
    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual(['[build-manager] container terminated: build terminated out of band']);
    // onError already committed the authoritative terminal row, so the bounded
    // verification must preserve the teardown tail drain on this path.
    expect(fetchFn).toHaveBeenCalled();
    expect(containerCalls.stopped).toBe(1);
  });

  it('still emits the marker when an external caller pre-terminalized the row', async () => {
    // The ORDINARY cancellation path, not an exotic race: `cancelContainerBuildDos`
    // (push-supersede, disconnect, branch-delete, project-delete) commits the terminal
    // row and only THEN calls this RPC — that DB-first ordering is what revokes the
    // deploy token, and it is deliberate. So the CAS here always loses.
    //
    // Losing it must not be read as "someone else already explained the kill": no
    // other teardown ran, and the agent's own post-SIGTERM line can never be pulled.
    // Gating the marker on the CAS left every externally-cancelled build's log simply
    // stopping, with nothing saying why.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;

    // Row already terminal in Postgres -> CAS no-ops. LOCAL status stays active,
    // because nothing inside this DO has torn the build down yet.
    vi.mocked(markBuildTerminalIfActive).mockResolvedValueOnce(false);
    stubOrderedPortFetch(m, []);

    await m.cancelBuild('build superseded');

    // If broken: gated on `terminal?.won === true`, this is `false` and the
    // only marker these builds would ever get is suppressed.
    //
    // The REASON defers to the CAS even though ownership does not: losing it means the
    // outcome was recorded elsewhere, so this site's `reason` would contradict the
    // check run, which finalizes from that recorded outcome. Emitted, but honest about
    // what it knows.
    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual(['[build-manager] container terminated: build terminated out of band']);
    expect(containerCalls.stopped).toBe(1);
  });

  it('does not assert a startup reason it lost the CAS for', async () => {
    // Same rule as enforceTimeout/cancelBuild, and it reads worse here: this catch
    // claims the marker SYNCHRONOUSLY, before any await, so an external cancel
    // arriving afterwards finds the claim taken and stays silent. The local reason
    // is then the ONLY explanation emitted — printed underneath a check run that
    // finalized to the recorded cancellation.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Row already terminal in Postgres -> the CAS in this catch loses.
    vi.mocked(markBuildTerminalIfActive).mockResolvedValueOnce(false);
    // Enter the catch AFTER the container launched, so the teardown runs.
    const scheduleSpy = vi
      .spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule')
      .mockRejectedValueOnce(new Error('schedule arming failed'));
    stubOrderedPortFetch(m, []);

    await expect(m.startBuild(makeConfig())).rejects.toThrow('schedule arming failed');

    // If broken: 'build failed: schedule arming failed' — a local reason
    // contradicting the outcome the check run actually publishes.
    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual(['[build-manager] container terminated: build terminated out of band']);

    scheduleSpy.mockRestore();
  });

  it('skips the drain when the terminal write never settled, so the live token dies sooner', async () => {
    // The drain sits in FRONT of the SIGTERM and costs up to 2x LOG_DRAIN_BUDGET_MS.
    // That is only safe because the row was revoked first: `builds.status` is the
    // deploy token's authority. When the revocation throws or times out the row stays
    // ACTIVE, so `middleware/auth.ts` and the go-live re-check both keep honoring the
    // token for the whole drain — long enough for a runner at final publish to ship
    // work the manager has already decided to kill. No revocation, no drain.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('hyperdrive blip'));
    const { fetchFn } = stubOrderedPortFetch(m, []);

    await expect(m.enforceTimeout()).rejects.toThrow('hyperdrive blip');

    // If broken: the teardown pull runs anyway, holding a still-valid token
    // open for the length of the drain.
    expect(fetchFn).not.toHaveBeenCalled();
    // The kill itself is unaffected — skipping the drain must not skip the SIGTERM.
    expect(containerCalls.stopped).toBe(1);
  });

  it('uses a neutral marker when an unknown timeout revocation loses to cancellation', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');
    vi.mocked(completeCheckRun).mockClear();

    // A deadline/transport error does not cancel the underlying CAS. Before its
    // result is known, another terminal writer wins with the authoritative outcome.
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(
      new Error('build b1: terminal status write did not settle within 5000ms'),
    );
    dbState.status.set('b1', 'cancelled');
    stubOrderedPortFetch(m, []);

    await expect(m.enforceTimeout()).rejects.toThrow('did not settle');

    expect(ctx._logs.map((row) => row.line)).toContain(
      '[build-manager] container terminated: build terminated out of band',
    );
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledOnce();
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({
      conclusion: 'cancelled',
    });
  });

  it('still explains the kill when a peer teardown destroyed the container first', async () => {
    // Overlap shape: a cancel arrives while enforceTimeout is parked on Hyperdrive.
    // The cancel sees the already-terminal LOCAL status, so it never claims, drains,
    // and destroys. enforceTimeout then resumes holding the claim but finds
    // `running === false`.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;

    let releaseRevocation!: () => void;
    const revocationParked = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    vi.mocked(markBuildTerminalIfActive).mockImplementationOnce(async () => {
      await revocationParked;
      return true;
    });
    const { fetchFn } = stubOrderedPortFetch(m, []);

    const timeout = m.enforceTimeout();
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // The peer runs to completion — container destroyed — while the owner is parked.
    await m.cancelBuild('project deleted');
    // The DO-local status is already failed, but the timeout CAS above is still
    // parked and Postgres continues to authorize the deploy token. The peer must
    // signal immediately, not drain during that publication window.
    expect(fetchFn).not.toHaveBeenCalled();
    const beforeOwner = (await (
      await m.fetch(new Request('https://manager/logs?since=0'))
    ).json()) as { logsComplete: boolean | null };
    expect(beforeOwner.logsComplete).toBe(false);
    releaseRevocation();
    await timeout;

    // If broken: the peer had no claim and the owner had no live container, so
    // the marker was gated out on both sides and the log simply stopped. Exactly one,
    // from the caller that owns the claim.
    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual(['[build-manager] container terminated: build timed out']);
    const afterOwner = (await (
      await m.fetch(new Request('https://manager/logs?since=0'))
    ).json()) as { lines: Array<LogRow>; logsComplete: boolean | null };
    expect(afterOwner.logsComplete).toBe(true);
    expect(afterOwner.lines.at(-1)?.line).toBe(
      '[build-manager] container terminated: build timed out',
    );
  });

  it('explains the kill on a startup-failure teardown, and skips its drain on failed revocation', async () => {
    // The third teardown site, which a partial edit left behind twice over: it
    // re-called the first-caller-wins claim (always false once the transition above
    // took it, so the marker was suppressed for EVERY startup failure) and omitted
    // the drain gate (so a failed revocation still drained with a live token).
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Post-launch failure: the container is up, then timeout-scheduling throws.
    vi.spyOn(m as unknown as { schedule: () => Promise<void> }, 'schedule').mockRejectedValueOnce(
      new Error('schedule arming failed'),
    );
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('hyperdrive blip'));
    const { fetchFn } = stubOrderedPortFetch(m, []);

    // The revocation failure is what surfaces here — the catch rethrows
    // `terminalError` ahead of the original cause once teardown has run.
    await expect(m.startBuild(makeConfig())).rejects.toThrow('hyperdrive blip');

    // If broken (1): the second claim returns false, so nothing says why.
    const markers = ctx._logs
      .map((r) => r.line)
      .filter((line) => line.startsWith('[build-manager] container terminated:'));
    expect(markers).toEqual(['[build-manager] container terminated: build terminated out of band']);
    // If broken (2): drainFirst defaulted to true, holding a still-valid token
    // open for the length of the drain.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('finalizes the check run when the terminal write commits after its deadline', async () => {
    // `withDeadline` rejects at TERMINAL_WRITE_TIMEOUT_MS but cannot cancel the query,
    // so a slow write can still commit afterwards. That rejection leaves `terminal`
    // null, so nothing finalizes — and once the late write lands the row IS terminal,
    // so retries and `onStop` early-out and the stale reaper (ACTIVE rows only) skips
    // it. Without the re-read the check run sits `in_progress` forever.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    vi.mocked(completeCheckRun).mockClear();
    // The check run must be resolvable, or the PATCH no-ops for want of an id and the
    // test would pass for the wrong reason.
    ctx._kv.set('checkRunId', '99001');

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(
      new Error('build b1: terminal status write did not settle within 5000ms'),
    );
    // The write that missed its deadline DID commit — the authoritative row is
    // terminal, which is precisely what makes the row invisible to the reaper.
    dbState.status.set('b1', 'failed');
    stubOrderedPortFetch(m, []);

    await expect(m.enforceTimeout()).rejects.toThrow('did not settle');

    // If broken: no PATCH at all, and nothing else will ever send one.
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledTimes(1);
  });

  it('finalizes the check run when the terminal write commits AFTER the re-read', async () => {
    // The test above covers the ordering where the late write beat the immediate
    // re-read. This is the other one, and it is the likelier of the two: the read is
    // taken within milliseconds of the 5s rejection, so a query that blew past that
    // deadline usually has not committed yet. A single re-read sees an ACTIVE row,
    // maps it to a null conclusion and returns — and by the time the write lands,
    // every other actor has early-outed on the DO-local terminal status. Reconciling
    // only once leaves the check `in_progress` permanently.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    vi.mocked(completeCheckRun).mockClear();
    ctx._kv.set('checkRunId', '99001');

    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(
      new Error('build b1: terminal status write did not settle within 5000ms'),
    );
    // Row still ACTIVE at teardown: the UPDATE is in flight, not yet committed.
    dbState.status.set('b1', 'building');
    stubOrderedPortFetch(m, []);
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];

    await expect(m.enforceTimeout()).rejects.toThrow('did not settle');

    // Nothing to conclude yet — and crucially, the manager did not give up.
    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();
    expect(scheduledTasks(m).some((t) => t.callback === 'reconcileTerminalWrite')).toBe(true);

    // The in-flight UPDATE now commits, exactly as `withDeadline` allows.
    dbState.status.set('b1', 'failed');
    await runDueSchedules(m);

    // If broken: no reconcile is ever armed, so this PATCH never happens and
    // the check run stays `in_progress` for the life of the repository.
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeCheckRun).mock.calls[0][4]).toMatchObject({
      conclusion: 'failure',
    });
  });

  it('keeps looking while the terminal write has still not landed', async () => {
    // The re-arm must survive a pass that learns nothing, or a write that commits on
    // the second minute is no better off than one that never commits. It self-limits
    // in the other direction too: a write that genuinely died leaves the row ACTIVE
    // until the hourly stale reaper marks it `failed`, and the next pass finalizes
    // from that — so the loop always ends, either at the commit or at the reaper.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    vi.mocked(completeCheckRun).mockClear();
    ctx._kv.set('checkRunId', '99001');
    dbState.status.set('b1', 'building');

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await m.reconcileTerminalWrite();

    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();
    expect(scheduledTasks(m).filter((t) => t.callback === 'reconcileTerminalWrite')).toHaveLength(
      1,
    );

    // Still nothing. Re-arm again rather than dropping the build on the floor.
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await m.reconcileTerminalWrite();
    expect(scheduledTasks(m).filter((t) => t.callback === 'reconcileTerminalWrite')).toHaveLength(
      1,
    );

    // The stale reaper terminalizes the row; the next pass concludes and stops.
    dbState.status.set('b1', 'failed');
    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await m.reconcileTerminalWrite();
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledTimes(1);
    expect(scheduledTasks(m).some((t) => t.callback === 'reconcileTerminalWrite')).toBe(false);
  });

  it('reuses the check-run id from the bounded reconciliation row', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Simulate eviction/cache loss: only the authoritative row still has the id.
    ctx._kv.delete('checkRunId');
    (m as unknown as { activeCheckRunId: string | null }).activeCheckRunId = null;
    vi.mocked(getBuild).mockClear();
    vi.mocked(completeCheckRun).mockClear();
    vi.mocked(getBuild).mockResolvedValueOnce({
      id: 'b1',
      created_at: dbState.createdAt,
      status: 'failed',
      check_run_id: '99001',
    } as never);

    await m.reconcileTerminalWrite();

    expect(vi.mocked(getBuild)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeCheckRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeCheckRun).mock.calls[0][3]).toBe('99001');
  });

  it('does not re-read a bounded reconciliation row whose check-run id is null', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    ctx._kv.delete('checkRunId');
    (m as unknown as { activeCheckRunId: string | null }).activeCheckRunId = null;
    vi.mocked(getBuild).mockClear();
    vi.mocked(completeCheckRun).mockClear();
    vi.mocked(getBuild).mockResolvedValueOnce({
      id: 'b1',
      created_at: dbState.createdAt,
      status: 'failed',
      check_run_id: null,
    } as never);

    await m.reconcileTerminalWrite();

    expect(vi.mocked(getBuild)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();
  });

  it('stops reconciling once the build row is gone', async () => {
    // `deleteProjectCascade` DELETES build rows during project teardown, so an
    // armed reconcile outlives its row. A missing row is not a pending one: no
    // write will ever land and no reaper can terminalize a row that is gone, so
    // re-arming here is an alarm every RECONCILE_RETRY_SECONDS forever.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    vi.mocked(completeCheckRun).mockClear();
    dbState.status.delete('b1'); // getBuild now returns null, as after a cascade delete

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    await m.reconcileTerminalWrite();

    // If broken: an absent row was treated like an active one and re-armed.
    expect(scheduledTasks(m).some((t) => t.callback === 'reconcileTerminalWrite')).toBe(false);
    expect(vi.mocked(completeCheckRun)).not.toHaveBeenCalled();
  });

  it('re-arms when the reconciliation read itself never settles', async () => {
    // This runs exactly when Postgres is already stalling — the same stall that
    // made the terminal write miss its deadline. An unbounded SELECT that PENDS
    // reaches neither `schedule()` call, so the invocation dies with no retry
    // armed and the check run is orphaned permanently: the very failure this
    // method exists to prevent, one layer up.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    vi.mocked(completeCheckRun).mockClear();
    // Pends forever — the Hyperdrive-stall shape, not the throw shape.
    vi.mocked(getBuild).mockReturnValueOnce(new Promise(() => {}) as never);

    (m as unknown as { _schedules: Array<ScheduledTask> })._schedules = [];
    vi.useFakeTimers();
    try {
      const pending = m.reconcileTerminalWrite();
      await vi.advanceTimersByTimeAsync(TERMINAL_WRITE_TIMEOUT_MS + 10);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    // If broken: the await never returns, so nothing is ever re-armed.
    expect(scheduledTasks(m).some((t) => t.callback === 'reconcileTerminalWrite')).toBe(true);
  });

  it('drains every page of a backlog in one pull, not one page per tick', async () => {
    // The agent caps a response so an oversized body cannot blow the per-request
    // timeout. But at one page per POLL_SECONDS tick, acknowledgement progress is
    // unnecessarily delayed and a deep backlog needs many scheduled callbacks.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._logs.length = 0;

    const pages = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [
      { seq: n, line: `page-${n}`, stream: 'stdout' as const, ts: n },
    ]);
    const fetchFn = stubPagedPortFetch(m, pages);

    await (m as unknown as { pullLogsOnce: (c: unknown) => Promise<void> }).pullLogsOnce({
      getTcpPort: () => ({ fetch: fetchFn }),
      running: true,
    });

    // If broken: one page per call, so seven pages wait for seven ticks.
    // One final empty request carries `since=<last ingested seq>` back to the agent,
    // acknowledging the last page without waiting for another scheduled callback.
    expect(fetchFn).toHaveBeenCalledTimes(pages.length + 1);
    expect(fetchFn.mock.calls.at(-1)?.[0]).toBe(`http://manager/logs?since=${pages.length}`);
    expect(ctx._logs.map((r) => r.line)).toEqual(pages.map((_, i) => `page-${i + 1}`));
  });

  it('bounds the whole paginated drain by wall clock, not per page', async () => {
    // The page cap bounds WORK; it does not bound LATENCY. A fresh
    // `AbortSignal.timeout` per request lets MAX_LOG_PULL_PAGES pages that each
    // answer just under LOG_PULL_TIMEOUT_MS hold one callback for 64s — and
    // `forceStopContainer` runs two of them in front of a SIGTERM. `pollLogs` and
    // `enforceTimeout` are both base-scheduler callbacks and run one at a time,
    // so that also postpones the Postgres revocation ending the token's authority.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._logs.length = 0;

    // A PRODUCTIVE but slow agent: every page delivers and reports more, so
    // neither the `hasMore` nor the cursor-not-advancing guard ever fires. This
    // is the only shape that reaches the ceiling — a wedged agent aborts at the
    // per-request timeout and breaks the loop after one page.
    const perPageMs = 1500;
    let clock = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let seq = 0;
    const fetchFn = vi.fn(async (_url: string, _port?: number, _init?: RequestInit) => {
      clock += perPageMs;
      seq += 1;
      return new RealResponse(
        JSON.stringify({
          lines: [{ seq, line: `page-${seq}`, stream: 'stdout', ts: seq }],
          lastSeq: seq,
          hasMore: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    (m as unknown as { _portFetch: typeof fetchFn })._portFetch = fetchFn;

    try {
      await (m as unknown as { pullLogsOnce: (c: unknown) => Promise<void> }).pullLogsOnce({
        getTcpPort: () => ({ fetch: fetchFn }),
        running: true,
      });
    } finally {
      nowSpy.mockRestore();
    }

    // If broken: MAX_LOG_PULL_PAGES (32) calls, i.e. 48s in one callback.
    const affordable = Math.ceil(LOG_DRAIN_BUDGET_MS / perPageMs);
    expect(fetchFn.mock.calls.length).toBe(affordable);
    expect(fetchFn.mock.calls.length).toBeLessThan(MAX_LOG_PULL_PAGES);
    // Cut short, not abandoned: the cursor advanced, so the next tick resumes.
    expect(fetchFn.mock.calls.at(-1)?.[0]).toBe(`http://manager/logs?since=${affordable - 1}`);
  });

  /**
   * Freeze the Workers clock for the length of a drain. A deployed Worker's clock
   * advances on I/O, NOT during CPU work, so every millisecond a callback spends
   * parsing, inserting and fanning out between fetches is invisible to
   * LOG_DRAIN_BUDGET_MS. Freezing `Date.now()` reproduces that exactly: the
   * wall-clock deadline can never expire, so whatever stops the loop is a
   * deterministic work bound and nothing else.
   */
  function withFrozenWorkerClock<T>(run: () => Promise<T>): Promise<T> {
    const frozen = Date.now();
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => frozen);
    return run().finally(() => spy.mockRestore());
  }

  /** Endless maximum-shape pages: every page delivers `rows` lines and claims more. */
  function stubEndlessPages(
    m: BuildManager,
    rows: number,
    line: (seq: number) => string = (seq) => `line-${seq}`,
  ): ReturnType<typeof vi.fn> {
    let seq = 0;
    const fn = vi.fn(async (_url: string, _port?: number, _init?: RequestInit) => {
      const lines = Array.from({ length: rows }, () => {
        seq += 1;
        return { seq, line: line(seq), stream: 'stdout', ts: seq };
      });
      return new RealResponse(JSON.stringify({ lines, lastSeq: seq, hasMore: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    (m as unknown as { _portFetch: typeof fn })._portFetch = fn;
    return fn;
  }

  function pullOnce(m: BuildManager, fetchFn: unknown): Promise<boolean> {
    return (m as unknown as { pullLogsOnce: (c: unknown) => Promise<boolean> }).pullLogsOnce({
      getTcpPort: () => ({ fetch: fetchFn }),
    });
  }

  it('bounds ingestion by a deterministic sink budget the frozen Workers clock cannot see', async () => {
    // LOG_DRAIN_BUDGET_MS bounds LATENCY, not WORK, and cannot be made to bound
    // work: it is read off a clock that stands still while the CPU runs. With the
    // agent answering instantly, a maximum-shape backlog puts
    // MAX_LOG_PULL_PAGES x MAX_LOG_RESPONSE_LINES rows through JSON.parse, the
    // SQLite insert path and the WS fan-out inside ONE callback — all of it scored
    // as free, all of it in front of a teardown's SIGTERM.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._logs.length = 0;

    // No subscribers and short lines, so a row costs exactly one sink op and the
    // expected page count is the budget divided by the agent's page cap.
    const fetchFn = stubEndlessPages(m, MAX_LOG_RESPONSE_LINES);
    const pages = MAX_LOG_SINK_OPS_PER_DRAIN / MAX_LOG_RESPONSE_LINES;

    await withFrozenWorkerClock(() => pullOnce(m, fetchFn));

    // If broken: MAX_LOG_PULL_PAGES (32) calls — 64000 rows inserted and
    // broadcast in one callback, with the deadline never once observing a tick.
    expect(fetchFn).toHaveBeenCalledTimes(pages);
    expect(pages).toBeLessThan(MAX_LOG_PULL_PAGES);
    // Whole pages only: the cursor covers exactly the rows that reached the sink.
    expect(logCursor(m)).toBe(MAX_LOG_SINK_OPS_PER_DRAIN);
    expect(ctx._logs.length).toBe(MAX_LOG_SINK_OPS_PER_DRAIN);

    // Cut short, not abandoned. The next callback resumes at the advanced cursor,
    // and that request is also the acknowledgement this one skipped.
    await withFrozenWorkerClock(() => pullOnce(m, fetchFn));
    expect(fetchFn.mock.calls[pages][0]).toBe(
      `http://manager/logs?since=${MAX_LOG_SINK_OPS_PER_DRAIN}`,
    );
    const seqs = ctx._logs.map((row) => Number(row.line.slice('line-'.length)));
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => seqs[0] + i)); // no gaps
  });

  it('charges WebSocket fan-out against the sink budget', async () => {
    // Every ingested row is one insert PLUS one send per live subscriber, so the
    // CPU a page costs scales with the tail audience. A row-count-only budget
    // would let N subscribers multiply the real work by (1 + N) for free.
    const rowsPerPage = 1000;
    const subscribers = 4;

    const quiet = makeStubCtx();
    const quietManager = makeManager(quiet, makeEnv());
    await quietManager.startBuild(makeConfig());
    const quietFetch = stubEndlessPages(quietManager, rowsPerPage);
    await withFrozenWorkerClock(() => pullOnce(quietManager, quietFetch));

    const watched = makeStubCtx();
    const watchedManager = makeManager(watched, makeEnv());
    await watchedManager.startBuild(makeConfig());
    for (let i = 0; i < subscribers; i++) {
      await watchedManager.fetch(
        new Request('https://manager/', { headers: { Upgrade: 'websocket' } }),
      );
    }
    expect(watched._sockets.length).toBe(subscribers);
    const watchedFetch = stubEndlessPages(watchedManager, rowsPerPage);
    await withFrozenWorkerClock(() => pullOnce(watchedManager, watchedFetch));

    // If broken: both drain the same 10 pages, and the watched one does
    // five times the sink work doing it.
    expect(quietFetch).toHaveBeenCalledTimes(MAX_LOG_SINK_OPS_PER_DRAIN / rowsPerPage);
    expect(watchedFetch).toHaveBeenCalledTimes(
      MAX_LOG_SINK_OPS_PER_DRAIN / (rowsPerPage * (1 + subscribers)),
    );
  });

  it('charges row payload bytes against the sink budget', async () => {
    // Bounding the ROW COUNT does not bound the work either: the agent caps a page
    // at MAX_LOG_RESPONSE_BYTES, not at a row count, so two 1 MiB lines are a full
    // page that a per-row budget prices at 2. Thirty-two of those pages are 64 MiB
    // copied into SQLite, into a JSON payload and into every send buffer.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._logs.length = 0;

    const megabyteLine = 'x'.repeat(LOG_SINK_OP_PAYLOAD_BYTES * 1024);
    const rowCost = megabyteLine.length / LOG_SINK_OP_PAYLOAD_BYTES;
    const rowsPerPage = MAX_LOG_RESPONSE_BYTES / megabyteLine.length;
    const fetchFn = stubEndlessPages(m, rowsPerPage, () => megabyteLine);

    await withFrozenWorkerClock(() => pullOnce(m, fetchFn));

    // If broken: MAX_LOG_PULL_PAGES (32) calls / 64 MiB in one callback.
    const pages = Math.ceil(MAX_LOG_SINK_OPS_PER_DRAIN / (rowsPerPage * rowCost));
    expect(fetchFn).toHaveBeenCalledTimes(pages);
    expect(pages).toBeLessThan(MAX_LOG_PULL_PAGES);
    expect(ctx._logs.length).toBe(pages * rowsPerPage);
  });

  it('caps the teardown drain so the SIGTERM is not held behind unbounded sink work', async () => {
    // `forceStopContainer` drains in FRONT of the
    // stop/destroy that frees a global fleet slot. On a frozen clock the drain has
    // no deadline it can observe, so only the work budget can return control to the
    // signals.
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._logs.length = 0;
    containerCalls.stopped = 0;

    const fetchFn = stubEndlessPages(m, MAX_LOG_RESPONSE_LINES);

    await withFrozenWorkerClock(() => m.cancelBuild('user cancelled'));

    // If broken: 32 pages of maximum-shape ingestion before the SIGTERM.
    expect(fetchFn.mock.calls.length).toBe(MAX_LOG_SINK_OPS_PER_DRAIN / MAX_LOG_RESPONSE_LINES);
    expect(containerCalls.stopped).toBe(1);
    expect(ctx._logs.map((row) => row.line)).toContain(
      '[build-manager] container terminated: user cancelled',
    );
  });

  it('re-arms the single-flight gate so a later pull is not swallowed', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Coalescing must not become a one-shot latch: the gate is released in a
    // `finally`, so the next tick pulls again.
    const fetchFn = stubPortFetch(m, [
      { lines: [{ seq: 1, line: 'first', stream: 'stdout', ts: 1 }], lastSeq: 1 },
      { lines: [{ seq: 2, line: 'second', stream: 'stdout', ts: 2 }], lastSeq: 2 },
    ]);

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][0]).toBe('http://manager/logs?since=1');
    expect(ctx._logs.map((r) => r.line)).toEqual(['first', 'second']);
  });

  it('releases the single-flight gate even when the pull throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // A rejected pull must not leave `pullInFlight` pinned to a settled promise —
    // that would silently mute the log loop for the rest of the build.
    const fetchFn = stubPortFetch(m, [
      new Error('agent unreachable'),
      { lines: [{ seq: 1, line: 'back online', stream: 'stdout', ts: 1 }], lastSeq: 1 },
    ]);

    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();
    await (m as unknown as { pollLogs: () => Promise<void> }).pollLogs();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(ctx._logs.map((r) => r.line)).toEqual(['back online']);
  });

  it('tears the container down even when the teardown drain pull throws', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    containerCalls.stopped = 0;
    containerCalls.destroyed = 0;

    // A wedged/unreachable agent must not cost the SIGKILL: an escaping throw here
    // would skip stop()/destroy() and leave the container pinning a fleet slot.
    const fetchFn = stubPortFetch(m, [new Error('agent unreachable')]);

    await expect(m.cancelBuild('build superseded')).resolves.toBeUndefined();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(containerCalls.stopped).toBe(1);
    expect(containerCalls.destroyed).toBe(1);
  });
});

describe('BuildManager.ingestLines (the pull-loop sink)', () => {
  it('upgrades a legacy log table once without fabricating a final delimiter', async () => {
    const ctx = makeStubCtx({
      legacyLogSchema: true,
      initialLogs: [{ seq: 1, line: '\x1b[?1049hERR', stream: 'stdout', ts: 1 }],
    });
    const m = makeManager(ctx, makeEnv());
    const readTail = () =>
      (m as unknown as { readLogTailMarkdown: () => Promise<string | null> }).readLogTailMarkdown;

    const first = await readTail().call(m);
    expect(parseFence(first as string).content).toEqual(['ERR']);
    await readTail().call(m);
    expect(
      ctx._sqlQueries.filter((query) => query.startsWith('ALTER TABLE logs ADD COLUMN')),
    ).toHaveLength(1);
    expect(ctx._logs[0].lineEnding).toBeNull();
  });

  it('inserts each line into SQLite and broadcasts it (sole producer is pollLogs)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await m.fetch(new Request('https://manager/', { headers: { Upgrade: 'websocket' } }));
    const server = ctx._sockets[0];
    server.sent = [];

    // Call ingestLines directly with BuildLogLine shape (no seq).
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'a', stream: 'stdout', ts: 1 } as unknown as LogRow,
      { line: 'b', stream: 'stderr', ts: 2 } as unknown as LogRow,
    ]);

    expect(ctx._logs.map((r) => r.line)).toEqual(['a', 'b']);
    const sent = server.sent.map((s) => JSON.parse(s));
    expect(sent).toContainEqual({ type: 'log', line: 'a', stream: 'stdout', ts: 1 });
    expect(sent).toContainEqual({ type: 'log', line: 'b', stream: 'stderr', ts: 2 });
  });
});

// Six backticks: the MINIMUM fence — survives log lines that themselves
// contain ``` (build tools echo markdown). Content with runs of ≥6 backticks
// grows the fence past the longest run (see the fence-sizing tests below).
const SIX_BACKTICKS = '``````';

// GitHub validates output.text in UTF-8 BYTES ("maximum bytesize of 65535"),
// so the byte-cap tests below measure results the way GitHub does.
const utf8 = new TextEncoder();

// Manual `String.prototype.isWellFormed()` (typing it needs lib es2024, which
// this package's tsconfig doesn't enable): true when the string contains an
// UNPAIRED surrogate — a high (0xD800–0xDBFF) not followed by a low
// (0xDC00–0xDFFF), or a low not preceded by a high. A byte-truncation cut that
// splits an emoji pair leaves exactly such a lone half.
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i++; // complete pair — skip its low half
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Longest run of consecutive backticks in a string (0 when none).
function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
}

// Fence delimiters are dynamic (max(6, longest content run + 1)) — parse them
// from the rendered output instead of assuming six, and assert the format
// contract on the way: `<backticks>text` opener, matching bare-backtick closer
// as the final line.
function parseFence(out: string): { fenceLen: number; content: Array<string> } {
  const rendered = out.split('\n');
  const openIdx = rendered.findIndex((line) => /^`+text$/.test(line));
  expect(openIdx).toBeGreaterThan(-1);
  const fenceLen = rendered[openIdx].length - 'text'.length;
  expect(rendered[rendered.length - 1]).toBe('`'.repeat(fenceLen));
  return { fenceLen, content: rendered.slice(openIdx + 1, rendered.length - 1) };
}

describe('formatLogTailMarkdown (pure check-run output.text renderer)', () => {
  it('returns null when nothing was captured (PATCH omits text)', async () => {
    expect(await formatLogTailMarkdown([], 0)).toBe(null);
  });

  it('renders header + six-backtick text fence, lines in given order, no marker when all captured lines are shown', async () => {
    expect(await formatLogTailMarkdown(['a', 'b', 'c'], 3)).toBe(
      `**Last 3 log lines:**\n\n${SIX_BACKTICKS}text\na\nb\nc\n${SIX_BACKTICKS}`,
    );
  });

  it('adds the omission marker when more lines were captured than are rendered', async () => {
    expect(await formatLogTailMarkdown(['b', 'c'], 5)).toBe(
      `**Last 2 log lines:**\n\n_…earlier lines omitted._\n\n${SIX_BACKTICKS}text\nb\nc\n${SIX_BACKTICKS}`,
    );
  });

  it('drops the OLDEST lines until the joined content fits the char cap (result under GitHub 65535)', async () => {
    // 100 lines of exactly 1000 chars: joined = 100*1000 + 99 separators > 60000.
    // Kept-count k satisfies 1000k + (k-1) <= 60000 → k = 59 (59058 chars).
    const lines = Array.from(
      { length: 100 },
      (_, i) => `${String(i).padStart(4, '0')}${'x'.repeat(996)}`,
    );
    const out = await formatLogTailMarkdown(lines, 100);
    expect(out).not.toBe(null);
    expect(out).toContain('**Last 59 log lines:**');
    expect(out).toContain('_…earlier lines omitted._');
    // The newest survives; the newest DROPPED line (index 40) does not.
    expect(out).toContain(lines[99]);
    expect(out).toContain(lines[41]);
    expect(out).not.toContain(lines[40]);
    expect((out as string).length).toBeLessThan(65535);
  });

  it('keeps the LAST 60000 chars of a single over-cap line', async () => {
    const big = 'h'.repeat(5000) + 't'.repeat(CHECK_RUN_LOG_TAIL_MAX_BYTES);
    expect(await formatLogTailMarkdown([big], 1)).toBe(
      `**Last 1 log lines:**\n\n${SIX_BACKTICKS}text\n${'t'.repeat(CHECK_RUN_LOG_TAIL_MAX_BYTES)}\n${SIX_BACKTICKS}`,
    );
    // Exactly AT the cap is kept whole — the cap only drops what EXCEEDS it.
    const atCap = 'e'.repeat(CHECK_RUN_LOG_TAIL_MAX_BYTES);
    expect(await formatLogTailMarkdown([atCap], 1)).toContain(`\n${atCap}\n`);
  });

  it('grows the fence to 7 backticks when a content line contains a 6-backtick run (no breakout)', async () => {
    const line = `fence bait: ${SIX_BACKTICKS} tail`;
    const out = (await formatLogTailMarkdown([line], 1)) as string;
    const { fenceLen, content } = parseFence(out);
    expect(fenceLen).toBe(7);
    // The line is preserved verbatim — sizing the fence, not mangling content.
    expect(content).toEqual([line]);
    // General invariant: no content backtick run can reach the fence length.
    expect(Math.max(...content.map(longestBacktickRun))).toBeLessThan(fenceLen);
  });

  it('grows the fence to 13 backticks for a 12-backtick content run', async () => {
    const out = (await formatLogTailMarkdown(['a', `x${'`'.repeat(12)}y`, 'b'], 3)) as string;
    const { fenceLen, content } = parseFence(out);
    expect(fenceLen).toBe(13);
    expect(content).toEqual(['a', `x${'`'.repeat(12)}y`, 'b']);
  });

  it('keeps the fence at exactly six backticks when the content has no backticks', async () => {
    const { fenceLen } = parseFence((await formatLogTailMarkdown(['plain', 'lines'], 2)) as string);
    expect(fenceLen).toBe(6);
  });

  it('holds the WHOLE string under GitHub’s 65535 cap for a pathological all-backtick line', async () => {
    const out = (await formatLogTailMarkdown(['`'.repeat(61000)], 1)) as string;
    expect(out.length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    // Format still parses: header first, then fence lines matching
    // ^`+text$ / ^`+$, and the fence still beats every content run.
    expect(out.split('\n')[0]).toBe('**Last 1 log lines:**');
    const { fenceLen, content } = parseFence(out);
    expect(content.length).toBeGreaterThan(0);
    expect(fenceLen).toBeGreaterThan(Math.max(...content.map(longestBacktickRun)));
  });

  // ——— UTF-8 byte caps: GitHub validates output.text in BYTES, not UTF-16
  // code units (its 422 reads "maximum bytesize of 65535"). CJK is 3 bytes
  // per code unit and emoji 4 bytes per 2 units, so unit-measured caps let
  // such content sail past GitHub's real limit. ———

  it('drops oldest lines by UTF-8 BYTE measure, not code units (CJK content)', async () => {
    // 40 lines of 4 ASCII + 998 CJK chars: 1002 units / 2998 bytes each.
    // Joined: 40119 units (fits a 60000 UNIT cap — the wrong measure) but
    // 119959 bytes. The byte cap keeps k lines where 2998k + (k-1) <= 60000,
    // i.e. the newest 20.
    const lines = Array.from(
      { length: 40 },
      (_, i) => `${String(i).padStart(4, '0')}${'语'.repeat(998)}`,
    );
    const out = (await formatLogTailMarkdown(lines, 40)) as string;
    expect(out).toContain('**Last 20 log lines:**');
    expect(out).toContain('_…earlier lines omitted._');
    expect(out).toContain(lines[39]);
    expect(out).toContain(lines[20]);
    expect(out).not.toContain(lines[19]);
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
  });

  it('tail-truncates a lone CJK line to its LAST ~60000 UTF-8 bytes (under 65535 total)', async () => {
    // 30000 units (would fit a unit cap untouched) but 90000 bytes.
    const out = (await formatLogTailMarkdown(['好'.repeat(30000)], 1)) as string;
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    const { content } = parseFence(out);
    expect(content).toHaveLength(1);
    // Still a pure '好' tail, and NEAR the 60000-byte content cap — proves
    // byte-capping keeps the tail rather than over-truncating it.
    expect(/^好+$/.test(content[0])).toBe(true);
    const contentBytes = utf8.encode(content[0]).length;
    expect(contentBytes).toBeLessThanOrEqual(60000);
    expect(contentBytes).toBeGreaterThanOrEqual(59990);
  });

  it('never leaves a split surrogate pair at a truncation cut (emoji at the boundary)', async () => {
    // '🚀' = 2 UTF-16 units / 4 UTF-8 bytes: 20000 emoji = 80000 bytes, so the
    // byte cap must cut inside the emoji run. A cut landing mid-pair would
    // strand a lone surrogate (re-encoded as a 3-byte U+FFFD — garbage).
    const out = (await formatLogTailMarkdown(['🚀'.repeat(20000)], 1)) as string;
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it('converges the WHOLE string under 65535 BYTES when the dynamic fence eats the byte headroom (emoji + backtick run)', async () => {
    // Content: 13500 emoji (54000 bytes) + a 6000-backtick run = 60000 bytes
    // exactly — passes the content cap untouched. The 6001-backtick fence
    // delimiters then push the rendered BYTE length past 65535 while its
    // UTF-16 length stays far under (the unit measure never fires). The
    // converging loop must cut the lone line by bytes without splitting an
    // emoji pair.
    const out = (await formatLogTailMarkdown(['🚀'.repeat(13500) + '`'.repeat(6000)], 1)) as string;
    expect(utf8.encode(out).length).toBeLessThanOrEqual(CHECK_RUN_OUTPUT_TEXT_MAX_BYTES);
    expect(hasLoneSurrogate(out)).toBe(false);
    const { fenceLen, content } = parseFence(out);
    expect(fenceLen).toBeGreaterThan(Math.max(...content.map(longestBacktickRun)));
  });
});

// A terminal CONSUMES escape sequences; a markdown code fence PRINTS them. The
// container captures build output verbatim (piped, not a pty), so whatever the
// repo's toolchain animates or colorizes lands in the check run as literal
// `^[[32m` / `^[[1G` noise, with every erased spinner frame still glued onto one
// line — the agent splits on CR/LF and a clack spinner separates frames with
// `ESC[1G ESC[J` and no newline.
describe('renderCapturedLog (terminal-visible text for the check run)', () => {
  const ESC = '\x1b';

  it('leaves a plain line untouched', async () => {
    expect(await renderCapturedLog('[build-agent] source extracted')).toBe(
      '[build-agent] source extracted',
    );
  });

  it('collapses a clack spinner line to its LAST frame (the erased ones are gone on screen)', async () => {
    // Exactly the shape captured from the voidzero.dev build: frame, cursor to
    // column 1, erase down, next frame — hundreds of times, on ONE line.
    const line =
      `◒  Hashing assets (100/281)${ESC}[1G${ESC}[J` +
      `◐  Hashing assets (200/281)${ESC}[1G${ESC}[J` +
      `◓  Hashing assets (281/281)${ESC}[1G${ESC}[J` +
      '◇  Checked for changes';
    expect(await renderCapturedLog(line)).toBe('◇  Checked for changes');
  });

  it('renders a trailing erase as the blank row a terminal would show', async () => {
    // The writer moved to column 1 and erased from there, so the row IS blank
    // (xterm.js confirms — see sanitize-log-line-oracle.test.ts). Nothing real is
    // lost, because clack
    // erases BEFORE writing each frame, so the final message lands after the
    // last erase and survives — second assertion.
    expect(await renderCapturedLog(`◆  Deployed!${ESC}[1G${ESC}[J`)).toBe('');
    expect(await renderCapturedLog(`◒ Hash${ESC}[1G${ESC}[J◆  Deployed!`)).toBe('◆  Deployed!');
  });

  it('strips SGR color codes emitted by third-party build tools', async () => {
    // vitepress/rolldown colorized despite the piped (non-TTY) stdio, and does
    // not consult CI — which is why the render-time strip has to exist.
    expect(
      await renderCapturedLog(`${ESC}[32m✓${ESC}[0m building client + server bundles...`),
    ).toBe('✓ building client + server bundles...');
  });

  it('strips DEC private cursor hide/show, which clack emits around every spinner', async () => {
    expect(await renderCapturedLog(`${ESC}[?25l│`)).toBe('│');
    expect(await renderCapturedLog(`${ESC}[?25h└  Done!`)).toBe('└  Done!');
  });

  it('strips OSC sequences (window title / hyperlink) under both BEL and ST terminators', async () => {
    expect(await renderCapturedLog(`${ESC}]0;building\x07done`)).toBe('done');
    expect(await renderCapturedLog(`${ESC}]8;;https://void.app${ESC}\\link`)).toBe('link');
  });

  // Expectations for the string-control cases below are ground truth from
  // @xterm/headless (a full VT500 parser), NOT from pyte — pyte implements OSC
  // only and has no DCS/SOS/PM/APC handling at all, so it cannot adjudicate them.
  it('consumes every C1 string control WHOLE, payload included', async () => {
    // A terminal displays nothing for any of these; leaving the payload behind
    // spends the check-run tail budget on bytes no reader will ever see.
    expect(await renderCapturedLog(`before${ESC}Pq#0;2;0;0;0payload${ESC}\\after`)).toBe(
      'beforeafter',
    );
    expect(await renderCapturedLog(`before${ESC}_Ga=T,f=100;BASE64${ESC}\\after`)).toBe(
      'beforeafter',
    );
    expect(await renderCapturedLog(`before${ESC}Xsos${ESC}\\after`)).toBe('beforeafter');
    expect(await renderCapturedLog(`before${ESC}^pm${ESC}\\after`)).toBe('beforeafter');
    // DECRQSS reply — a real one a tool can receive and echo.
    expect(await renderCapturedLog(`${ESC}P1$r0m${ESC}\\ok`)).toBe('ok');
  });

  it('consumes an UNTERMINATED string control to end of line', async () => {
    // `pipeStream` caps one line at MAX_PARTIAL_LINE_CHARS and splits on LF, so
    // a long payload reaches us with its ST already cut off. A VT parser stays
    // in the string state to end of input, so this is faithful, and it is what
    // stops a 128KB truncated blob from surviving into the fence.
    expect(await renderCapturedLog(`before${ESC}_Gpayload with no terminator`)).toBe('before');
    expect(await renderCapturedLog(`before${ESC}]0;title never closed`)).toBe('before');
  });

  it('terminates on BEL for OSC only — DCS/SOS/PM/APC run to ST', async () => {
    // xterm's VT500 transition table exits OSC_STRING on BEL (`OSC_END` -> GROUND)
    // but treats BEL as IGNORE / DCS_PUT in SOS_PM_APC_STRING and in every DCS
    // state, so the payload after an embedded BEL is still invisible. BEL is also
    // an ordinary data byte inside sixel, so this is reachable from real payloads.
    for (const intro of ['P', 'X', '^', '_']) {
      expect(await renderCapturedLog(`before${ESC}${intro}hidden\x07still${ESC}\\after`)).toBe(
        'beforeafter',
      );
    }
    // ...and with no ST at all, the string still runs to end of line.
    expect(await renderCapturedLog(`${ESC}Pabc\x07def`)).toBe('');
    // OSC keeps BEL as a terminator (the legacy xterm convention).
    expect(await renderCapturedLog(`${ESC}]0;title\x07visible`)).toBe('visible');
  });

  it('aborts a string control on an embedded ESC, as a VT parser does', async () => {
    expect(await renderCapturedLog(`${ESC}Pq${ESC}[2Kmore${ESC}\\tail`)).toBe('moretail');
  });

  it('treats bare CR as a rewrite too (progress bars that never emit LF)', async () => {
    expect(await renderCapturedLog('12%\r45%\r100%')).toBe('100%');
  });

  it('returns empty for a line that was pure control output', async () => {
    expect(await renderCapturedLog(`${ESC}[?25l${ESC}[1G${ESC}[J`)).toBe('');
    expect(await renderCapturedLog('')).toBe('');
  });

  it('does not mistake ordinary text for an escape sequence', async () => {
    expect(await renderCapturedLog('cost [32m] and \\x1b are literal')).toBe(
      'cost [32m] and \\x1b are literal',
    );
  });

  // Expectations below are ground truth from a real VT emulator, not from reading
  // the regex back to itself. An erase is only a frame boundary when it reaches
  // BACK past the cursor; erase-forward leaves the prefix on screen, and
  // discarding it drops diagnostic context.
  //
  // pyte adjudicates the EL cases and ED 0/1/2, but NOT ED 3: its
  // `erase_in_display` hardcodes `how == 2 or how == 3`, so it reports 3J as a
  // full-screen erase and cannot represent scrollback at all. The 3J expectation
  // below comes from @xterm/headless (full VT500 parser), which leaves the cursor
  // row untouched — an earlier revision trusted pyte here and misfiled 3J as
  // prefix-erasing.
  it('keeps the prefix across erase-FORWARD, which clears only from the cursor on', async () => {
    // Terminal renders each of these as 'Downloading done'.
    expect(await renderCapturedLog(`Downloading${ESC}[K done`)).toBe('Downloading done');
    expect(await renderCapturedLog(`Downloading${ESC}[0K done`)).toBe('Downloading done');
    expect(await renderCapturedLog(`Downloading${ESC}[J done`)).toBe('Downloading done');
    expect(await renderCapturedLog(`Downloading${ESC}[0J done`)).toBe('Downloading done');
    // ED 3 ("Erase Saved Lines", an xterm extension) drops scrollback rows ABOVE
    // the viewport and writes no visible cell, so the prefix survives.
    expect(await renderCapturedLog(`Downloading${ESC}[3J done`)).toBe('Downloading done');
  });

  it('drops the prefix for erases that reach back past the cursor', async () => {
    // Terminal blanks the prefix for each of these. 2J is here and 3J is not:
    // 2J clears the entire screen INCLUDING the cursor's own row.
    for (const seq of ['[1K', '[2K', '[1J', '[2J']) {
      expect((await renderCapturedLog(`Downloading${ESC}${seq} done`)).trim()).toBe('done');
    }
  });

  it('still terminalizes the frame for the clear-screen combos that carry 3J', async () => {
    // Every real emitter found in the dep tree (vite, tsc, playwright,
    // /usr/bin/clear) pairs 3J with 2J, whose boundary still applies — so the
    // reclassification above changes nothing for them.
    for (const combo of [
      `${ESC}[2J${ESC}[3J${ESC}[H`,
      `${ESC}[3J${ESC}[H${ESC}[2J`,
      `${ESC}[H${ESC}[2J${ESC}[3J`,
    ]) {
      expect((await renderCapturedLog(`Downloading${combo} done`)).trim()).toBe('done');
    }
  });

  it('overwrites in place on a partial column move', async () => {
    // `ESC[5G` is neither a frame boundary nor a full rewrite: it parks the
    // cursor at column 5 and the text that follows overwrites from there,
    // leaving the tail of the old content visible; a terminal shows the splice.
    expect(await renderCapturedLog(`Downloading${ESC}[5G done`)).toBe('Down doneng');
  });

  it('bounds the row against a hostile cursor parameter', async () => {
    // Build output is UNTRUSTED and a CSI parameter is just digits. `pad()` grew
    // the row to the requested column, so one crafted line asked for a billion
    // array pushes — and enough digits parse to Infinity, which never
    // terminates. This runs inside the DO while finalizing the check run, so it
    // could take out the BuildManager before its scheduler cleanup ran.
    for (const seq of ['[999999999G', '[1;999999999H', '[999999999C', `[${'9'.repeat(400)}G`]) {
      const out = await renderCapturedLog(`x${ESC}${seq}y`);
      // If broken: allocates until the isolate dies. Resource-bound rows
      // drop fail-closed instead of partially applying a terminal mutation.
      expect(out).toBe('');
    }
  });

  it('preflights every parameter-driven loop before xterm executes it', async () => {
    for (const final of ['S', 'T', 'L', 'M', 'I', 'Z', 'b', '@', 'P', 'X']) {
      await expect(renderCapturedLog(`SECRET${ESC}[999999999${final}`)).resolves.toBe('');
    }
  });

  it('bounds repeated DEC selective erases that scan protection metadata', async () => {
    for (const final of ['J', 'K']) {
      const selectiveEraseFlood = `x${`${ESC}[?2${final}`.repeat(2_700)}ERR`;
      expect(selectiveEraseFlood.length).toBeLessThanOrEqual(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
      await expect(renderCapturedLog(selectiveEraseFlood)).resolves.toBe('');
    }
  });

  it('bounds REP allocation by preceding-grapheme length as well as Ps', async () => {
    const combining = `a${'\u0301'.repeat(131)}`;
    expect(combining.length * 8_000).toBeGreaterThan(TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS);
    expect(await renderCapturedLog(`${combining}${ESC}[8000b`)).toBe('');
  });

  it('does not treat adjacent REP commands as repeated allocations', async () => {
    // xterm clears its preceding-join state after CSI dispatch, so only the
    // first REP can repeat the preceding grapheme; an adjacent REP is a no-op.
    // Preflight must reset the source at the same boundary rather than charging
    // a second allocation that the maintained parser will never perform.
    expect(await renderCapturedLog(`a${ESC}[2b${ESC}[2b`)).toBe('aaa');
  });

  it('preserves the REP source across an aborted or ignored escape sequence', async () => {
    expect(await renderCapturedLog(`a${ESC}[${ESC}[2b`)).toBe('aaa');
    expect(await renderCapturedLog(`a${ESC}[??x${ESC}[2b`)).toBe('aaa');

    const grapheme = `a${'\u0301'.repeat(131)}`;
    expect(await renderCapturedLog(`${grapheme}${ESC}[${ESC}[8000b`)).toBe('');
    expect(await renderCapturedLog(`${grapheme}${ESC}[??x${ESC}[8000b`)).toBe('');
  });

  it('does not charge a whole ordinary ASCII run as REP source', async () => {
    const text = 'a'.repeat(132);
    expect(await renderCapturedLog(`${text}${ESC}[8000b`)).toBe(`${text}${'a'.repeat(8_000)}`);
  });

  it('does not charge unsupported private REP identities', async () => {
    const grapheme = `a${'\u0301'.repeat(131)}`;
    expect(await renderCapturedLog(`${grapheme}${ESC}[?8000b`)).toBe(grapheme);
  });

  it('bounds cumulative REP expansion from distinct printable graphemes', async () => {
    const grapheme = `a${'\u0301'.repeat(2_000)}`;
    const allocation = grapheme.length * 200;
    expect(allocation).toBeLessThan(TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS);
    expect(allocation * 3).toBeGreaterThan(TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS);
    const segment = `${grapheme}${ESC}[200b${ESC}[2K`;
    expect(await renderCapturedLog(segment.repeat(3))).toBe('');
  });

  it('drops insert mode because printable writes would shift the full dense row', async () => {
    expect(await renderCapturedLog(`${ESC}[4hSECRET`)).toBe('');
  });

  it('uses a fixed right margin independent of non-painting control bytes', async () => {
    const raw = `SECRET${ESC}[200GZ`;
    const padded = `SECRET${ESC}[m${ESC}[m${ESC}[m${ESC}[m${ESC}[m${ESC}[200GZ`;
    const expected = await renderCapturedLog(raw);
    expect(await renderCapturedLog(padded)).toBe(expected);
    expect(expected).toHaveLength(200);
  });

  it('keeps a long diagnostic with harmless SGR instead of charging queue latency', async () => {
    const text = 'x'.repeat(10_000);
    expect(await renderCapturedLog(`${text}${ESC}[0m`)).toBe(text);
  });

  it('does not charge truecolor values as parser work', async () => {
    const truecolor = `${ESC}[38;2;255;255;255m`;
    expect(await renderCapturedLog(`${truecolor.repeat(11)}VISIBLE${ESC}[0m`)).toBe('VISIBLE');
  });

  it('rejects repeated full terminal resets before allocating the xterm grid', async () => {
    const resets = `${ESC}c`.repeat(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS / 2);
    expect(resets).toHaveLength(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
    expect(await renderCapturedLog(resets)).toBe('');
  });

  it('bounds tab searches after output clears every configured stop', async () => {
    const prefix = `${ESC}[3g`;
    const hostile = `${prefix}${'\r\t'.repeat(
      Math.floor((TERMINAL_RENDER_MAX_INPUT_CODE_UNITS - prefix.length) / 2),
    )}`;
    expect(hostile.length).toBeLessThanOrEqual(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
    expect(await renderCapturedLog(hostile)).toBe('');
  });

  it('does not let tab expansion amplify a hostile line', async () => {
    // Tabs advance 8 columns per byte, so bounding the row at `length * 8` would
    // let a 128KB line of tabs (the agent's per-line capture cap) expand to a
    // ~1M-cell row.
    const hostile = '\t'.repeat(MAX_PARTIAL_LINE_CHARS) + 'END';
    const row = await renderCapturedLog(hostile);
    // The controlled input cap is checked before allocating the fixed grid.
    expect(hostile.length).toBeGreaterThan(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
    expect(row).toBe('');

    // And the tail formatter must not retain a full window of them.
    const out = await formatLogTailMarkdown(
      Array.from({ length: CHECK_RUN_LOG_TAIL_LINES }, () => hostile),
      CHECK_RUN_LOG_TAIL_LINES,
    );
    expect(out).toBeNull();
  });

  it('skips repeated ICH at the row end instead of growing the row per command', async () => {
    // ICH at the content end inserts only trailing blanks and leaves the cursor
    // put. Materializing them grew the row on every command; spreading the insert
    // into `splice` also blew V8's argument limit for a count near the row bound.
    // Long enough to cross the deterministic controlled-input cap before xterm
    // allocates a grid or executes any insertion.
    const hostile = `seed${`${ESC}[130000@`.repeat(2000)}END`;
    // If broken: RangeError from the spread, or minutes of quadratic copying.
    expect(await renderCapturedLog(hostile)).toBe('');
  });

  it('skips visually inert ICH beyond the modeled row instead of allocating blanks', async () => {
    // EL2 makes the row structurally empty without moving the cursor. ICH at
    // that empty suffix changes no visible cell, but allocating its full count
    // and then clearing again bypassed the retained-suffix shift budget: this
    // near-capture-limit line requested about 1.3 billion blank assignments.
    const pair = `${ESC}[2K${ESC}[131072@`;
    const hostile = pair.repeat(Math.floor(MAX_PARTIAL_LINE_CHARS / pair.length));
    const out = await renderCapturedLog(hostile);
    expect(out).toBe('');
  });

  it('charges ICH row growth as well as retained-suffix movement', async () => {
    // Seeding one cell after EL2 made `ichMoved === 1`, but ICH then allocated
    // and filled the rest of the 131K row. Repeating this near the capture limit
    // requested about one billion assignments while barely touching the budget.
    const pair = `${ESC}[2Kx${ESC}[G${ESC}[131071@`;
    const hostile = pair.repeat(Math.floor(MAX_PARTIAL_LINE_CHARS / pair.length));
    const out = await renderCapturedLog(hostile);
    // Once growth spends the cumulative work budget, fail closed rather than
    // preserving a cell that a later terminal mutation could hide.
    expect(out).toBe('');
  });

  it('bounds the CUMULATIVE cost of many shifts on a long row', async () => {
    // Bounding the ROW is not the same as bounding the WORK. Each DCH/ICH shifts
    // the retained suffix, so N commands on an L-cell row cost N x L — and both
    // come from the same repo-controlled line, which makes the total QUADRATIC in
    // the input even though nothing grows without bound. This 125KB variant stays
    // inside the capture cap and still asks for 20,000 full-row shifts.
    const hostile = `${'a'.repeat(65_000)}${ESC}[G${`${ESC}[@`.repeat(20_000)}`;
    expect(hostile.length).toBeLessThanOrEqual(MAX_PARTIAL_LINE_CHARS);
    const out = await renderCapturedLog(hostile);
    // The first over-budget shift clears the row rather than preserving content
    // a real terminal continued to mutate.
    expect(out).toBe('');
  });

  it('bounds the cumulative cost of repeated erases on a long row', async () => {
    // Bounding DCH/ICH was not enough: EL, ED and ECH all rewrite cells too.
    // This input is below the agent's 128KiB capture ceiling but asks ECH to
    // rewrite almost all of a 100,000-cell row 3,000 times — roughly 300 million
    // assignments in the DO while it is trying to finalize a check run.
    const hostile = `SECRET${'a'.repeat(99_994)}${ESC}[7G${`${ESC}[999999X`.repeat(3_000)}`;
    const out = await renderCapturedLog(hostile);
    // Once the budget is spent, fail closed by dropping the modeled row. Ignoring
    // an over-budget erase could resurrect text a real terminal hid.
    expect(out).toBe('');
  });

  it('spends the shift budget on ordinary work before the fail-closed limit', async () => {
    // The bound must not bite ordinary output. A handful of inserts on a normal
    // row is far under the budget and behaves exactly as a terminal would.
    expect(await renderCapturedLog(`abcdef${ESC}[3D${ESC}[2@`)).toBe('abc  def');
    expect(await renderCapturedLog(`abcdef${ESC}[6D${ESC}[2P`)).toBe('cdef');
  });

  it('fails closed when aggregate CSI parameter work exceeds its deterministic budget', async () => {
    const command = `${ESC}[64@`;
    const hostile = command.repeat(Math.floor(TERMINAL_RENDER_MAX_PARAMETER_WORK / 64) + 1);
    expect(hostile.length).toBeLessThan(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
    expect(await renderCapturedLog(hostile)).toBe('');
    expect(TERMINAL_RENDER_COLUMNS).toBe(32 * 1024);
  });

  it('strips colon-form truecolor SGR (ITU-T T.416)', async () => {
    expect(await renderCapturedLog(`${ESC}[38:2::255:0:0mRED${ESC}[0m done`)).toBe('RED done');
  });

  it('strips private-parameter CSI', async () => {
    expect(await renderCapturedLog(`${ESC}[>4;2mtext`)).toBe('text');
    expect(await renderCapturedLog(`${ESC}[=7htext`)).toBe('text');
  });

  it('leaves no ESC byte behind for any sequence it handles', async () => {
    const line = `${ESC}[?25l${ESC}[38:2::0:255:0m✓${ESC}[0m built${ESC}[K${ESC}[?25h`;
    expect(await renderCapturedLog(line)).toBe('✓ built');
    expect(await renderCapturedLog(line)).not.toContain(ESC);
  });
});

describe('formatLogTailMarkdown sanitizes before measuring', () => {
  const ESC = '\x1b';

  it('renders the visible frame, not the erased ones', async () => {
    const spinner = `◒  Uploading${ESC}[1G${ESC}[J◐  Uploading (59/59)${ESC}[1G${ESC}[J◆  Deployed!`;
    expect(await formatLogTailMarkdown([spinner], 1)).toBe(
      `**Last 1 log lines:**\n\n${SIX_BACKTICKS}text\n◆  Deployed!\n${SIX_BACKTICKS}`,
    );
  });

  it('keeps diagnostics visible after a tool leaves a wide terminal margin', async () => {
    const margin = ' '.repeat(512);
    const out = (await formatLogTailMarkdown(
      [
        { line: `${ESC}[?25l${margin}build finished`, lineEnding: 'crlf' },
        { line: `${margin}deploy: output missing`, lineEnding: 'none' },
      ],
      2,
    )) as string;
    expect(parseFence(out).content).toEqual([
      `${' '.repeat(32)}build finished`,
      `${' '.repeat(32)}deploy: output missing`,
    ]);
  });

  it('drops lines that carried nothing but control output', async () => {
    const out = (await formatLogTailMarkdown(
      ['real output', `${ESC}[?25h`, 'more output'],
      3,
    )) as string;
    expect(parseFence(out).content).toEqual(['real output', 'more output']);
  });

  it('returns null when every captured line was pure control output (PATCH omits text)', async () => {
    expect(await formatLogTailMarkdown([`${ESC}[?25l`, `${ESC}[1G${ESC}[J`], 2)).toBe(null);
  });

  it('spends the byte budget on visible text only — an erased-frame flood must not evict real lines', async () => {
    // One spinner line whose raw form is ~1.4MB of erased frames but whose
    // visible text is 12 chars. Pre-sanitize accounting would blow the content
    // cap and shift out every line before it.
    const flood =
      Array.from({ length: 20000 }, (_, i) => `frame ${i}${ESC}[1G${ESC}[J`).join('') + 'Deployed!';
    expect(flood.length).toBeGreaterThan(CHECK_RUN_LOG_TAIL_MAX_BYTES);
    const out = await formatLogTailMarkdown(['first real line', flood, 'last real line'], 3);
    // The unsafe stateful group makes the later terminal state unknowable. Even
    // rendering only the newer plain row could be wrong under a persisted mode.
    expect(out).toBeNull();
  });

  it('a terminal-only string-control payload must not evict real diagnostics either', async () => {
    // One 120KB Kitty graphics blob — under pipeStream's 128KB per-line cap, so
    // this arrives intact. Its visible width is zero, but left as text it alone
    // exceeds the tail budget and shifts out every line before it.
    const blob = `${ESC}_Ga=T,f=100;${'QUJDRA'.repeat(20000)}${ESC}\\`;
    expect(blob.length).toBeGreaterThan(CHECK_RUN_LOG_TAIL_MAX_BYTES);
    const lines = [...Array.from({ length: 9 }, (_, i) => `[vite] error detail ${i}`), blob];
    const out = await formatLogTailMarkdown(lines, lines.length);
    // The newest group itself is unsafe, so there is no sound terminal suffix to
    // render. Live/admin logs still retain the original bounded record.
    expect(out).toBeNull();
  });

  it('preserves parser state when a 7-bit string control spans captured rows', async () => {
    for (const [intro, terminator] of [
      [`${ESC}]0;title=`, `${ESC}\\`],
      [`${ESC}Pq`, `${ESC}\\`],
      [`${ESC}X`, `${ESC}\\`],
      [`${ESC}^`, `${ESC}\\`],
      [`${ESC}_G`, `${ESC}\\`],
    ]) {
      const out = (await formatLogTailMarkdown(
        ['first', `before${intro}SECRET`, `MORE${terminator}after`, 'last'],
        4,
      )) as string;
      expect(parseFence(out).content).toEqual(['first', 'beforeafter', 'last']);
      expect(out).not.toContain('SECRET');
      expect(out).not.toContain('MORE');
    }
  });

  it('preserves parser state for the 8-bit C1 forms across captured rows', async () => {
    for (const intro of ['\u009d0;title=', '\u0090q', '\u0098', '\u009e', '\u009fG']) {
      const out = (await formatLogTailMarkdown(
        ['first', `before${intro}SECRET`, 'MORE', `PAYLOAD\u009cafter`, 'last'],
        5,
      )) as string;
      expect(parseFence(out).content).toEqual(['first', 'beforeafter', 'last']);
      expect(out).not.toContain('SECRET');
      expect(out).not.toContain('MORE');
      expect(out).not.toContain('PAYLOAD');
    }
  });

  it('preserves incomplete ESC and CSI state across captured rows', async () => {
    for (const lines of [
      [`before${ESC}`, '[31mRED'],
      [`before${ESC}[`, '31mRED'],
    ]) {
      const out = (await formatLogTailMarkdown(lines, lines.length)) as string;
      expect(parseFence(out).content).toEqual(['before', 'RED']);
      expect(out).not.toContain('31m');
    }
  });

  it('renders captured newlines without losing CSI state or bare-CR rewrites', async () => {
    const first = { line: `before${ESC}[`, lineEnding: 'cr' as const };
    const bareCr = (await formatLogTailMarkdown(
      [first, { line: '31mRED', lineEnding: 'none' }],
      2,
    )) as string;
    expect(parseFence(bareCr).content).toEqual(['REDore']);

    const bareLf = (await formatLogTailMarkdown(
      [
        { ...first, lineEnding: 'lf' as const },
        { line: '31mRED', lineEnding: 'none' },
      ],
      2,
    )) as string;
    expect(parseFence(bareLf).content).toEqual(['before', 'RED']);

    const crlf = (await formatLogTailMarkdown(
      [
        { ...first, lineEnding: 'crlf' as const },
        { line: '31mRED', lineEnding: 'none' },
      ],
      2,
    )) as string;
    expect(parseFence(crlf).content).toEqual(['before', 'RED']);
  });

  it('starts plain LF-delimited log lines at column zero', async () => {
    const out = (await formatLogTailMarkdown(
      [
        { line: 'abc', lineEnding: 'lf' },
        { line: 'X', lineEnding: 'none' },
      ],
      2,
    )) as string;
    expect(parseFence(out).content).toEqual(['abc', 'X']);
  });

  it('keeps plain LF-delimited logs on the text path beyond the terminal input budget', async () => {
    const lines = Array.from(
      { length: CHECK_RUN_LOG_TAIL_LINES },
      (_, index) => `${index}: ${'x'.repeat(400)}`,
    );
    expect(lines.join('\n').length).toBeGreaterThan(TERMINAL_TAIL_MAX_INPUT_CODE_UNITS);
    const out = (await formatLogTailMarkdown(
      lines.map((line) => ({ line, lineEnding: 'lf' })),
      lines.length,
    )) as string;
    expect(parseFence(out).content).toEqual(lines);
  });

  it('does not invent a REP source across a captured LF inside CSI', async () => {
    const grapheme = `a${'\u0301'.repeat(8_200)}`;
    const out = (await formatLogTailMarkdown(
      [
        { line: `${grapheme}${ESC}[`, lineEnding: 'lf' },
        { line: `128b${ESC}[2K${ESC}[1GERR`, lineEnding: 'none' },
      ],
      2,
    )) as string;
    expect(parseFence(out).content).toEqual([grapheme, 'ERR']);
  });

  it('preserves protection and configured tab stops across parser-ground rows', async () => {
    const protectedOut = (await formatLogTailMarkdown(
      [`${ESC}[1"q`, `SECRET${ESC}[?2K`],
      2,
    )) as string;
    expect(parseFence(protectedOut).content).toEqual(['SECRET']);

    const tabsOut = (await formatLogTailMarkdown(
      [`${ESC}[3g${ESC}[21G${ESC}H`, `SECRET_TOKEN_ABCDEFG\r\t${ESC}[1K${ESC}[1GERR`],
      2,
    )) as string;
    expect(parseFence(tabsOut).content).toEqual(['ERR']);
    expect(tabsOut).not.toContain('KEN_ABCDEFG');
  });

  it('retains a normal 100-row tail when the newest diagnostic uses color', async () => {
    const lines = [
      ...Array.from({ length: CHECK_RUN_LOG_TAIL_LINES - 1 }, (_, index) => `error ${index}`),
      `${ESC}[31mFAILED${ESC}[0m`,
    ];
    const out = (await formatLogTailMarkdown(lines, lines.length)) as string;
    const content = parseFence(out).content;
    expect(content).toHaveLength(CHECK_RUN_LOG_TAIL_LINES);
    expect(content.at(0)).toBe('error 0');
    expect(content.at(-1)).toBe('FAILED');
  });

  it('does not resurrect cached rows cleared by later terminal history controls', async () => {
    const ris = (await formatLogTailMarkdown([`SECRET${ESC}`, 'cERR'], 2)) as string;
    expect(parseFence(ris).content).toEqual(['ERR']);

    const ed3 = (await formatLogTailMarkdown(['SECRET', `${ESC}[3JERR`], 2)) as string;
    expect(parseFence(ed3).content).toEqual(['ERR']);
  });

  it('keeps captured normal and alternate-buffer histories separate', async () => {
    const staysAlternate = (await formatLogTailMarkdown(
      ['SECRET', `${ESC}[?1049hERR`],
      2,
    )) as string;
    expect(parseFence(staysAlternate).content).toEqual(['ERR']);

    const returnsToNormal = (await formatLogTailMarkdown(
      ['normal', `${ESC}[?1049hALT${ESC}[3J${ESC}[?1049lERR`],
      2,
    )) as string;
    expect(parseFence(returnsToNormal).content).toEqual(['normal', 'ERR']);

    const alternateScroll = (await formatLogTailMarkdown(
      [`${ESC}[?1049hALT1`, { line: 'ALT2', lineEnding: 'none' }],
      2,
    )) as string;
    expect(parseFence(alternateScroll).content).toEqual(['ALT2']);

    const reentersClearedAlternate = (await formatLogTailMarkdown(
      [`${ESC}[?1049hOLD`, `${ESC}[?1049l`, `${ESC}[?1049hNEW`],
      3,
    )) as string;
    expect(parseFence(reentersClearedAlternate).content).toEqual(['NEW']);
  });

  it('does not resurrect a row scrolled away by control input within one capture', async () => {
    const out = (await formatLogTailMarkdown([`SECRET\u0085ERR`], 1)) as string;
    expect(parseFence(out).content).toEqual(['ERR']);
  });

  it('charges raw in-record vertical controls even though captured endings are bounded', async () => {
    const hostile = `SECRET${'\u0085'.repeat(TERMINAL_RENDER_MAX_PARAMETER_WORK / 2048 + 1)}ERR`;
    expect(await formatLogTailMarkdown([{ line: hostile, lineEnding: 'none' }], 1)).toBeNull();
  });

  it('drops an over-budget multiline string group whole and resumes after its terminator', async () => {
    const payload = 'SECRET'.repeat(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS);
    const out = await formatLogTailMarkdown(
      ['first diagnostic', `${ESC}_G`, payload, `${ESC}\\`, 'latest failure'],
      5,
    );
    expect(out).toBeNull();
  });

  it('spends the controlled-input budget on newest whole parser groups first', async () => {
    const olderControlled = Array.from(
      { length: 6 },
      (_, index) => `${ESC}[0mold-${index}-${'x'.repeat(7_000)}`,
    );
    const out = await formatLogTailMarkdown(
      [...olderControlled, `before${ESC}_GSECRET`, `MORE${ESC}\\latest failure`],
      olderControlled.length + 2,
    );
    // A fresh terminal after the omitted controlled prefix could expose text
    // whose interpretation depends on persistent state from that prefix.
    expect(out).toBeNull();
  });

  it('fails closed instead of starting after an omitted state-setting group', async () => {
    const setup = `${ESC}[3g${ESC}[21G${ESC}H${'x'.repeat(TERMINAL_RENDER_MAX_INPUT_CODE_UNITS)}`;
    const dependent = `SECRET_TOKEN_ABCDEFG\r\t${ESC}[1K${ESC}[1GERR`;
    expect(await formatLogTailMarkdown([setup, dependent], 2)).toBeNull();
  });

  it('can omit an oversized plain prefix because it cannot mutate terminal state', async () => {
    const out = (await formatLogTailMarkdown(
      ['x'.repeat(TERMINAL_TAIL_MAX_INPUT_CODE_UNITS), `${ESC}[31mFAILED${ESC}[0m`],
      2,
    )) as string;
    expect(parseFence(out).content).toEqual(['FAILED']);
  });
});

describe('BuildManager finalizeCheckRun log tail (output.text)', () => {
  // These assert on the ACTUAL completion PATCH body: the file-level check-run
  // mock is routed to the REAL completeCheckRun (importActual) and the global
  // fetch is stubbed to capture the PATCH. `getInstallationToken` stays
  // file-mocked, so the real module runs fully offline.
  let patches: Array<{ url: string; body: { output: Record<string, unknown> } }>;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../../src/github/check-run.ts')>(
      '../../src/github/check-run.ts',
    );
    vi.mocked(completeCheckRun).mockImplementation(actual.completeCheckRun);
    patches = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method === 'PATCH' && /\/check-runs\/[^/]+$/.test(url)) {
          patches.push({ url, body: JSON.parse(String(init?.body)) });
          return new Response('{}', { status: 200 });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Restore the file-level inert default so the other suites keep a no-op mock.
    vi.mocked(completeCheckRun).mockImplementation(async () => false);
  });

  it('embeds the stored log tail as output.text in the completion PATCH', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    // Finalize resolves the run id from DO storage (create is inert in this file).
    ctx._kv.set('checkRunId', '99001');
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'installing deps', stream: 'stdout', ts: 1 } as unknown as LogRow,
      { line: 'building app', stream: 'stdout', ts: 2 } as unknown as LogRow,
      { line: 'deploy complete', stream: 'stdout', ts: 3 } as unknown as LogRow,
    ]);

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(patches[0].body.output.text).toBe(
      `**Last 3 log lines:**\n\n${SIX_BACKTICKS}text\ninstalling deps\nbuilding app\ndeploy complete\n${SIX_BACKTICKS}`,
    );
  });

  it('omits output.text entirely when no log lines were captured', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    // The PATCH body is byte-identical to the pre-tail contract: no `text` key.
    expect('text' in patches[0].body.output).toBe(false);
  });

  it('still PATCHes (without text) when the log-tail read throws (best-effort)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    ctx._kv.set('checkRunId', '99001');
    await (m as unknown as { ingestLines: (lines: Array<LogRow>) => Promise<void> }).ingestLines([
      { line: 'installing deps', stream: 'stdout', ts: 1 } as unknown as LogRow,
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(
      m as unknown as { readLogTailMarkdown: () => Promise<string | null> },
      'readLogTailMarkdown',
    ).mockRejectedValue(new Error('sqlite read failed'));

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect('text' in patches[0].body.output).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'finalizeCheckRun: log tail read failed (best-effort)',
      expect.any(Error),
    );
    warn.mockRestore();
  });
});

describe('BuildManager agent-control auth + transition guards', () => {
  it('rejects POST /status without the agent secret (401) and leaves status unchanged', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      new Request('https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(401);
    // No status write occurred, so the stored state was not touched. (onStart ran
    // inside the base start() at startBuild, so the status sits at 'building'; the
    // rejected control POST must leave it there.)
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });
  });

  it('rejects POST /cancel without the agent secret (401) and does not stop the container', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    const res = await m.fetch(new Request('https://manager/cancel', { method: 'POST' }));

    expect(res.status).toBe(401);
    expect(containerCalls.stopped).toBe(0);
  });

  it('rejects POST /status with a WRONG agent secret (401)', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      new Request('https://manager/status', {
        method: 'POST',
        headers: { Authorization: 'Bearer not-the-real-token' },
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(401);
    expect(dbState.writes).toEqual([]);
  });

  it('rejects a terminal status from the agent even WITH the secret (4xx) and keeps status unchanged', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    for (const status of ['complete', 'failed', 'cancelled'] as const) {
      const res = await m.fetch(
        agentRequest(ctx, 'https://manager/status', {
          method: 'POST',
          body: JSON.stringify({ status }),
        }),
      );
      expect(res.status).toBe(400);
    }

    // No terminal write — the build was NOT finalized by the agent. (status sits
    // at 'building' from onStart inside the base start(); a rejected agent
    // terminal write must not move it.)
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });
  });

  it('accepts a non-terminal status WITH the secret', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      agentRequest(ctx, 'https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(lastWrite('deploying')).toBeDefined();
  });

  // A progress report that races a concurrent terminalizer must NOT
  // resurrect the cancelled row. The DO's local status can still say active
  // (its setStatus didn't run for the out-of-band cancel), so the only thing
  // standing between a forged/late 'deploying' and a re-enabled deploy token is
  // the guarded CAS — which must no-op against the already-`cancelled` DB row.
  it('POST /status on an out-of-band cancelled row → 409, row stays cancelled, no write, container stopped', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Simulate a concurrent terminalizer (push-supersede / disconnect) that
    // committed the DB row `cancelled` while the DO's LOCAL config.status still
    // says active ('building', from onStart inside the base start()).
    dbState.status.set('b1', 'cancelled');
    dbState.writes = [];
    containerCalls.stopped = 0;

    const res = await m.fetch(
      agentRequest(ctx, 'https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'deploying' }),
      }),
    );

    expect(res.status).toBe(409);
    // The CAS no-op'd → no 'deploying' write, row stays cancelled.
    expect(dbState.writes.some((w) => w.status === 'deploying')).toBe(false);
    expect(dbState.status.get('b1')).toBe('cancelled');
    // cancelBuild best-effort stop()s the orphaned container.
    expect(containerCalls.stopped).toBe(1);
  });

  // The agent param is whitelisted to progress statuses only, so a
  // buggy/malicious agent can't write an arbitrary lifecycle state (e.g.
  // resetting a row to 'queued').
  it('rejects a non-whitelist status (queued) WITH the secret (400) and writes nothing', async () => {
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.writes = [];

    const res = await m.fetch(
      agentRequest(ctx, 'https://manager/status', {
        method: 'POST',
        body: JSON.stringify({ status: 'queued' }),
      }),
    );

    expect(res.status).toBe(400);
    expect(dbState.writes).toEqual([]);
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'building' });
  });
});

// Env scrub: the build agent must NOT hand the control-plane secrets to
// untrusted repo child processes (install / `void deploy`), or a malicious
// postinstall could read DO_LOG_URL/AGENT_TOKEN and forge build status.
describe('build-agent sanitizeChildEnv (env scrub)', () => {
  const fullEnv = {
    PATH: '/usr/bin',
    HOME: '/root',
    DO_LOG_URL: 'https://manager/logs',
    SOURCE_TOKEN: 'ghs_secret',
    AGENT_TOKEN: 'agent-secret',
    VOID_TOKEN: 'deploy-jwt',
    CF_ACCESS_CLIENT_ID: 'svc-id.access',
    CF_ACCESS_CLIENT_SECRET: 'svc-secret',
    VOID_ACCESS_CREDENTIALS: '{"https://proxy.example.com":{"CF_ACCESS_TOKEN":"private"}}',
    VOID_API_URL: 'https://api.void.cloud',
    VOID_PROJECT: 'my-app',
  };

  it('drops every control-plane + credential secret from the (install) child env', () => {
    const child = sanitizeChildEnv(fullEnv);
    expect(child.DO_LOG_URL).toBeUndefined();
    expect(child.SOURCE_TOKEN).toBeUndefined();
    expect(child.AGENT_TOKEN).toBeUndefined();
    // the live deploy token must NOT reach untrusted install lifecycle
    // scripts — a postinstall could exfiltrate it or publish to the scoped
    // project within the TTL. It's scrubbed by default; only the deploy step
    // re-injects it (see the next test).
    expect(child.VOID_TOKEN).toBeUndefined();
    // The shared staging CF Access service token is equally sensitive — a leaked
    // pair reaches every Access-gated staging host — so it's scrubbed too.
    expect(child.CF_ACCESS_CLIENT_ID).toBeUndefined();
    expect(child.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
    expect(child.VOID_ACCESS_CREDENTIALS).toBeUndefined();
    // The scrub list is exactly these secrets.
    expect([...SCRUBBED_ENV_VARS].sort()).toEqual([
      'AGENT_TOKEN',
      'CF_ACCESS_CLIENT_ID',
      'CF_ACCESS_CLIENT_SECRET',
      'DO_LOG_URL',
      'SOURCE_TOKEN',
      'VOID_ACCESS_CREDENTIALS',
      'VOID_TOKEN',
    ]);
  });

  it('re-injects VOID_TOKEN + CF Access creds only for the trusted deploy step (via extra overrides)', () => {
    // The deploy spawn passes the captured deploy token + CF Access pair as extra
    // (runBuild captures them into locals and deletes them from process.env before
    // any child spawns — see the parent-process scrub tests below).
    const deployEnv = sanitizeChildEnv(fullEnv, {
      VOID_TOKEN: fullEnv.VOID_TOKEN,
      CF_ACCESS_CLIENT_ID: fullEnv.CF_ACCESS_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: fullEnv.CF_ACCESS_CLIENT_SECRET,
    });
    expect(deployEnv.VOID_TOKEN).toBe('deploy-jwt');
    expect(deployEnv.CF_ACCESS_CLIENT_ID).toBe('svc-id.access');
    expect(deployEnv.CF_ACCESS_CLIENT_SECRET).toBe('svc-secret');
    // Still scrubbed of the DO control-plane secrets.
    expect(deployEnv.DO_LOG_URL).toBeUndefined();
    expect(deployEnv.SOURCE_TOKEN).toBeUndefined();
    expect(deployEnv.AGENT_TOKEN).toBeUndefined();
  });

  it('drops re-inject overrides whose value is undefined (off-staging CF Access)', () => {
    // On production/dev the captured CF Access locals are undefined; passing them
    // as extra must not resurrect an empty/garbage value — sanitizeChildEnv treats
    // an undefined override as a delete.
    const deployEnv = sanitizeChildEnv(fullEnv, {
      VOID_TOKEN: fullEnv.VOID_TOKEN,
      CF_ACCESS_CLIENT_ID: undefined,
      CF_ACCESS_CLIENT_SECRET: undefined,
    });
    expect(deployEnv.VOID_TOKEN).toBe('deploy-jwt');
    expect(deployEnv.CF_ACCESS_CLIENT_ID).toBeUndefined();
    expect(deployEnv.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
  });

  it('keeps non-secret deploy + system vars the build legitimately needs', () => {
    const child = sanitizeChildEnv(fullEnv);
    expect(child.VOID_API_URL).toBe('https://api.void.cloud');
    expect(child.VOID_PROJECT).toBe('my-app');
    expect(child.PATH).toBe('/usr/bin');
    expect(child.HOME).toBe('/root');
  });

  it('does not mutate the source env object', () => {
    const copy = { ...fullEnv };
    sanitizeChildEnv(fullEnv);
    expect(fullEnv).toEqual(copy);
  });
});

// Parent-process secret scrub (heap env). The agent deletes the control-plane +
// credential secrets from its OWN `process.env` at the right lifecycle points —
// AGENT_TOKEN/DO_LOG_URL at module load (captured into module consts first), and
// SOURCE_TOKEN/VOID_TOKEN inside runBuild (captured into locals, deleted before
// any child spawns). This is defense-in-depth for the spawn-inheritance path
// only: `sanitizeChildEnv` already strips the COPY handed to every untrusted
// child. It does NOT scrub `/proc/self/environ` — `unsetenv()` only mutates the
// heap `environ`, while `/proc/<pid>/environ` keeps the initial-stack block — so
// a same-uid child can still recover these via `/proc/<ppid>/environ`, which is
// why untrusted children run under a non-root uid. This does not cover the
// deploy-child→vite-build VOID_TOKEN inheritance.
describe('build-agent shutdown handlers (PID-1 SIGTERM delivery)', () => {
  it('registers SIGTERM + SIGINT listeners so the DO stop() SIGTERM is not dropped by PID 1', () => {
    // The agent is PID 1 in the container; Linux delivers a signal to PID 1 only
    // if a handler is installed, else it is dropped. Without these listeners the
    // DO's stop() (a bare SIGTERM) is silently ignored and the container leaks a
    // global slot. Assert the listeners are registered; clean up only the ones we
    // added (diff against the pre-existing set so we don't disturb the runner's).
    const beforeTerm = process.rawListeners('SIGTERM');
    const beforeInt = process.rawListeners('SIGINT');
    try {
      installShutdownHandlers();
      const addedTerm = process.rawListeners('SIGTERM').filter((l) => !beforeTerm.includes(l));
      const addedInt = process.rawListeners('SIGINT').filter((l) => !beforeInt.includes(l));
      expect(addedTerm).toHaveLength(1);
      expect(addedInt).toHaveLength(1);
    } finally {
      for (const l of process.rawListeners('SIGTERM').filter((x) => !beforeTerm.includes(x))) {
        process.removeListener('SIGTERM', l as (...args: Array<unknown>) => void);
      }
      for (const l of process.rawListeners('SIGINT').filter((x) => !beforeInt.includes(x))) {
        process.removeListener('SIGINT', l as (...args: Array<unknown>) => void);
      }
    }
  });
});

describe('build-agent parent-process secret scrub', () => {
  it('deletes AGENT_TOKEN and DO_LOG_URL from process.env at module load', async () => {
    // Both are captured into module-level consts (read by postToDo) at import,
    // then deleted from process.env at load — BEFORE any child spawns. Prove the
    // delete by re-importing the module fresh with both set: the load-time delete
    // must remove them from the parent's heap env. (Pre-fix the module left them
    // in process.env, so this would still see them after import.)
    const saved = { AGENT_TOKEN: process.env.AGENT_TOKEN, DO_LOG_URL: process.env.DO_LOG_URL };
    process.env.AGENT_TOKEN = 'agent-secret';
    process.env.DO_LOG_URL = 'https://manager/logs';
    try {
      vi.resetModules();
      // Re-evaluate the agent module so its load-time scrub runs against the env
      // we just set. The import is for its side effect (the deletes).
      await import('../../container/build-agent.mjs');
      expect(process.env.AGENT_TOKEN).toBeUndefined();
      expect(process.env.DO_LOG_URL).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      vi.resetModules();
    }
  });

  it('deletes VOID_TOKEN and SOURCE_TOKEN from process.env during runBuild — while the deploy child still receives VOID_TOKEN', async () => {
    const saved = {
      VOID_TOKEN: process.env.VOID_TOKEN,
      SOURCE_TOKEN: process.env.SOURCE_TOKEN,
      VOID_API_URL: process.env.VOID_API_URL,
      VOID_PROJECT: process.env.VOID_PROJECT,
    };
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.SOURCE_TOKEN = 'ghs_secret';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    try {
      const seen: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(
          async (cmd: string, _args: ReadonlyArray<string>, opts?: { env?: NodeJS.ProcessEnv }) => {
            seen.push({ cmd, env: opts?.env });
            return 0;
          },
        ),
        reportStatus: vi.fn(async () => {}),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(0);

      // After runBuild, the parent's HEAP env no longer holds either secret (the
      // spawn-inheritance vector is closed; the `/proc/self/environ` block is
      // NOT scrubbed — see this describe's preamble).
      expect(process.env.VOID_TOKEN).toBeUndefined();
      expect(process.env.SOURCE_TOKEN).toBeUndefined();

      // The install child saw neither (sanitizeChildEnv scrubs the copy AND the
      // parent already deleted them).
      const install = seen.find((s) => s.cmd === 'npm');
      expect(install?.env?.VOID_TOKEN).toBeUndefined();
      expect(install?.env?.SOURCE_TOKEN).toBeUndefined();

      // The trusted deploy child STILL receives the token (captured into a local
      // before the parent-env delete and re-injected via the extra overrides).
      const deploy = [...seen].reverse().find((s) => s.cmd === 'npx');
      expect(deploy?.env?.VOID_TOKEN).toBe('deploy-jwt');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

// The build container is a CI environment and must say so, or interactive CLIs
// animate into a piped stdout: `@clack/prompts`' spinner redraws in place with
// `ESC[1G ESC[J` and no newline, so the agent's CR/LF splitter glues every frame
// into one unreadable captured line. The void CLI already guards this
// (`createSpinner()` falls back to plain `log.step` output) behind clack's
// `isCI`. `github_actions` builds got `CI=true` free from the runner; container
// builds set nothing, which is why only they rendered broken.
describe('PINNED_VOID_CLI_VERSION (fallback CLI ↔ SDK package contract)', () => {
  it('matches the workspace SDK package the platform deploys against', () => {
    // The Worker bundle must use the exact SDK version from the release commit.
    expect(PINNED_VOID_CLI_VERSION).toBe(voidPackageJson.version);
  });

  it('matches the container agent’s own backstop default', () => {
    // Both import the same release manifest, including when the agent receives
    // no VOID_CLI_VERSION override from the manager.
    expect(DEFAULT_VOID_CLI_VERSION).toBe(PINNED_VOID_CLI_VERSION);
  });
});

describe('build-agent nonInteractiveEnv (CI-safe child output)', () => {
  it('sets CI to the exact string "true" — clack compares by identity, so "1" is a no-op', () => {
    expect(nonInteractiveEnv()).toEqual({ CI: 'true' });
  });

  it('survives the env scrub (CI is not a secret)', () => {
    expect(sanitizeChildEnv({ PATH: '/usr/bin' }, nonInteractiveEnv()).CI).toBe('true');
  });

  it('reaches BOTH build children — the deploy child renders the spinner, the install child its own progress', async () => {
    // runBuild requireEnv()s the token pair up front (and deletes both from
    // process.env as it runs) — save/restore covers that too.
    const saved = {
      VOID_TOKEN: process.env.VOID_TOKEN,
      SOURCE_TOKEN: process.env.SOURCE_TOKEN,
      VOID_API_URL: process.env.VOID_API_URL,
      VOID_PROJECT: process.env.VOID_PROJECT,
    };
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.SOURCE_TOKEN = 'ghs_secret';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    try {
      const seen: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(
          async (cmd: string, _args: ReadonlyArray<string>, opts?: { env?: NodeJS.ProcessEnv }) => {
            seen.push({ cmd, env: opts?.env });
            return 0;
          },
        ),
        reportStatus: vi.fn(async () => {}),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(0);
      expect(seen.map((s) => s.cmd)).toEqual(['npm', 'npx', 'npx']);
      for (const child of seen) {
        expect(child.env?.CI).toBe('true');
      }
      // The cache overrides must survive being merged alongside it.
      expect(seen[0]?.env?.HOME).toBe(BUILDER_HOME);
      expect(seen[1]?.env?.HOME).toBe(BUILDER_HOME);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

// Untrusted build children must run as a NON-ROOT uid. `delete
// process.env.X` cannot scrub `/proc/<ppid>/environ` (unsetenv leaves the
// initial-stack env block), so a same-uid child of the root agent could recover
// AGENT_TOKEN/SOURCE_TOKEN regardless. The fix drops the install + deploy children
// to BUILDER_UID, hands them a writable cache HOME, and chowns the root-extracted
// source tree to the builder. Real setuid only works as root (in the container),
// so the unit seam asserts the pure helpers + the wiring, not a live uid drop.
describe('build-agent non-root child isolation', () => {
  it('childSpawnOptions drops untrusted children to the non-root builder uid/gid', () => {
    const opts = childSpawnOptions();
    expect(opts.uid).toBe(BUILDER_UID);
    expect(opts.gid).toBe(BUILDER_GID);
    expect(BUILDER_UID).toBe(1000);
    expect(BUILDER_GID).toBe(1000);
    // Non-zero (non-root) is the security invariant: the child must not share the
    // root agent's uid.
    expect(opts.uid).toBeGreaterThan(0);
    expect(opts.cwd).toBe('/tmp/build/src');
  });

  it('builderCacheEnv points every package-manager cache at the builder home', () => {
    // Without these the non-root builder would EPERM writing corepack/npm/yarn/bun
    // caches — the image defaults e.g. BUN_INSTALL=/usr/local (root-owned).
    const env = builderCacheEnv();
    expect(env.HOME).toBe(BUILDER_HOME);
    expect(env.HOME).toBe('/home/builder');
    expect(env.XDG_CACHE_HOME).toBe('/home/builder/.cache');
    expect(env.npm_config_cache).toBe('/home/builder/.npm');
    expect(env.COREPACK_HOME).toBe('/home/builder/.cache/node/corepack');
    expect(env.YARN_CACHE_FOLDER).toBe('/home/builder/.cache/yarn');
    expect(env.BUN_INSTALL).toBe('/home/builder/.bun');
  });

  it('the install AND deploy children run with the builder cache env (HOME=/home/builder)', async () => {
    const saved = {
      VOID_TOKEN: process.env.VOID_TOKEN,
      SOURCE_TOKEN: process.env.SOURCE_TOKEN,
      VOID_API_URL: process.env.VOID_API_URL,
      VOID_PROJECT: process.env.VOID_PROJECT,
    };
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.SOURCE_TOKEN = 'ghs_secret';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    try {
      const seen: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(
          async (cmd: string, _args: ReadonlyArray<string>, opts?: { env?: NodeJS.ProcessEnv }) => {
            seen.push({ cmd, env: opts?.env });
            return 0;
          },
        ),
        reportStatus: vi.fn(async () => {}),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(0);

      const install = seen.find((s) => s.cmd === 'npm');
      expect(install?.env?.HOME).toBe('/home/builder');
      expect(install?.env?.COREPACK_HOME).toBe('/home/builder/.cache/node/corepack');
      expect(install?.env?.BUN_INSTALL).toBe('/home/builder/.bun');

      const deploy = [...seen].reverse().find((s) => s.cmd === 'npx');
      expect(deploy?.env?.HOME).toBe('/home/builder');
      // The builder cache env must NOT clobber the re-injected deploy token.
      expect(deploy?.env?.VOID_TOKEN).toBe('deploy-jwt');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('hands the extracted tree to the builder (chown) after download, before the install child', async () => {
    const saved = {
      VOID_TOKEN: process.env.VOID_TOKEN,
      SOURCE_TOKEN: process.env.SOURCE_TOKEN,
      VOID_API_URL: process.env.VOID_API_URL,
      VOID_PROJECT: process.env.VOID_PROJECT,
    };
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.SOURCE_TOKEN = 'ghs_secret';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    try {
      const order: Array<string> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {
          order.push('download');
        }),
        chownWorkDir: vi.fn(async () => {
          order.push('chown');
        }),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild: vi.fn(async (cmd: string) => {
          order.push(`child:${cmd}`);
          return 0;
        }),
        reportStatus: vi.fn(async () => {}),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(0);
      // chown must sit between the source download and the first untrusted child,
      // so the root-extracted tree is builder-owned before non-root install writes.
      expect(order[0]).toBe('download');
      expect(order[1]).toBe('chown');
      expect(order.indexOf('chown')).toBeLessThan(order.indexOf('child:npm'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  // a dependency lifecycle script that daemonizes during install survives as
  // a same-uid sibling of the deploy child and could read its
  // /proc/<deploy-pid>/environ (VOID_TOKEN + staging CF Access). runBuild must
  // reap all BUILDER_UID processes AFTER the install child closes and BEFORE the
  // deploy child spawns.
  it('reaps leftover builder processes between install and the deploy spawn', async () => {
    const saved = {
      VOID_TOKEN: process.env.VOID_TOKEN,
      VOID_API_URL: process.env.VOID_API_URL,
      VOID_PROJECT: process.env.VOID_PROJECT,
    };
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    try {
      const order: Array<string> = [];
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        chownWorkDir: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        // install is cmd 'npm', deploy is cmd 'npx'
        runChild: vi.fn(async (cmd: string) => {
          order.push(`child:${cmd}`);
          return 0;
        }),
        killBuilderProcesses: vi.fn(async () => {
          order.push('reap');
        }),
        reportStatus: vi.fn(async (status: string) => {
          order.push(`status:${status}`);
        }),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(0);
      // The reap runs strictly after the install child closes and strictly before
      // the deploy child (and even before the 'deploying' status flip).
      expect(order.indexOf('child:npm')).toBeLessThan(order.indexOf('reap'));
      expect(order.indexOf('reap')).toBeLessThan(order.indexOf('status:deploying'));
      expect(order.indexOf('reap')).toBeLessThan(order.indexOf('child:npx'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('does NOT reap (or deploy) when the install fails', async () => {
    const saved = {
      VOID_TOKEN: process.env.VOID_TOKEN,
      VOID_API_URL: process.env.VOID_API_URL,
      VOID_PROJECT: process.env.VOID_PROJECT,
    };
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    try {
      const reap = vi.fn(async () => {});
      const runChild = vi.fn(async () => 19); // install fails
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        chownWorkDir: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild,
        killBuilderProcesses: reap,
        reportStatus: vi.fn(async () => {}),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(19);
      // A failed install returns before the deploy phase, so there is no
      // secret-bearing deploy child to protect — the reap is skipped.
      expect(reap).not.toHaveBeenCalled();
      expect(runChild).toHaveBeenCalledTimes(1);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});

describe('parseProcStatusUid', () => {
  it('parses the real uid from the Uid line', () => {
    const status =
      'Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n';
    expect(parseProcStatusUid(status)).toBe(1000);
  });

  it('parses a root (uid 0) process', () => {
    expect(parseProcStatusUid('Name:\tagent\nUid:\t0\t0\t0\t0\n')).toBe(0);
  });

  it('returns null when there is no Uid line (kernel-thread / torn read)', () => {
    expect(parseProcStatusUid('Name:\tkworker\nState:\tI (idle)\n')).toBeNull();
  });
});

// lifecycle invariant: the build agent must ALWAYS resolve to an exit code
// and close its control server on every failure path, so the container never
// hangs on a still-open listening socket (which would leak a build slot until
// the DO's `sleepAfter` ceiling — or indefinitely for unlimited plans with no
// timeout alarm). A non-zero install exit must not bypass `process.exit` and
// `server.close`.
describe('build-agent lifecycle (container must always exit)', () => {
  const REQUIRED_ENV = [
    'VOID_TOKEN',
    'VOID_API_URL',
    'VOID_PROJECT',
    'VOID_PROXY_URL',
    'CF_ACCESS_CLIENT_ID',
    'CF_ACCESS_CLIENT_SECRET',
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of REQUIRED_ENV) {
      savedEnv[key] = process.env[key];
    }
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
  });

  afterEach(() => {
    for (const key of REQUIRED_ENV) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('resolves to the non-zero install exit code (no hang) when install fails', async () => {
    // runChild returns the package-manager exit code; a non-zero install must
    // resolve runBuild to that code WITHOUT running the deploy step or dropping
    // out of the driver unresolved.
    const deploy = vi.fn(async () => 0);
    const runChild = vi.fn(async (cmd: string) => {
      // first invocation is the dependency install — fail it.
      return cmd === 'npx' ? await deploy() : 17;
    });

    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });

    expect(code).toBe(17);
    // The deploy step must NOT run after a failed install.
    expect(deploy).not.toHaveBeenCalled();
    // Exactly one child ran (the install); deploy was skipped.
    expect(runChild).toHaveBeenCalledTimes(1);
  });

  it.each([0, 19])(
    'connects before deploy and stops if connection fails (exit %s)',
    async (connectExit) => {
      const runChild = vi.fn(
        async (_cmd: string, args: ReadonlyArray<string>, _opts?: { env?: NodeJS.ProcessEnv }) =>
          args.includes('connect') ? connectExit : 0,
      );
      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild,
        reportStatus: vi.fn(async () => {}),
        hasLocalVoid: () => true,
      });
      expect(code).toBe(connectExit);
      const calls = runChild.mock.calls;
      expect(calls[1]?.[1]).toEqual([
        '--yes',
        'void',
        'connect',
        'https://api.void.cloud',
        '--no-login',
      ]);
      expect(calls[1]?.[2]?.env?.VOID_TOKEN).toBeUndefined();
      expect(calls[1]?.[2]?.env?.VOID_ACCESS_ORIGIN).toBe('https://api.void.cloud');
      expect(calls.some(([, args]) => args.includes('deploy'))).toBe(connectExit === 0);
    },
  );

  it('scopes captured Access credentials to the configured API and proxy only for deployment', async () => {
    process.env.VOID_PROXY_URL = 'https://proxy.example.com';
    process.env.CF_ACCESS_CLIENT_ID = 'service-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'service-secret';
    const runChild = vi.fn(
      async (_cmd: string, _args: ReadonlyArray<string>, _opts?: { env?: NodeJS.ProcessEnv }) => 0,
    );
    expect(
      await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild,
        reportStatus: vi.fn(async () => {}),
        hasLocalVoid: () => true,
      }),
    ).toBe(0);
    const [install, connect, deploy] = runChild.mock.calls;
    expect(install?.[2]?.env?.VOID_ACCESS_CREDENTIALS).toBeUndefined();
    expect(connect?.[2]?.env?.VOID_ACCESS_CREDENTIALS).toBeUndefined();
    expect(JSON.parse(deploy?.[2]?.env?.VOID_ACCESS_CREDENTIALS ?? 'null')).toEqual({
      'https://api.void.cloud': {
        CF_ACCESS_CLIENT_ID: 'service-id',
        CF_ACCESS_CLIENT_SECRET: 'service-secret',
      },
      'https://proxy.example.com': {
        CF_ACCESS_CLIENT_ID: 'service-id',
        CF_ACCESS_CLIENT_SECRET: 'service-secret',
      },
    });
  });

  it('passes VOID_TOKEN to the DEPLOY child but NOT the INSTALL child', async () => {
    // Capture the env each spawned child receives. runChild is called first for
    // the install (cmd !== 'npx'), then for the deploy (cmd === 'npx').
    const seen: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];
    const runChild = vi.fn(
      async (cmd: string, _args: ReadonlyArray<string>, opts?: { env?: NodeJS.ProcessEnv }) => {
        seen.push({ cmd, env: opts?.env });
        return 0;
      },
    );

    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(0);

    const install = seen.find((s) => s.cmd === 'npm');
    const deploy = [...seen].reverse().find((s) => s.cmd === 'npx');
    expect(install).toBeDefined();
    expect(deploy).toBeDefined();
    // The untrusted install (postinstall scripts) must NOT see the deploy token.
    expect(install?.env?.VOID_TOKEN).toBeUndefined();
    // The trusted deploy step still authenticates with it.
    expect(deploy?.env?.VOID_TOKEN).toBe('deploy-jwt');
  });

  it('falls back to the PINNED void@<version> (never @latest) when the repo has no local void', async () => {
    // BuildManager injects VOID_CLI_VERSION; the agent must spawn that exact
    // pinned version, never a moving `void@latest` dist-tag.
    const savedCliVersion = process.env.VOID_CLI_VERSION;
    process.env.VOID_CLI_VERSION = '0.9.1';
    try {
      const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
      const runChild = vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      });

      const code = await runBuild({
        downloadSource: vi.fn(async () => {}),
        resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
        runChild,
        reportStatus: vi.fn(async () => {}),
        // No local `void` binary → take the npx fallback path.
        hasLocalVoid: () => false,
      });
      expect(code).toBe(0);

      const deploy = [...seen].reverse().find((s) => s.cmd === 'npx');
      expect(deploy).toBeDefined();
      expect(deploy?.args).toContain('void@0.9.1');
      expect(deploy?.args.some((a) => a === 'void@latest')).toBe(false);
    } finally {
      if (savedCliVersion === undefined) {
        delete process.env.VOID_CLI_VERSION;
      } else {
        process.env.VOID_CLI_VERSION = savedCliVersion;
      }
    }
  });

  it('resolves to the deploy exit code on a successful install + failed deploy', async () => {
    const runChild = vi.fn(async (cmd: string) => (cmd === 'npx' ? 1 : 0));
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(1);
  });

  it('resolves to 0 on a fully successful build', async () => {
    const runChild = vi.fn(async () => 0);
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      runChild,
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(0);
  });

  it('resolves to non-zero (1) when a build step throws — never leaves the driver unresolved', async () => {
    const code = await runBuild({
      downloadSource: vi.fn(async () => {
        throw new Error('source download failed: HTTP 404');
      }),
    });
    expect(code).toBe(1);
  });

  it('closeControlServer invokes server.close and resolves (server-close path on every exit)', async () => {
    let closed = false;
    const fakeServer = {
      close(cb: () => void) {
        closed = true;
        cb();
      },
    };
    await expect(closeControlServer(fakeServer)).resolves.toBeUndefined();
    expect(closed).toBe(true);
  });

  it('closeControlServer is a no-op for a null server (best-effort)', async () => {
    await expect(closeControlServer(null)).resolves.toBeUndefined();
    await expect(closeControlServer(undefined)).resolves.toBeUndefined();
  });
});

// The DO PULLS logs (`GET /logs?since=N`) on a ~1s cadence and cannot pull at all
// once the container exits — `logBuffer` and the control server die with the
// process, and the DO's own `container.running` guard early-outs before it ever
// fetches. Without a barrier every line between the last successful poll and
// exit is lost, including the failing build's actual error output and the closing
// `[build-agent] void deploy exited with code N`. With `waitForLogDrain` the
// agent holds the control server open at exit until the DO has ACKNOWLEDGED
// every recorded line. The ack is the `since` cursor on a subsequent
// `GET /logs?since=N` — the DO advances that cursor only after a successful
// `res.json()` + `ingestLines()`, so it proves storage. The served mark
// (`servedLogSeq`) deliberately does NOT gate the barrier: `res.end`'s callback
// fires even when the peer never read a byte, so releasing on it certifies the
// wrong side of the transport.
describe('build-agent exit-time log drain barrier', () => {
  it('waits until the DO puller catches up, then resolves true', async () => {
    // Model the puller: `served` trails `recorded` and only advances on a "poll",
    // which here happens on each sleep tick.
    let served = 0;
    const recorded = 5;
    const sleeps: Array<number> = [];

    const drained = await waitForLogDrain({
      timeoutMs: 4000,
      pollMs: 100,
      served: () => served,
      recorded: () => recorded,
      now: (() => {
        let t = 0;
        return () => (t += 10); // never reaches the deadline
      })(),
      sleep: async (ms) => {
        sleeps.push(ms);
        served += 2; // the DO polled: 0 -> 2 -> 4 -> 6 (>= 5)
      },
    });

    expect(drained).toBe(true);
    // It actually WAITED (it did not return on the first check with served < recorded).
    expect(sleeps).toEqual([100, 100, 100]);
  });

  it('returns immediately when the puller is already caught up', async () => {
    const sleep = vi.fn(async () => {});
    await expect(waitForLogDrain({ served: () => 9, recorded: () => 9, sleep })).resolves.toBe(
      true,
    );
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up at the deadline (bounded — a dead/absent DO must never hang the container)', async () => {
    // `served` NEVER advances: the DO is gone, already terminal, or was never
    // wired. An unbounded wait here would pin a global container slot per build.
    const sleep = vi.fn(async () => {});
    let clock = 0;

    const drained = await waitForLogDrain({
      timeoutMs: 4000,
      pollMs: 100,
      served: () => 0,
      recorded: () => 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        await sleep();
      },
    });

    expect(drained).toBe(false);
    // Bounded by timeoutMs/pollMs — 40 ticks of 100ms, not an infinite loop.
    expect(sleep).toHaveBeenCalledTimes(40);
    expect(clock).toBe(4000);
  });

  it('resets the idle deadline while acknowledged progress continues across slow callbacks', async () => {
    let clock = 0;
    const acknowledgedAt = [7_000, 14_000, 21_000];
    const served = (): number => acknowledgedAt.filter((at) => at <= clock).length;

    const drained = await waitForLogDrain({
      timeoutMs: 30_000,
      idleTimeoutMs: 8_000,
      pollMs: 1_000,
      served,
      recorded: () => acknowledgedAt.length,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    // A fixed 8s deadline would close during the second/third productive pull.
    expect(drained).toBe(true);
    expect(clock).toBe(21_000);
  });

  it('still releases a dead DO at the short idle deadline, not the absolute cap', async () => {
    let clock = 0;
    const drained = await waitForLogDrain({
      timeoutMs: LOG_DRAIN_ABSOLUTE_TIMEOUT_MS,
      idleTimeoutMs: LOG_DRAIN_IDLE_TIMEOUT_MS,
      pollMs: 1_000,
      served: () => 0,
      recorded: () => 1,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(drained).toBe(false);
    expect(clock).toBe(LOG_DRAIN_IDLE_TIMEOUT_MS);
  });

  it('enforces the non-resettable absolute cap despite continual partial progress', async () => {
    let clock = 0;
    let acknowledged = 0;
    let nextProgress = 7_000;
    const drained = await waitForLogDrain({
      timeoutMs: 20_000,
      idleTimeoutMs: 8_000,
      pollMs: 1_000,
      served: () => acknowledged,
      recorded: () => 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= nextProgress) {
          acknowledged += 1;
          nextProgress += 7_000;
        }
      },
    });

    expect(drained).toBe(false);
    expect(acknowledged).toBeGreaterThan(0);
    expect(clock).toBe(20_000);
  });

  it('uses real timers by default without hanging when the deadline is short', async () => {
    // Same starvation, but through the REAL setTimeout path used in main().
    await expect(
      waitForLogDrain({ timeoutMs: 30, pollMs: 5, served: () => 0, recorded: () => 1 }),
    ).resolves.toBe(false);
  });
});

// End-to-end over the agent's REAL HTTP control server: the lines recorded AFTER
// the build child closes (the `void deploy exited with code N` line is emitted
// after `child.on('close')` resolves) must still be retrievable while the server
// is open — that is exactly what the drain barrier buys, and those lines were
// missing from every real container build's check run.
describe('build-agent GET /logs serves post-child-close lines', () => {
  const REQUIRED_ENV = ['VOID_TOKEN', 'VOID_API_URL', 'VOID_PROJECT'] as const;
  let savedEnv: Record<string, string | undefined>;
  let server: import('node:http').Server | null = null;

  beforeEach(() => {
    savedEnv = {};
    for (const key of REQUIRED_ENV) {
      savedEnv[key] = process.env[key];
    }
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
  });

  afterEach(async () => {
    await closeControlServer(server);
    server = null;
    for (const key of REQUIRED_ENV) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('budgets a page by serialized bytes, not UTF-16 code units', async () => {
    // `entry.line.length` is UTF-16 code units of the raw string, which is not
    // what goes on the wire: JSON escaping turns one control character into six
    // bytes, and each entry carries ~61 bytes of seq/stream/ts envelope. Counting
    // code units under-counted the body by up to 6x — and the DO advances its
    // cursor only after a SUCCESSFUL parse, so a body too large to read inside
    // LOG_PULL_TIMEOUT_MS is a livelock, not a slow transfer.
    const before = getBufferedLogLines();
    const since = before.length > 0 ? before[before.length - 1].seq : 0;

    // Under the OLD accounting these fit one page twice over (2000 x 1048 chars
    // is just under the 2 MiB budget, and the line cap is 2000). Serialized, each
    // NUL is `\u0000` — six bytes — so the real body is ~12.6 MB.
    const control = '\u0000'.repeat(1048);
    // record() mirrors each line to stderr; keep the NUL bytes out of the test output.
    const mirror = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      for (let i = 0; i < MAX_LOG_RESPONSE_LINES; i++) {
        record(control, 'stdout');
      }
    } finally {
      mirror.mockRestore();
    }

    server = await startControlServer(0);
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('expected a TCP address');
    }
    const res = await fetch(`http://127.0.0.1:${address.port}/logs?since=${since}`);
    const text = await res.text();

    // If broken: ~12.6 MB, six times the cap it claims to honour.
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_LOG_RESPONSE_BYTES);
    const body = JSON.parse(text) as { lines: Array<{ seq: number }>; hasMore: boolean };
    // Still makes progress, and still reports the remainder.
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.lines.length).toBeLessThan(MAX_LOG_RESPONSE_LINES);
    expect(body.hasMore).toBe(true);
  });

  it('pages an oversized backlog so each pull advances the cursor', async () => {
    // Unpaged, the response would be every retained line above the cursor — up to
    // MAX_BUFFERED_LOG_LINES x MAX_PARTIAL_LINE_CHARS in one body. The DO aborts
    // at LOG_PULL_TIMEOUT_MS and only advances `logCursor` after a SUCCESSFUL
    // parse, so an oversized body is a LIVELOCK, not a slow transfer: every retry
    // asks for the same backlog and the cursor never moves, until the drain
    // barrier expires and the tail is lost.
    const before = getBufferedLogLines();
    let since = before.length > 0 ? before[before.length - 1].seq : 0;
    const start = since;

    // Comfortably past the byte cap: 40 x 128KB.
    const big = 'x'.repeat(128 * 1024);
    for (let i = 0; i < 40; i++) {
      record(big, 'stdout');
    }
    const finalSeq = getBufferedLogLines().slice(-1)[0].seq;

    server = await startControlServer(0);
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('expected a TCP address');
    }
    const pull = async (
      from: number,
    ): Promise<{ lines: Array<{ seq: number }>; lastSeq: number }> =>
      (await (await fetch(`http://127.0.0.1:${address.port}/logs?since=${from}`)).json()) as {
        lines: Array<{ seq: number }>;
        lastSeq: number;
      };

    // If broken: one body carries all 40 lines (~5MB) and `lastSeq` jumps
    // straight to the end, so nothing bounds the transfer the DO must finish.
    const first = await pull(since);
    expect(JSON.stringify(first.lines).length).toBeLessThanOrEqual(MAX_LOG_RESPONSE_BYTES * 1.1);
    expect(first.lastSeq).toBeLessThan(finalSeq);
    expect(first.lastSeq).toBe(first.lines[first.lines.length - 1].seq);

    // And repeated pulls converge — each batch strictly advances the cursor.
    let rounds = 0;
    since = first.lastSeq;
    while (since < finalSeq && rounds < 50) {
      const next = await pull(since);
      expect(next.lastSeq).toBeGreaterThan(since);
      since = next.lastSeq;
      rounds++;
    }
    expect(since).toBe(finalSeq);
    expect(start).toBeLessThan(finalSeq);
  });

  it("serves the post-close `void deploy exited with code N` line, and releases the barrier only on the DO's ACK, not on serving it", async () => {
    // The module-level ring is shared across this file's suites, so poll from the
    // current high-water mark rather than 0.
    const before = getBufferedLogLines();
    const since = before.length > 0 ? before[before.length - 1].seq : 0;

    // Ephemeral port: the container's fixed 4000 could collide in CI.
    server = await startControlServer(0);
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('expected a TCP address');
    }

    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      resolveInstall: () => ({ manager: 'npm', cmd: 'npm', args: ['ci'] }),
      // The child "closes" here; the agent's closing line is recorded AFTER it.
      runChild: vi.fn(async () => 0),
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(0);

    const res = await fetch(`http://127.0.0.1:${address.port}/logs?since=${since}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{ seq: number; line: string }>;
      lastSeq: number;
    };

    // Without the drain barrier the container exits before the DO's next ~1s
    // poll, so this line would never reach the DO's store or the check run.
    expect(body.lines.map((l) => l.line)).toContain('[build-agent] void deploy exited with code 0');
    // The handler stamps the served high-water mark — diagnostic only.
    expect(body.lastSeq).toBeGreaterThan(since);
    expect(getServedLogSeq()).toBe(body.lastSeq);

    // Serving the tail must NOT release the barrier. The DO has
    // received bytes but has not said it stored them, and if its `res.json()` or
    // `ingestLines()` throws it leaves its cursor unadvanced and retries — against
    // an agent that would already be gone.
    expect(getAckedLogSeq()).toBe(since);
    await expect(waitForLogDrain({ timeoutMs: 50, pollMs: 5 })).resolves.toBe(false);

    // The DO's NEXT poll carries the advanced cursor. That is the acknowledgement,
    // and only then may the container die. No off-by-one: the cursor the DO stores
    // is `lastSeq` verbatim, so it comes back as `since=lastSeq`.
    const ack = await fetch(`http://127.0.0.1:${address.port}/logs?since=${body.lastSeq}`);
    expect(ack.status).toBe(200);
    const ackBody = (await ack.json()) as { lines: Array<unknown>; lastSeq: number };
    expect(ackBody.lines).toEqual([]);
    expect(getAckedLogSeq()).toBe(body.lastSeq);
    await expect(waitForLogDrain({ timeoutMs: 50, pollMs: 5 })).resolves.toBe(true);
  });

  it('clamps a forged /logs cursor to recorded lines — it cannot ack the future', async () => {
    // This server is unauthenticated, binds all interfaces on a fixed port, and the
    // untrusted build children share its network namespace, so `since` is
    // attacker-reachable. Unclamped, ONE `?since=MAX_SAFE_INTEGER` would mark every
    // FUTURE line acked and release the exit barrier for good.
    server = await startControlServer(0);
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('expected a TCP address');
    }

    const forged = await fetch(
      `http://127.0.0.1:${address.port}/logs?since=${Number.MAX_SAFE_INTEGER}`,
    );
    expect(forged.status).toBe(200);

    // Recorded AFTER the forgery — exactly the line a suppressed tail would lose.
    record('[build-agent] void deploy exited with code 1', 'stdout');

    // If broken: resolves true, because the forged mark already covers this
    // line's seq. The honest DO is unaffected — its cursor is always a previously
    // served `lastSeq`, so the clamp is a no-op for it (asserted by the test above,
    // which still reaches `true` on a genuine ack).
    await expect(waitForLogDrain({ timeoutMs: 50, pollMs: 5 })).resolves.toBe(false);
  });
});

// the build agent's REAL package-manager + deploy-command
// resolution reads the repo files in WORK_DIR (`/tmp/build/src`). These tests
// prepare that directory on disk, run `runBuild` WITHOUT injecting
// `resolveInstall` (so the real lockfile/packageManager detection runs), and
// capture the spawned commands via an injected `runChild`. The WORK_DIR is wiped
// before/after each case so a stray `.pnp.cjs`/lockfile can't leak into another
// test's deploy-command branch (which keys off `existsSync('.pnp.cjs')`).
describe('build-agent install + deploy resolution', () => {
  const WORK_DIR = '/tmp/build/src';
  const REQUIRED_ENV = ['VOID_TOKEN', 'VOID_API_URL', 'VOID_PROJECT'] as const;
  let savedEnv: Record<string, string | undefined>;

  function resetWorkDir(): void {
    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(WORK_DIR, { recursive: true });
  }

  /** Run the real install + deploy resolution, capturing every spawned command. */
  async function runAndCapture(
    hasLocalVoid: () => boolean,
  ): Promise<Array<{ cmd: string; args: ReadonlyArray<string> }>> {
    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      // resolveInstall is intentionally NOT injected — exercise the real one.
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid,
    });
    expect(code).toBe(0);
    return seen;
  }

  beforeEach(() => {
    savedEnv = {};
    for (const key of REQUIRED_ENV) {
      savedEnv[key] = process.env[key];
    }
    process.env.VOID_TOKEN = 'deploy-jwt';
    process.env.VOID_API_URL = 'https://api.void.cloud';
    process.env.VOID_PROJECT = 'my-app';
    resetWorkDir();
  });

  afterEach(() => {
    for (const key of REQUIRED_ENV) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  // a yarn.lock repo pinned to Yarn CLASSIC (1.x via Corepack) must install
  // with `--frozen-lockfile` — Yarn 1 does NOT recognize Berry's `--immutable`
  // and would SILENTLY run a mutable install, losing the frozen-lockfile guard.
  it('yarn.lock + packageManager yarn@1.x → install with --frozen-lockfile', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@1.22.19' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install).toBeDefined();
    expect(install?.args).toEqual(['yarn', 'install', '--frozen-lockfile']);
  });

  // a yarn.lock repo pinned to Yarn Berry (4.x) installs with `--immutable`.
  it('yarn.lock + packageManager yarn@4.x → install with --immutable', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--immutable']);
  });

  // NO packageManager pin — the flag is sniffed from the yarn.lock header.
  // Corepack's REAL unpinned default is Yarn 1.22 (Classic), and a v1 lockfile
  // carries a `# yarn lockfile v1` header → must install `--frozen-lockfile`
  // (Yarn 1 silently ignores Berry's `--immutable` → mutable install).
  it('yarn.lock (v1 header) + NO pin → install with --frozen-lockfile', async () => {
    writeFileSync(
      `${WORK_DIR}/yarn.lock`,
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n',
    );
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--frozen-lockfile']);
  });

  // a Berry lockfile (no v1 header, `__metadata` block) with no pin AND no
  // `.yarnrc.yml` yarnPath has no resolvable Yarn version — corepack's default
  // Classic 1.22 ignores `--immutable` and can't parse a Berry lock. resolveInstall
  // FAILS FAST with actionable guidance rather than breaking mid-install.
  it('yarn.lock (Berry __metadata) + NO pin + no yarnrc → fails fast, no install spawned', async () => {
    writeFileSync(
      `${WORK_DIR}/yarn.lock`,
      '# This file is generated by running "yarn install".\n\n__metadata:\n  version: 8\n',
    );
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(1);
    expect(seen.some((s) => s.cmd === 'corepack' && s.args[0] === 'yarn')).toBe(false);
  });

  // a Berry lockfile with no pin but a `.yarnrc.yml` yarnPath WORKS: corepack's
  // default Yarn 1.22 re-execs the bundled Berry release, which honors `--immutable`.
  it('yarn.lock (Berry __metadata) + NO pin + .yarnrc.yml yarnPath → install with --immutable', async () => {
    writeFileSync(
      `${WORK_DIR}/yarn.lock`,
      '# This file is generated by running "yarn install".\n\n__metadata:\n  version: 8\n',
    );
    writeFileSync(`${WORK_DIR}/.yarnrc.yml`, 'yarnPath: .yarn/releases/yarn-4.3.1.cjs\n');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--immutable']);
  });

  // NO lockfile but a packageManager pin must be honored — defaulting to
  // `npm install` would break a pnpm `workspace:*` repo / install a different
  // graph. No lockfile means no frozen flag.
  it('no lockfile + packageManager pnpm@9 → corepack pnpm install (no frozen flag)', async () => {
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'pnpm@9.1.0' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'pnpm');
    expect(install).toBeDefined();
    expect(install?.args).toEqual(['pnpm', 'install']);
    // No npm fallback was used.
    expect(seen.some((s) => s.cmd === 'npm')).toBe(false);
  });

  it('no lockfile + packageManager yarn@4 → corepack yarn install --no-immutable (CI=true would otherwise forbid creating the lockfile)', async () => {
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    const seen = await runAndCapture(() => true);

    // If broken: Berry >= 3.0.0 defaults `enableImmutableInstalls` to true
    // under CI, and `nonInteractiveEnv()` sets `CI=true` on this child — so a bare
    // `yarn install` aborts with YN0028 on the one plan whose job is to CREATE the
    // missing lockfile. Measured against Berry 3.0.0 / 3.6.4 / 4.14.1 / 4.18.0.
    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--no-immutable']);
  });

  it('keeps the LOCKFILE yarn plans immutable — the escape hatch is scoped to the no-lockfile plan', async () => {
    // Relaxing these would let a build mutate a committed lockfile and deploy
    // resolutions the repo never pinned.
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));
    writeFileSync(`${WORK_DIR}/yarn.lock`, '__metadata:\n  version: 8\n');

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'corepack' && s.args[0] === 'yarn');
    expect(install?.args).toEqual(['yarn', 'install', '--immutable']);
    expect(install?.args).not.toContain('--no-immutable');
  });

  it('no lockfile + NO packageManager pin → npm install (default preserved)', async () => {
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ name: 'app' }));

    const seen = await runAndCapture(() => true);

    const install = seen.find((s) => s.cmd === 'npm');
    expect(install?.args).toEqual(['install']);
  });

  // a Yarn Berry PnP repo (`.pnp.cjs` present, no node_modules) must run the
  // deploy THROUGH the package manager so PnP is active and the build children
  // `void deploy` spawns inherit it — `corepack yarn ... deploy`, NOT bare npx.
  it('PnP repo (.pnp.cjs present) runs deploy via corepack yarn, not bare npx', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    // void resolves in the PnP graph → `yarn void deploy`.
    const seen = await runAndCapture(() => true);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy).toBeDefined();
    expect(deploy?.args).toEqual(['yarn', 'void', 'deploy', '--project', 'my-app']);
    // The deploy did NOT go through bare npx.
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  it('PnP repo without resolvable void falls back to yarn dlx', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    // void does NOT resolve → `yarn dlx void@<ver> deploy`.
    const seen = await runAndCapture(() => false);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy?.args.slice(0, 2)).toEqual(['yarn', 'dlx']);
    expect(deploy?.args.some((a) => a.startsWith('void@'))).toBe(true);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  // The default `hasLocalVoid` must NOT treat a present `.pnp.cjs` as proof
  // that `void` is locally resolvable — under PnP (no `node_modules/.bin/void`)
  // it checks whether the repo DECLARES `void`. A PnP repo that declares void →
  // `yarn void deploy`; one that does not → the `yarn dlx void@<ver>` fetch
  // fallback.
  it('default hasLocalVoid: PnP repo that DECLARES void → corepack yarn void deploy', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(
      `${WORK_DIR}/package.json`,
      JSON.stringify({ packageManager: 'yarn@4.3.1', dependencies: { void: '^0.9.0' } }),
    );

    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      // hasLocalVoid intentionally NOT injected — exercise the real default.
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy?.args).toEqual(['yarn', 'void', 'deploy', '--project', 'my-app']);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  it('default hasLocalVoid: PnP repo that does NOT declare void → corepack yarn dlx', async () => {
    writeFileSync(`${WORK_DIR}/yarn.lock`, '');
    writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
    writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));

    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {}),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      // hasLocalVoid intentionally NOT injected — the real default must FETCH
      // because the repo does not declare `void`.
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.cmd === 'corepack' && s.args.includes('deploy'));
    expect(deploy?.args.slice(0, 2)).toEqual(['yarn', 'dlx']);
    expect(deploy?.args.some((a) => a.startsWith('void@'))).toBe(true);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  // `pnpPresent` must be computed AFTER download() populates WORK_DIR; at runBuild
  // entry WORK_DIR is still empty, and a false reading sends a PnP repo down the
  // bare-`npx` path (which can't resolve PnP-managed deps during `void deploy`).
  // The PnP tests above pre-write `.pnp.cjs` BEFORE runBuild — here it appears
  // only when download() runs, exactly like a real container.
  it('detects PnP created by download() (not pre-existing) → corepack yarn', async () => {
    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      // WORK_DIR starts clean (beforeEach); the source — including `.pnp.cjs` —
      // only materializes once download() runs, like a real build.
      downloadSource: vi.fn(async () => {
        writeFileSync(`${WORK_DIR}/yarn.lock`, '');
        writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
        writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));
      }),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.args.includes('deploy'));
    expect(deploy?.cmd).toBe('corepack');
    expect(deploy?.args).toEqual(['yarn', 'void', 'deploy', '--project', 'my-app']);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });

  // `pnpPresent` must be computed AFTER the install step, not just
  // after download(). A Yarn Berry PnP repo can gitignore `.pnp.cjs` and let
  // `yarn install` GENERATE it — a snapshot taken before install reads false, so
  // the deploy wrongly takes the bare-`npx` path (no node_modules, no active PnP
  // runtime → the build children `void deploy` spawns can't resolve deps). Here
  // `.pnp.cjs` appears only when the install command runs.
  it('detects PnP created by yarn install (not committed) → corepack yarn', async () => {
    const seen: Array<{ cmd: string; args: ReadonlyArray<string> }> = [];
    const code = await runBuild({
      downloadSource: vi.fn(async () => {
        // Berry repo that does NOT commit `.pnp.cjs` — only yarn.lock + pin.
        writeFileSync(`${WORK_DIR}/yarn.lock`, '');
        writeFileSync(`${WORK_DIR}/package.json`, JSON.stringify({ packageManager: 'yarn@4.3.1' }));
      }),
      runChild: vi.fn(async (cmd: string, args: ReadonlyArray<string>) => {
        seen.push({ cmd, args });
        // `yarn install` generates the PnP loader (the case committed `.pnp.cjs`
        // tests above don't cover).
        if (cmd === 'corepack' && args[0] === 'yarn' && args[1] === 'install') {
          writeFileSync(`${WORK_DIR}/.pnp.cjs`, '');
        }
        return 0;
      }),
      reportStatus: vi.fn(async () => {}),
      hasLocalVoid: () => true,
    });
    expect(code).toBe(0);

    const deploy = seen.find((s) => s.args.includes('deploy'));
    expect(deploy?.cmd).toBe('corepack');
    expect(deploy?.args).toEqual(['yarn', 'void', 'deploy', '--project', 'my-app']);
    expect(seen.some((s) => s.cmd === 'npx')).toBe(false);
  });
});

// An unbounded `logBuffer` lets a verbose build (large package-manager / compiler
// output) OOM the agent on the memory-constrained standard-1 container. The buffer
// is capped at MAX_BUFFERED_LOG_LINES (oldest evicted in a chunk), keeping only a
// best-effort recent tail for the /logs pull.
describe('build-agent log buffer is bounded', () => {
  it('caps logBuffer at MAX_BUFFERED_LOG_LINES while keeping the most recent line', () => {
    const flood = MAX_BUFFERED_LOG_LINES * 2 + 137;
    for (let i = 0; i < flood; i += 1) {
      record(`line ${i}`, 'stdout');
    }
    const buf = getBufferedLogLines();
    // Bounded regardless of how much was logged (or what prior tests recorded —
    // the cap is absolute).
    expect(buf.length).toBeLessThanOrEqual(MAX_BUFFERED_LOG_LINES);
    // The newest line is always retained...
    expect(buf.at(-1)?.line).toBe(`line ${flood - 1}`);
    // ...the oldest were evicted (seq stays monotonic, so the first retained seq
    // is far past 1)...
    expect(buf[0].seq).toBeGreaterThan(1);
    // ...and seq is contiguous across the retained window (no gaps from eviction).
    expect(buf.at(-1)!.seq - buf[0].seq + 1).toBe(buf.length);
  });

  it('caps logBuffer by BYTES as well, so few huge lines cannot pin the heap', () => {
    // The line cap bounds the COUNT only: at MAX_PARTIAL_LINE_CHARS each, 10000
    // retained lines is ~1.22 GiB of live strings, and a puller draining
    // MAX_LOG_PULL_PAGES x MAX_LOG_RESPONSE_BYTES per callback needs ~19
    // callbacks to clear it. Capping bytes makes "one drain covers the ring"
    // structural rather than average-case.
    const huge = 'x'.repeat(128 * 1024);
    const flood = Math.ceil((MAX_BUFFERED_LOG_BYTES / huge.length) * 2);
    // Far below the LINE cap, so only the byte cap can evict here.
    expect(flood).toBeLessThan(MAX_BUFFERED_LOG_LINES);
    for (let i = 0; i < flood; i += 1) {
      record(`${huge}${i}`, 'stdout');
    }

    const buf = getBufferedLogLines();
    // Measured the way `/logs` budgets a page — serialized bytes, not UTF-16 code
    // units. Counting code units here would let the ring hold up to 6x this on the
    // wire, which no longer fits what one drain can fetch.
    const retained = buf.reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1,
      0,
    );
    expect(retained).toBeLessThanOrEqual(MAX_BUFFERED_LOG_BYTES);
    // Oldest-first eviction: the newest line survives, and seq stays contiguous.
    expect(buf.at(-1)?.line.endsWith(`${flood - 1}`)).toBe(true);
    expect(buf.at(-1)!.seq - buf[0].seq + 1).toBe(buf.length);

    // The ring is module state shared with every later test, and it is now at the
    // cap — leaving it there makes the next big line evict from the front and
    // shift the indices those tests slice from.
    clearBufferedLogLines();
  });

  it('measures the ring in the same unit a page is budgeted in', () => {
    // The whole point of the byte cap is that the ring fits inside what one drain
    // can fetch, and a drain is budgeted in SERIALIZED bytes. Control characters
    // JSON-escape to six bytes each, so a ring counted in UTF-16 code units holds
    // up to 6x its nominal size on the wire — straight back past the
    // MAX_LOG_PULL_PAGES x MAX_LOG_RESPONSE_BYTES the guarantee rests on.
    const control = '\u0000'.repeat(64 * 1024);
    const flood = Math.ceil((MAX_BUFFERED_LOG_BYTES / (control.length * 6)) * 2);
    expect(flood).toBeLessThan(MAX_BUFFERED_LOG_LINES);
    // record() mirrors each line to stderr; keep the NUL bytes out of the test output.
    const mirror = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      for (let i = 0; i < flood; i += 1) {
        record(control, 'stdout');
      }
    } finally {
      mirror.mockRestore();
    }

    const wire = getBufferedLogLines().reduce(
      (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)) + 1,
      0,
    );
    // If broken: ~6x the cap, because only code units were counted.
    expect(wire).toBeLessThanOrEqual(MAX_BUFFERED_LOG_BYTES);
    // And still comfortably inside one full drain.
    expect(wire).toBeLessThanOrEqual(MAX_LOG_PULL_PAGES * MAX_LOG_RESPONSE_BYTES);

    clearBufferedLogLines();
  });

  // record() also mirrors every line to process.stderr (the last-resort log path).
  // Capping logBuffer + pendingLines isn't enough: process.stderr.write ALSO queues
  // in Node's Writable buffer when the sink drains slowly, so a flood with a slow/
  // blocked log consumer would grow THAT buffer without bound — the same OOM in the
  // stream layer. record() now latches on write()'s false return and skips the
  // mirror until 'drain'.
  it('stops mirroring to stderr under backpressure instead of buffering per line', () => {
    // Clear any saturation latched by a prior test (fires the registered once-
    // 'drain' if set; a no-op otherwise), so this test starts unsaturated.
    process.stderr.emit('drain');
    // Simulate a permanently-full sink: write() always reports saturation.
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(false);
    try {
      const flood = 5000;
      for (let i = 0; i < flood; i += 1) {
        record(`line ${i}`, 'stdout');
      }
      // The first false latches saturation and the rest skip, so the call count is tiny and independent of flood size.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      spy.mockRestore();
      // Release the latch for subsequent tests (fires the once-'drain' set above).
      process.stderr.emit('drain');
    }
  });
});

// pipeStream turns a child's byte stream into line-delimited record() calls. It
// splits on CR/LF/CRLF so `\r` progress frames (install / build spinners that
// rewrite a line with bare CR) reach the live tail before the process exits. The
// MAX_BUFFERED_LOG_LINES ring caps LINE count, not bytes, so the partial-line
// buffer needs its own cap or a `\n`-free run can OOM the standard-1 container.
// Past MAX_PARTIAL_LINE_CHARS it records ONE truncated line then drops the rest of
// that line until its terminator (so a terminator-free flood = one bounded record).
// The CR for a torn CRLF is tracked in a flag, never buffered as data, so it is
// never emitted mid-line or at EOF.
describe('build-agent pipeStream line splitting + tail cap', () => {
  // Minimal stand-in for the child's stdout/stderr: pipeStream only uses
  // setEncoding (no-op here — we feed strings directly) plus the 'data'/'end'
  // events. Emitting synchronously lets each test assert right after feed().
  class FakeReadable extends EventEmitter {
    setEncoding() {}
    feed(...chunks: Array<string>) {
      for (const chunk of chunks) {
        this.emit('data', chunk);
      }
    }
    end() {
      this.emit('end');
    }
  }

  // Module log state (logBuffer/logSeq) is shared across tests and never reset,
  // so capture the lines recorded only after this point.
  function capture(run: (src: FakeReadable) => void): Array<string> {
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    run(src);
    return getBufferedLogLines()
      .slice(before)
      .map((l) => l.line);
  }

  function captureRows(run: (src: FakeReadable) => void) {
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    run(src);
    return getBufferedLogLines().slice(before);
  }

  it('flushes bare-CR progress frames as lines instead of holding them until end', () => {
    // If broken: splitting only on `\n`, "a\rb\rc" carries the whole run
    // in `tail` and records nothing before 'end' — live tail stays empty.
    const src = new FakeReadable();
    const before = getBufferedLogLines().length;
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    src.feed('a\rb\rc');
    // The completed frames are recorded on the data event, BEFORE end.
    expect(
      getBufferedLogLines()
        .slice(before)
        .map((l) => l.line),
    ).toEqual(['a', 'b']);
    src.end();
    // The final frame (no trailing terminator) flushes on end.
    expect(
      getBufferedLogLines()
        .slice(before)
        .map((l) => l.line),
    ).toEqual(['a', 'b', 'c']);
  });

  it('preserves exact same-chunk CR, LF, CRLF, and EOF delimiters', () => {
    const rows = captureRows((src) => {
      src.feed('a\rb\nc\r\nd');
      src.end();
    });
    expect(rows.map(({ line, lineEnding }) => ({ line, lineEnding }))).toEqual([
      { line: 'a', lineEnding: 'cr' },
      { line: 'b', lineEnding: 'lf' },
      { line: 'c', lineEnding: 'crlf' },
      { line: 'd', lineEnding: 'none' },
    ]);
  });

  it.each(['\n', '\r\n'])(
    'renders piped build output without staircase indentation (%j)',
    async (ending) => {
      const lines = [
        'dependencies:',
        '+ vue 3.5.44',
        '+ void 1.1.11',
        '[build-agent] $ void deploy --project example',
        '\x1b[32m✓ built in 119ms\x1b[0m',
        'dist/client/index.html  0.57 kB',
        '  at build (build.ts:10:2)',
        'Uploading 1/2\r\x1b[2K✓ Uploaded 2/2',
        '╭─ https://example.void.app ─╮',
        '│  2 static assets          │',
        '╰───────────────────────────╯',
        '✓ Successfully deployed!',
      ];
      const rows = captureRows((src) => {
        // Split a newline and an ANSI sequence across stream chunks as well.
        const raw = lines.join(ending);
        for (let offset = 0; offset < raw.length; offset += 7) {
          src.feed(raw.slice(offset, offset + 7));
        }
        src.end();
      });
      const out = (await formatLogTailMarkdown(rows, rows.length)) as string;
      expect(parseFence(out).content).toEqual([
        ...lines.slice(0, 4),
        '✓ built in 119ms',
        ...lines.slice(5, 7),
        '✓ Uploaded 2/2',
        ...lines.slice(8),
      ]);
      expect(rows[0].lineEnding).toBe(ending === '\n' ? 'lf' : 'crlf');
      expect(rows.some((row) => row.line.includes('\x1b[32m'))).toBe(true);
    },
  );

  it('classifies a CR at a chunk seam after one-byte lookahead', () => {
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    src.feed('torn\r');
    expect(getBufferedLogLines()).toHaveLength(before);
    src.feed('\nrewrite\r');
    expect(
      getBufferedLogLines()
        .slice(before)
        .map(({ line, lineEnding }) => ({ line, lineEnding })),
    ).toEqual([{ line: 'torn', lineEnding: 'crlf' }]);
    src.feed('next');
    src.end();
    expect(
      getBufferedLogLines()
        .slice(before)
        .map(({ line, lineEnding }) => ({ line, lineEnding })),
    ).toEqual([
      { line: 'torn', lineEnding: 'crlf' },
      { line: 'rewrite', lineEnding: 'cr' },
      { line: 'next', lineEnding: 'none' },
    ]);
  });

  it('keeps an over-cap row bounded while its final CR awaits lookahead', () => {
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    src.feed(`${'x'.repeat(MAX_PARTIAL_LINE_CHARS * 3)}\r`);
    // The ambiguous row is pending, but only its capped prefix + marker remains.
    expect(getBufferedLogLines()).toHaveLength(before);
    src.feed('next');
    src.end();
    const rows = getBufferedLogLines().slice(before);
    expect(rows).toHaveLength(2);
    expect(rows[0].line.length).toBeLessThanOrEqual(MAX_PARTIAL_LINE_CHARS + 32);
    expect(rows[0].line.endsWith('truncated]')).toBe(true);
    expect(rows[0].lineEnding).toBe('cr');
    expect(rows[1]).toMatchObject({ line: 'next', lineEnding: 'none' });
  });

  it('bounds a terminator-free flood to ONE truncated record (memory cap)', () => {
    // If broken: recording the full over-cap tail (and the line-count ring
    // not being a byte cap) lets a `\n`-free flood retain ~its entire size. The
    // fix records one truncated line, then drops the rest until a terminator.
    const before = getBufferedLogLines().length;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    // 12.8 MB of bytes with zero line terminators, fed as 64 KiB chunks.
    for (let i = 0; i < 200; i++) {
      src.feed('y'.repeat(64 * 1024));
    }
    src.end();
    const recorded = getBufferedLogLines().slice(before);
    // Exactly one record, capped at the per-line limit (+ marker), NOT ~12.8 MB.
    expect(recorded).toHaveLength(1);
    expect(recorded[0].line.length).toBeLessThanOrEqual(MAX_PARTIAL_LINE_CHARS + 32);
    expect(recorded[0].line.endsWith('truncated]')).toBe(true);
  });

  it('resumes normal recording after the dropped over-cap line hits a newline', () => {
    // The remainder of an over-cap line is dropped only until its terminator;
    // subsequent lines record normally (the drop does not swallow the stream).
    const lines = capture((src) => {
      src.feed('z'.repeat(MAX_PARTIAL_LINE_CHARS + 10), 'still-dropped\nafter\n');
      src.end();
    });
    // [0] = the truncated monster line; "still-dropped" is the monster's tail and
    // is discarded; "after" records normally.
    expect(lines).toHaveLength(2);
    expect(lines[0].endsWith('truncated]')).toBe(true);
    expect(lines[1]).toBe('after');
  });

  it('does not flush a carried CR as data at the force-flush boundary (torn CRLF)', () => {
    // Carrying the `\r` into `tail` would let the force-flush emit a line ending
    // in `\r`, then the next chunk's `\n` would open a spurious empty line. The CR
    // is a flag, never buffered, so neither happens.
    const lines = capture((src) => {
      src.feed('x'.repeat(MAX_PARTIAL_LINE_CHARS) + '\r', '\nZ');
      src.end();
    });
    expect(lines.some((l) => l.endsWith('\r'))).toBe(false);
    expect(lines.some((l) => l === '')).toBe(false);
    expect(lines.at(-1)).toBe('Z');
  });

  it('treats a stream ending on a bare CR as a delimiter, not trailing data', () => {
    // If broken: end() records the carried `\r` as data ("a\r"). A CR is a
    // delimiter, so the line is "a".
    const lines = capture((src) => {
      src.feed('a\r');
      src.end();
    });
    expect(lines).toEqual(['a']);
  });

  it('does not emit empty lines for a CRLF split across a chunk boundary at the CR|LF seam', () => {
    // The trailing `\r` of the first chunk is held back so the next chunk's `\n`
    // completes the CRLF without producing a spurious empty record.
    const lines = capture((src) => {
      src.feed('x\r', '\ny\r\n');
      src.end();
    });
    expect(lines).toEqual(['x', 'y']);
  });

  it('preserves plain newline splitting (no behavior change for LF streams)', () => {
    const withTrailing = capture((src) => {
      src.feed('a\nb\nc\n');
      src.end();
    });
    expect(withTrailing).toEqual(['a', 'b', 'c']);

    const noTrailing = capture((src) => {
      src.feed('a\nb\nc');
      src.end();
    });
    expect(noTrailing).toEqual(['a', 'b', 'c']);
  });

  it('flushes a partial tail with no trailing newline on end', () => {
    const lines = capture((src) => {
      src.feed('partial-no-newline');
      src.end();
    });
    expect(lines).toEqual(['partial-no-newline']);
  });

  // A bare-CR flood (a runaway progress spinner, or a malicious build) emits one
  // record() per CR. The per-line byte cap can't help — each line is short; the
  // hazard is the COUNT of delimiter-emitted lines piling into the unflushed PUSH
  // batch within a single synchronous 'data' handler (the flush timer can't fire
  // until the handler yields). MAX_PENDING_LOG_LINES bounds the batch.
  it('bounds the pending PUSH batch under a bare-CR delimiter flood', () => {
    // One chunk, processed in a single synchronous turn (no flush can interleave),
    // carrying far more CR delimiters than the cap.
    const flood = MAX_PENDING_LOG_LINES * 3 + 11;
    const src = new FakeReadable();
    pipeStream(src as unknown as NodeJS.ReadableStream, 'stdout');
    src.feed('\r'.repeat(flood));
    // Uncapped, every CR would push a row and the batch would grow to `flood`
    // (>> the cap) before any flush.
    expect(getPendingLogLineCount()).toBeLessThanOrEqual(MAX_PENDING_LOG_LINES);
  });
});
