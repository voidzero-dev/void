import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// The BuildManager DO drives a GitHub Check Run across the
// build lifecycle — POST `/check-runs` once all pre-start rechecks pass, then PATCH
// it `completed` at every terminal site (onStop / onError / enforceTimeout /
// cancelBuild / the startBuild catch). This mirrors the unit harness
// (test/unit/build-manager.test.ts) but exercises the REAL `check-run.ts` module
// through a stubbed global `fetch`, so the create/finalize wiring + best-effort
// guarantees are asserted end-to-end.

// `@cloudflare/containers` Container base class — same faithful stub as the unit
// harness: start() launches THEN runs onStart before resolving, stop()/destroy()
// model SIGTERM/SIGKILL, schedule()/_runDueSchedules() model the base alarm loop.
const containerCalls = {
  started: 0,
  stopped: 0,
  destroyed: 0,
  baseAlarms: 0,
};
type ScheduledTask = { whenSeconds: number; callback: string };
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    envVars: Record<string, string> = {};
    defaultPort?: number;
    enableInternet?: boolean;
    sleepAfter?: string | number;
    _schedules: Array<ScheduledTask> = [];
    _containerRunning = false;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
    async start(): Promise<void> {
      containerCalls.started += 1;
      this._containerRunning = true;
      await (this as unknown as { onStart(): Promise<void> }).onStart();
    }
    async stop(): Promise<void> {
      containerCalls.stopped += 1;
      this._containerRunning = false;
    }
    async destroy(): Promise<void> {
      containerCalls.destroyed += 1;
      this._containerRunning = false;
    }
    async fetch(): Promise<Response> {
      return new Response('container', { status: 200 });
    }
    async schedule(whenSeconds: number, callback: string): Promise<void> {
      this._schedules.push({ whenSeconds, callback });
    }
    async alarm(): Promise<void> {
      containerCalls.baseAlarms += 1;
    }
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

// db.ts — CAS-modeled status store (same as the unit harness) PLUS a captured
// `check_run_id` so the persisted id can be asserted.
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
  status: new Map<string, string>(),
  deployment: null as { id: string } | null,
  createdAt: new Date().toISOString(),
  requeued: [] as Array<string>,
  installationCovered: true,
  // Captured `builds.check_run_id` writes (id -> checkRunId). Default null per build.
  checkRunIds: new Map<string, string>(),
  // When true, setBuildCheckRunId rejects (transient Postgres outage) so the
  // best-effort DB-write swallow can be asserted (the DO cache still retains it).
  setCheckRunIdThrows: false,
};
vi.mock('../../src/db.ts', () => ({
  createDb: () => ({ __mock: 'db' }),
  updateBuildStatus: vi.fn(async (_db: unknown, id: string, status: string, opts?: unknown) => {
    dbState.status.set(id, status);
    dbState.writes.push({ id, status, opts: opts as StatusWrite['opts'] });
  }),
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
  getBuild: vi.fn(async (_db: unknown, id: string) => {
    const status = dbState.status.get(id);
    if (status === undefined) {
      return null;
    }
    // Carry the persisted `check_run_id` (the real row does) so the
    // finalizeCheckRun DO-storage-miss fallback can recover it from Postgres.
    return {
      id,
      created_at: dbState.createdAt,
      status,
      check_run_id: dbState.checkRunIds.get(id) ?? null,
    };
  }),
  requeueBuildIfStarting: vi.fn(async (_db: unknown, id: string) => {
    if (dbState.status.get(id) !== 'starting') {
      return false;
    }
    dbState.status.set(id, 'queued');
    dbState.requeued.push(id);
    return true;
  }),
  installationCoversRepo: vi.fn(
    async (
      _db: unknown,
      connectionId: string,
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
  // Records the persisted check_run_id. Rejects when `setCheckRunIdThrows` so the
  // best-effort swallow (DO cache retains the id) can be asserted.
  setBuildCheckRunId: vi.fn(async (_db: unknown, id: string, checkRunId: string) => {
    if (dbState.setCheckRunIdThrows) {
      throw new Error('postgres write failed');
    }
    dbState.checkRunIds.set(id, checkRunId);
  }),
}));

// deploy-token.ts — deterministic fakes (mirror the unit harness).
vi.mock('../../src/auth/deploy-token.ts', () => ({
  signDeployToken: vi.fn(async () => 'deploy-token'),
  DEPLOY_TOKEN_HARD_MAX_MINUTES: 60,
  deployTokenTtlSecondsForBuildMinutes: (timeoutMinutes: number) => {
    const buildMinutes = timeoutMinutes > 0 ? timeoutMinutes : Infinity;
    const cappedMinutes = Math.min(buildMinutes, 60);
    return cappedMinutes * 60 + 5 * 60;
  },
}));

// installation-token.ts — provide a REAL `getInstallationToken` (so the un-mocked
// `check-run.ts` can mint a token and reach `fetch`), plus the API constants and
// the freshness/tarball helpers the manager needs. `check-run.ts` is intentionally
// NOT mocked: this test drives the real create/complete module via stubbed `fetch`.
vi.mock('../../src/github/installation-token.ts', () => ({
  GITHUB_API_BASE: 'https://api.github.com',
  GITHUB_API_VERSION: '2026-03-10',
  getInstallationToken: vi.fn(async () => 'install-token'),
  generateSourceTarballUrl: vi.fn(
    (repo: string, sha: string) => `https://api.github.com/repos/${repo}/tarball/${sha}`,
  ),
  getBranchHeadComparisonStatus: vi.fn(async () => 'identical'),
}));

import { signDeployToken } from '../../src/auth/deploy-token.ts';
import { BuildManager } from '../../src/build-manager.ts';
import type { BuildConfig } from '../../src/build-types.ts';
import { getBuild, markBuildTerminalIfActive } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { getBranchHeadComparisonStatus } from '../../src/github/installation-token.ts';

// --- ctx / env / config fakes (mirror the unit harness) ---

type LogRow = { seq: number; line: string; stream: string; ts: number };

function makeStubCtx() {
  const kv = new Map<string, unknown>();
  const logs: Array<LogRow> = [];
  let seq = 0;
  const sockets: Array<FakeWebSocket> = [];

  const sql = {
    exec(query: string, ...bindings: Array<unknown>) {
      if (query.startsWith('INSERT INTO logs')) {
        seq += 1;
        logs.push({
          seq,
          line: bindings[0] as string,
          stream: bindings[1] as string,
          ts: bindings[2] as number,
        });
      }
      return { toArray: () => logs.slice().sort((a, b) => a.seq - b.seq) };
    },
  };

  return {
    _logs: logs,
    _sockets: sockets,
    _kv: kv,
    storage: {
      sql,
      get: vi.fn(async (k: string) => kv.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        kv.set(k, v);
      }),
      getAlarm: vi.fn(async () => null),
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
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
    commitSha: 'sha1234567890',
    branch: 'main',
    repoFullName: 'owner/repo',
    connectionId: 'c1',
    installationId: 'inst1',
    repositoryId: 'repo1',
    instanceType: 'standard-1',
    timeoutMinutes: 10,
    ...overrides,
  };
}

function makeManager(ctx: ReturnType<typeof makeStubCtx>, env: ApiEnv['Bindings']) {
  return new BuildManager(ctx as unknown as ConstructorParameters<typeof BuildManager>[0], env);
}

async function runDueSchedules(m: BuildManager): Promise<void> {
  await (m as unknown as { _runDueSchedules: () => Promise<void> })._runDueSchedules();
}

function schedulerGet(env: ApiEnv['Bindings']): ReturnType<typeof vi.fn> {
  return (env as unknown as { BUILD_SCHEDULER: { get: ReturnType<typeof vi.fn> } }).BUILD_SCHEDULER
    .get;
}

// --- fetch stub: GitHub check-run create (POST) + complete (PATCH) + token POST ---

type FetchCall = {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
};

const CHECK_RUN_ID = 99_001;

type FetchMatchers = {
  // Override the create response status (default 201) / body. Used for the 4xx +
  // 5xx-retry + missing-id scenarios.
  createStatus?: number;
  createBody?: Record<string, unknown> | null;
  // Override the complete (PATCH) response status (default 200).
  completeStatus?: number;
};

function installFetch(matchers: FetchMatchers = {}): {
  posts: Array<FetchCall>;
  patches: Array<FetchCall>;
  calls: Array<FetchCall>;
} {
  const posts: Array<FetchCall> = [];
  const patches: Array<FetchCall> = [];
  const calls: Array<FetchCall> = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: Record<string, unknown> | undefined;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          body = undefined;
        }
      }
      const call: FetchCall = { method, url, body };
      calls.push(call);

      // Installation access-token mint (only reached if getInstallationToken is the
      // real impl; here it is mocked, so this is a safety net).
      if (url.includes('/access_tokens') && method === 'POST') {
        return Response.json({
          token: 'tok',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }

      // PATCH .../check-runs/{id} — finalize.
      if (method === 'PATCH' && /\/check-runs\/[^/]+$/.test(url)) {
        patches.push(call);
        const status = matchers.completeStatus ?? 200;
        if (status >= 400) {
          return new Response('patch error', { status });
        }
        return Response.json({ id: CHECK_RUN_ID, status: 'completed' }, { status });
      }

      // POST .../check-runs — create.
      if (method === 'POST' && /\/check-runs$/.test(url)) {
        posts.push(call);
        const status = matchers.createStatus ?? 201;
        if (status >= 400) {
          return new Response('create error', { status });
        }
        const responseBody =
          matchers.createBody === undefined
            ? { id: CHECK_RUN_ID, status: 'in_progress' }
            : matchers.createBody;
        return Response.json(responseBody ?? {}, { status });
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );

  return { posts, patches, calls };
}

beforeEach(() => {
  dbState.writes = [];
  dbState.status = new Map<string, string>([['b1', 'starting']]);
  dbState.deployment = null;
  dbState.createdAt = new Date().toISOString();
  dbState.requeued = [];
  dbState.installationCovered = true;
  dbState.checkRunIds = new Map<string, string>();
  dbState.setCheckRunIdThrows = false;
  containerCalls.started = 0;
  containerCalls.stopped = 0;
  containerCalls.destroyed = 0;
  containerCalls.baseAlarms = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BuildManager check-run lifecycle — create', () => {
  it('POSTs one in_progress check-run once all rechecks pass and persists the id', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    // Exactly one POST /check-runs with the create contract.
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toMatch(/\/repos\/owner\/repo\/check-runs$/);
    expect(posts[0].body).toMatchObject({
      name: 'Void Build',
      head_sha: 'sha1234567890',
      external_id: 'b1',
      status: 'in_progress',
    });
    // No finalize yet — the build is still running.
    expect(patches).toHaveLength(0);
    // Persisted to Postgres (best-effort) AND cached in input-gated DO storage.
    expect(dbState.checkRunIds.get('b1')).toBe(String(CHECK_RUN_ID));
    expect(ctx._kv.get('checkRunId')).toBe(String(CHECK_RUN_ID));
    // The build still started normally.
    expect(containerCalls.started).toBe(1);
  });

  it('does NOT POST when freshness is non-identical (no check-run, NULL id)', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce('ahead');
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(0);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();
    expect(containerCalls.started).toBe(0);
  });

  it('does NOT POST when freshness is null (requeue path), NULL id', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    dbState.createdAt = new Date().toISOString(); // fresh → requeue
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(dbState.requeued).toEqual(['b1']);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
  });

  it('does NOT POST when the installation no longer covers the repo (uncovered cancel)', async () => {
    dbState.installationCovered = false;
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(containerCalls.started).toBe(0);
  });

  it('does NOT POST when the row was cancelled after the claim (no check-run)', async () => {
    dbState.status.set('b1', 'cancelled');
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    expect(dbState.checkRunIds.has('b1')).toBe(false);
  });

  it('SHA guard — does NOT POST when commitSha is empty (head_sha:"" would 422)', async () => {
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig({ commitSha: '' }));

    expect(posts).toHaveLength(0);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    // The build still starts — the SHA guard only suppresses the check-run.
    expect(containerCalls.started).toBe(1);
  });

  it('create returns 500 (single-shot, no retry) → build still starts, id NULL, finalizers no-op', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts, patches } = installFetch({ createStatus: 500 });
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    // A 5xx on create is NOT retried (the POST is not idempotent) → exactly one
    // attempt, returns null.
    expect(posts).toHaveLength(1);
    // The build started anyway.
    expect(containerCalls.started).toBe(1);
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();

    // A finalize site no-ops (no id stored) → no PATCH.
    dbState.writes = [];
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(patches).toHaveLength(0);

    // At least one area:'github' warn was logged for the create failure.
    const githubWarn = warnSpy.mock.calls.some((c) =>
      typeof c[0] === 'string' ? c[0].includes('"area":"github"') : false,
    );
    expect(githubWarn).toBe(true);
    warnSpy.mockRestore();
  });

  it('4xx on create → no retry (exactly one POST), id NULL', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts } = installFetch({ createStatus: 422 });
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(1); // definitive 4xx — no retries
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(containerCalls.started).toBe(1);
    warnSpy.mockRestore();
  });

  it('still caches the id in DO storage when the Postgres persist throws (best-effort)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbState.setCheckRunIdThrows = true;
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    // The POST succeeded and the build started — the DB-write throw was swallowed.
    expect(posts).toHaveLength(1);
    expect(containerCalls.started).toBe(1);
    // DB write failed (not recorded) but the DO cache retains the id for finalizers.
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(ctx._kv.get('checkRunId')).toBe(String(CHECK_RUN_ID));
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — finalize terminal sites', () => {
  it('onStop exit 0 → PATCH conclusion:success with the dashboard details_url', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    dbState.deployment = { id: 'dpl_1' };

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({
      status: 'completed',
      conclusion: 'success',
      details_url: 'https://my-app.void.app',
    });
  });

  it('onStop exit 1 → PATCH conclusion:failure, summary mentions the exit code', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await m.onStop({ exitCode: 1, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'failure' });
    const output = patches[0].body?.output as { summary?: string };
    expect(output.summary).toMatch(/1/);
  });

  it('onError → PATCH conclusion:failure', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await m.onError(new Error('boom'));

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ conclusion: 'failure' });
    const output = patches[0].body?.output as { summary?: string };
    expect(output.summary).toBe('boom');
  });

  it('enforceTimeout → PATCH conclusion:failure, summary "build timed out"', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await runDueSchedules(m); // base alarm invokes enforceTimeout

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ conclusion: 'failure' });
    const output = patches[0].body?.output as { summary?: string };
    expect(output.summary).toBe('build timed out');
  });

  it('cancelBuild on an active row → PATCH conclusion:cancelled, summary == reason', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    await m.cancelBuild('project disconnected');

    expect(patches).toHaveLength(1);
    // The cancel finalize sets an env-aware details_url via projectUrl() — default
    // env (no SITE_DOMAIN) → prod fallback.
    expect(patches[0].body).toMatchObject({
      conclusion: 'cancelled',
      details_url: 'https://my-app.void.app',
    });
    const output = patches[0].body?.output as { summary?: string };
    expect(output.summary).toBe('project disconnected');
  });

  it('cancelBuild on an already-terminal row → re-PATCH original conclusion', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    // First finalize cleanly via onStop (success PATCH).
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(patches).toHaveLength(1);

    // A late cancel may be recovering an invocation lost after the PostgreSQL
    // commit but before its check PATCH. Re-PATCH the authoritative conclusion
    // idempotently rather than replacing it with the cancellation reason.
    await m.cancelBuild('project disconnected');
    expect(patches).toHaveLength(2);
    expect(patches[1].body).toMatchObject({ conclusion: 'success' });
    const output = patches[1].body?.output as { summary?: string };
    expect(output.summary).toBe('Build complete.');
  });

  it('PATCH returns 500 in onStop → build still finalized, scheduler poked, no throw', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { patches } = installFetch({ completeStatus: 500 });
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());
    schedulerGet(env).mockClear();

    // Does NOT throw despite the PATCH failing.
    await m.onStop({ exitCode: 0, reason: 'exit' });

    // The build is still terminalized.
    expect(dbState.status.get('b1')).toBe('complete');
    // The PATCH was attempted (3 times: initial + 2 retries on 5xx).
    expect(patches).toHaveLength(3);
    // The scheduler was still poked (the finally always runs).
    expect(schedulerGet(env)).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — startBuild failures after create', () => {
  // A non-capacity throw AFTER the check-run is created must finalize
  // the run as `failure` via the startBuild catch — otherwise it strands `in_progress`
  // forever (no onStop ever finalizes a force-stopped build). The slot still frees.
  it('startBuild throws AFTER create (non-capacity) → build failed via catch, one failure PATCH, no stranded in_progress', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    schedulerGet(env).mockClear();

    // this.start() throws a NON-capacity error AFTER the check-run create site.
    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockRejectedValueOnce(new Error('image pull failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow('image pull failed');
    expect(startSpy).toHaveBeenCalled();

    // The run was created once, then finalized exactly once as failure.
    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ conclusion: 'failure' });
    const output = patches[0].body?.output as { summary?: string };
    expect(output.summary).toBe('image pull failed');

    // The build is failed (not stranded), and the slot was freed (scheduler poked).
    expect(dbState.status.get('b1')).toBe('failed');
    expect(schedulerGet(env)).toHaveBeenCalled();

    startSpy.mockRestore();
  });

  // Even if the terminal CAS write itself throws, the catch's
  // `finally { pokeScheduler() }` must still run — finalizeCheckRun never throws and
  // does not perturb that.
  it('startBuild catch still pokes the scheduler when the terminal write throws (finalize never perturbs)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts } = installFetch({ completeStatus: 500 });
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    schedulerGet(env).mockClear();

    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockRejectedValueOnce(new Error('image pull failed'));
    vi.mocked(markBuildTerminalIfActive).mockRejectedValueOnce(new Error('terminal write failed'));

    await expect(m.startBuild(makeConfig())).rejects.toThrow();

    expect(posts).toHaveLength(1);
    // The slot still frees despite both the terminal-write throw and the failing PATCH.
    expect(schedulerGet(env)).toHaveBeenCalled();
    startSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // A capacity error AFTER create re-throws WITHOUT terminalizing
  // (the build is requeued). The run stays `in_progress` (NO PATCH). When the
  // scheduler re-runs startBuild on the SAME DO, the stored id is reused → NO
  // second POST. Total: exactly ONE POST, ZERO PATCH.
  it('capacity error after create then requeue → reuses the DO-stored id, exactly one POST total, no PATCH', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // First run: start() throws the capacity error AFTER the create site.
    const startSpy = vi
      .spyOn(m as unknown as { start: () => Promise<void> }, 'start')
      .mockRejectedValueOnce(
        new Error('there is no container instance that can be provided to this durable object'),
      );

    await expect(m.startBuild(makeConfig())).rejects.toThrow(/no container instance/);
    expect(startSpy).toHaveBeenCalled();

    // The run was created but NOT finalized (capacity re-throw doesn't terminalize).
    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(0);
    // The id persists in DO storage for the requeue.
    expect(ctx._kv.get('checkRunId')).toBe(String(CHECK_RUN_ID));
    // The row was left exactly as the scheduler claimed it (capacity path doesn't write).
    expect(dbState.status.get('b1')).toBe('starting');

    startSpy.mockRestore();

    // Second run (requeue): startBuild re-invoked on the SAME DO. start() now succeeds.
    await m.startBuild(makeConfig());

    // No SECOND POST — the stored id was reused.
    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(0);
    expect(containerCalls.started).toBe(1);
  });
});

describe('BuildManager check-run lifecycle — CAS-lost finalize (matches the DB outcome)', () => {
  // When a terminal site LOSES the CAS (the row was terminalized out-of-band
  // before this site ran), the check-run must be PATCHed to the AUTHORITATIVE recorded
  // outcome — never this site's assumed one — so GitHub never contradicts the DB.
  //
  // Force the out-of-band terminalization the same way the
  // 'already-terminal' scenarios do: pre-set the DB row terminal BEFORE invoking the
  // handler, so `markBuildTerminalIfActive(...)` CAS-no-ops (current ∉ ACTIVE → false).
  // The DO's in-memory `config.status` is still 'starting' (set by startBuild), so the
  // local TERMINAL_STATUSES fast-path guard does NOT short-circuit — the lost-CAS
  // branch is exercised.
  it('onStop exit 0 but row cancelled out-of-band → PATCH conclusion:cancelled (not success)', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Out-of-band cancel committed the terminal row AFTER the create, BEFORE onStop.
    dbState.status.set('b1', 'cancelled');

    await m.onStop({ exitCode: 0, reason: 'exit' });

    // Exactly one PATCH, and it matches the DB's recorded 'cancelled' — NOT 'success'.
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    // The DB row is untouched by the lost CAS (still 'cancelled').
    expect(dbState.status.get('b1')).toBe('cancelled');
  });

  it('onStop exit 0 but row failed out-of-band → PATCH conclusion:failure (not success)', async () => {
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Out-of-band terminal write recorded 'failed' before the exit-0 onStop.
    dbState.status.set('b1', 'failed');

    await m.onStop({ exitCode: 0, reason: 'exit' });

    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(dbState.status.get('b1')).toBe('failed');
  });
});

describe('BuildManager check-run lifecycle — cancel during create (post-create recheck)', () => {
  // A cancel that interleaves DURING the createCheckRun POST. The createCheckRun
  // fetch yields the DO input gate, so a cancelBuild RPC can terminalize the row
  // mid-POST (its own finalize ran BEFORE the id was stored → no-op). The post-create
  // recheck (`getBuild` after the POST) must see the non-'starting' row, finalize the
  // just-created run to the recorded outcome, and NOT mint a token / start a container.
  //
  // Model the interleave with the harness's own `fetch` stub: the create POST handler
  // flips the DB row to 'cancelled' as a side effect, so the pre-create recheck (run
  // BEFORE the POST) still sees 'starting' and the POST happens, but the post-create
  // recheck (run AFTER the POST) observes the 'cancelled' row.
  it('cancel lands during create → exactly one cancelled PATCH, no container, no token', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Flip the row terminal at the moment the create POST is served — the post-create
    // recheck then reads 'cancelled'.
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && /\/check-runs$/.test(url)) {
        dbState.status.set('b1', 'cancelled');
      }
      return original(input, init);
    });

    await m.startBuild(makeConfig());

    // The run was created once, then finalized exactly once as 'cancelled'.
    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    // NO container started and NO deploy token minted — the recheck returned early.
    expect(containerCalls.started).toBe(0);
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    // Local status synced to the recorded terminal outcome.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
  });
});

describe('BuildManager check-run lifecycle — best-effort DO-storage cache', () => {
  // Caching the check-run id in DO storage is BEST-EFFORT. A rejecting
  // `ctx.storage.put` for the check-run key must NOT fail or perturb the build — the
  // container still starts and the scheduler is still poked.
  it('storage.put rejection for the check-run key does not fail the build', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    schedulerGet(env).mockClear();

    // Reject ONCE, only for the check-run key — leave config/agent-token puts intact.
    const realPut = ctx.storage.put.getMockImplementation()!;
    let rejected = false;
    ctx.storage.put.mockImplementation(async (k: string, v: unknown) => {
      if (k === 'checkRunId' && !rejected) {
        rejected = true;
        throw new Error('DO storage put failed');
      }
      return realPut(k, v);
    });

    const m = makeManager(ctx, env);

    // Does NOT throw despite the cache put rejecting.
    await m.startBuild(makeConfig());

    // The create succeeded and the build started normally.
    expect(posts).toHaveLength(1);
    expect(rejected).toBe(true);
    expect(containerCalls.started).toBe(1);
    // The id was NOT cached (put rejected) so finalizers will no-op, but the build
    // proceeded normally: the container's onStart CAS-flipped the row 'starting' ->
    // 'building' (active, NOT failed). The put rejection was swallowed, not fatal.
    expect(ctx._kv.get('checkRunId')).toBeUndefined();
    expect(dbState.status.get('b1')).toBe('building');
    // The Postgres persist still ran (best-effort, independent of the DO cache).
    expect(dbState.checkRunIds.get('b1')).toBe(String(CHECK_RUN_ID));
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — redelivery (single build, single POST)', () => {
  // A redelivery that dedups to the SAME build runs startBuild on the same DO; the
  // idempotent-create guard plus the supersede-reuse upstream means exactly one POST.
  // Model it directly: a second startBuild on the same DO reuses the stored id.
  it('a redelivered start on the same DO reuses the id → one POST total', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());
    expect(posts).toHaveLength(1);

    // Re-claim the row 'starting' and re-run startBuild (redelivery on the same DO).
    dbState.status.set('b1', 'starting');
    await m.startBuild(makeConfig());

    // Still exactly one POST — the stored id was reused; no finalize happened.
    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(0);
  });
});

describe('BuildManager check-run lifecycle — finalize hardening (DO-miss fallback + lost-CAS throw)', () => {
  // A DO-storage MISS for the check-run id must NOT strand the run `in_progress`.
  // `finalizeCheckRun` falls back to the persisted `builds.check_run_id` (the column
  // `setBuildCheckRunId` wrote at create). Recreate the miss like the best-effort-put
  // scenario — reject `ctx.storage.put('checkRunId')` ONCE so the DO cache never
  // holds the id — but the Postgres persist still ran (dbState.checkRunIds). Then
  // drive a terminal finalizer and assert a PATCH DID happen.
  it('onStop exit 0 with the DO-storage id missing → finalize recovers it from builds.check_run_id, one success PATCH', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();

    // Reject ONCE, only for the check-run key — leave config/agent-token puts intact.
    // After this the DO cache has NO id, but setBuildCheckRunId still persisted it.
    const realPut = ctx.storage.put.getMockImplementation()!;
    let rejected = false;
    ctx.storage.put.mockImplementation(async (k: string, v: unknown) => {
      if (k === 'checkRunId' && !rejected) {
        rejected = true;
        throw new Error('DO storage put failed');
      }
      return realPut(k, v);
    });

    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Precondition for the fallback: DO storage missed the id, Postgres has it.
    expect(rejected).toBe(true);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();
    expect(dbState.checkRunIds.get('b1')).toBe(String(CHECK_RUN_ID));
    expect(containerCalls.started).toBe(1);

    await m.onStop({ exitCode: 0, reason: 'exit' });

    // The finalizer recovered the id from the persisted column and PATCHed success.
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(dbState.status.get('b1')).toBe('complete');
    warnSpy.mockRestore();
  });

  // On the lost-CAS `!won` path the terminal site calls
  // `finalizeCheckRunToRecordedOutcome`, which reads the authoritative row via
  // `getBuild`. If that read THROWS it must be swallowed (log + return) — never
  // propagate out of the terminal handler (which would skip the PATCH AND, worse,
  // reject before/around the finally and strand the slot). Assert the handler
  // resolves, the scheduler is still poked (slot freed), and NO PATCH is sent.
  it('lost-CAS finalize getBuild throw is swallowed → onStop resolves, scheduler poked, no PATCH', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // startBuild consumes its own getBuild calls (the pre-start cancellation recheck);
    // run it FIRST so the throw below targets ONLY the finalize-path getBuild.
    await m.startBuild(makeConfig());

    // Out-of-band terminal write recorded 'failed' before onStop → onStop's exit-0
    // `markBuildTerminalIfActive` CAS-no-ops (current ∉ ACTIVE) → won=false → the
    // `!won` branch calls finalizeCheckRunToRecordedOutcome.
    dbState.status.set('b1', 'failed');

    // The next getBuild — the one inside finalizeCheckRunToRecordedOutcome — throws.
    // onStop's exit-0 path makes no other getBuild call (the deployment lookup is a
    // separate mock), so this targets the finalize read precisely.
    vi.mocked(getBuild).mockRejectedValueOnce(new Error('hyperdrive read failed'));

    schedulerGet(env).mockClear();

    // Does NOT throw despite the finalize-path getBuild rejecting.
    await expect(m.onStop({ exitCode: 0, reason: 'exit' })).resolves.toBeUndefined();

    // The slot was still freed (the finally always runs).
    expect(schedulerGet(env)).toHaveBeenCalled();
    // The throw aborted finalize BEFORE any completeCheckRun PATCH — gracefully skipped.
    expect(patches).toHaveLength(0);
    // The DB row is untouched by the lost CAS (still 'failed').
    expect(dbState.status.get('b1')).toBe('failed');
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — requeue/create-cancel id reuse', () => {
  // A requeue runs startBuild on a FRESH DO (or one whose best-effort
  // DO-storage cache was lost), so DO storage holds NO check-run id — but the
  // FIRST run's `setBuildCheckRunId` persisted it to `builds.check_run_id`. The
  // create-gate must reuse that PERSISTED id (the pre-create-recheck `row` carries
  // it) instead of POSTing a SECOND `Void Build` run, which would orphan the first
  // one `in_progress`. Model the requeue's starting state directly: seed
  // `dbState.checkRunIds` (Postgres has the id) while leaving DO storage empty.
  it('requeue with DO storage empty but builds.check_run_id set → reuses the persisted id, no second POST', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // Postgres already holds the id from the first run; the DO cache does not.
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    expect(ctx._kv.get('checkRunId')).toBeUndefined();

    await m.startBuild(makeConfig());

    // The create-gate reused `row.check_run_id` → the `if (!checkRunId ...)` create
    // branch was skipped → NO new POST. No finalize either (the build is running).
    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(0);
    // The build proceeded normally on the reused id.
    expect(containerCalls.started).toBe(1);
    expect(dbState.status.get('b1')).toBe('building');

    // Drive a terminal finalizer: the reused id is recovered via the PG fallback
    // (DO storage never held it) and the PATCH targets it.
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
  });

  // A cancel interleaves DURING the create POST AND both persists fail —
  // the DO-storage cache put rejects and the Postgres `setBuildCheckRunId` rejects —
  // so the just-created id lives ONLY in startBuild's local variable. The post-create
  // recheck must still finalize the run to the recorded outcome using that in-hand id
  // (passed as `explicitId` to `finalizeCheckRun`), even though neither DO nor PG holds
  // it. Otherwise the run is stranded `in_progress` forever.
  it('cancel during create with BOTH persists failing → finalizes via the in-hand id, exactly one cancelled PATCH', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();

    // Both persists fail: the DO-storage cache put rejects ONCE for the check-run key
    // (leaving config/agent-token puts intact), and the Postgres persist rejects too.
    const realPut = ctx.storage.put.getMockImplementation()!;
    let putRejected = false;
    ctx.storage.put.mockImplementation(async (k: string, v: unknown) => {
      if (k === 'checkRunId' && !putRejected) {
        putRejected = true;
        throw new Error('DO storage put failed');
      }
      return realPut(k, v);
    });
    dbState.setCheckRunIdThrows = true;

    // Flip the row terminal at the moment the create POST is served — the post-create
    // recheck then reads 'cancelled' (pre-create recheck still saw 'starting').
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && /\/check-runs$/.test(url)) {
        dbState.status.set('b1', 'cancelled');
      }
      return original(input, init);
    });

    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // Exactly one POST (create) and exactly one PATCH (post-create recheck finalize),
    // even though neither persist held the id — the local var was passed as explicitId.
    expect(posts).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    // Recheck returned early: no container, no deploy token.
    expect(containerCalls.started).toBe(0);
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
    // Proof BOTH persists failed — the PATCH could only have come from the in-hand id.
    expect(putRejected).toBe(true);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();
    expect(dbState.checkRunIds.get('b1')).toBeUndefined();
    // Local status synced to the recorded terminal outcome.
    expect(ctx._kv.get('buildConfig')).toMatchObject({ status: 'cancelled' });
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — dual persist fail, build continues', () => {
  // createCheckRun succeeds but BOTH the DO put and the Postgres persist
  // fail, and NO cancel interleaves — the post-create recheck sees 'starting', so the
  // build CONTINUES to run the container. The id then lives ONLY in the in-memory
  // `activeCheckRunId` field (the explicitId path is not taken — that's only the cancel
  // branch). A later terminal finalizer (onStop — a SEPARATE invocation with no access
  // to startBuild's local var) must still recover the id from the field and PATCH the
  // run, instead of leaving it stranded `in_progress`.
  it('build runs to completion → terminal finalize recovers the id from the in-memory field', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();

    // Both persists fail: DO put rejects ONCE for the check-run key + PG persist throws.
    const realPut = ctx.storage.put.getMockImplementation()!;
    let putRejected = false;
    ctx.storage.put.mockImplementation(async (k: string, v: unknown) => {
      if (k === 'checkRunId' && !putRejected) {
        putRejected = true;
        throw new Error('DO storage put failed');
      }
      return realPut(k, v);
    });
    dbState.setCheckRunIdThrows = true;

    const m = makeManager(ctx, env);
    await m.startBuild(makeConfig());

    // The run was created and the build CONTINUED (no cancel): one POST, container
    // started, both durable stores empty (the id lives only in the in-memory field),
    // and nothing finalized yet.
    expect(posts).toHaveLength(1);
    expect(containerCalls.started).toBe(1);
    expect(putRejected).toBe(true);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();
    expect(dbState.checkRunIds.get('b1')).toBeUndefined();
    expect(patches).toHaveLength(0);

    // Build completes — the terminal finalizer (separate invocation) recovers the id
    // from `activeCheckRunId` and PATCHes, instead of leaving it stranded in_progress.
    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'success' });
    warnSpy.mockRestore();
  });
});

describe('BuildManager check-run lifecycle — pre-start terminalize finalizes a PRIOR run', () => {
  // The pre-start terminalizing early-returns in `startBuild` call
  // `finalizeCheckRunToStatus(config, <status>)` before returning. A capacity requeue
  // re-runs `startBuild` on the SAME build id, and `builds.check_run_id` survives the
  // requeue, so a run created on a PRIOR attempt would otherwise be stranded
  // `in_progress` forever when a pre-start recheck terminalizes the build. The
  // finalize NO-OPS on a first attempt (no id anywhere → `finalizeCheckRun` returns
  // before any PATCH) and PATCHes on a requeue (id recovered from `builds.check_run_id`
  // — the harness's `getBuild` carries `dbState.checkRunIds`).

  // Pre-create cancel recheck: the row is terminal BEFORE startBuild runs,
  // so freshness + coverage pass (they don't read status) and the cancellation recheck
  // `getBuild` observes a non-'starting' terminal row → early return. A PRIOR run was
  // persisted, so it must be finalized to the recorded outcome ('cancelled').
  it('requeue cancel-recheck finalizes the prior run → no create POST, one cancelled PATCH', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // A prior attempt persisted the run id to builds.check_run_id (survives the requeue).
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    // The row was cancelled out-of-band before this requeue claimed/ran startBuild, so
    // the pre-create cancellation recheck fires. Freshness is 'identical' (default) and
    // coverage is true (default) so the earlier pre-start gates pass first.
    dbState.status.set('b1', 'cancelled');

    await m.startBuild(makeConfig());

    // Early return BEFORE the create block → NO create POST.
    expect(posts).toHaveLength(0);
    // The prior run was finalized exactly once, to the recorded 'cancelled' outcome.
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    // No container, no deploy token — the recheck returned early.
    expect(containerCalls.started).toBe(0);
    expect(vi.mocked(signDeployToken)).not.toHaveBeenCalled();
  });

  // Non-identical head branch: a missed newer-push leaves a stale queued
  // build; the just-in-time freshness recheck returns non-'identical' → cancel + return
  // BEFORE the create block. A PRIOR run must be finalized to 'cancelled'.
  it('non-identical head finalizes the prior run → no create POST, one cancelled PATCH', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce('behind');
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // A prior attempt persisted the run id (survives the requeue).
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));

    await m.startBuild(makeConfig());

    // The build is cancelled (non-identical head), no create POST.
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(posts).toHaveLength(0);
    // The prior run was finalized exactly once, as 'cancelled'.
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    expect(containerCalls.started).toBe(0);
  });

  // First-attempt terminalize (NO prior run): the same non-identical pre-start path with
  // NO persisted id anywhere (DO storage empty, builds.check_run_id null). The finalize
  // correctly NO-OPS — `finalizeCheckRun` resolves no id and returns before any PATCH.
  it('first-attempt terminalize does NOT PATCH (nothing to finalize)', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce('behind');
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    // No prior run: dbState.checkRunIds empty (default) and DO storage empty.
    expect(dbState.checkRunIds.has('b1')).toBe(false);
    expect(ctx._kv.get('checkRunId')).toBeUndefined();

    await m.startBuild(makeConfig());

    // The build is cancelled, but with no run to finalize there is no POST and no PATCH.
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });
});

describe('BuildManager check-run lifecycle — pre-start finalize is CAS-aware', () => {
  // The three pre-start terminalizing early-returns (freshness aged-out,
  // non-identical head, uncovered repo) call `markBuildTerminalIfActive` then finalize
  // a PRIOR-attempt run. Their awaits (getBranchHeadComparisonStatus fetch /
  // installationCoversRepo Hyperdrive read) release the DO input gate, so a concurrent
  // terminalizer (terminateBuildsForProject commits an out-of-band terminal status,
  // then the cancelBuild RPC) can win the CAS with a DIFFERENT status. Like the catch
  // site and the terminal sites, each path captures the `won` boolean and, on a
  // loss, finalizes to the AUTHORITATIVE recorded outcome — so GitHub never contradicts
  // the DB. Forced the same way as the terminal-site lost-CAS tests: pre-set the row
  // terminal so `markBuildTerminalIfActive` CAS-no-ops (current ∉ ACTIVE → false).

  // --- lost-CAS branch: the conclusion must match the recorded DB status, NOT the
  // path's hardcoded one. ---

  it('aged-out freshness, row cancelled out-of-band → PATCH cancelled (not the hardcoded failure)', async () => {
    // null comparison + aged-out → the 'failed' aged-out branch. The row was cancelled
    // out-of-band first, so the CAS loses and the run must finalize 'cancelled'.
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    dbState.createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h old → aged out
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID)); // prior-attempt run
    dbState.status.set('b1', 'cancelled'); // out-of-band terminal winner
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    // Returned before the create block → no POST. One PATCH, to the RECORDED 'cancelled'
    // — never the aged-out path's assumed 'failure'.
    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/check-runs\/99001$/);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    // The lost CAS left the DB row untouched (still 'cancelled').
    expect(dbState.status.get('b1')).toBe('cancelled');
    expect(containerCalls.started).toBe(0);
  });

  it('non-identical head, row failed out-of-band → PATCH failure (not the hardcoded cancelled)', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce('behind');
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    dbState.status.set('b1', 'failed'); // out-of-band terminal winner (e.g. concurrent timeout)
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(dbState.status.get('b1')).toBe('failed');
    expect(containerCalls.started).toBe(0);
  });

  it('uncovered repo, row failed out-of-band → PATCH failure (not the hardcoded cancelled)', async () => {
    dbState.installationCovered = false; // freshness 'identical' (default) → reaches coverage
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    dbState.status.set('b1', 'failed'); // out-of-band terminal winner
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(dbState.status.get('b1')).toBe('failed');
    expect(containerCalls.started).toBe(0);
  });

  // --- won branch (CAS wins → finalize to this site's own conclusion). The
  // non-identical-head won case is covered by the prior-run suite above. ---

  it('aged-out freshness wins the CAS → PATCH failure (the aged-out conclusion)', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce(null);
    dbState.createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // aged out
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    // status stays 'starting' (default) → CAS wins.
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'failure' });
    // The CAS won and recorded 'failed'.
    expect(dbState.status.get('b1')).toBe('failed');
  });

  it('uncovered repo wins the CAS → PATCH cancelled (the uncovered conclusion)', async () => {
    dbState.installationCovered = false;
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID));
    // status stays 'starting' (default) → CAS wins.
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ status: 'completed', conclusion: 'cancelled' });
    expect(dbState.status.get('b1')).toBe('cancelled');
  });
});

describe('BuildManager check-run lifecycle — details_url is env-aware (SITE_DOMAIN)', () => {
  // The check-run details_url links to the project's public traffic URL. Staging and
  // production serve on different base domains, so the link must follow the
  // per-environment SITE_DOMAIN binding (the same source the deploy-URL output uses),
  // not a hardcoded `.void.app`.
  it('staging SITE_DOMAIN → create + finalize link to {slug}.staging.void.app', async () => {
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    env.SITE_DOMAIN = 'staging.void.app';
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ details_url: 'https://my-app.staging.void.app' });

    await m.onStop({ exitCode: 0, reason: 'exit' });
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({ details_url: 'https://my-app.staging.void.app' });
  });

  it('unset SITE_DOMAIN → falls back to the production {slug}.void.app', async () => {
    const { posts } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv(); // SITE_DOMAIN unset
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ details_url: 'https://my-app.void.app' });
  });

  // The status→conclusion helper (`finalizeCheckRunToStatus`) is a SEPARATE detailsUrl
  // site from the create POST + the direct finalizeCheckRun terminal sites. It is reached
  // by the pre-start prior-run finalizes and by the lost-CAS recorded-outcome path, so it
  // must be env-aware too. Exercise it via the non-identical-head pre-start branch with a
  // prior-attempt run id, and assert the PATCH links to the staging domain.
  it('staging SITE_DOMAIN → finalizeCheckRunToStatus PATCH links to the staging domain', async () => {
    vi.mocked(getBranchHeadComparisonStatus).mockResolvedValueOnce('behind');
    dbState.checkRunIds.set('b1', String(CHECK_RUN_ID)); // prior-attempt run to finalize
    const { posts, patches } = installFetch();
    const ctx = makeStubCtx();
    const env = makeEnv();
    env.SITE_DOMAIN = 'staging.void.app';
    const m = makeManager(ctx, env);

    await m.startBuild(makeConfig());

    // Cancelled before the create block → no POST; the prior run is finalized via
    // finalizeCheckRunToStatus, whose PATCH must use the staging domain.
    expect(posts).toHaveLength(0);
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toMatchObject({
      status: 'completed',
      conclusion: 'cancelled',
      details_url: 'https://my-app.staging.void.app',
    });
  });
});
