import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import {
  createGitHubConnection as createGitHubConnectionRecord,
  deleteGitHubConnection,
  getBuild,
  getGitHubConnection,
  getGitHubInstallation,
  getInstallationRevocationAt,
  getProject,
  getProjectBuilds,
  markGitHubInstallationStatus,
  setBuildCheckRunId,
  upsertGitHubInstallation,
  upsertGitHubInstallationMember,
} from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
// Namespace import so a test can spy the pre-tx `getGitHubInstallation` snapshot
// (the under-lock re-read inside the handler hits the row directly, not via this).
import * as db from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { createGitHubWebhookIngressProof } from '../../src/github/webhook-ingress-auth.ts';
import { scheduled } from '../../src/index.ts';
import internalGitHubWebhook from '../../src/routes/internal-github-webhook.ts';
import { webhookRoutes } from '../../src/routes/webhooks.ts';
import {
  builds,
  deployments,
  githubConnections,
  githubInstallations,
  projectMembers,
} from '../../src/schema.ts';
import {
  getTestGitHubInstallationMembers,
  createTestBuild,
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  recordingBuildManager,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

const WEBHOOK_SECRET = 'test-webhook-secret';
const INGRESS_SECRET = 'test-purpose-separated-ingress-secret';
const DELIVERY_ID = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

// The push handler makes a live GitHub compare call to detect a stale
// out-of-order push (`getBranchHeadComparisonStatus`). Stub the helper so tests
// never hit the network. `compareStatus` controls its return for the next push.
// The handler is fail-CLOSED: it builds ONLY when the push IS the current branch
// head ('identical') and skips every other verdict — 'ahead' (stale), 'behind'
// (branch moved backward off the sha — abandoned commit), 'diverged' (off-branch),
// and null (compare API unreachable). The default is 'identical' (the push IS the
// head) so push tests that don't exercise the gate create their build. Tests exercising
// the freshness gate set it to 'ahead'/'behind'/'diverged'/null (all skip).
let compareStatus: string | null = 'identical';
function setCompareStatus(status: string | null): void {
  compareStatus = status;
}
// Per-branch overrides. A commit can be the head of one connected branch and not
// another, which the single `compareStatus` cannot express.
let compareStatusByBranch: Record<string, string | null> | null = null;
function setCompareStatusByBranch(map: Record<string, string | null> | null): void {
  compareStatusByBranch = map;
}

// Concurrency probe for the rerun fan-out. A `check_suite` rerequest compares
// one branch head per DISTINCT branch, and GitHub drops a webhook delivery it has
// not been answered in 10s (with no automatic redelivery), so those compares must
// not be awaited in series. When armed with N, every compare call parks until N
// of them have been in flight AT ONCE. `compareConcurrencyPeak` is monotonic, so
// a serial handler tops out at 1, releases each call on the deadline, and the
// test fails on the assertion rather than hanging.
let compareInFlight = 0;
let compareConcurrencyPeak = 0;
let compareBarrierSize = 0;
function armCompareConcurrencyProbe(size: number): void {
  compareInFlight = 0;
  compareConcurrencyPeak = 0;
  compareBarrierSize = size;
}

// A one-shot side effect the compare mock runs BEFORE returning, used by the
// route test to inject a revocation that commits AFTER the push resolver's
// checks but BEFORE the supersede/create tx (the compare call sits exactly in
// that window). Consumed on first invocation so it fires once per push.
let compareSideEffect: (() => Promise<void>) | null = null;
function setCompareSideEffect(fn: (() => Promise<void>) | null): void {
  compareSideEffect = fn;
}

// The branch-delete handler re-verifies current git state via
// `getBranchExistence` before cancelling (a stale/out-of-order delete must not
// clobber a valid recreated-branch build). Stub it so tests never hit the
// network. The default is 'absent' (the branch is confirmed gone), so
// branch-delete tests cancel unless they override it.
// Tests exercising the staleness gate set 'present' (recreated) or 'unknown'
// (unconfirmed) — both must fail closed and skip cancellation.
let branchExistence: 'present' | 'absent' | 'unknown' = 'absent';
function setBranchExistence(value: 'present' | 'absent' | 'unknown'): void {
  branchExistence = value;
}

// The installation_repositories handler refetches the authoritative accessible
// repo list (`listInstallationRepositories`) on an `all`→`selected` narrowing,
// because the cached array is intentionally empty for `all` installs and the
// event delta can't reconstruct the kept set. Stub it so tests control the
// refetched set without hitting the network.
let listReposResult: {
  repositories: ReadonlyArray<{ full_name: string; id: number }>;
  owner: undefined;
  repositorySelection: 'all' | 'selected';
} = { repositories: [], owner: undefined, repositorySelection: 'selected' };
function setListReposResult(
  repositories: ReadonlyArray<{ full_name: string; id: number }>,
  repositorySelection: 'all' | 'selected' = 'selected',
): void {
  listReposResult = { repositories, owner: undefined, repositorySelection };
}

vi.mock('../../src/github/installation-token.ts', () => ({
  getBranchHeadComparisonStatus: async (
    _env: unknown,
    _installationId: unknown,
    _repo: unknown,
    _sha: unknown,
    branch?: string,
  ) => {
    if (compareBarrierSize > 1) {
      compareInFlight++;
      compareConcurrencyPeak = Math.max(compareConcurrencyPeak, compareInFlight);
      // Wait on the monotonic PEAK, not the live count: the last arrival exits
      // immediately and decrements, which would otherwise strand its peers.
      const deadline = Date.now() + 1000;
      while (compareConcurrencyPeak < compareBarrierSize && Date.now() < deadline) {
        await new Promise((r) => {
          setTimeout(r, 5);
        });
      }
      compareInFlight--;
    }
    if (compareSideEffect) {
      const fn = compareSideEffect;
      compareSideEffect = null;
      await fn();
    }
    if (compareStatusByBranch && branch !== undefined && branch in compareStatusByBranch) {
      return compareStatusByBranch[branch]!;
    }
    return compareStatus;
  },
  getBranchExistence: async () => branchExistence,
  getInstallationToken: async () => 'tok',
  // check-run.ts imports these constants from installation-token.ts; the mock
  // replaces the whole module, so re-export them or completeCheckRun's fetch URL
  // resolves to `undefined` and throws.
  GITHUB_API_BASE: 'https://api.github.com',
  GITHUB_API_VERSION: '2026-03-10',
}));

vi.mock('../../src/github/installation-repos.ts', () => ({
  listInstallationRepositories: async () => listReposResult,
}));

let env: TestEnv;

// Build a standalone app that mounts the webhook router under /webhooks with
// the same per-request `db` middleware index.ts installs, so the router is
// tested in isolation against the shared test env.
function makeApp(overrideEnv: TestEnv): { app: Hono<ApiEnv>; appEnv: TestEnv } {
  const app = new Hono<ApiEnv>();
  app.use('*', async (context, next) => {
    context.set('db', overrideEnv.db);
    await next();
  });
  app.route('/webhooks', webhookRoutes);
  app.route('/internal/github-webhook', internalGitHubWebhook);
  return { app, appEnv: overrideEnv };
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

async function clearBuildTables(db: Db): Promise<void> {
  await db.delete(builds);
  await db.delete(githubConnections);
  await db.delete(githubInstallations);
}

async function createGitHubConnection(
  db: Db,
  args: Omit<Parameters<typeof createGitHubConnectionRecord>[1], 'authorizedByUserId'> & {
    authorizedByUserId?: string;
  },
) {
  const project = await getProject(db, args.projectId);
  if (!project) {
    throw new Error('test project missing');
  }
  return createGitHubConnectionRecord(db, {
    ...args,
    authorizedByUserId: args.authorizedByUserId ?? project.user_id,
  });
}

// Seed an ACTIVE github_installations row. The push resolver
// (`getGitHubConnectionsByRepo`) INNER JOINs github_installations and
// requires status='active' plus repo membership, so every push test that
// expects a build must seed one. Mirrors the OIDC test's `seedActiveInstallation`:
// pass `repositories` for a `selected` install (membership enforced) or leave it
// empty to default to an `all`-repos install (every repo granted).
async function seedInstallation(
  db: Db,
  installationId: string,
  repositories: ReadonlyArray<{ full_name: string; id: number }> = [],
  repositorySelection: 'all' | 'selected' = repositories.length > 0 ? 'selected' : 'all',
): Promise<void> {
  await upsertGitHubInstallation(db, {
    installationId,
    userId: null,
    accountLogin: `acct-${installationId}`,
    accountId: installationId,
    accountType: 'Organization',
    repositories,
    repositorySelection,
  });
}

async function post(
  app: Hono<ApiEnv>,
  appEnv: TestEnv,
  event: string,
  payload: unknown,
  options?: { secret?: string | null; signature?: string | null; withSecret?: boolean },
): Promise<Response> {
  const body = JSON.stringify(payload);
  const withSecret = options?.withSecret ?? true;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
  };
  if (options?.signature !== undefined && options.signature !== null) {
    headers['X-Hub-Signature-256'] = options.signature;
  } else if (options?.signature !== null) {
    headers['X-Hub-Signature-256'] = await sign(options?.secret ?? WEBHOOK_SECRET, body);
  }
  // The workflow_run handler defers the best-effort "Void Build" check-run
  // completion onto `executionCtx.waitUntil` (off the webhook 2xx path). Capture
  // those promises and await them before returning so tests can assert the PATCH
  // deterministically — real Workers await waitUntil on response close; Hono
  // passes the ctx through but does not await.
  const pending: Array<Promise<unknown>> = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await app.fetch(
    new Request('http://localhost/webhooks/github', { method: 'POST', headers, body }),
    { ...appEnv, GITHUB_WEBHOOK_SECRET: withSecret ? WEBHOOK_SECRET : undefined },
    executionCtx,
  );
  await Promise.all(pending);
  return res;
}

async function postThroughIngressOperation(
  app: Hono<ApiEnv>,
  appEnv: TestEnv,
  event: string,
  payload: unknown,
  options?: {
    deliveryId?: string;
    timestampSeconds?: number;
    proofBody?: string;
    proof?: string;
    signature?: string;
  },
): Promise<Response> {
  const body = JSON.stringify(payload);
  const bodyBytes = new TextEncoder().encode(body);
  const deliveryId = options?.deliveryId ?? DELIVERY_ID;
  const timestampSeconds = options?.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const proof =
    options?.proof ??
    (await createGitHubWebhookIngressProof({
      secret: INGRESS_SECRET,
      timestampSeconds,
      deliveryId,
      event,
      body: new TextEncoder().encode(options?.proofBody ?? body),
    }));
  const response = await app.fetch(
    new Request('https://void-api.internal/internal/github-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-GitHub-Delivery': deliveryId,
        'X-Hub-Signature-256': options?.signature ?? (await sign(WEBHOOK_SECRET, body)),
        'X-Void-GitHub-Ingress-Timestamp': String(timestampSeconds),
        'X-Void-GitHub-Ingress-Proof': proof,
      },
      body: bodyBytes,
    }),
    {
      ...appEnv,
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_WEBHOOK_INGRESS_SECRET: INGRESS_SECRET,
    },
    {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  );
  return response;
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearBuildTables(env.db);
  await clearTables(env.db);
  // Default to the head verdict so push tests build.
  setCompareStatus('identical');
  setCompareStatusByBranch(null);
  armCompareConcurrencyProbe(0);
  setCompareSideEffect(null);
  // Default to 'absent' so branch-delete tests cancel.
  setBranchExistence('absent');
  // Default the refetch to an empty 'selected' result; tests that exercise the
  // all→selected refetch set their own.
  setListReposResult([], 'selected');
});

afterEach(() => {
  vi.restoreAllMocks();
  // Some check-run tests stub the global `fetch`; unstub so it never leaks.
  vi.unstubAllGlobals();
});

describe('POST /webhooks/github', () => {
  it('returns 503 when the webhook secret is unset', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {}, { withSecret: false });
    expect(res.status).toBe(503);
  });

  it('returns 401 on a bad signature', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(
      app,
      appEnv,
      'push',
      { ref: 'refs/heads/main' },
      {
        signature: 'sha256=deadbeef',
      },
    );
    expect(res.status).toBe(401);
  });

  it('rejects an invalid or expired ingress proof before webhook processing', async () => {
    const { app, appEnv } = makeApp(env);
    const invalid = await postThroughIngressOperation(
      app,
      appEnv,
      'push',
      {},
      {
        proof: `sha256=${'0'.repeat(64)}`,
      },
    );
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({ error: 'invalid ingress proof' });

    const expired = await postThroughIngressOperation(
      app,
      appEnv,
      'push',
      {},
      {
        timestampSeconds: Math.floor(Date.now() / 1000) - 301,
      },
    );
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: 'invalid ingress proof' });
  });

  it('binds the ingress proof to the exact body and still verifies GitHub independently', async () => {
    const { app, appEnv } = makeApp(env);
    const mutated = await postThroughIngressOperation(
      app,
      appEnv,
      'push',
      { value: 2 },
      {
        proofBody: JSON.stringify({ value: 1 }),
      },
    );
    expect(mutated.status).toBe(401);
    expect(await mutated.json()).toEqual({ error: 'invalid ingress proof' });

    const invalidGitHub = await postThroughIngressOperation(
      app,
      appEnv,
      'push',
      {},
      {
        signature: `sha256=${'0'.repeat(64)}`,
      },
    );
    expect(invalidGitHub.status).toBe(401);
    expect(await invalidGitHub.json()).toEqual({ error: 'invalid signature' });
  });

  it('creates a container build row and pokes the scheduler on a matching push', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-container');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '5551',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');

    // Spy on the scheduler namespace to assert the poke is dispatched and does
    // not throw (the test env's BUILD_SCHEDULER is a mock namespace).
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 5551 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; buildIds: ReadonlyArray<string> };
    expect(json.ok).toBe(true);
    expect(json.buildIds).toHaveLength(1);

    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build).not.toBeNull();
    expect(build!.executor).toBe('container');
    expect(build!.status).toBe('queued');
    expect(build!.commit_sha).toBe('abc1234');
    expect(build!.branch).toBe('main');
    expect(build!.project_id).toBe(project.id);
    expect(build!.user_id).toBe(user.id);
    // The owner is a free-plan user (createTestUser default), so the build's
    // container size is resolved + persisted at enqueue as the free class.
    expect(build!.instance_type).toBe('standard-3');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [pokeUrl, pokeInit] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(pokeUrl).toContain('/poke');
    expect(pokeInit.method).toBe('POST');
  });

  it("persists a paid owner's container size (standard-4) on the build row at enqueue", async () => {
    // The connection owner is a paid plan (pro), so the push handler resolves the
    // owner's plan and stamps the large container size on the row at enqueue —
    // before the scheduler ever runs — making it the persisted size-of-record.
    const user = await createTestUser(env.db, 'paid-owner', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, user.id, 'wh-paid');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '556',
      repoFullName: 'octo/paid',
      repositoryId: '5561',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '556');
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'paid123',
      installation: { id: 556 },
      repository: { full_name: 'octo/paid', id: 5561 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);

    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.executor).toBe('container');
    expect(build!.user_id).toBe(user.id);
    // pro plan → standard-4, stamped at enqueue.
    expect(build!.instance_type).toBe('standard-4');
  });

  it('ignores a stale push whose sha is behind the branch head (compare === ahead)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-stale-push');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');
    const { app, appEnv } = makeApp(env);

    // The live branch head is AHEAD of this push's sha — an older push delivered
    // out-of-order after a newer one. Building it would roll the project back.
    setCompareStatus('ahead');

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'oldsha1',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'push is not the current branch head',
    });
    // No build row was created for the stale commit.
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(0);
  });

  it('builds a push whose sha IS the branch head (compare === identical)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-head-push');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '5552',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    // The push's sha IS the live head — proceed and build it.
    setCompareStatus('identical');

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'headsha1',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 5552 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.commit_sha).toBe('headsha1');
    expect(build!.status).toBe('queued');
  });

  it('ignores a push when the branch head was moved backward off the sha (compare === behind), leaving the queued build intact', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-behind-push');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');
    const existing = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
      commitSha: 'newer-queued',
      branch: 'main',
    });
    const { app, appEnv } = makeApp(env);

    // The branch head is BEHIND this push's sha — i.e. the branch was moved
    // BACKWARD off `after` (force-push / rollback), so `after` is an abandoned
    // commit the owner moved away from. Definitively not the head; skip it.
    setCompareStatus('behind');

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abandonedsha',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'push is not the current branch head',
    });
    // No new build row, and the pre-existing queued build is left intact.
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(1);
    const stillQueued = await getBuild(env.db, existing.id);
    expect(stillQueued!.status).toBe('queued');
    expect(stillQueued!.commit_sha).toBe('newer-queued');
  });

  it('ignores a push when the compare API is unreachable (compare === null), leaving the queued build intact', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-null-push');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');
    // An existing queued build (e.g. from a newer push) that must NOT be
    // superseded by this unverifiable older delivery.
    const existing = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
      commitSha: 'newer-queued',
      branch: 'main',
    });
    const { app, appEnv } = makeApp(env);

    // Compare API unreachable — cannot confirm freshness, so fail closed.
    setCompareStatus(null);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'unverifiable',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'push is not the current branch head',
    });
    // No new build row for the unverifiable push.
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(1);
    // The pre-existing queued build is untouched (not superseded/cancelled).
    const stillQueued = await getBuild(env.db, existing.id);
    expect(stillQueued!.status).toBe('queued');
    expect(stillQueued!.commit_sha).toBe('newer-queued');
  });

  it('ignores a push whose sha is off-branch (compare === diverged), leaving the queued build intact', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-diverged-push');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');
    const existing = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
      commitSha: 'newer-queued',
      branch: 'main',
    });
    const { app, appEnv } = makeApp(env);

    // The pushed sha was force-pushed away — it is off the branch's history.
    setCompareStatus('diverged');

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'orphansha',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'push is not the current branch head',
    });
    // No new build row, and the pre-existing queued build is left intact.
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(1);
    const stillQueued = await getBuild(env.db, existing.id);
    expect(stillQueued!.status).toBe('queued');
    expect(stillQueued!.commit_sha).toBe('newer-queued');
  });

  it('ignores a push to a non-connected branch (no build row)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-branch');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '555');
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/feature',
      after: 'abc1234',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(0);
  });

  it('does not create a build for github_actions executor on push', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-actions');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '777',
      repoFullName: 'octo/actions-repo',
      repositoryId: '886845',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '777');
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'def5678',
      installation: { id: 777 },
      repository: { full_name: 'octo/actions-repo', id: 886_845 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { executor?: string }).toMatchObject({
      executor: 'github_actions',
    });
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(0);
  });

  it('skips a branch-delete push (all-zero after sha)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-delete');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '555',
      repoFullName: 'octo/repo',
      repositoryId: '715167',
      branch: 'main',
      buildExecutor: 'container',
    });
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 555 },
      repository: { full_name: 'octo/repo', id: 715_167 },
    });

    expect(res.status).toBe(200);
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(0);
  });

  it('upserts an installation on installation:created', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9001,
        account: { login: 'octo-org', id: 42, type: 'Organization' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo-org/site', id: 1 }],
    });

    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9001');
    expect(installation).not.toBeNull();
    expect(installation!.account_login).toBe('octo-org');
    expect(installation!.account_id).toBe('42');
    expect(installation!.account_type).toBe('Organization');
    expect(installation!.status).toBe('active');
    expect(installation!.repositories).toEqual([{ full_name: 'octo-org/site', id: 1 }]);
    expect(installation!.repository_selection).toBe('selected');
  });

  it('records repository_selection=all on an all-repos install', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9011,
        account: { login: 'octo-all', id: 11, type: 'Organization' },
        repository_selection: 'all',
      },
      // An all-repos install does not enumerate repositories.
      repositories: [],
    });

    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9011');
    expect(installation!.repository_selection).toBe('all');
    expect(installation!.repositories).toEqual([]);
  });

  it('marks an installation deleted on installation:deleted', async () => {
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9002, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    const res = await post(app, appEnv, 'installation', {
      action: 'deleted',
      installation: { id: 9002 },
    });
    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9002');
    expect(installation!.status).toBe('deleted');
  });

  it('does NOT reactivate a deleted installation from a stale/redelivered created', async () => {
    // A genuine reinstall gets a NEW installation_id, so a `created` that
    // conflicts with an existing row is always a stale replay. After `deleted`,
    // it must stay `deleted` — otherwise the connection resolvers (which gate
    // only on status='active') would resume minting deploy tokens for an App the
    // user removed.
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9020, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    await post(app, appEnv, 'installation', { action: 'deleted', installation: { id: 9020 } });
    // Redelivered original `created` arrives after the delete.
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9020,
        account: { login: 'octo', id: 7, type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo/site', id: 1 }],
    });
    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9020');
    expect(installation!.status).toBe('deleted');
  });

  it('does NOT reactivate a suspended installation from a stale/redelivered created', async () => {
    // Only `installation.unsuspend` may clear a suspension; a stale `created`
    // must leave it `suspended`.
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9021, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    await post(app, appEnv, 'installation', { action: 'suspend', installation: { id: 9021 } });
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9021, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9021');
    expect(installation!.status).toBe('suspended');
    // And a real unsuspend still clears it.
    await post(app, appEnv, 'installation', { action: 'unsuspend', installation: { id: 9021 } });
    const after = await getGitHubInstallation(env.db, '9021');
    expect(after!.status).toBe('active');
  });

  it('does NOT roll back the repo cache from a stale/redelivered created', async () => {
    // A redelivered ORIGINAL `created` (ids are never reused, so a conflicting
    // `created` is always stale) must not overwrite repo membership the
    // authoritative `installation_repositories` handler has since advanced.
    const { app, appEnv } = makeApp(env);
    // Genuine first install: selected, [A].
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9030,
        account: { login: 'octo', id: 7, type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo/a', id: 1 }],
    });
    // User adds B → the authoritative handler advances the cache to [A, B].
    await post(app, appEnv, 'installation_repositories', {
      action: 'added',
      installation: { id: 9030 },
      repositories_added: [{ full_name: 'octo/b', id: 2 }],
      repositories_removed: [],
      repository_selection: 'selected',
    });
    expect(
      (await getGitHubInstallation(env.db, '9030'))!.repositories.map((r) => r.id).sort(),
    ).toEqual([1, 2]);
    // Redelivered ORIGINAL created (only [A]) — must NOT roll the cache back to [A].
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9030,
        account: { login: 'octo', id: 7, type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo/a', id: 1 }],
    });
    expect(res.status).toBe(200);
    const after = await getGitHubInstallation(env.db, '9030');
    expect(after!.repositories.map((r) => r.id).sort()).toEqual([1, 2]);
    expect(after!.repository_selection).toBe('selected');
  });

  it('does NOT downgrade an all selection from a stale/redelivered created that says selected', async () => {
    const { app, appEnv } = makeApp(env);
    // Install is `all` (covers every repo).
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9031,
        account: { login: 'octo', id: 7, type: 'User' },
        repository_selection: 'all',
      },
      repositories: [],
    });
    // Redelivered original created carrying `selected` must not downgrade the row
    // (which would silently restrict coverage to the payload's repos).
    const res = await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9031,
        account: { login: 'octo', id: 7, type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo/a', id: 1 }],
    });
    expect(res.status).toBe(200);
    expect((await getGitHubInstallation(env.db, '9031'))!.repository_selection).toBe('all');
  });

  it('does NOT revive a deleted installation from a stale/redelivered unsuspend', async () => {
    // unsuspend is guarded to the suspended->active transition only. A stale
    // unsuspend landing after a later `deleted` must leave the row terminal,
    // else the resolvers (status='active' only) would re-grant deploys.
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9022, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    await post(app, appEnv, 'installation', { action: 'suspend', installation: { id: 9022 } });
    await post(app, appEnv, 'installation', { action: 'deleted', installation: { id: 9022 } });
    // Redelivered unsuspend arrives after the delete.
    const res = await post(app, appEnv, 'installation', {
      action: 'unsuspend',
      installation: { id: 9022 },
    });
    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9022');
    expect(installation!.status).toBe('deleted');
  });

  it('does NOT let a stale suspend walk a deleted install back to suspended (then unsuspend)', async () => {
    // The harder chain: suspend -> deleted -> STALE suspend -> STALE unsuspend.
    // The stale suspend must NOT rewrite deleted->suspended, else the stale
    // unsuspend's suspended->active guard would re-arm and revive the removed App.
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9023, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [],
    });
    await post(app, appEnv, 'installation', { action: 'suspend', installation: { id: 9023 } });
    await post(app, appEnv, 'installation', { action: 'deleted', installation: { id: 9023 } });
    // Redelivered suspend lands after the delete — must be a no-op on the terminal row.
    await post(app, appEnv, 'installation', { action: 'suspend', installation: { id: 9023 } });
    expect((await getGitHubInstallation(env.db, '9023'))!.status).toBe('deleted');
    // A following stale unsuspend therefore still finds no `suspended` row to revive.
    await post(app, appEnv, 'installation', { action: 'unsuspend', installation: { id: 9023 } });
    expect((await getGitHubInstallation(env.db, '9023'))!.status).toBe('deleted');
  });

  it('applies the repository delta on installation_repositories', async () => {
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: { id: 9003, account: { login: 'octo', id: 7, type: 'User' } },
      repositories: [
        { full_name: 'octo/a', id: 1 },
        { full_name: 'octo/b', id: 2 },
      ],
    });

    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'added',
      installation: { id: 9003 },
      repositories_added: [{ full_name: 'octo/c', id: 3 }],
      repositories_removed: [{ full_name: 'octo/a', id: 1 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9003');
    const ids = installation!.repositories.map((r) => r.id).sort();
    expect(ids).toEqual([2, 3]);
    expect(installation!.repository_selection).toBe('selected');
  });

  it('updates repository_selection when the install flips to all', async () => {
    const { app, appEnv } = makeApp(env);
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9004,
        account: { login: 'octo', id: 8, type: 'User' },
        repository_selection: 'selected',
      },
      repositories: [{ full_name: 'octo/a', id: 1 }],
    });

    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'added',
      installation: { id: 9004 },
      repositories_added: [],
      repositories_removed: [],
      repository_selection: 'all',
    });

    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9004');
    expect(installation!.repository_selection).toBe('all');
  });

  // When an `all` install is narrowed to `selected`, the cached `repositories`
  // array is empty by design, so applying the event's removed/added delta to it would persist
  // `selected` with NO kept repos — silently breaking builds for repos the user
  // kept. The handler must instead REFETCH the authoritative accessible set.
  it('refetches the repo list when an all install narrows to selected', async () => {
    const { app, appEnv } = makeApp(env);
    // Seed an `all` install: selection='all', empty cache (what GitHub delivers).
    await post(app, appEnv, 'installation', {
      action: 'created',
      installation: {
        id: 9005,
        account: { login: 'octo', id: 9, type: 'User' },
        repository_selection: 'all',
      },
      repositories: [],
    });

    // The authoritative post-narrowing set the refetch returns: the user kept
    // octo/keep1 + octo/keep2 (neither appears in the delta below).
    setListReposResult([
      { full_name: 'octo/keep1', id: 11 },
      { full_name: 'octo/keep2', id: 22 },
    ]);

    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 9005 },
      repositories_added: [],
      repositories_removed: [{ full_name: 'octo/dropped', id: 99 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    const installation = await getGitHubInstallation(env.db, '9005');
    expect(installation!.repository_selection).toBe('selected');
    // The kept repos come from the REFETCH, not the empty-cache delta (which
    // would have produced []).
    const ids = installation!.repositories.map((r) => r.id).sort((a, b) => a - b);
    expect(ids).toEqual([11, 22]);
  });

  // A STALE all→selected delivery arriving after the user already switched the
  // App back to `all`. The refetch authoritatively reports `all`, so
  // every repo is still covered — the stale `repositories_removed` must NOT cancel
  // the in-flight build for a still-covered repo (that would revoke a valid token
  // + tear down a valid container).
  it('does not cancel builds when a stale all→selected refetch reports all', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'stale-all-narrow');
    await seedInstallation(env.db, '9006', [], 'all');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9006',
      repoFullName: 'octo/still-covered',
      repositoryId: '9601',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-stale',
      branch: 'main',
    });

    // The user already flipped back to `all`, so the authoritative refetch says
    // `all` (with no enumerated repos).
    setListReposResult([], 'all');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 9006 },
      repositories_added: [],
      // Stale delta naming the still-covered repo.
      repositories_removed: [{ full_name: 'octo/still-covered', id: 9601 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    // Authoritative selection wins: stored as `all`, not the stale `selected`.
    const installation = await getGitHubInstallation(env.db, '9006');
    expect(installation!.repository_selection).toBe('all');
    // The build is NOT cancelled — under `all` the repo is still covered. (The
    // `selection === 'all'` guard takes the early return BEFORE the revocation
    // tx, so no DO cancel is attempted either.)
    const after = await getBuild(env.db, build.id);
    expect(after!.status).toBe('building');
  });

  it('completes a seeded actions build on workflow_run:completed (success)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-wfr');
    // The workflow_run handler resolves the build by mapping the payload repo
    // (installation + full_name) to a connected project first, so a matching
    // connection must exist.
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '321',
      repoFullName: 'octo/wfr',
      repositoryId: '855536',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '321');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    // The build links to the deployment via commit sha — stamp the deployment
    // commit to match the workflow head sha.
    await env.db
      .update(deployments)
      .set({ commit: 'sha-success' })
      .where(eq(deployments.id, deployment.id));

    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-success',
      branch: 'main',
      githubRunId: '123456',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 321 },
      repository: { full_name: 'octo/wfr', id: 855_536 },
      workflow_run: { id: 123_456, run_attempt: 1, conclusion: 'success', head_sha: 'sha-success' },
    });

    expect(res.status).toBe(200);
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('complete');
    expect(updated!.deployment_id).toBe(deployment.id);
    expect(updated!.completed_at).not.toBeNull();
  });

  it('fails a seeded actions build on workflow_run:completed (failure)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-wfr-fail');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '322',
      repoFullName: 'octo/wfr-fail',
      repositoryId: '871475',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '322');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-fail',
      branch: 'main',
      githubRunId: '654321',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 322 },
      repository: { full_name: 'octo/wfr-fail', id: 871_475 },
      workflow_run: { id: 654_321, run_attempt: 1, conclusion: 'failure', head_sha: 'sha-fail' },
    });

    expect(res.status).toBe(200);
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.deployment_id).toBeNull();
  });

  it('ignores a workflow_run:completed without run_attempt (build unchanged)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-wfr-no-attempt');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '323',
      repoFullName: 'octo/wfr-no-attempt',
      repositoryId: '871476',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '323');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-no-attempt',
      branch: 'main',
      githubRunId: '654322',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 323 },
      repository: { full_name: 'octo/wfr-no-attempt', id: 871_476 },
      workflow_run: { id: 654_322, conclusion: 'success', head_sha: 'sha-no-attempt' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'missing workflow_run run_attempt' });
    const unchanged = await getBuild(env.db, build.id);
    expect(unchanged!.status).toBe('building');
    expect(unchanged!.completed_at).toBeNull();
  });

  // github_actions builds have no BuildManager DO, so the "Void Build" check run
  // created at OIDC-exchange time is finalized HERE, on workflow_run:completed.
  // A successful run PATCHes the run to completed/success.
  it('completes the "Void Build" check run on workflow_run:completed (success)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-check-ok');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '331',
      repoFullName: 'octo/check-ok',
      repositoryId: '766742',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '331');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-check-ok',
      branch: 'main',
      githubRunId: '424250',
      githubRunAttempt: '1',
    });
    await setBuildCheckRunId(env.db, build.id, '5001');

    // getInstallationToken is module-mocked (returns 'tok'), so completeCheckRun's
    // only network call is the PATCH — capture it.
    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: 5001 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 331 },
      repository: { full_name: 'octo/check-ok', id: 766_742 },
      workflow_run: {
        id: 424_250,
        run_attempt: 1,
        conclusion: 'success',
        head_sha: 'sha-check-ok',
      },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('complete');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('/repos/octo/check-ok/check-runs/5001');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string) as { status: string; conclusion: string };
    expect(body.status).toBe('completed');
    expect(body.conclusion).toBe('success');
  });

  // A failed run PATCHes the run to completed/failure.
  it('completes the "Void Build" check run on workflow_run:completed (failure)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-check-fail');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '332',
      repoFullName: 'octo/check-fail',
      repositoryId: '739072',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '332');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-check-fail',
      branch: 'main',
      githubRunId: '424251',
      githubRunAttempt: '1',
    });
    await setBuildCheckRunId(env.db, build.id, '5002');

    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: 5002 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 332 },
      repository: { full_name: 'octo/check-fail', id: 739_072 },
      workflow_run: {
        id: 424_251,
        run_attempt: 1,
        conclusion: 'failure',
        head_sha: 'sha-check-fail',
      },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('failed');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('/repos/octo/check-fail/check-runs/5002');
    const body = JSON.parse(init.body as string) as { conclusion: string };
    expect(body.conclusion).toBe('failure');
  });

  // No check_run_id (create failed, or a build predating the column) => the
  // completion is a no-op: no PATCH is attempted, and the build still finalizes.
  it('does not PATCH a check run when the build has no check_run_id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-check-none');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '333',
      repoFullName: 'octo/check-none',
      repositoryId: '811598',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '333');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-check-none',
      branch: 'main',
      githubRunId: '424252',
      githubRunAttempt: '1',
    });
    // No setBuildCheckRunId — check_run_id stays NULL.

    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({}),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 333 },
      repository: { full_name: 'octo/check-none', id: 811_598 },
      workflow_run: {
        id: 424_252,
        run_attempt: 1,
        conclusion: 'success',
        head_sha: 'sha-check-none',
      },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('complete');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The completion is best-effort: even if completeCheckRun throws, the webhook
  // must still return 2xx and the build must still be finalized.
  it('still returns 2xx and finalizes the build when completeCheckRun throws', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-check-throw');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '334',
      repoFullName: 'octo/check-throw',
      repositoryId: '870692',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '334');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-check-throw',
      branch: 'main',
      githubRunId: '424253',
      githubRunAttempt: '1',
    });
    await setBuildCheckRunId(env.db, build.id, '5003');

    // completeCheckRun is designed never to throw, but the handler wraps it
    // defensively; force a throw to prove that guard holds.
    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi
      .spyOn(checkRunModule, 'completeCheckRun')
      .mockRejectedValue(new Error('check-run PATCH exploded'));
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(app, appEnv, 'workflow_run', {
        action: 'completed',
        installation: { id: 334 },
        repository: { full_name: 'octo/check-throw', id: 870_692 },
        workflow_run: {
          id: 424_253,
          run_attempt: 1,
          conclusion: 'success',
          head_sha: 'sha-check-throw',
        },
      });

      expect(res.status).toBe(200);
      expect((await getBuild(env.db, build.id))!.status).toBe('complete');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  // The check reflects GitHub's RUN outcome, so completion is driven from the
  // workflow_run conclusion INDEPENDENT of our internal build-status CAS. Ten
  // out-of-band paths (push-supersede, OIDC latest-wins, disconnect, app/repo
  // removal, teardown, reaper, ...) can drive the build terminal WITHOUT touching
  // its check; GitHub still fires workflow_run:completed (even for a run it
  // cancelled via concurrency). A workflow_run for an ALREADY-TERMINAL build that
  // carries a check_run_id must STILL PATCH the check — otherwise it stays
  // stranded `in_progress` forever. Also exercises the widened conclusion mapping
  // (cancelled → 'cancelled').
  it('completes the "Void Build" check run even when the build is already terminal', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-check-terminal');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '335',
      repoFullName: 'octo/check-terminal',
      repositoryId: '796140',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '335');
    // Seed the build ALREADY terminal (an out-of-band cancel won the race before
    // the completion webhook arrived) but carrying a check_run_id.
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'cancelled',
      commitSha: 'sha-check-terminal',
      branch: 'main',
      githubRunId: '424260',
      githubRunAttempt: '1',
    });
    await setBuildCheckRunId(env.db, build.id, '5010');

    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: 5010 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 335 },
      repository: { full_name: 'octo/check-terminal', id: 796_140 },
      workflow_run: {
        id: 424_260,
        run_attempt: 1,
        conclusion: 'cancelled',
        head_sha: 'sha-check-terminal',
      },
    });

    expect(res.status).toBe(200);
    // The DB row stays terminal — the CAS no-ops on an already-terminal build.
    expect((await getBuild(env.db, build.id))!.status).toBe('cancelled');

    // ...but the check was STILL PATCHed to the mapped conclusion.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('/repos/octo/check-terminal/check-runs/5010');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string) as { status: string; conclusion: string };
    expect(body.status).toBe('completed');
    expect(body.conclusion).toBe('cancelled');
  });

  it('still terminalizes the actions build when the deployment lookup throws (slot-pin fix)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-wfr-lookupthrow');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '323',
      repoFullName: 'octo/wfr-throw',
      repositoryId: '823577',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '323');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ commit: 'sha-throw' })
      .where(eq(deployments.id, deployment.id));
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-throw',
      branch: 'main',
      githubRunId: '777777',
      githubRunAttempt: '1',
    });

    // A transient Hyperdrive/Postgres failure on the deployment lookup must NOT
    // skip the terminal write — else the build stays ACTIVE, keeps honoring its
    // deploy token, and pins the user's slot until the hourly reaper.
    const dbModule = await import('../../src/db.ts');
    const spy = vi
      .spyOn(dbModule, 'getDeploymentByProjectAndCommit')
      .mockRejectedValue(new Error('Hyperdrive transient 500'));
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(app, appEnv, 'workflow_run', {
        action: 'completed',
        installation: { id: 323 },
        repository: { full_name: 'octo/wfr-throw', id: 823_577 },
        workflow_run: { id: 777_777, run_attempt: 1, conclusion: 'success', head_sha: 'sha-throw' },
      });

      expect(res.status).toBe(200);
      const updated = await getBuild(env.db, build.id);
      // Terminalized (slot released, token revoked) despite the failed lookup...
      expect(updated!.status).toBe('complete');
      // ...just without the deployment link.
      expect(updated!.deployment_id).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // A GitHub `run_id` is unique only WITHIN a repository, so a workflow_run
  // webhook for repo X must NEVER finalize repo Y's build that happens to share
  // the numeric run_id. The handler resolves the build scoped to the connected
  // project of the payload's repository.
  // ---------------------------------------------------------------------------

  it('does not finalize another project build that shares the run_id', async () => {
    const user = await createTestUser(env.db);
    const projectX = await createTestProject(env.db, user.id, 'wh-collide-x');
    const projectY = await createTestProject(env.db, user.id, 'wh-collide-y');
    await createGitHubConnection(env.db, {
      projectId: projectX.id,
      installationId: '900',
      repoFullName: 'octo/x',
      repositoryId: '872525',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: projectY.id,
      installationId: '901',
      repoFullName: 'octo/y',
      repositoryId: '894906',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '900');
    await seedInstallation(env.db, '901');

    // Both projects have an in-flight build for the SAME run_id.
    const buildX = await createTestBuild(env.db, {
      projectId: projectX.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-x',
      branch: 'main',
      githubRunId: '500',
      githubRunAttempt: '1',
    });
    const buildY = await createTestBuild(env.db, {
      projectId: projectY.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-y',
      branch: 'main',
      githubRunId: '500',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    // A workflow_run for repo X must finalize ONLY buildX, leaving buildY alone.
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 900 },
      repository: { full_name: 'octo/x', id: 872_525 },
      workflow_run: { id: 500, run_attempt: 1, conclusion: 'failure', head_sha: 'sha-x' },
    });

    expect(res.status).toBe(200);
    const updatedX = await getBuild(env.db, buildX.id);
    const updatedY = await getBuild(env.db, buildY.id);
    expect(updatedX!.status).toBe('failed');
    expect(updatedY!.status).toBe('building');
  });

  // ---------------------------------------------------------------------------
  // One repo can back MULTIPLE github_actions projects (matrix / multiple
  // --project jobs sharing one run_id+attempt, distinct project_ids). GitHub
  // fires workflow_run:completed ONCE, so the handler must finalize EVERY
  // matching build — not stop at the first connection — or the other projects'
  // builds stay ACTIVE until the 60m reaper.
  // ---------------------------------------------------------------------------

  it('finalizes EVERY active build sharing a run_id across projects on one repo', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'wh-wfr-multi-a');
    const projectB = await createTestProject(env.db, user.id, 'wh-wfr-multi-b');
    // Two github_actions connections on the SAME repo + installation.
    await createGitHubConnection(env.db, {
      projectId: projectA.id,
      installationId: '960',
      repoFullName: 'octo/multi',
      repositoryId: '960960',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: projectB.id,
      installationId: '960',
      repoFullName: 'octo/multi',
      repositoryId: '960960',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '960', [{ full_name: 'octo/multi', id: 960_960 }]);

    // Each project has its OWN live deployment at the workflow head sha, so each
    // build links to its OWN deployment (resolved per-candidate).
    const deploymentA = await createTestDeployment(env.db, projectA.id, 'live');
    const deploymentB = await createTestDeployment(env.db, projectB.id, 'live');
    await env.db
      .update(deployments)
      .set({ commit: 'sha-multi' })
      .where(eq(deployments.id, deploymentA.id));
    await env.db
      .update(deployments)
      .set({ commit: 'sha-multi' })
      .where(eq(deployments.id, deploymentB.id));

    // Both projects have an ACTIVE build sharing ONE run_id (different project_id).
    const buildA = await createTestBuild(env.db, {
      projectId: projectA.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-multi',
      branch: 'main',
      githubRunId: '960',
      githubRunAttempt: '1',
    });
    const buildB = await createTestBuild(env.db, {
      projectId: projectB.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-multi',
      branch: 'main',
      githubRunId: '960',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 960 },
      repository: { full_name: 'octo/multi', id: 960_960 },
      workflow_run: { id: 960, run_attempt: 1, conclusion: 'success', head_sha: 'sha-multi' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; buildIds: ReadonlyArray<string> };
    expect(body.buildIds).toHaveLength(2);
    expect([...body.buildIds].sort()).toEqual([buildA.id, buildB.id].sort());

    // BOTH builds are finalized, each linked to its OWN deployment.
    const updatedA = await getBuild(env.db, buildA.id);
    const updatedB = await getBuild(env.db, buildB.id);
    expect(updatedA!.status).toBe('complete');
    expect(updatedB!.status).toBe('complete');
    expect(updatedA!.deployment_id).toBe(deploymentA.id);
    expect(updatedB!.deployment_id).toBe(deploymentB.id);
  });

  // ---------------------------------------------------------------------------
  // A RERUN of a completed run produces a NEW active build alongside the
  // prior terminal row (same project + run_id, incremented run_attempt). The
  // workflow_run webhook for the rerun (run_attempt 2) must finalize the ACTIVE
  // rerun build, not re-touch the old terminal row.
  // ---------------------------------------------------------------------------

  it('finalizes the active rerun build, not the prior terminal row, for a re-run', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rerun');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '950',
      repoFullName: 'octo/rerun',
      repositoryId: '889911',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '950');

    // Prior attempt 1 for run 800, already terminal.
    const terminal = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'failed',
      commitSha: 'sha-old',
      branch: 'main',
      githubRunId: '800',
      githubRunAttempt: '1',
    });
    // The rerun: a fresh ACTIVE build for the SAME run_id, attempt 2.
    const rerun = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-new',
      branch: 'main',
      githubRunId: '800',
      githubRunAttempt: '2',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 950 },
      repository: { full_name: 'octo/rerun', id: 889_911 },
      workflow_run: { id: 800, run_attempt: 2, conclusion: 'success', head_sha: 'sha-new' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; buildIds: ReadonlyArray<string> };
    // The webhook resolved and finalized the active rerun build.
    expect(body.buildIds).toEqual([rerun.id]);
    const updatedRerun = await getBuild(env.db, rerun.id);
    expect(updatedRerun!.status).toBe('complete');
    expect(updatedRerun!.completed_at).not.toBeNull();
    // The old terminal row is untouched (still failed).
    const updatedTerminal = await getBuild(env.db, terminal.id);
    expect(updatedTerminal!.status).toBe('failed');
  });

  // ---------------------------------------------------------------------------
  // Rerun-correctness — a redelivered/late completion for attempt 1 must NOT
  // finalize attempt 2's ACTIVE build (matched by run_attempt) NOR re-finalize
  // attempt 1's already-terminal row (the update is conditional on ACTIVE). It
  // resolves to the terminal attempt-1 row and is ignored as already-terminal.
  // ---------------------------------------------------------------------------

  it('a redelivered attempt-1 completion leaves attempt-2 ACTIVE and does not re-finalize attempt-1', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rerun-redeliver');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '951',
      repoFullName: 'octo/redeliver',
      repositoryId: '874787',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '951');

    // Attempt 1 for run 801, already terminal (failed).
    const attempt1 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'failed',
      commitSha: 'sha-a1',
      branch: 'main',
      githubRunId: '801',
      githubRunAttempt: '1',
    });
    // Attempt 2 for the SAME run_id, currently ACTIVE.
    const attempt2 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-a2',
      branch: 'main',
      githubRunId: '801',
      githubRunAttempt: '2',
    });

    const { app, appEnv } = makeApp(env);
    // A late/redelivered completion for ATTEMPT 1 (conclusion success).
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 951 },
      repository: { full_name: 'octo/redeliver', id: 874_787 },
      workflow_run: { id: 801, run_attempt: 1, conclusion: 'success', head_sha: 'sha-a1' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'build already terminal',
    });

    // Attempt 2 is untouched — still ACTIVE (building).
    const updated2 = await getBuild(env.db, attempt2.id);
    expect(updated2!.status).toBe('building');
    expect(updated2!.completed_at).toBeNull();
    // Attempt 1 is unchanged — still failed, not resurrected/refinalized.
    const updated1 = await getBuild(env.db, attempt1.id);
    expect(updated1!.status).toBe('failed');
  });

  it('ignores a workflow_run for a repo with no connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-no-conn');
    // A build exists for the run_id, but the payload repo maps to no connection.
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-z',
      branch: 'main',
      githubRunId: '600',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 999 },
      repository: { full_name: 'octo/unknown', id: 881_839 },
      workflow_run: { id: 600, run_attempt: 1, conclusion: 'success', head_sha: 'sha-z' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
  });

  // ---------------------------------------------------------------------------
  // Connection resolution keys on the IMMUTABLE repository id. A push or
  // workflow_run whose full_name now matches but whose repository.id differs
  // from the connected id (a deleted-and-recreated repo reusing the name) must
  // NOT deploy; a renamed repo (same id, new full_name) must still resolve.
  // ---------------------------------------------------------------------------

  it('ignores a push whose full_name matches but repository.id differs (name reuse)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-id-mismatch');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '610',
      repoFullName: 'octo/repo',
      repositoryId: '100',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '610');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 610 },
      // Same name, DIFFERENT immutable id.
      repository: { full_name: 'octo/repo', id: 999 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    expect((await env.db.select().from(builds)).length).toBe(0);
  });

  it('creates a build for a renamed repo by its immutable id (same id, new full_name)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-renamed');
    // Connection stores the OLD name but the immutable id is unchanged.
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '611',
      repoFullName: 'octo/old-name',
      repositoryId: '100',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '611');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'def5678',
      installation: { id: 611 },
      // The NEW name but the SAME immutable id.
      repository: { full_name: 'octo/new-name', id: 100 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.project_id).toBe(project.id);
  });

  // ---------------------------------------------------------------------------
  // A repository_id-matched push whose payload full_name differs from the
  // stored name must self-heal the stored repo_full_name, so the container build
  // fetches the source tarball from the correct (renamed) repo.
  // ---------------------------------------------------------------------------

  it('self-heals the stored repo_full_name on a renamed-repo push', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-selfheal');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '620',
      repoFullName: 'octo/old',
      repositoryId: '555',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '620');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 620 },
      // Same immutable id, NEW name.
      repository: { full_name: 'octo/new', id: 555 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);

    // The stored name was healed to the new full_name.
    const healed = await getGitHubConnection(env.db, project.id);
    expect(healed!.repo_full_name).toBe('octo/new');
  });

  // Resolution keys on the immutable repository id only: a connection sharing the
  // repo name but recording a different id is not matched (a recreated/reused
  // name could otherwise deploy to the wrong project).
  it('does not match a connection by name when the push carries a different repository id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-null-id');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '650',
      repoFullName: 'octo/legacy',
      repositoryId: '722400',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '650');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    // Push for the SAME name but bearing an immutable id — must not match.
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'leg0001',
      installation: { id: 650 },
      repository: { full_name: 'octo/legacy', id: 12_345 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    // No build was created for the unmatched connection.
    expect((await env.db.select().from(builds)).length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // A repo may back multiple projects (only project_id is unique). A push
  // must build every connection whose branch matches, and only those.
  // ---------------------------------------------------------------------------

  it('routes a push to the matching-branch project when two projects share a repo', async () => {
    const user = await createTestUser(env.db);
    const projectMain = await createTestProject(env.db, user.id, 'wh-multi-main');
    const projectDev = await createTestProject(env.db, user.id, 'wh-multi-dev');
    // main connection created first; develop connection created second.
    await createGitHubConnection(env.db, {
      projectId: projectMain.id,
      installationId: '630',
      repoFullName: 'octo/shared',
      repositoryId: '777',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: projectDev.id,
      installationId: '630',
      repoFullName: 'octo/shared',
      repositoryId: '777',
      branch: 'develop',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '630');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/develop',
      after: 'dev0001',
      installation: { id: 630 },
      repository: { full_name: 'octo/shared', id: 777 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds?: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);

    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(1);
    expect(rows[0].project_id).toBe(projectDev.id);
  });

  it('fans out a push to every same-branch connection when two projects share a repo', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'wh-fanout-a');
    const projectB = await createTestProject(env.db, user.id, 'wh-fanout-b');
    await createGitHubConnection(env.db, {
      projectId: projectA.id,
      installationId: '640',
      repoFullName: 'octo/fan',
      repositoryId: '888',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: projectB.id,
      installationId: '640',
      repoFullName: 'octo/fan',
      repositoryId: '888',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '640');

    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'fan0001',
      installation: { id: 640 },
      repository: { full_name: 'octo/fan', id: 888 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds?: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(2);

    const rows = await env.db.select().from(builds);
    const projectIds = rows.map((r) => r.project_id).sort();
    expect(projectIds).toEqual([projectA.id, projectB.id].sort());
  });

  it('does not finalize a workflow_run whose repository.id differs from the connected id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-wfr-id-mismatch');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '612',
      repoFullName: 'octo/repo',
      repositoryId: '100',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '612');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-x',
      branch: 'main',
      githubRunId: '700',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 612 },
      // Same name, DIFFERENT immutable id => resolves no connection.
      repository: { full_name: 'octo/repo', id: 999 },
      workflow_run: { id: 700, run_attempt: 1, conclusion: 'success', head_sha: 'sha-x' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    // The build is untouched — still building.
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
  });

  // The push resolver is revocation-aware. A delayed/redelivered
  // signed push that arrives AFTER the App is suspended/uninstalled (or the repo
  // dropped from a `selected` install) must resolve no connection and build
  // nothing, even within the installation-token cache window.
  it('ignores a push for a SUSPENDED installation (no build)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-f23-1-susp');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '7301',
      repoFullName: 'octo/susp',
      repositoryId: '764776',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '7301');
    await markGitHubInstallationStatus(env.db, '7301', 'suspended');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 7301 },
      repository: { full_name: 'octo/susp', id: 764_776 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    expect((await env.db.select().from(builds)).length).toBe(0);
  });

  it('ignores a push for a DELETED installation (no build)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-f23-1-del');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '7302',
      repoFullName: 'octo/del',
      repositoryId: '873576',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '7302');
    await markGitHubInstallationStatus(env.db, '7302', 'deleted');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 7302 },
      repository: { full_name: 'octo/del', id: 873_576 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    expect((await env.db.select().from(builds)).length).toBe(0);
  });

  it('ignores a push for a repo NOT in a selected install (no build)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-f23-1-sel');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '7303',
      repoFullName: 'octo/dropped',
      repositoryId: '73',
      branch: 'main',
      buildExecutor: 'container',
    });
    // A 'selected' install whose cached set does NOT include this repo.
    await seedInstallation(env.db, '7303', [{ full_name: 'octo/other', id: 7399 }], 'selected');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 7303 },
      repository: { full_name: 'octo/dropped', id: 73 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ignored?: string }).toMatchObject({
      ignored: 'no matching connection',
    });
    expect((await env.db.select().from(builds)).length).toBe(0);
  });

  it('builds a push for an ACTIVE install whose repo IS a member (happy path)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-f23-1-ok');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '7304',
      repoFullName: 'octo/member',
      repositoryId: '74',
      branch: 'main',
      buildExecutor: 'container',
    });
    // A 'selected' install whose cached set INCLUDES this repo by id.
    await seedInstallation(env.db, '7304', [{ full_name: 'octo/member', id: 74 }], 'selected');

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'abc1234',
      installation: { id: 7304 },
      repository: { full_name: 'octo/member', id: 74 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.status).toBe('queued');
    expect(build!.commit_sha).toBe('abc1234');
  });

  it('returns 2xx and ignores an unknown event', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'star', { action: 'created' });
    expect(res.status).toBe(200);
  });

  it('returns 2xx for a pull_request stub event', async () => {
    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'pull_request', { action: 'opened' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Pushes must be idempotent and latest-wins:
//   * a newer push supersedes older STILL-QUEUED builds for the same
//     project+branch (so the newest commit deploys, not whichever finishes last)
//   * a webhook redelivery for a commit already in flight must NOT double-build
//   * an already-RUNNING build for an OLDER commit IS superseded too:
//     leaving it active would keep a live deploy token (it could publish a stale
//     commit) and pin a concurrency slot
// ---------------------------------------------------------------------------

describe('POST /webhooks/github — push idempotency + latest-wins', () => {
  // A scheduler poke that always succeeds, so the handler reaches its return.
  // The BUILD_MANAGER records `cancelBuild` RPCs so superseded ACTIVE container
  // builds can be asserted to have had their DO torn down.
  function pokeApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const { namespace, cancelledIds } = recordingBuildManager();
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_MANAGER: namespace,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);
    return { app, appEnv, cancelledIds };
  }

  async function pushCommit(
    app: Hono<ApiEnv>,
    appEnv: TestEnv,
    after: string,
  ): Promise<{ buildId: string }> {
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after,
      installation: { id: 700 },
      repository: { full_name: 'octo/idem', id: 70 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { buildIds: ReadonlyArray<string> };
    // Each push here creates or reuses exactly one build.
    expect(body.buildIds).toHaveLength(1);
    return { buildId: body.buildIds[0] };
  }

  it('newer push supersedes the older queued build; redelivery dedups; running IS cancelled', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-idem');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    const { app, appEnv, cancelledIds } = pokeApp();

    // Push commit aaa -> a queued build is created.
    const first = await pushCommit(app, appEnv, 'aaa');
    expect(first.buildId).toBeTruthy();
    const buildAaa = await getBuild(env.db, first.buildId);
    expect(buildAaa!.status).toBe('queued');
    expect(buildAaa!.commit_sha).toBe('aaa');

    // Latest-wins: push commit bbb -> the aaa build is superseded (cancelled)
    // and a new bbb build is queued.
    const second = await pushCommit(app, appEnv, 'bbb');
    expect(second.buildId).not.toBe(first.buildId);
    const supersededAaa = await getBuild(env.db, first.buildId);
    expect(supersededAaa!.status).toBe('cancelled');
    expect(supersededAaa!.error).toBe('superseded by newer push');
    const buildBbb = await getBuild(env.db, second.buildId);
    expect(buildBbb!.status).toBe('queued');
    expect(buildBbb!.commit_sha).toBe('bbb');

    // Redelivery dedup: pushing bbb again reuses the in-flight build, creating
    // none. Same buildId is returned and the total build count is unchanged.
    const beforeCount = (await env.db.select().from(builds)).length;
    const redeliver = await pushCommit(app, appEnv, 'bbb');
    expect(redeliver.buildId).toBe(second.buildId);
    const afterCount = (await env.db.select().from(builds)).length;
    expect(afterCount).toBe(beforeCount);

    // A running build for an OLDER commit IS cancelled. Flip bbb to
    // building, then push a new commit ccc. The building bbb build is superseded
    // (cancelled) — revoking its deploy token + freeing its slot — and its DO is
    // torn down via the cancelBuild RPC; a new ccc build is queued.
    await env.db.update(builds).set({ status: 'building' }).where(eq(builds.id, second.buildId));
    const third = await pushCommit(app, appEnv, 'ccc');
    expect(third.buildId).not.toBe(second.buildId);
    const supersededBbb = await getBuild(env.db, second.buildId);
    expect(supersededBbb!.status).toBe('cancelled');
    expect(supersededBbb!.error).toBe('superseded by newer push');
    expect(cancelledIds).toContain(second.buildId);
    const buildCcc = await getBuild(env.db, third.buildId);
    expect(buildCcc!.status).toBe('queued');
    expect(buildCcc!.commit_sha).toBe('ccc');
  });

  it('keeps a valid ingress delivery idempotent through the existing push pipeline', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-ingress-idem');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '701',
      repoFullName: 'octo/ingress-idem',
      repositoryId: '71',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '701');
    const { app, appEnv } = pokeApp();
    const payload = {
      ref: 'refs/heads/main',
      after: 'ingress-sha',
      installation: { id: 701 },
      repository: { full_name: 'octo/ingress-idem', id: 71 },
    };

    const first = await postThroughIngressOperation(app, appEnv, 'push', payload);
    const second = await postThroughIngressOperation(app, appEnv, 'push', payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json<{ buildIds: ReadonlyArray<string> }>();
    const secondBody = await second.json<{ buildIds: ReadonlyArray<string> }>();
    expect(firstBody.buildIds).toHaveLength(1);
    expect(secondBody.buildIds).toEqual(firstBody.buildIds);
    expect(
      (await env.db.select().from(builds)).filter((build) => build.project_id === project.id),
    ).toHaveLength(1);
  });

  it('redelivery after the commit already COMPLETED reuses the build (no re-enqueue)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-idem-complete');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    const { app, appEnv } = pokeApp();

    // Push commit xxx -> a queued build is created, then mark it complete AND make
    // it the project's LIVE deployment (the deploy succeeded and xxx is what is
    // currently live). A redelivery of the same push must NOT re-enqueue a build
    // for an already-deployed, still-live commit.
    const first = await pushCommit(app, appEnv, 'xxx');
    const depXxx = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(builds)
      .set({ status: 'complete', deployment_id: depXxx.id })
      .where(eq(builds.id, first.buildId));

    const beforeCount = (await env.db.select().from(builds)).length;
    const redeliver = await pushCommit(app, appEnv, 'xxx');
    expect(redeliver.buildId).toBe(first.buildId);
    const afterCount = (await env.db.select().from(builds)).length;
    expect(afterCount).toBe(beforeCount);
    // Still exactly one build for this project+branch, still complete.
    const rows = await env.db.select().from(builds).where(eq(builds.project_id, project.id));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('complete');
  });

  it('re-pushing a commit after a FAILED build enqueues a new build (failed does not block)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-idem-failed');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    const { app, appEnv } = pokeApp();

    // Push commit yyy -> a queued build is created, then mark it failed. A
    // re-push of the same commit must retry with a NEW queued build.
    const first = await pushCommit(app, appEnv, 'yyy');
    await env.db.update(builds).set({ status: 'failed' }).where(eq(builds.id, first.buildId));

    const second = await pushCommit(app, appEnv, 'yyy');
    expect(second.buildId).not.toBe(first.buildId);
    const retried = await getBuild(env.db, second.buildId);
    expect(retried!.status).toBe('queued');
    expect(retried!.commit_sha).toBe('yyy');
    // The failed build is untouched (not superseded — only QUEUED rows are).
    expect((await getBuild(env.db, first.buildId))!.status).toBe('failed');
  });

  // A force-push ROLLBACK to a previously-deployed (still `complete`) SHA
  // that the project is NOT currently live on must RE-DEPLOY it: a fresh queued
  // build is enqueued (the old `complete` build is NOT reused), so the project
  // actually returns to the rolled-back commit. A newer in-flight build for the
  // now-off-branch commit must still be cancelled and its DO torn down — it would
  // otherwise keep a live deploy token and publish the stale newer commit.
  it('rollback to a complete SHA that is not live RE-DEPLOYS it AND cancels a newer in-flight build', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rollback');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    // B1: a previously-deployed commit C1, already `complete`.
    const b1 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'C1',
      branch: 'main',
    });
    // The project is now LIVE on a NEWER deployment (depB, commit C2) — NOT C1.
    await createTestDeployment(env.db, project.id, 'live', undefined, undefined, { commit: 'C2' });
    // B2: a NEWER in-flight build for C2 on the same project+branch (the commit
    // the branch advanced to, now being rolled back away from).
    const b2 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'C2',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = pokeApp();

    // The rollback push: the branch head is now C1 again ('identical' default),
    // so the freshness gate lets it through. C1 is NOT the live deployment, so a
    // FRESH queued C1 build is enqueued (B1 not reused) and B2 is cancelled.
    const rollback = await pushCommit(app, appEnv, 'C1');
    // A NEW C1 build was created (not B1 reused), and the response carries its id.
    expect(rollback.buildId).not.toBe(b1.id);
    const fresh = await getBuild(env.db, rollback.buildId);
    expect(fresh!.status).toBe('queued');
    expect(fresh!.commit_sha).toBe('C1');
    // B1 is left intact (complete builds are never terminalized by supersede).
    expect((await getBuild(env.db, b1.id))!.status).toBe('complete');

    // B2 is cancelled (its token revoked) and its DO torn down.
    const cancelledB2 = await getBuild(env.db, b2.id);
    expect(cancelledB2!.status).toBe('cancelled');
    expect(cancelledB2!.error).toBe('superseded by newer push');
    expect(cancelledIds).toContain(b2.id);
  });

  // Genuine redelivery: when the pushed complete SHA IS the project's
  // current live deployment, reuse it (no new build).
  it('redelivery of a complete SHA that is currently live reuses it (no re-enqueue)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rollback-live');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    // The project is LIVE on depA, and B1 (complete C1) is linked to depA.
    const depA = await createTestDeployment(env.db, project.id, 'live', undefined, undefined, {
      commit: 'C1',
    });
    const b1 = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'C1',
      branch: 'main',
    });
    await env.db.update(builds).set({ deployment_id: depA.id }).where(eq(builds.id, b1.id));

    const { app, appEnv } = pokeApp();

    const beforeCount = (await env.db.select().from(builds)).length;
    const redeliver = await pushCommit(app, appEnv, 'C1');
    expect(redeliver.buildId).toBe(b1.id);
    const afterCount = (await env.db.select().from(builds)).length;
    expect(afterCount).toBe(beforeCount);
  });

  // The supersede helper returns `{ build: null, skipped: 'config-changed' }`
  // when a concurrent PATCH /projects/:id/github changed the connection's
  // branch/executor first. That null is db-layer-authoritative (see db-builds
  // tests); here we confirm that on the normal (non-skip) path a matching push
  // still enqueues a build and returns its id.
  it('push still returns a build id on the normal (non-skipped) path (caller)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-f23-2-caller');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '700',
      repoFullName: 'octo/idem',
      repositoryId: '70',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '700');

    const { app, appEnv } = pokeApp();
    const res = await pushCommit(app, appEnv, 'zzz');
    const build = await getBuild(env.db, res.buildId);
    expect(build!.status).toBe('queued');
    expect(build!.commit_sha).toBe('zzz');
  });
});

// Orphaned-queued-build path: the webhook push handler pokes
// BUILD_SCHEDULER best-effort after inserting the row, and the DO lets its alarm
// lapse on an empty queue. If that poke fails the row would sit `queued` with no
// alarm to drain it. The hourly cron tier must re-arm the scheduler whenever a
// container build is still queued. The mockController has `cron === undefined`
// (not FAST_CRON), so scheduled() runs the hourly tier.
describe('scheduled() re-arms BUILD_SCHEDULER for orphaned queued builds', () => {
  const mockController = {} as ScheduledController;
  const mockCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  // Build the full hourly-tier bindings from the shared test env, overriding
  // BUILD_SCHEDULER with a fetch spy so we can assert the poke. CRON_FIRES_QUEUE
  // isn't on TestEnv, so stub it inline (scheduled() doesn't exercise it here).
  function makeBindings(pokeFetch: ReturnType<typeof vi.fn>): ApiEnv['Bindings'] {
    return {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: pokeFetch }),
      } as unknown as DurableObjectNamespace,
      CRON_FIRES_QUEUE: {
        send: async () => {},
        sendBatch: async () => {},
      },
    } as unknown as ApiEnv['Bindings'];
  }

  it('pokes the scheduler when a container build is queued but the poke was missed', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-reaper');
    // Simulate the webhook having inserted the row but its poke having failed:
    // the row is queued, yet no alarm was armed.
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
      commitSha: 'sha-orphan',
      branch: 'main',
    });

    const pokeFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );

    await scheduled(mockController, makeBindings(pokeFetch), mockCtx);

    expect(pokeFetch).toHaveBeenCalledTimes(1);
    const [pokeUrl, pokeInit] = pokeFetch.mock.calls[0]! as [string, RequestInit];
    expect(pokeUrl).toContain('/poke');
    expect(pokeInit.method).toBe('POST');
  });

  it('does not poke the scheduler when no container build is queued', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-no-reaper');
    // A non-queued container build and a queued github_actions build must NOT
    // trigger the reaper — only queued container builds are scheduler-drained.
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-running',
      branch: 'main',
    });
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'queued',
      commitSha: 'sha-actions',
      branch: 'main',
    });

    const pokeFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );

    await scheduled(mockController, makeBindings(pokeFetch), mockCtx);

    expect(pokeFetch).not.toHaveBeenCalled();
  });

  it('does not throw if the scheduler poke fails (isolated from the rest of the tick)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-reaper-fail');
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
      commitSha: 'sha-orphan2',
      branch: 'main',
    });

    const pokeFetch = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error('DO transport failure');
    });

    await expect(
      scheduled(mockController, makeBindings(pokeFetch), mockCtx),
    ).resolves.toBeUndefined();
    expect(pokeFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The hourly tier must reap GitHub Actions builds stuck ACTIVE far past
// any plan's build timeout. A missed workflow_run completion (or a disconnect
// mid-run) would otherwise pin a concurrency slot forever. Container builds are
// handled by their own DO timeout and must NOT be reaped here.
// ---------------------------------------------------------------------------

describe('scheduled() reaps over-age active github_actions builds', () => {
  const mockController = {} as ScheduledController;
  const mockCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  function makeBindings(): ApiEnv['Bindings'] {
    return {
      ...env,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: async () => Response.json({ ok: true }) }),
      } as unknown as DurableObjectNamespace,
      CRON_FIRES_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    } as unknown as ApiEnv['Bindings'];
  }

  // Backdate a build's created_at so it falls outside the reaper's max-age.
  async function ageBuild(buildId: string, minutesAgo: number): Promise<void> {
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - (${minutesAgo} * interval '1 minute')` })
      .where(eq(builds.id, buildId));
  }

  it('fails an over-age active github_actions build', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-stale-actions');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-stale',
      branch: 'main',
      githubRunId: '900',
    });
    // Older than the 60-minute reaper threshold.
    await ageBuild(build.id, 90);

    await scheduled(mockController, makeBindings(), mockCtx);

    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('failed');
    expect(updated!.completed_at).not.toBeNull();
  });

  it('does not reap a recent active github_actions build', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-fresh-actions');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-fresh',
      branch: 'main',
      githubRunId: '901',
    });
    // Only 5 minutes old — well within any plan's build timeout.
    await ageBuild(build.id, 5);

    await scheduled(mockController, makeBindings(), mockCtx);

    expect((await getBuild(env.db, build.id))!.status).toBe('building');
  });

  it('does not reap an over-age active container build (DO timeout owns those)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-stale-container');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-c',
      branch: 'main',
    });
    await ageBuild(build.id, 120);

    await scheduled(mockController, makeBindings(), mockCtx);

    expect((await getBuild(env.db, build.id))!.status).toBe('building');
  });
});

// ---------------------------------------------------------------------------
// App removal/suspension and repo-removal must revoke in-flight builds.
// Terminalizing a build row (→ cancelled) revokes its deploy token (the
// middleware guard rejects a token whose bound build is no longer active), and
// active CONTAINER builds also get a best-effort `cancelBuild` DO RPC.
// ---------------------------------------------------------------------------

describe('POST /webhooks/github — revoke builds on App removal', () => {
  // Build an app whose env carries a recording BUILD_MANAGER so DO-cancel RPCs
  // can be asserted. `post` spreads appEnv into the request env, so the handler
  // sees this BUILD_MANAGER.
  function recordingApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const { namespace, cancelledIds } = recordingBuildManager();
    const overrideEnv: TestEnv = { ...env, BUILD_MANAGER: namespace };
    const { app, appEnv } = makeApp(overrideEnv);
    return { app, appEnv, cancelledIds };
  }

  it('cancels in-flight builds and stops the container DO on installation:deleted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-1-del');
    await seedInstallation(env.db, '8001');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8001',
      repoFullName: 'octo/del',
      repositoryId: '873576',
      branch: 'main',
      buildExecutor: 'container',
    });
    const container = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-del',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation', {
      action: 'deleted',
      installation: { id: 8001 },
    });

    expect(res.status).toBe(200);
    const updated = await getBuild(env.db, container.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('github app uninstalled');
    // Active container build got the DO cancel RPC.
    expect(cancelledIds).toContain(container.id);
    // The installation status was flipped too.
    expect((await getGitHubInstallation(env.db, '8001'))!.status).toBe('deleted');
  });

  it('cancels in-flight builds on installation:suspend (both executors)', async () => {
    const user = await createTestUser(env.db);
    const containerProject = await createTestProject(env.db, user.id, 'f18-1-susp-c');
    const actionsProject = await createTestProject(env.db, user.id, 'f18-1-susp-a');
    await seedInstallation(env.db, '8002');
    await createGitHubConnection(env.db, {
      projectId: containerProject.id,
      installationId: '8002',
      repoFullName: 'octo/susp-c',
      repositoryId: '8201',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: actionsProject.id,
      installationId: '8002',
      repoFullName: 'octo/susp-a',
      repositoryId: '8202',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const container = await createTestBuild(env.db, {
      projectId: containerProject.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-susp-c',
      branch: 'main',
    });
    const actions = await createTestBuild(env.db, {
      projectId: actionsProject.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-susp-a',
      branch: 'main',
      githubRunId: '82000',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation', {
      action: 'suspend',
      installation: { id: 8002 },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, container.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, container.id))!.error).toBe('github app suspended');
    expect((await getBuild(env.db, actions.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, actions.id))!.error).toBe('github app suspended');
    // Only the container build has a DO; actions builds are skipped.
    expect(cancelledIds).toEqual([container.id]);
    expect((await getGitHubInstallation(env.db, '8002'))!.status).toBe('suspended');
  });

  it('cancels only the removed repo build on installation_repositories:removed', async () => {
    const user = await createTestUser(env.db);
    const removedProject = await createTestProject(env.db, user.id, 'f18-1-rm-removed');
    const keptProject = await createTestProject(env.db, user.id, 'f18-1-rm-kept');
    await seedInstallation(env.db, '8003');
    await createGitHubConnection(env.db, {
      projectId: removedProject.id,
      installationId: '8003',
      repoFullName: 'octo/removed',
      repositoryId: '8301',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: keptProject.id,
      installationId: '8003',
      repoFullName: 'octo/kept',
      repositoryId: '8302',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const removedBuild = await createTestBuild(env.db, {
      projectId: removedProject.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-rm',
      branch: 'main',
    });
    const keptBuild = await createTestBuild(env.db, {
      projectId: keptProject.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-keep',
      branch: 'main',
      githubRunId: '83000',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 8003 },
      repositories_added: [],
      repositories_removed: [{ full_name: 'octo/removed', id: 8301 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    // The removed repo's build is cancelled with the right reason + DO RPC.
    const updatedRemoved = await getBuild(env.db, removedBuild.id);
    expect(updatedRemoved!.status).toBe('cancelled');
    expect(updatedRemoved!.error).toBe('repository removed from github app');
    expect(cancelledIds).toContain(removedBuild.id);
    // The non-removed repo's build under the same installation stays active.
    expect((await getBuild(env.db, keptBuild.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(keptBuild.id);
  });

  it('does NOT downgrade an all install or revoke builds on a stale selected removal that missed a concurrent widen', async () => {
    // A stale `installation_repositories:removed` delivery that
    // says `selected` arrives AFTER the install was widened to `all`. Its pre-tx
    // snapshot still read `selected`, so the `all`→`selected` refetch gate never
    // fired (refetched === null). The handler must decide the persisted selection
    // from the row re-read UNDER the lock — keeping `all` — and must NOT revoke the
    // build for the "removed" repo, which `all` still covers.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f-stale-narrow');
    // The REAL (committed) row is `all`.
    await seedInstallation(env.db, '8009', [], 'all');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8009',
      repoFullName: 'octo/keep',
      repositoryId: '8901',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-stale-narrow',
      branch: 'main',
    });

    // Force the handler's pre-tx snapshot to read `selected` while the committed
    // row stays `all`, reproducing the missed-concurrent-widen interleave. The
    // under-lock re-read inside the handler still hits the real `all` row. One-shot:
    // the test's later assertions read the real row.
    const realRow = await getGitHubInstallation(env.db, '8009');
    const spy = vi
      .spyOn(db, 'getGitHubInstallation')
      .mockResolvedValueOnce({ ...realRow!, repository_selection: 'selected' });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 8009 },
      repositories_added: [],
      repositories_removed: [{ full_name: 'octo/keep', id: 8901 }],
      repository_selection: 'selected',
    });
    spy.mockRestore();

    expect(res.status).toBe(200);
    // (a) The stale `selected` did NOT downgrade the locked `all` selection.
    expect((await getGitHubInstallation(env.db, '8009'))!.repository_selection).toBe('all');
    // (b) The still-covered repo's in-flight build was NOT revoked.
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(build.id);
  });

  it('does NOT cancel builds on installation:unsuspend', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-1-unsusp');
    await seedInstallation(env.db, '8004');
    await env.db
      .update(githubInstallations)
      .set({ status: 'suspended' })
      .where(eq(githubInstallations.installation_id, '8004'));
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8004',
      repoFullName: 'octo/unsusp',
      repositoryId: '763767',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-unsusp',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation', {
      action: 'unsuspend',
      installation: { id: 8004 },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([]);
    expect((await getGitHubInstallation(env.db, '8004'))!.status).toBe('active');
  });

  it('does NOT cancel builds on installation_repositories:added (no removals)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-1-added');
    await seedInstallation(env.db, '8005');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8005',
      repoFullName: 'octo/added',
      repositoryId: '8501',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-added',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'added',
      installation: { id: 8005 },
      repositories_added: [{ full_name: 'octo/another', id: 8502 }],
      repositories_removed: [],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A push supersedes stale active github_actions builds for the same
// branch whose commit is NOT the new head, so an older in-flight Actions build
// can't keep a live deploy token after a newer push. Same-commit (already
// exchanged OIDC for the new head) and cross-branch builds are spared.
// ---------------------------------------------------------------------------

describe('POST /webhooks/github — supersede stale actions builds on push', () => {
  it('supersedes an active actions build for an older commit on the pushed branch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-2-supersede');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8101',
      repoFullName: 'octo/sup',
      repositoryId: '8601',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '8101');
    const stale = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'c1',
      branch: 'main',
      githubRunId: '86001',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c2',
      installation: { id: 8101 },
      repository: { full_name: 'octo/sup', id: 8601 },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { executor?: string }).toMatchObject({
      executor: 'github_actions',
    });
    const updated = await getBuild(env.db, stale.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('superseded by newer push');
    // No new build row was created (actions builds self-create via OIDC).
    const rows = await env.db.select().from(builds);
    expect(rows.length).toBe(1);
  });

  it('spares an active actions build whose commit IS the new head', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-2-same-commit');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8102',
      repoFullName: 'octo/same',
      repositoryId: '8602',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '8102');
    // A build that already exchanged OIDC for the new head commit c2.
    const fresh = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'c2',
      branch: 'main',
      githubRunId: '86002',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c2',
      installation: { id: 8102 },
      repository: { full_name: 'octo/same', id: 8602 },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, fresh.id))!.status).toBe('building');
  });

  it('spares an active actions build on a different branch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-2-cross-branch');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8103',
      repoFullName: 'octo/cross',
      repositoryId: '8603',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '8103');
    // An active build on a DIFFERENT branch (dev) must not be superseded by a
    // push to main.
    const devBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'devsha',
      branch: 'dev',
      githubRunId: '86003',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'mainsha',
      installation: { id: 8103 },
      repository: { full_name: 'octo/cross', id: 8603 },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, devBuild.id))!.status).toBe('building');
  });
});

// ---------------------------------------------------------------------------
// The CONTAINER analog of the actions-build case: a push supersedes stale ACTIVE
// container builds for the same branch whose commit is NOT the new head, so an
// older in-flight container build can't keep a live deploy token (publishing a
// stale commit) or pin a concurrency slot. Its BuildManager DO is torn down via
// the cancelBuild RPC. Same-commit (a redelivery race that already exchanged for
// the new head) and cross-branch builds are spared.
// ---------------------------------------------------------------------------

describe('POST /webhooks/github — supersede stale container builds on push', () => {
  // A scheduler poke that always succeeds + a recording BUILD_MANAGER so DO
  // cancels of superseded active container builds can be asserted.
  function recordingPokeApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const { namespace, cancelledIds } = recordingBuildManager();
    const pokeEnv: TestEnv = {
      ...env,
      BUILD_MANAGER: namespace,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: fetchSpy }),
      } as unknown as DurableObjectNamespace,
    };
    const { app, appEnv } = makeApp(pokeEnv);
    return { app, appEnv, cancelledIds };
  }

  it('supersedes an active container build for an older commit + tears down its DO', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-1-supersede');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9101',
      repoFullName: 'octo/csup',
      repositoryId: '9601',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9101');
    const stale = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'c1',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingPokeApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c2',
      installation: { id: 9101 },
      repository: { full_name: 'octo/csup', id: 9601 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; buildIds: ReadonlyArray<string> };
    expect(json.ok).toBe(true);
    expect(json.buildIds).toHaveLength(1);
    // The older active build is cancelled (token revoked + slot freed) and its
    // DO was torn down.
    const updated = await getBuild(env.db, stale.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('superseded by newer push');
    expect(cancelledIds).toContain(stale.id);
    // A new queued build for c2 was created.
    const fresh = await getBuild(env.db, json.buildIds[0]);
    expect(fresh!.status).toBe('queued');
    expect(fresh!.commit_sha).toBe('c2');
  });

  it('spares an active container build whose commit IS the new head (exceptCommitSha)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-1-same-commit');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9102',
      repoFullName: 'octo/csame',
      repositoryId: '9602',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9102');
    // A build already in flight for the new head commit c2 (a redelivery race).
    const fresh = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'c2',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingPokeApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c2',
      installation: { id: 9102 },
      repository: { full_name: 'octo/csame', id: 9602 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    // Same-commit in-flight build is REUSED (dedup), not cancelled, and no DO
    // teardown happened.
    expect(json.buildIds).toEqual([fresh.id]);
    expect((await getBuild(env.db, fresh.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(fresh.id);
  });

  it('spares an active container build on a different branch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-1-cross-branch');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9103',
      repoFullName: 'octo/ccross',
      repositoryId: '9603',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9103');
    // An active build on a DIFFERENT branch (dev) must not be superseded by a
    // push to main.
    const devBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'devsha',
      branch: 'dev',
    });

    const { app, appEnv, cancelledIds } = recordingPokeApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'mainsha',
      installation: { id: 9103 },
      repository: { full_name: 'octo/ccross', id: 9603 },
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, devBuild.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(devBuild.id);
  });

  it('same-commit redelivery of a building build reuses it (no cancel, no DO teardown)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-1-redeliver');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9104',
      repoFullName: 'octo/credeliver',
      repositoryId: '9604',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9104');
    const building = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'c5',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingPokeApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c5',
      installation: { id: 9104 },
      repository: { full_name: 'octo/credeliver', id: 9604 },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    // The same-commit building build is reused, not self-cancelled.
    expect(json.buildIds).toEqual([building.id]);
    expect((await getBuild(env.db, building.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(building.id);
    // No extra build row was created.
    const rows = await env.db.select().from(builds).where(eq(builds.project_id, project.id));
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The supersede/create tx re-checks installation status under the
// connection lock. The push resolver sees an ACTIVE install, but a revocation
// commits in the LATER window (after the resolver, before the build tx). The
// compare mock fires a side effect that suspends the install in exactly that
// window, so the in-tx re-check catches it: no container build is enqueued.
// ---------------------------------------------------------------------------

describe('POST /webhooks/github — in-tx install re-check', () => {
  it('does not enqueue a container build when the install is revoked between the resolver and the build tx', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f25-1-late-revoke');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9201',
      repoFullName: 'octo/late',
      repositoryId: '9701',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9201');

    // The resolver runs FIRST (install still active), then the compare call —
    // whose mock suspends the install — then the supersede/create tx, whose
    // in-tx re-check now sees the suspended status and fails closed.
    setCompareSideEffect(async () => {
      await markGitHubInstallationStatus(env.db, '9201', 'suspended');
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c9',
      installation: { id: 9201 },
      repository: { full_name: 'octo/late', id: 9701 },
    });

    // The push loop tolerates a null build: no build ids, github_actions early-out.
    expect(res.status).toBe(200);
    expect(await getProjectBuilds(env.db, project.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The supersede/create tx asserts the LOCKED connection is the SAME row
// the push resolver matched. `project_id` is UNIQUE, so a disconnect+reconnect to
// a different repo (same branch/executor, and crucially the SAME installation_id +
// repository_id) DELETEs the old row and CREATEs a new one with a fresh id between
// the resolver and the build tx. The install re-check keys on the PASSED
// installationId, so a same-install swap PASSES it — the id-match is the only
// guard that catches it. The compare mock performs the swap in exactly that
// window, so the resolved connection.id no longer matches: no build is enqueued.
// ---------------------------------------------------------------------------

describe('POST /webhooks/github — in-tx connection id assertion', () => {
  it('does not enqueue a container build when the connection is replaced between the resolver and the build tx', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f26-2-replaced');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9201',
      repoFullName: 'octo/swap',
      repositoryId: '9702',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '9201');

    // The resolver matches the OLD connection, then the compare call's mock swaps
    // it for a fresh row (same project/install/repo/branch, new id) — proving the
    // install re-check does NOT catch it — then the supersede/create tx's
    // in-tx id-match sees the new id and fails closed.
    setCompareSideEffect(async () => {
      await deleteGitHubConnection(env.db, project.id);
      await createGitHubConnection(env.db, {
        projectId: project.id,
        installationId: '9201',
        repoFullName: 'octo/swap',
        repositoryId: '9702',
        branch: 'main',
        buildExecutor: 'container',
      });
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: 'c26',
      installation: { id: 9201 },
      repository: { full_name: 'octo/swap', id: 9702 },
    });

    // The push loop tolerates a null build: no build ids, github_actions early-out.
    expect(res.status).toBe(200);
    expect(await getProjectBuilds(env.db, project.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Repo removal must match the IMMUTABLE repository_id, not the mutable
// repo_full_name. A rename-then-remove leaves the connection holding the OLD
// name while the payload carries the current name + immutable id, so a name-only
// match would miss it and leave the in-flight build active. Legacy rows with a
// null repository_id still fall back to the name match.
// ---------------------------------------------------------------------------

describe('POST /webhooks/github — repo removal matches immutable repository_id', () => {
  function recordingApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const { namespace, cancelledIds } = recordingBuildManager();
    const overrideEnv: TestEnv = { ...env, BUILD_MANAGER: namespace };
    const { app, appEnv } = makeApp(overrideEnv);
    return { app, appEnv, cancelledIds };
  }

  it('cancels a build for a renamed-then-removed repo via its immutable id', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-2-renamed');
    await seedInstallation(env.db, '9201');
    // The connection still holds the OLD name (a rename happened); the immutable
    // id matches the payload.
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9201',
      repoFullName: 'octo/old',
      repositoryId: '8401',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-renamed',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 9201 },
      repositories_added: [],
      // The payload carries the CURRENT name (octo/new) + the immutable id.
      repositories_removed: [{ full_name: 'octo/new', id: 8401 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('repository removed from github app');
    expect(cancelledIds).toContain(build.id);
  });

  it('spares a connection whose repository_id is NOT in the removed set', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f19-2-kept');
    await seedInstallation(env.db, '9203');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '9203',
      repoFullName: 'octo/kept',
      repositoryId: '8403',
      branch: 'main',
      buildExecutor: 'container',
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-kept',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'installation_repositories', {
      action: 'removed',
      installation: { id: 9203 },
      repositories_added: [],
      // A DIFFERENT repo's id is removed; the kept connection must stay active.
      repositories_removed: [{ full_name: 'octo/other', id: 8499 }],
      repository_selection: 'selected',
    });

    expect(res.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(build.id);
  });
});

// ---------------------------------------------------------------------------
// Workflow_run completion uses a CAS (`markBuildTerminalIfActive`) so a
// concurrent terminalizer that flipped the row to cancelled between the ACTIVE
// guard and the write is never clobbered. A build already terminal at write
// time is ignored, and no deployment is linked to it.
// ---------------------------------------------------------------------------

describe('POST /webhooks/github — CAS workflow_run completion', () => {
  it('ignores a workflow_run for a build already cancelled (CAS no-op)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-3-cancelled');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8201',
      repoFullName: 'octo/cas',
      repositoryId: '791148',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '8201');
    // A deployment exists for the head sha — confirm it is NOT linked to the
    // cancelled build by the ignored completion.
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await env.db
      .update(deployments)
      .set({ commit: 'sha-cas' })
      .where(eq(deployments.id, deployment.id));
    // Seed the build ALREADY cancelled (a concurrent terminalizer won the race).
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'cancelled',
      commitSha: 'sha-cas',
      branch: 'main',
      githubRunId: '87001',
      githubRunAttempt: '1',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(app, appEnv, 'workflow_run', {
      action: 'completed',
      installation: { id: 8201 },
      repository: { full_name: 'octo/cas', id: 791_148 },
      workflow_run: { id: 87_001, run_attempt: 1, conclusion: 'success', head_sha: 'sha-cas' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'build already terminal' });
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.deployment_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A branch-delete push (all-zero `after`) has no source to build, but an
// in-flight build for the DELETED branch still holds a live deploy token (the
// guard revokes a token only once its bound build is no longer active), so
// it could keep publishing the deleted branch's SHA until its token TTL / the
// reaper. The push handler terminalizes those builds (scoped to the deleted
// branch + this repo) and tears down their container DOs, mirroring the App
// removal / repo-removal revocation paths. Other branches and terminal builds
// are left untouched.
// ---------------------------------------------------------------------------

describe('POST /webhooks/github — revoke builds on branch delete', () => {
  function recordingApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const { namespace, cancelledIds } = recordingBuildManager();
    const overrideEnv: TestEnv = { ...env, BUILD_MANAGER: namespace };
    const { app, appEnv } = makeApp(overrideEnv);
    return { app, appEnv, cancelledIds };
  }

  it('cancels an in-flight container build for the deleted branch + tears down its DO', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-del');
    await seedInstallation(env.db, '8601', [{ full_name: 'octo/del-branch', id: 8611 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8601',
      repoFullName: 'octo/del-branch',
      repositoryId: '8611',
      branch: 'main',
      buildExecutor: 'container',
    });
    const inflight = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-del-branch',
      branch: 'main',
    });
    // No created_at backdating needed: the handler reads its monotonic fence from
    // the DB clock (`select now()`) on the same clock that stamped this build, and
    // captures it AFTER createTestBuild ran, so created_at <= fence holds naturally.

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8601 },
      repository: { full_name: 'octo/del-branch', id: 8611 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    // The deleted branch's in-flight build is terminalized (token revoked) and
    // its container DO is torn down via the cancelBuild RPC.
    const updated = await getBuild(env.db, inflight.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('branch deleted');
    expect(cancelledIds).toContain(inflight.id);
  });

  it('leaves an in-flight build for a DIFFERENT branch on the same repo untouched', async () => {
    const user = await createTestUser(env.db);
    const mainProject = await createTestProject(env.db, user.id, 'f18-4-other-main');
    const devProject = await createTestProject(env.db, user.id, 'f18-4-other-dev');
    await seedInstallation(env.db, '8602', [{ full_name: 'octo/other-branch', id: 8612 }]);
    // Two connections on the SAME repo, different branches.
    await createGitHubConnection(env.db, {
      projectId: mainProject.id,
      installationId: '8602',
      repoFullName: 'octo/other-branch',
      repositoryId: '8612',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: devProject.id,
      installationId: '8602',
      repoFullName: 'octo/other-branch',
      repositoryId: '8612',
      branch: 'dev',
      buildExecutor: 'container',
    });
    // An active build on the dev branch — a delete of `main` must NOT touch it.
    const devBuild = await createTestBuild(env.db, {
      projectId: devProject.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-dev',
      branch: 'dev',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8602 },
      repository: { full_name: 'octo/other-branch', id: 8612 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    // The dev-branch build is untouched (different branch).
    expect((await getBuild(env.db, devBuild.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(devBuild.id);
  });

  it('no-ops when no connection matches the deleted branch (still ignored)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-nomatch');
    await seedInstallation(env.db, '8603', [{ full_name: 'octo/nomatch', id: 8613 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8603',
      repoFullName: 'octo/nomatch',
      repositoryId: '8613',
      branch: 'main',
      buildExecutor: 'container',
    });
    // An active build on the connected branch, but the delete targets a branch
    // with no connection — nothing should be terminalized.
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-keep',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/feature',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8603 },
      repository: { full_name: 'octo/nomatch', id: 8613 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    // No connection on `feature`, so the main-branch build is left alone.
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([]);
  });

  it('leaves a terminal build for the deleted branch untouched (status guard)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-terminal');
    await seedInstallation(env.db, '8604', [{ full_name: 'octo/terminal', id: 8614 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8604',
      repoFullName: 'octo/terminal',
      repositoryId: '8614',
      branch: 'main',
      buildExecutor: 'container',
    });
    // A COMPLETE build for the branch being deleted — terminateBuildsForProject's
    // status guard (queued/starting/building/deploying only) must not touch it.
    const done = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'sha-done',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8604 },
      repository: { full_name: 'octo/terminal', id: 8614 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    // The complete build keeps its terminal status; no DO teardown.
    expect((await getBuild(env.db, done.id))!.status).toBe('complete');
    expect(cancelledIds).not.toContain(done.id);
  });

  // GitHub does NOT guarantee webhook ordering. If the branch was deleted, recreated, and a NEW valid build enqueued, a LATE delete
  // event must NOT cancel that build. The handler re-verifies current git state
  // (`getBranchExistence`) and skips cancellation unless the branch is confirmed
  // absent. Here the branch is currently PRESENT (recreated) — the build stays.
  it('does NOT cancel a build when the branch currently exists (recreated; stale delete)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-recreated');
    await seedInstallation(env.db, '8605', [{ full_name: 'octo/recreated', id: 8615 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8605',
      repoFullName: 'octo/recreated',
      repositoryId: '8615',
      branch: 'main',
      buildExecutor: 'container',
    });
    // A fresh in-flight build for the recreated branch (a newer push enqueued it).
    const inflight = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-recreated',
      branch: 'main',
    });

    // Current git state: the branch EXISTS (it was recreated after the delete).
    setBranchExistence('present');

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8605 },
      repository: { full_name: 'octo/recreated', id: 8615 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    // The valid recreated-branch build is left intact; no token revocation, no DO
    // teardown.
    expect((await getBuild(env.db, inflight.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(inflight.id);
  });

  // Fail-closed — when current git state cannot be confirmed
  // ('unknown': transient failure / no-access), the handler does NOT cancel. The
  // original in-flight build's exposure is already bounded by the deploy-token
  // TTL + the hourly reaper, so it is safer to leave it than risk clobbering a
  // valid build off an unverifiable event.
  it('does NOT cancel a build when branch existence is unknown (fail closed)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-unknown');
    await seedInstallation(env.db, '8606', [{ full_name: 'octo/unknown-del', id: 8616 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8606',
      repoFullName: 'octo/unknown-del',
      repositoryId: '8616',
      branch: 'main',
      buildExecutor: 'container',
    });
    const inflight = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-unknown',
      branch: 'main',
    });

    // The existence check is inconclusive (e.g. transient 5xx exhausted, or 403).
    setBranchExistence('unknown');

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8606 },
      repository: { full_name: 'octo/unknown-del', id: 8616 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    expect((await getBuild(env.db, inflight.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(inflight.id);
  });

  // TOCTOU fence — the absence check is point-in-time, so a build
  // enqueued in the window BETWEEN 'absent' being confirmed and the cancellation
  // UPDATE (a branch recreated + pushed in that gap) must not be cancelled. The
  // handler captures a DB-clock fence (`select now()`) BEFORE the check and only
  // terminalizes builds created at or before it (inclusive `<=`). Modeled here by
  // two same-branch builds: an orphan created an hour in the past (<= fence →
  // cancelled) and a recreated build an hour in the future (> fence → survives).
  // Both created_at and the fence come from the one Postgres clock, so there is no
  // cross-clock skew to misclassify them. Without the createdBefore fence,
  // terminateBuildsForProject would cancel BOTH.
  it('does NOT cancel a build created after the absence-check fence (recreate race)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'f18-4-fence');
    await seedInstallation(env.db, '8608', [{ full_name: 'octo/fence-del', id: 8618 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8608',
      repoFullName: 'octo/fence-del',
      repositoryId: '8618',
      branch: 'main',
      buildExecutor: 'container',
    });
    // Orphan build for the deleted incarnation — created an hour before the fence.
    // Seed created_at on the DB clock via `now()` (NOT a JS `...Z` string): the
    // column is `timestamp without time zone`, so a UTC string written directly
    // has its offset dropped and lands at the wrong instant under the harness's
    // non-UTC session timezone — mirror how `defaultNow` writes.
    const orphan = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-orphan',
      branch: 'main',
    });
    await env.db
      .update(builds)
      .set({ created_at: sql`now() - interval '1 hour'` })
      .where(eq(builds.id, orphan.id));
    // Build for the recreated branch — modeled as enqueued AFTER the fence (the
    // check-to-cancel window) via a created_at an hour in the future.
    const recreated = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-recreated-race',
      branch: 'main',
    });
    await env.db
      .update(builds)
      .set({ created_at: sql`now() + interval '1 hour'` })
      .where(eq(builds.id, recreated.id));

    // Branch is confirmed absent (the delete is genuine), so cancellation runs.
    setBranchExistence('absent');

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'push', {
      ref: 'refs/heads/main',
      after: '0000000000000000000000000000000000000000',
      installation: { id: 8608 },
      repository: { full_name: 'octo/fence-del', id: 8618 },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'branch delete' });
    // Orphan (before the fence) is terminalized; the post-fence recreated build
    // survives — the fence closes the check-to-cancel TOCTOU.
    expect((await getBuild(env.db, orphan.id))!.status).toBe('cancelled');
    expect(cancelledIds).toContain(orphan.id);
    expect((await getBuild(env.db, recreated.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(recreated.id);
  });
});

describe('POST /webhooks/github — organization member_removed revocation', () => {
  // Build an app whose env carries a recording BUILD_MANAGER so the post-commit
  // DO-cancel RPCs can be asserted (mirrors the App-removal suite).
  function recordingApp(): {
    app: Hono<ApiEnv>;
    appEnv: TestEnv;
    cancelledIds: ReadonlyArray<string>;
  } {
    const { namespace, cancelledIds } = recordingBuildManager();
    const overrideEnv: TestEnv = { ...env, BUILD_MANAGER: namespace };
    const { app, appEnv } = makeApp(overrideEnv);
    return { app, appEnv, cancelledIds };
  }

  // Seed an Organization installation (account_id = orgId, 'Organization').
  // Organization installs have no owner.
  async function seedOrgInstall(installationId: string, orgId: string): Promise<void> {
    await upsertGitHubInstallation(env.db, {
      installationId,
      userId: null,
      accountLogin: `org-${orgId}`,
      accountId: orgId,
      accountType: 'Organization',
      repositories: [],
      repositorySelection: 'all',
    });
  }

  const ORG = '9100';
  const ORG2 = '9200';
  const G = '7777'; // removed user's linked GitHub id

  it('severs the removed member: deletes the connection they authorized, membership, and terminates the in-flight build', async () => {
    const user = await createTestUser(env.db, 'org-removed', 'github', G);
    await seedOrgInstall('8100', ORG);
    const project = await createTestProject(env.db, user.id, 'org-sever');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8100',
      repoFullName: 'org/repo',
      repositoryId: '81001',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8100',
      userId: user.id,
      githubAccountId: G,
      ttlSeconds: 3600,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-org',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // Connection severed (future auto-deploy trigger removed).
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
    // Membership cache cleared.
    const members = await getTestGitHubInstallationMembers(env.db, '8100');
    expect(members.some((m) => m.user_id === user.id)).toBe(false);
    // In-flight build token revoked (build-row terminalized) + DO cancelled.
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('cancelled');
    expect(updated!.error).toBe('org membership removed');
    expect(cancelledIds).toContain(build.id);
  });

  it('severs a shared-project connection authorized by the removed project admin', async () => {
    const owner = await createTestUser(env.db, 'org-shared-owner');
    const admin = await createTestUser(env.db, 'org-shared-admin', 'github', G);
    await seedOrgInstall('8101', ORG);
    const project = await createTestProject(env.db, owner.id, 'org-shared-sever');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: admin.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8101',
      repoFullName: 'org/shared-repo',
      repositoryId: '81011',
      branch: 'main',
      buildExecutor: 'container',
      authorizedByUserId: admin.id,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8101',
      userId: admin.id,
      githubAccountId: G,
      ttlSeconds: 3600,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: owner.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-org-shared',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
    expect((await getBuild(env.db, build.id))?.status).toBe('cancelled');
    expect(cancelledIds).toContain(build.id);
  });

  // A member_removed(X) whose affected-user set is EMPTY (X has no oauth link and no membership proof-id row) must STILL write
  // a tombstone for (each org install, github_account_id=X). This is the pre-mint
  // hole: a soon-to-be-removed member pre-mints a join_code + connect_grant
  // carrying X while still in the org, WITHOUT any Void user/membership/oauth-link,
  // so there is nobody to sever — but the durable tombstone must be recorded or the
  // post-removal replay of those artifacts creates an auto-deploying connection.
  it('EXACT HOLE: writes a tombstone for (each org install, X) even when NO Void user is affected', async () => {
    const X = '99999'; // removed GitHub id: NO oauth link, NO membership proof-id
    // Two installs under ORG so we can assert the tombstone lands on EACH.
    const owner = await createTestUser(env.db, 'org-hole-owner', 'github', G);
    await seedOrgInstall('8110', ORG);
    await seedOrgInstall('8111', ORG);
    // A DIFFERENT org's install must NOT be tombstoned.
    await seedOrgInstall('8112', ORG2);
    // An unrelated connection (owned by owner, not X) must survive — nothing to sever.
    const project = await createTestProject(env.db, owner.id, 'org-hole-survives');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8110',
      repoFullName: 'org/survives',
      repositoryId: '81101',
      branch: 'main',
      buildExecutor: 'container',
    });

    // Pre-condition: no tombstone exists yet.
    expect(await getInstallationRevocationAt(env.db, '8110', X)).toBeNull();

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // A tombstone for (each ORG install, X) exists.
    expect(await getInstallationRevocationAt(env.db, '8110', X)).not.toBeNull();
    expect(await getInstallationRevocationAt(env.db, '8111', X)).not.toBeNull();
    // Scope: the other org's install is NOT tombstoned.
    expect(await getInstallationRevocationAt(env.db, '8112', X)).toBeNull();
    // Nothing severed (no affected Void user) — the unrelated connection survives.
    expect(await getGitHubConnection(env.db, project.id)).not.toBeNull();
  });

  // A browser-proof-X membership does NOT back a connection, so X's removal must
  // NOT sever a connection reached only via that membership — it only voids the
  // listing membership. Such a connection is an UNREACHABLE state anyway (the
  // connect gate can never mint a connection for a user whose OWN linked GitHub
  // id is not the grant id).
  it('does NOT sever a connection for a member pulled in ONLY by a browser-proof-X membership; voids only the X membership + writes the tombstone', async () => {
    // X is the removed GitHub id with NO oauth link — getUserByOAuthAccount('github',
    // X) resolves nobody. V is a google-only Void account (NOT oauth-linked to X)
    // holding an X-keyed browser-proof membership on the org install. The seeded
    // connection for V is an unreachable state (Threat-L1: the member connect gate
    // requires the caller's OWN linked GitHub id to equal the grant id, and V has
    // no github oauth id), included here to prove it is NOT severed.
    const X = '6551234';
    const v = await createTestUser(env.db, 'org-f1-v', 'google', 'google-f1-v');
    await seedOrgInstall('8190', ORG);
    const project = await createTestProject(env.db, v.id, 'org-f1-proj');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8190',
      repoFullName: 'org/f1',
      repositoryId: '81901',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8190',
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: v.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-f1',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // V's X-keyed membership cache is DELETED (arm b, keyed by the github id).
    expect(
      (await getTestGitHubInstallationMembers(env.db, '8190')).some((m) => m.user_id === v.id),
    ).toBe(false);
    // The durable tombstone for (install, X) — keyed by the removed GitHub id — is
    // still written, closing a later pre-removal connect_grant replay even after V
    // oauth-links X.
    expect(await getInstallationRevocationAt(env.db, '8190', X)).not.toBeNull();
    // Connection is NOT severed and the build is NOT terminated: the connection is
    // oauth-backed (never by a browser-proof membership), and X owns no oauth Void
    // account, so there is nothing X-backed to sever.
    expect(await getGitHubConnection(env.db, project.id)).not.toBeNull();
    const updated = await getBuild(env.db, build.id);
    expect(updated!.status).toBe('building');
    expect(cancelledIds).not.toContain(build.id);
  });

  // Only the OAUTH-X user's connection is severed; a distinct browser-proof-X
  // membership only gets its listing row voided — its owner's connection
  // (oauth-backed, not by the membership) is spared. V's connection is
  // unreachable via the connect gate anyway (Threat-L1).
  it('severs the oauth-X user AND voids a distinct browser-proof-X membership, but spares that member’s oauth-backed connection', async () => {
    // X is the removed GitHub id. U is oauth-linked to X (arm a) AND holds an
    // X-keyed membership. V is a google-only account with an X-keyed browser-proof
    // membership but NOT oauth-linked to X.
    const X = '7551234';
    const u = await createTestUser(env.db, 'org-union-u', 'github', X);
    const v = await createTestUser(env.db, 'org-union-v', 'google', 'google-union-v');
    await seedOrgInstall('8200', ORG);
    const uProj = await createTestProject(env.db, u.id, 'org-union-u-proj');
    const vProj = await createTestProject(env.db, v.id, 'org-union-v-proj');
    await createGitHubConnection(env.db, {
      projectId: uProj.id,
      installationId: '8200',
      repoFullName: 'org/u',
      repositoryId: '82001',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: vProj.id,
      installationId: '8200',
      repoFullName: 'org/v',
      repositoryId: '82002',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8200',
      userId: u.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8200',
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // U's connection (oauth-backed by X, arm a) is severed…
    expect(await getGitHubConnection(env.db, uProj.id)).toBeNull();
    // …but V's connection SURVIVES: a browser-proof membership never backs it, and
    // V's oauth id is not X.
    expect(await getGitHubConnection(env.db, vProj.id)).not.toBeNull();
    // Both X-keyed memberships are voided (U's via arm a, V's via arm b).
    const members = await getTestGitHubInstallationMembers(env.db, '8200');
    expect(members.some((m) => m.user_id === u.id)).toBe(false);
    expect(members.some((m) => m.user_id === v.id)).toBe(false);
    // Tombstoned ONCE, keyed by the removed GitHub id X — a single row covers X.
    expect(await getInstallationRevocationAt(env.db, '8200', X)).not.toBeNull();
  });

  // The same Void user holds an X-keyed membership on one org install AND a
  // legit Z-backed connection on a DIFFERENT org install (X != its oauth id Z).
  // member_removed(X) must void only the X membership and leave the Z-backed
  // connection + its in-flight build fully intact.
  it('spares a Z-backed connection when the SAME user’s X-keyed membership is voided (browser-proof ≠ oauth id)', async () => {
    const X = '3330001';
    const Z = '3330002';
    const v = await createTestUser(env.db, 'org-r8-v', 'github', Z);
    // I1: historical/uninstalled org install; I2: the reinstalled active one.
    // Same org account → BOTH resolve into orgInstallIds
    // (getGitHubInstallationsByAccount has NO status filter).
    await seedOrgInstall('8210', ORG); // I1
    await seedOrgInstall('8211', ORG); // I2
    // Mark I1 deleted to mirror uninstall→reinstall history. installation.deleted
    // does NOT remove membership rows, so V's stale X-membership persists on I1.
    await markGitHubInstallationStatus(env.db, '8210', 'deleted');
    const vProj = await createTestProject(env.db, v.id, 'org-r8-v-proj');
    // V's legit Z-backed connection lives on the ACTIVE install I2.
    await createGitHubConnection(env.db, {
      projectId: vProj.id,
      installationId: '8211',
      repoFullName: 'org/v-legit',
      repositoryId: '82111',
      branch: 'main',
      buildExecutor: 'container',
    });
    // V's stale X-keyed browser-proof membership on I1.
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8210',
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });
    // V's current Z-keyed membership on I2.
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8211',
      userId: v.id,
      githubAccountId: Z,
      ttlSeconds: 3600,
    });
    const build = await createTestBuild(env.db, {
      projectId: vProj.id,
      userId: v.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-r8',
      branch: 'main',
    });

    const { app, appEnv, cancelledIds } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // V's Z-backed I2 connection SURVIVES (X is not V's oauth id — V is still an
    // org member via Z).
    expect(await getGitHubConnection(env.db, vProj.id)).not.toBeNull();
    // Its in-flight build is NOT terminated.
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).not.toContain(build.id);
    // V's stale (I1, X) browser-proof membership IS deleted (arm b).
    expect(
      (await getTestGitHubInstallationMembers(env.db, '8210')).some((m) => m.user_id === v.id),
    ).toBe(false);
    // V's current (I2, Z) membership SURVIVES (not X-keyed).
    expect(
      (await getTestGitHubInstallationMembers(env.db, '8211')).some(
        (m) => m.user_id === v.id && m.github_account_id === Z,
      ),
    ).toBe(true);
    // Tombstone stamped for BOTH org installs, keyed by X.
    expect(await getInstallationRevocationAt(env.db, '8210', X)).not.toBeNull();
    expect(await getInstallationRevocationAt(env.db, '8211', X)).not.toBeNull();
  });

  it('ignores member_removed when the org has no installs', async () => {
    const user = await createTestUser(env.db, 'org-noinstall', 'github', G);
    // A connection under a DIFFERENT org — must survive since ORG2 has no installs.
    await seedOrgInstall('8120', ORG);
    const project = await createTestProject(env.db, user.id, 'org-other');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8120',
      repoFullName: 'org/other',
      repositoryId: '81201',
      branch: 'main',
      buildExecutor: 'container',
    });

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG2) }, // no installs under ORG2
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'organization: no org installs' });
    expect(await getGitHubConnection(env.db, project.id)).not.toBeNull();
  });

  it('ignores a non-removal action (member_added) — connection + membership survive', async () => {
    const user = await createTestUser(env.db, 'org-added', 'github', G);
    await seedOrgInstall('8130', ORG);
    const project = await createTestProject(env.db, user.id, 'org-added-proj');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8130',
      repoFullName: 'org/added',
      repositoryId: '81301',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8130',
      userId: user.id,
      githubAccountId: G,
      ttlSeconds: 3600,
    });

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_added',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'organization:member_added' });
    expect(await getGitHubConnection(env.db, project.id)).not.toBeNull();
    const members = await getTestGitHubInstallationMembers(env.db, '8130');
    expect(members.some((m) => m.user_id === user.id)).toBe(true);
  });

  it('SCOPE: does not sever the removed user’s connection under a DIFFERENT org', async () => {
    const user = await createTestUser(env.db, 'org-scope-org', 'github', G);
    await seedOrgInstall('8140', ORG);
    await seedOrgInstall('8141', ORG2);
    const inOrg = await createTestProject(env.db, user.id, 'org-scope-in');
    const inOrg2 = await createTestProject(env.db, user.id, 'org-scope-out');
    await createGitHubConnection(env.db, {
      projectId: inOrg.id,
      installationId: '8140',
      repoFullName: 'org/in',
      repositoryId: '81401',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: inOrg2.id,
      installationId: '8141',
      repoFullName: 'org2/out',
      repositoryId: '81411',
      branch: 'main',
      buildExecutor: 'container',
    });

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    // The ORG connection is severed…
    expect(await getGitHubConnection(env.db, inOrg.id)).toBeNull();
    // …but the ORG2 connection (different org's install) is untouched.
    expect(await getGitHubConnection(env.db, inOrg2.id)).not.toBeNull();
  });

  it('SCOPE: leaves another user’s connection + membership under the same org intact', async () => {
    const removed = await createTestUser(env.db, 'org-scope-u', 'github', G);
    const other = await createTestUser(env.db, 'org-scope-v', 'github', '8888');
    await seedOrgInstall('8150', ORG);
    const removedProj = await createTestProject(env.db, removed.id, 'org-u-proj');
    const otherProj = await createTestProject(env.db, other.id, 'org-v-proj');
    await createGitHubConnection(env.db, {
      projectId: removedProj.id,
      installationId: '8150',
      repoFullName: 'org/u',
      repositoryId: '81501',
      branch: 'main',
      buildExecutor: 'container',
    });
    await createGitHubConnection(env.db, {
      projectId: otherProj.id,
      installationId: '8150',
      repoFullName: 'org/v',
      repositoryId: '81502',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8150',
      userId: removed.id,
      githubAccountId: G,
      ttlSeconds: 3600,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8150',
      userId: other.id,
      githubAccountId: '8888',
      ttlSeconds: 3600,
    });

    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });

    expect(res.status).toBe(200);
    // Removed user's connection is gone…
    expect(await getGitHubConnection(env.db, removedProj.id)).toBeNull();
    // …but V's connection under the SAME org install stays.
    expect(await getGitHubConnection(env.db, otherProj.id)).not.toBeNull();
    // V's membership stays; only U's is deleted.
    const members = await getTestGitHubInstallationMembers(env.db, '8150');
    expect(members.some((m) => m.user_id === removed.id)).toBe(false);
    expect(members.some((m) => m.user_id === other.id)).toBe(true);
  });

  it('is idempotent on redelivery: two deliveries both 200, single net effect', async () => {
    const user = await createTestUser(env.db, 'org-idem', 'github', G);
    await seedOrgInstall('8170', ORG);
    const project = await createTestProject(env.db, user.id, 'org-idem-proj');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '8170',
      repoFullName: 'org/idem',
      repositoryId: '81701',
      branch: 'main',
      buildExecutor: 'container',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '8170',
      userId: user.id,
      githubAccountId: G,
      ttlSeconds: 3600,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      commitSha: 'sha-idem',
      branch: 'main',
    });

    const { app, appEnv } = recordingApp();
    const payload = {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    };
    const res1 = await post(app, appEnv, 'organization', payload);
    const res2 = await post(app, appEnv, 'organization', payload);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ ok: true });
    // Still exactly one net effect: connection gone, membership gone, build terminal.
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
    const members = await getTestGitHubInstallationMembers(env.db, '8170');
    expect(members.some((m) => m.user_id === user.id)).toBe(false);
    expect((await getBuild(env.db, build.id))!.status).toBe('cancelled');
  });

  it('ignores payloads missing organization.id or membership.user.id', async () => {
    await createTestUser(env.db, 'org-missing', 'github', G);
    await seedOrgInstall('8180', ORG);

    const { app, appEnv } = recordingApp();

    const resNoOrg = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      membership: { user: { id: Number(G) } },
    });
    expect(resNoOrg.status).toBe(200);
    expect(await resNoOrg.json()).toEqual({ ok: true, ignored: 'organization: missing ids' });

    const resNoUser = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: {},
    });
    expect(resNoUser.status).toBe(200);
    expect(await resNoUser.json()).toEqual({ ok: true, ignored: 'organization: missing ids' });
  });

  // Monotonic revocation: member_removed writes a durable tombstone for
  // (each org install, removed user), so a later replay of a pre-removal
  // join_code/connect_grant (iat <= revoked_at) is rejected forever after.
  it('records a revocation tombstone for every org install of the removed user', async () => {
    await createTestUser(env.db, 'org-tomb', 'github', G);
    // Two installs under ORG (both should get a tombstone); one under ORG2 (must NOT).
    await seedOrgInstall('8190', ORG);
    await seedOrgInstall('8191', ORG);
    await seedOrgInstall('8192', ORG2);

    const before = Date.now();
    const { app, appEnv } = recordingApp();
    const res = await post(app, appEnv, 'organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    });
    expect(res.status).toBe(200);

    // Both ORG installs carry a tombstone (keyed by the removed GitHub id G)
    // stamped at (≈) the removal moment.
    const t8190 = await getInstallationRevocationAt(env.db, '8190', G);
    const t8191 = await getInstallationRevocationAt(env.db, '8191', G);
    expect(t8190).not.toBeNull();
    expect(t8191).not.toBeNull();
    expect(t8190!).toBeGreaterThan(before - 60_000);
    // The ORG2 install (different org, not in scope) gets NO tombstone.
    expect(await getInstallationRevocationAt(env.db, '8192', G)).toBeNull();
  });

  it('redelivery keeps a single tombstone and never regresses revoked_at (monotonic)', async () => {
    await createTestUser(env.db, 'org-tomb-idem', 'github', G);
    await seedOrgInstall('8195', ORG);

    const { app, appEnv } = recordingApp();
    const payload = {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(G) } },
    };

    await post(app, appEnv, 'organization', payload);
    const first = await getInstallationRevocationAt(env.db, '8195', G);
    expect(first).not.toBeNull();

    await post(app, appEnv, 'organization', payload);
    const second = await getInstallationRevocationAt(env.db, '8195', G);
    expect(second).not.toBeNull();
    // High-water mark: the redelivery advances or holds, never regresses.
    expect(second!).toBeGreaterThanOrEqual(first!);
  });
});

// ---------------------------------------------------------------------------
// GitHub's "Re-run" button on the Void Build check run (`check_run:rerequested`)
// and "Re-run all checks" (`check_suite:rerequested`).
//
// The rerun reuses the PUSH pipeline, so it inherits the freshness gate: a rerun
// can never deploy a commit a push could not.
// ---------------------------------------------------------------------------
describe('POST /webhooks/github — rerun from the check run', () => {
  /** A BUILD_SCHEDULER stand-in that records pokes. */
  function pokeEnvWith(base: TestEnv): { pokeEnv: TestEnv; pokes: Array<string> } {
    const pokes: Array<string> = [];
    const pokeEnv: TestEnv = {
      ...base,
      BUILD_SCHEDULER: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          fetch: async (url: string) => {
            pokes.push(url);
            return Response.json({ ok: true });
          },
        }),
      } as unknown as DurableObjectNamespace,
    };
    return { pokeEnv, pokes };
  }

  const checkRunPayload = (overrides?: {
    name?: string;
    action?: string;
    headSha?: string;
    headBranch?: string | null;
    id?: number;
    // No default: a per-check rerun that cannot name its build FAILS CLOSED, so
    // every test that expects work must pass a real build id.
    externalId?: string;
    conclusion?: string | null;
  }) => ({
    action: overrides?.action ?? 'rerequested',
    installation: { id: 900 },
    repository: { full_name: 'octo/site', id: 9001 },
    check_run: {
      id: overrides?.id ?? 55_001,
      name: overrides?.name ?? 'Void Build',
      head_sha: overrides?.headSha ?? 'cafe1234',
      external_id: overrides?.externalId ?? 'bld_old',
      conclusion: overrides?.conclusion === undefined ? 'failure' : overrides.conclusion,
      check_suite: {
        head_branch: overrides?.headBranch === undefined ? 'main' : overrides.headBranch,
      },
    },
  });

  /**
   * The build a clicked check run points at. A per-check rerun FAILS CLOSED
   * without one, so every test that expects the handler to get as far as the
   * freshness gate needs a real row to name.
   */
  async function seedClickedBuild(
    project: { id: string },
    user: { id: string },
    status: 'queued' | 'failed' | 'complete' = 'failed',
  ) {
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    if (status !== 'queued') {
      await env.db.update(builds).set({ status }).where(eq(builds.id, build.id));
    }
    return build;
  }

  async function seedContainerProject(slug: string, branch = 'main') {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, slug);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '900',
      repoFullName: 'octo/site',
      repositoryId: '9001',
      branch,
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '900');
    return { user, project };
  }

  it('enqueues a fresh build when the previous build for the commit FAILED', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-failed');
    // The state the button exists for: a terminal failed build on the branch head.
    const failed = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    await env.db.update(builds).set({ status: 'failed' }).where(eq(builds.id, failed.id));

    const { pokeEnv, pokes } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: failed.id }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    // A NEW row — a failed build is never reused.
    expect(json.buildIds[0]).not.toBe(failed.id);
    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.project_id).toBe(project.id);
    expect(build!.commit_sha).toBe('cafe1234');
    expect(build!.status).toBe('queued');
    // The scheduler is woken now rather than on its next alarm.
    expect(pokes).toHaveLength(1);
  });

  it('refuses to rerun a commit that is no longer the branch head', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-stale');
    const clicked = await seedClickedBuild(project, user);
    // 'behind' = the branch moved off this commit (force-push / rollback). Building
    // it would roll production back to an abandoned commit.
    setCompareStatus('behind');
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: clicked.id }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
    // No NEW build — only the failed one the check pointed at.
    expect((await getProjectBuilds(env.db, project.id)).map((b) => b.id)).toEqual([clicked.id]);
  });

  it('refuses to rerun when the compare API is unreachable (fail closed)', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-unknown');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus(null);
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: clicked.id }));

    expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
    expect((await getProjectBuilds(env.db, project.id)).map((b) => b.id)).toEqual([clicked.id]);
  });

  it('ignores a rerequest for a check run that is not ours', async () => {
    await seedContainerProject('wh-rerun-foreign');
    const { app, appEnv } = makeApp(env);

    const res = await post(
      app,
      appEnv,
      'check_run',
      checkRunPayload({ name: 'Socket Security: Project Report' }),
    );

    expect(await res.json()).toEqual({ ok: true, ignored: 'check_run is not the Void build' });
  });

  it('ignores non-rerequested check_run actions', async () => {
    await seedContainerProject('wh-rerun-created');
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ action: 'created' }));

    expect(await res.json()).toEqual({ ok: true, ignored: 'check_run:created' });
  });

  it('skips a connection whose branch head is not this commit', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-otherbranch', 'release');
    const clicked = await seedClickedBuild(project, user);
    // The suite names `main`, but the connection tracks `release` — and `release`
    // has moved on. The FRESHNESS gate is what refuses, not a branch filter.
    setCompareStatusByBranch({ release: 'behind' });
    const { app, appEnv } = makeApp(env);

    const res = await post(
      app,
      appEnv,
      'check_run',
      checkRunPayload({ headBranch: 'main', externalId: clicked.id }),
    );

    expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
    expect((await getProjectBuilds(env.db, project.id)).map((b) => b.id)).toEqual([clicked.id]);
  });

  it('reruns a project tracking another branch at the SAME commit', async () => {
    // GitHub keeps ONE suite per app per commit even when that commit heads several
    // branches, so the payload names only one of them. Treating `head_branch` as a
    // filter would drop this project's connection entirely and break its button.
    const { project, user } = await seedContainerProject('wh-rerun-samesha', 'release');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatusByBranch({ release: 'identical' });
    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(
      app,
      appEnv,
      'check_run',
      checkRunPayload({ headBranch: 'main', externalId: clicked.id }),
    );

    const json = (await res.json()) as { buildIds?: Array<string> };
    expect(json.buildIds).toHaveLength(1);
    expect((await getBuild(env.db, json.buildIds![0]))!.project_id).toBe(project.id);
  });

  it('tells a github_actions project to rerun from Actions instead', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rerun-actions');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '900',
      repoFullName: 'octo/site',
      repositoryId: '9001',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await seedInstallation(env.db, '900');
    const clicked = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: clicked.id }));

    // Nothing in the Checks API can start a workflow run, so say so rather than
    // returning a silent success the user would read as a working button.
    expect(await res.json()).toEqual({
      ok: true,
      ignored: 'github_actions rerun must be run from Actions',
    });
  });

  it('handles "Re-run all checks" (check_suite:rerequested) the same way', async () => {
    const { project } = await seedContainerProject('wh-rerun-suite');
    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'check_suite', {
      action: 'rerequested',
      installation: { id: 900 },
      repository: { full_name: 'octo/site', id: 9001 },
      check_suite: { head_sha: 'cafe1234', head_branch: 'main' },
    });

    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    const build = await getBuild(env.db, json.buildIds[0]);
    expect(build!.project_id).toBe(project.id);
  });

  it('ignores check_suite:requested so a push is not built twice', async () => {
    await seedContainerProject('wh-suite-requested');
    const { app, appEnv } = makeApp(env);

    // A suite is requested on EVERY push, which the push handler already builds.
    const res = await post(app, appEnv, 'check_suite', {
      action: 'requested',
      installation: { id: 900 },
      repository: { full_name: 'octo/site', id: 9001 },
      check_suite: { head_sha: 'cafe1234', head_branch: 'main' },
    });

    expect(await res.json()).toEqual({ ok: true, ignored: 'check_suite:requested' });
  });

  it('self-heals a renamed repo on rerun, so the build fetches the right source', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'wh-rerun-renamed');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '900',
      // Stored under the OLD name; the immutable id still matches.
      repoFullName: 'octo/old-site',
      repositoryId: '9001',
      branch: 'main',
      buildExecutor: 'container',
    });
    await seedInstallation(env.db, '900');
    const clicked = await seedClickedBuild(project, user);
    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);

    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: clicked.id }));

    const json = (await res.json()) as { buildIds: ReadonlyArray<string> };
    expect(json.buildIds).toHaveLength(1);
    const connection = await getGitHubConnection(env.db, project.id);
    expect(connection!.repo_full_name).toBe('octo/site');
  });

  it('ignores a rerequest with missing routing fields', async () => {
    const { app, appEnv } = makeApp(env);

    const res = await post(app, appEnv, 'check_run', {
      action: 'rerequested',
      check_run: { name: 'Void Build' },
    });

    expect(await res.json()).toEqual({ ok: true, ignored: 'missing check_run routing fields' });
  });

  /** A second project on the SAME repo AND branch — allowed: only project_id is unique. */
  async function seedSiblingProject(
    slug: string,
    executor: 'container' | 'github_actions',
    branch = 'main',
  ) {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, slug);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '900',
      repoFullName: 'octo/site',
      repositoryId: '9001',
      branch,
      buildExecutor: executor,
    });
    return { user, project };
  }

  it('rebuilds only the project whose check run was clicked', async () => {
    const { project: clicked, user } = await seedContainerProject('wh-rerun-target');
    const { project: sibling } = await seedSiblingProject('wh-rerun-sibling', 'container');
    // The check the user clicked belongs to THIS build, on THIS project.
    const failed = await createTestBuild(env.db, {
      projectId: clicked.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    await env.db.update(builds).set({ status: 'failed' }).where(eq(builds.id, failed.id));

    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);
    const res = await post(app, appEnv, 'check_run', checkRunPayload({ externalId: failed.id }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildIds?: Array<string> };
    expect(json.buildIds).toHaveLength(1);
    // Resolving by repo + branch alone would have rebuilt the sibling too.
    expect(await getProjectBuilds(env.db, sibling.id)).toHaveLength(0);
    expect((await getBuild(env.db, json.buildIds![0]))!.project_id).toBe(clicked.id);
  });

  it('never enqueues a sibling container build from a click on an Actions check', async () => {
    const actions = await seedSiblingProject('wh-rerun-actions-owner', 'github_actions');
    await seedInstallation(env.db, '900');
    const { project: containerSibling } = await seedSiblingProject(
      'wh-rerun-container-sib',
      'container',
    );
    const actionsBuild = await createTestBuild(env.db, {
      projectId: actions.project.id,
      userId: actions.user.id,
      executor: 'github_actions',
      commitSha: 'cafe1234',
      branch: 'main',
    });

    const { app, appEnv } = makeApp(env);
    const res = await post(
      app,
      appEnv,
      'check_run',
      checkRunPayload({ externalId: actionsBuild.id }),
    );

    expect(await res.json()).toEqual({
      ok: true,
      ignored: 'github_actions rerun must be run from Actions',
    });
    expect(await getProjectBuilds(env.db, containerSibling.id)).toHaveLength(0);
  });

  it('fans out across sibling projects for "Re-run all checks"', async () => {
    const { project: first } = await seedContainerProject('wh-suite-first');
    const { project: second } = await seedSiblingProject('wh-suite-second', 'container');

    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);
    // A suite rerequest carries no external_id, and covers every check in it.
    const res = await post(app, appEnv, 'check_suite', {
      action: 'rerequested',
      installation: { id: 900 },
      repository: { full_name: 'octo/site', id: 9001 },
      check_suite: { head_sha: 'cafe1234', head_branch: 'main' },
    });

    const json = (await res.json()) as { buildIds?: Array<string> };
    expect(json.buildIds).toHaveLength(2);
    expect(await getProjectBuilds(env.db, first.id)).toHaveLength(1);
    expect(await getProjectBuilds(env.db, second.id)).toHaveLength(1);
  });

  it('compares every branch of a suite fan-out concurrently, not in series', async () => {
    // Two projects on the SAME repo tracking DIFFERENT branches. `head_branch` is
    // not a filter, so both are candidates and the handler owes one branch-head
    // compare each. GitHub drops a delivery it has not been answered in 10s and
    // does not redeliver it, so awaiting those compares in series is what turns a
    // slow GitHub into a silently lost Re-run click.
    const { project: first } = await seedContainerProject('wh-suite-conc-main');
    const { project: second } = await seedSiblingProject(
      'wh-suite-conc-release',
      'container',
      'release',
    );
    // The same commit heads both branches, so both compares return 'identical'
    // and both projects really do rebuild.
    setCompareStatusByBranch({ main: 'identical', release: 'identical' });
    // Park each compare until BOTH are in flight at once. A serial handler can
    // never get there: call two does not start until call one has returned.
    armCompareConcurrencyProbe(2);

    const { pokeEnv } = pokeEnvWith(env);
    const { app, appEnv } = makeApp(pokeEnv);
    const res = await post(app, appEnv, 'check_suite', {
      action: 'rerequested',
      installation: { id: 900 },
      repository: { full_name: 'octo/site', id: 9001 },
      check_suite: { head_sha: 'cafe1234', head_branch: 'main' },
    });

    expect(compareConcurrencyPeak).toBe(2);
    const json = (await res.json()) as { buildIds?: Array<string> };
    expect(json.buildIds).toHaveLength(2);
    expect(await getProjectBuilds(env.db, first.id)).toHaveLength(1);
    expect(await getProjectBuilds(env.db, second.id)).toHaveLength(1);
  });

  it('refuses a per-check rerun whose build no longer exists', async () => {
    const { project } = await seedContainerProject('wh-rerun-orphan-check');
    const { project: sibling } = await seedSiblingProject('wh-rerun-orphan-sib', 'container');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { pokeEnv, pokes } = pokeEnvWith(env);
      const { app, appEnv } = makeApp(pokeEnv);

      // Deleting a project cascades its build rows away while GitHub keeps the
      // check for months. Falling back to the branch set here would rebuild —
      // and could deploy — sibling projects owned by other users.
      const res = await post(app, appEnv, 'check_run', checkRunPayload({ id: 77_004 }));

      expect(await res.json()).toEqual({ ok: true, ignored: 'originating build not found' });
      expect(await getProjectBuilds(env.db, project.id)).toHaveLength(0);
      expect(await getProjectBuilds(env.db, sibling.id)).toHaveLength(0);
      expect(pokes).toHaveLength(0);
      // The refusal is reported, and it does NOT invent a passing conclusion.
      const [, , , , opts] = spy.mock.calls[0]!;
      expect(opts.conclusion).toBe('failure');
    } finally {
      spy.mockRestore();
    }
  });

  it('never writes a passing conclusion for a rerun it refused', async () => {
    // GitHub counts `neutral` as passing for a REQUIRED status check. Writing one
    // here would let anyone with rerun rights clear branch protection on a commit
    // that never built.
    const { project, user } = await seedContainerProject('wh-rerun-no-bypass');
    const failed = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    await env.db.update(builds).set({ status: 'failed' }).where(eq(builds.id, failed.id));
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_005, externalId: failed.id, conclusion: 'failure' }),
      );

      expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
      const [, , , , opts] = spy.mock.calls[0]!;
      // The run stays red, with an explanation. It does not become passing.
      expect(opts.conclusion).toBe('failure');
      expect(opts.title).toBe('Commit is no longer the branch head');
    } finally {
      spy.mockRestore();
    }
  });

  it('maps an unwritable `stale` conclusion to cancelled', async () => {
    // GitHub reports `stale` on a run but REJECTS it on update, so echoing it
    // back would 422 every time and leave the rerequest unresolved.
    const { project, user } = await seedContainerProject('wh-rerun-stale-conclusion');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { app, appEnv } = makeApp(env);
      await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_008, externalId: clicked.id, conclusion: 'stale' }),
      );

      const [, , , , opts] = spy.mock.calls[0]!;
      expect(opts.conclusion).toBe('cancelled');
    } finally {
      spy.mockRestore();
    }
  });

  it('completes a refused rerun as cancelled when the run had no conclusion', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-null-conclusion');
    const failed = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    await env.db.update(builds).set({ status: 'failed' }).where(eq(builds.id, failed.id));
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { app, appEnv } = makeApp(env);
      await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_006, externalId: failed.id, conclusion: null }),
      );

      const [, , , , opts] = spy.mock.calls[0]!;
      // Never ran to a verdict, so it was never passing. `cancelled`, not neutral.
      expect(opts.conclusion).toBe('cancelled');
    } finally {
      spy.mockRestore();
    }
  });

  it('treats a reused QUEUED build as work, not as already live', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-queued-reuse');
    // A queued build for this exact commit already exists — a duplicate webhook
    // delivery, or a push that landed first. The supersede tx REUSES it.
    const queued = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    expect((await getBuild(env.db, queued.id))!.status).toBe('queued');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { pokeEnv, pokes } = pokeEnvWith(env);
      const { app, appEnv } = makeApp(pokeEnv);

      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_007, externalId: queued.id }),
      );

      // An UNRUN build must never be reported as deployed, and it still needs the
      // scheduler poke it is waiting for.
      const json = (await res.json()) as { buildIds?: Array<string> };
      expect(json.buildIds).toEqual([queued.id]);
      expect(pokes).toHaveLength(1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('reports success, not neutral, when the commit is already built and live', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-already-live');
    const done = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
      commitSha: 'cafe1234',
      branch: 'main',
    });
    // The project is LIVE on exactly this commit, so the supersede tx REUSES the
    // completed row and returns it non-null — which must not read as an enqueue.
    await createTestDeployment(env.db, project.id, 'live', undefined, undefined, {
      commit: 'cafe1234',
    });

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { pokeEnv, pokes } = pokeEnvWith(env);
      const { app, appEnv } = makeApp(pokeEnv);

      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_003, externalId: done.id }),
      );

      // Nothing was enqueued, and the scheduler is not woken for work that
      // does not exist.
      expect(await res.json()).toEqual({ ok: true, enqueued: 0, reused: [done.id] });
      expect(pokes).toHaveLength(0);
      // The run this replaces was green; downgrading it to `neutral` would lose an
      // accurate success.
      expect(spy).toHaveBeenCalledTimes(1);
      const [, , , checkRunId, opts] = spy.mock.calls[0]!;
      expect(checkRunId).toBe('77003');
      expect(opts.conclusion).toBe('success');
      expect(opts.title).toBe('Already built and live');
      // No second build row was created.
      expect(await getProjectBuilds(env.db, project.id)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('completes the clicked check run when a stale commit enqueues nothing', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-stale-reported');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(true);
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_001, externalId: clicked.id, conclusion: 'neutral' }),
      );

      expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
      // GitHub reset the suite to `queued` on the click. Leaving it there is what
      // makes the button look broken, so the refusal is reported ON the check.
      expect(spy).toHaveBeenCalledTimes(1);
      const [, , , checkRunId, opts] = spy.mock.calls[0]!;
      expect(checkRunId).toBe('77001');
      // Echoes the run's OWN conclusion back; it does not invent one.
      expect(opts.conclusion).toBe('neutral');
      expect(opts.title).toBe('Commit is no longer the branch head');
    } finally {
      spy.mockRestore();
    }
  });

  it('still returns 2xx when GitHub REJECTS the no-op report', async () => {
    // completeCheckRun resolves false on a non-2xx; it does not throw. The
    // rejection-mock test below covers the other shape.
    const { project, user } = await seedContainerProject('wh-rerun-report-false');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockResolvedValue(false);
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_009, externalId: clicked.id }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('answers the webhook without waiting for the no-op report', async () => {
    // GitHub drops a delivery we have not answered in 10s and does NOT redeliver a
    // failure automatically. completeCheckRun mints a token and retries with no
    // clock of its own, so the report goes to waitUntil and the 2xx does not wait
    // on it. `post` deliberately AWAITS waitUntil for determinism, so this calls
    // app.fetch directly.
    const { project, user } = await seedContainerProject('wh-rerun-report-deferred');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    let settle: (v: boolean) => void = () => {};
    const spy = vi.spyOn(checkRunModule, 'completeCheckRun').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    try {
      const { app, appEnv } = makeApp(env);
      const payload = checkRunPayload({ id: 77_010, externalId: clicked.id });
      const body = JSON.stringify(payload);
      const pending: Array<Promise<unknown>> = [];
      const res = await app.fetch(
        new Request('http://localhost/webhooks/github', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'check_run',
            'X-Hub-Signature-256': await sign(WEBHOOK_SECRET, body),
          },
          body,
        }),
        { ...appEnv, GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET },
        {
          waitUntil: (p: Promise<unknown>) => {
            pending.push(p);
          },
          passThroughOnException: () => {},
        } as unknown as ExecutionContext,
      );

      // Answered while the report is STILL outstanding...
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
      expect(pending).toHaveLength(1);
      // ...and the call really did start, so it cannot be silently skipped.
      expect(spy).toHaveBeenCalledTimes(1);
      settle(true);
      await Promise.all(pending);
    } finally {
      spy.mockRestore();
    }
  });

  it('still returns 2xx when reporting the no-op to GitHub fails', async () => {
    const { project, user } = await seedContainerProject('wh-rerun-report-throws');
    const clicked = await seedClickedBuild(project, user);
    setCompareStatus('behind');

    const checkRunModule = await import('../../src/github/check-run.ts');
    const spy = vi
      .spyOn(checkRunModule, 'completeCheckRun')
      .mockRejectedValue(new Error('check-run PATCH exploded'));
    try {
      const { app, appEnv } = makeApp(env);
      const res = await post(
        app,
        appEnv,
        'check_run',
        checkRunPayload({ id: 77_002, externalId: clicked.id }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, enqueued: 0 });
    } finally {
      spy.mockRestore();
    }
  });
});
