import { createDefaultPlanCatalog } from '@void/platform/plans';
import { eq } from 'drizzle-orm';
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
  createGithubActionsBuildWithinLimit,
  deleteGitHubConnection,
  getBuild,
  getProject,
  getProjectBuilds,
  markGitHubInstallationStatus,
  setBuildCheckRunId,
  setGitHubInstallationRepositories,
  updateBuildStatus,
  updateGitHubConnection,
  upsertGitHubInstallation,
} from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import type { GithubOidcClaims } from '../../src/github/oidc-verify.ts';
import { writePlanCatalog } from '../../src/plans.ts';
import { oidcRoutes } from '../../src/routes/auth-oidc.ts';
import {
  builds,
  githubConnections,
  githubInstallations,
  projects,
  users,
} from '../../src/schema.ts';
import { verifyDeployToken } from '../helpers/project-token.ts';
import {
  createTestBuild,
  JWT_SECRET,
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

// Stub the OIDC verifier so we exercise the route's connection-resolution and
// token-minting logic without a real GitHub JWKS. `setVerifyResult` controls
// what `verifyGithubOidcToken` returns for the next call. The stub mirrors
// jose's audience enforcement: when the route passes an expected `audience`,
// a claims `aud` that doesn't match resolves to null (verification failure).
let verifyResult: GithubOidcClaims | null = null;
function setVerifyResult(result: GithubOidcClaims | null): void {
  verifyResult = result;
}

vi.mock('../../src/github/oidc-verify.ts', () => ({
  verifyGithubOidcToken: async (_token: string, opts?: { audience?: string }) => {
    if (verifyResult && opts?.audience !== undefined && verifyResult.aud !== opts.audience) {
      return null;
    }
    return verifyResult;
  },
}));

// The App JWT signer imports a real PKCS#8 PEM; the test secret is a placeholder,
// so stub it. The route only uses the returned string as a Bearer the fetch mock
// never inspects.
vi.mock('../../src/github/app-jwt.ts', () => ({
  createAppJwt: async () => 'app-jwt-stub',
}));

// Controls the DEFAULT mocked `GET /repos/{repo}/installation` live-revocation
// response. `installationId` defaults to the seeded connection's
// installation id ('1'); `accountId === null` echoes the active claims'
// `repository_owner_id` so the live owner check passes for legit cases. Tests
// that exercise the live-check rejections (404 / id mismatch / owner mismatch)
// mutate this before the exchange. `status` < 0 models the 404 "App not
// installed" signal (helper returns null).
let liveInstall: { status: number; installationId: string; accountId: string | null } = {
  status: 200,
  installationId: '1',
  accountId: null,
};
function setLiveInstall(
  next: Partial<{ status: number; installationId: string; accountId: string | null }>,
): void {
  liveInstall = { ...liveInstall, ...next };
}

// Controls the mocked GitHub compare response (`getBranchHeadComparisonStatus`)
// used by the OIDC stale-SHA guard. The exchange compares `claims.sha` against
// the live branch head and FAILS CLOSED: it proceeds ONLY when the branch head IS
// `claims.sha` ('identical'). 'ahead' (sha stale), 'behind' (branch moved backward
// off sha — abandoned commit), and 'diverged' (off-branch) are all rejected 409;
// null (API error/404) is unverifiable (503). Default 'identical' is the happy-
// path "sha IS the head" verdict, so tests that don't exercise the guard mint a
// token. Tests exercising the guard set it to 'ahead'/'behind'/'diverged'/null
// via `setCompareStatus`.
let compareStatus: string | null = 'identical';
function setCompareStatus(status: string | null): void {
  compareStatus = status;
}

// Per-call compare verdicts, consumed in order before falling back to the static
// `compareStatus`. The exchange compares TWICE — a pre-check before the build
// tx and a post-create re-check after the row insert (closing the compare→insert
// TOCTOU) — so the TOCTOU tests need the calls to DIFFER: first 'identical' (pass
// the pre-check, create the row), then 'ahead'/null (a newer push landed in the
// window). Reset to empty in beforeEach.
let compareStatusQueue: Array<string | null> = [];
function setCompareStatusQueue(queue: Array<string | null>): void {
  compareStatusQueue = [...queue];
}

// A one-shot side effect the `/compare/` fetch runs BEFORE returning, used by the
// route test to inject a revocation that commits AFTER the resolver +
// live-install checks but BEFORE the build tx (the compare call sits in that
// window — it precedes `getRepoInstallation` and `createGithubActionsBuildWithinLimit`,
// and the live `getRepoInstallation` reads the fetch mock, not the DB, so a
// DB-only suspend is caught only by the in-tx re-check). Consumed on first use.
let compareSideEffect: (() => Promise<void>) | null = null;
function setCompareSideEffect(fn: (() => Promise<void>) | null): void {
  compareSideEffect = fn;
}

// Controls the mocked `POST /repos/{repo}/check-runs` response for the
// best-effort "Void Build" check-run create at the end of a successful
// exchange. Default 200 returns a fixed id so happy-path exchanges persist it; a
// >=400 status models a create failure (`createCheckRun` returns null) — the
// exchange must still mint a token and persist NO check_run_id. Reset each test.
const CHECK_RUN_ID = '999001';
let checkRunCreateStatus = 200;
let checkRunSideEffect: (() => Promise<void>) | null = null;
function setCheckRunCreateStatus(status: number): void {
  checkRunCreateStatus = status;
}
// Counts successful `POST /check-runs` create calls across a test. The create
// mock returns a DISTINCT id per call (999001, 999002, ...) so a duplicated
// create on a repeated exchange is observable both by the count AND by a changed
// persisted `check_run_id`. A single-exchange test still sees the first id
// (999001 === CHECK_RUN_ID). Reset in beforeEach.
let checkRunCreateCount = 0;

const APP_ID = '123456';
const APP_KEY = 'pkcs8-pem-placeholder';

let env: TestEnv;

function makeApp(overrideEnv: TestEnv): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.use('*', async (context, next) => {
    context.set('db', overrideEnv.db);
    await next();
  });
  app.route('/auth', oidcRoutes);
  return app;
}

function makeClaims(overrides: Partial<GithubOidcClaims> = {}): GithubOidcClaims {
  const repository = overrides.repository ?? 'octo/repo';
  const ref = overrides.ref ?? 'refs/heads/main';
  // Default the workflow claims to the scaffolded `void-deploy.yml` for the
  // (possibly overridden) repository on the (possibly overridden) ref, so the
  // happy-path exchange satisfies the route's workflow binding. Tests that
  // exercise the binding rejection override `workflow_ref`/`job_workflow_ref`.
  const scaffoldRef = `${repository}/.github/workflows/void-deploy.yml@${ref}`;
  return {
    repository,
    repository_owner: repository.split('/')[0]!,
    // The owning account's immutable numeric id. The OIDC exchange binds it to
    // the installation's `account_id`, so the seeded installation's accountId
    // (see `seedActiveInstallation`) defaults to this same value for legit cases.
    repository_owner_id: 'octo-id',
    repository_id: '42',
    ref,
    sha: 'sha-oidc',
    run_id: '987654',
    run_attempt: '1',
    workflow: 'Deploy to Void',
    workflow_ref: scaffoldRef,
    job_workflow_ref: scaffoldRef,
    sub: `repo:${repository}:ref:${ref}`,
    aud: 'void',
    // The workflow trigger event. Defaults to the scaffolded `push` trigger so
    // every happy-path exchange satisfies the route's event allowlist; tests
    // exercising the allowlist override it (e.g. `pull_request_target`).
    event_name: 'push',
    ...overrides,
  };
}

async function exchange(
  app: Hono<ApiEnv>,
  appEnv: TestEnv,
  body: unknown,
  options?: { withSecrets?: boolean },
): Promise<Response> {
  const withSecrets = options?.withSecrets ?? true;
  // The route creates+persists the best-effort "Void Build" check run
  // SYNCHRONOUSLY (awaited before the token response), so the check-run POST and
  // persisted `check_run_id` are already durable when `app.fetch` resolves — no
  // `waitUntil` flush needed.
  return app.fetch(
    new Request('http://localhost/auth/github-oidc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {
      ...appEnv,
      GITHUB_APP_ID: withSecrets ? APP_ID : undefined,
      GITHUB_APP_PRIVATE_KEY: withSecrets ? APP_KEY : undefined,
    },
  );
}

async function clearBuildTables(db: Db): Promise<void> {
  await db.delete(builds);
  await db.delete(githubConnections);
  await db.delete(githubInstallations);
}

// Seed an `active` GitHub App installation so the OIDC connection lookup (which
// INNER JOINs github_installations and requires status='active') resolves. By
// default (no repositories supplied) it models an "all repositories" install
// (`repository_selection = 'all'`), so membership is not enforced; supplying a
// non-empty `repositories` array models a `selected` install that must contain
// the repo. Pass `repositorySelection` explicitly to override (e.g. to seed an
// empty `selected` install — the "no repos" state).
async function seedActiveInstallation(
  db: Db,
  installationId: string,
  repositories: ReadonlyArray<{ full_name: string; id: number }> = [],
  repositorySelection: 'all' | 'selected' = repositories.length > 0 ? 'selected' : 'all',
  // The installation's GitHub account id. The OIDC exchange binds this to the
  // token's `repository_owner_id` claim, so it defaults to `makeClaims`'s
  // default owner id ('octo-id') for legit cases. Override it to model a repo
  // transferred to a DIFFERENT owner (same repository_id, new account).
  accountId: string = 'octo-id',
): Promise<void> {
  await upsertGitHubInstallation(db, {
    installationId,
    userId: null,
    accountLogin: 'octo',
    accountId,
    accountType: 'Organization',
    repositories,
    repositorySelection,
  });
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

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearBuildTables(env.db);
  await clearTables(env.db);
  setVerifyResult(null);
  // Reset the live-install mock to the legit default for each test.
  liveInstall = { status: 200, installationId: '1', accountId: null };
  // Default to the happy-path 'identical' verdict (sha IS the head) so the
  // fail-closed guard lets tests that don't exercise it mint a token.
  setCompareStatus('identical');
  setCompareStatusQueue([]);
  setCompareSideEffect(null);
  // Default the best-effort check-run create to succeed with a fixed id.
  setCheckRunCreateStatus(200);
  checkRunSideEffect = null;
  checkRunCreateCount = 0;
  // The OIDC route makes a live `GET /repos/{repo}/installation` call
  // and a live `GET /repos/{repo}/compare/{base}...{branch}` call for
  // the stale-SHA guard (which first mints an installation token via
  // `POST /app/installations/{id}/access_tokens`). The default mock serves the
  // installation lookup with the seeded connection's installation id and the
  // active claims' repository_owner_id, mints a stub token, and returns the
  // (default 'identical') compare status.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/access_tokens')) {
        return Response.json({
          token: 'installation-token-stub',
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
      }
      if (url.includes('/check-runs')) {
        if (checkRunSideEffect) {
          const effect = checkRunSideEffect;
          checkRunSideEffect = null;
          await effect();
        }
        // The best-effort "Void Build" check-run create (end of the exchange).
        if (checkRunCreateStatus < 200 || checkRunCreateStatus >= 300) {
          return new Response('check-run create failed', { status: checkRunCreateStatus });
        }
        // Distinct id per successful create so a duplicate create is observable.
        // The first call returns 999001 (=== CHECK_RUN_ID) so single-exchange
        // tests keep asserting that value.
        checkRunCreateCount += 1;
        return Response.json({ id: 999000 + checkRunCreateCount });
      }
      if (url.includes('/compare/')) {
        // Fire the one-shot revocation side effect: the compare call is
        // the route step between the resolver/live-install checks and the build
        // tx, so a suspend committed here is caught only by the in-tx re-check.
        if (compareSideEffect) {
          const fn = compareSideEffect;
          compareSideEffect = null;
          await fn();
        }
        // null models a GitHub API error/404 (the helper returns null) so the
        // fail-closed guard rejects (503 unverifiable); a non-null value is the
        // comparison `status` ('identical'/'behind' proceed; 'ahead'/'diverged' 409).
        // A queued per-call verdict (TOCTOU tests) takes precedence over the static one.
        const verdict = compareStatusQueue.length > 0 ? compareStatusQueue.shift()! : compareStatus;
        if (verdict === null) {
          return new Response('not found', { status: 404 });
        }
        return Response.json({ status: verdict });
      }
      if (url.includes('/installation')) {
        if (liveInstall.status < 200 || liveInstall.status >= 300) {
          return new Response('not found', { status: liveInstall.status });
        }
        const accountId = liveInstall.accountId ?? verifyResult?.repository_owner_id ?? 'octo-id';
        return Response.json({
          id: liveInstall.installationId,
          account: { id: accountId },
        });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('POST /auth/github-oidc', () => {
  it('returns 503 when GitHub App secrets are unset', async () => {
    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 't', project: 'p' }, { withSecrets: false });
    expect(res.status).toBe(503);
  });

  it('returns 400 when oidcToken is missing', async () => {
    const app = makeApp(env);
    const res = await exchange(app, env, { project: 'p' });
    expect(res.status).toBe(400);
  });

  it('returns 401 on an invalid oidc token', async () => {
    const app = makeApp(env);
    setVerifyResult(null);
    const res = await exchange(app, env, { oidcToken: 'bad', project: 'p' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when no github_actions connection exists for the repo', async () => {
    const app = makeApp(env);
    setVerifyResult(makeClaims({ repository: 'octo/unconnected' }));
    const res = await exchange(app, env, { oidcToken: 't', project: 'p' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the user who authorized the connection is no longer owner or admin', async () => {
    const user = await createTestUser(env.db);
    const former = await createTestUser(env.db, 'oidc-former-owner');
    const project = await createTestProject(env.db, user.id, 'oidc-stale-authorizer');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      buildExecutor: 'github_actions',
      authorizedByUserId: former.id,
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 't', project: project.slug });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      'no authorized github actions connection for repository; reconnect the repository',
    );
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);
  });

  it('returns 401 when the connection is a container executor', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-container');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'container',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 't', project: project.slug });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the declared project slug does not match the connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-slug');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 't', project: 'a-different-slug' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the oidc token audience is not "void"', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-aud');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    // A token minted for a different audience must be rejected at verification.
    setVerifyResult(makeClaims({ aud: 'sigstore' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    // No build row is created when the audience check fails.
    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 when the oidc ref does not match the connected branch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-branch');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ ref: 'refs/heads/attacker' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 when the oidc ref is a tag', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-tag');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ ref: 'refs/tags/v1' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 when the oidc ref is a pull-request merge ref', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-pr');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ ref: 'refs/pull/1/merge' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  // verifyGithubOidcToken validates the signature but NOT claim TYPES, so a
  // signed-but-malformed token can carry a missing/non-string `ref`. The handler
  // must return the controlled 401 (the same response every other malformed claim
  // gets) rather than throwing on `.startsWith`/`.slice` into a global 500.
  it('returns 401 (not 500) when the oidc ref claim is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-no-ref');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    // makeClaims always sets `ref`; drop it to model the malformed token. The
    // type pins `ref: string`, so reach through a mutable record to delete it.
    const claims = makeClaims();
    delete (claims as unknown as Record<string, unknown>).ref;
    setVerifyResult(claims as unknown as GithubOidcClaims);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 (not 500) when the oidc ref claim is not a string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-bad-ref');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ ref: 123 as unknown as string }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('mints a scoped deploy token and creates a building actions build', async () => {
    const user = await createTestUser(env.db, 'octo-user');
    const project = await createTestProject(env.db, user.id, 'oidc-ok');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ sha: 'commit-xyz', run_id: '424242' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);

    const json = (await res.json()) as { token: string; projectId: string; buildId: string };
    expect(json.projectId).toBe(project.id);
    expect(json.token).toBeTruthy();
    expect(json.buildId).toBeTruthy();

    // The minted token is a project-scoped deploy token.
    const payload = await verifyDeployToken(json.token, JWT_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.aud).toBe('deploy');
    expect(payload!.sub).toBe(user.id);
    expect(payload!.project).toBe(project.id);
    expect(payload!.login).toBe('octo-user');
    // The token is bound to the created build so the deploy endpoint can reject
    // it once that build is superseded/cancelled by a newer run.
    expect(payload!.build).toBe(json.buildId);

    // A building actions build row was created with the OIDC run metadata.
    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(1);
    const build = projectBuilds[0]!;
    expect(build.id).toBe(json.buildId);
    expect(build.executor).toBe('github_actions');
    expect(build.status).toBe('building');
    expect(build.commit_sha).toBe('commit-xyz');
    expect(build.branch).toBe('main');
    expect(build.github_run_id).toBe('424242');
    expect(build.logs_url).toBe('https://github.com/octo/repo/actions/runs/424242');
  });

  it('returns 403 and creates no build when the project owner is manually suspended', async () => {
    const user = await createTestUser(env.db, 'oidc-suspended-owner');
    const project = await createTestProject(env.db, user.id, 'oidc-suspended');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await env.db
      .update(users)
      .set({ suspended_reason: 'platform policy violation' })
      .where(eq(users.id, user.id));
    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'project owner suspended',
      message: expect.any(String),
    });
    expect(await getProjectBuilds(env.db, project.id)).toEqual([]);
    expect(checkRunCreateCount).toBe(0);
  });

  // The github_actions executor has no BuildManager DO, so the OIDC exchange is
  // the only place the "Void Build" check run can be created. A successful create
  // must persist the returned id onto the build so the workflow_run completion
  // handler can finalize it.
  it('creates and persists a "Void Build" check run for a github_actions exchange', async () => {
    const user = await createTestUser(env.db, 'octo-check');
    const project = await createTestProject(env.db, user.id, 'oidc-check');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ sha: 'commit-check', run_id: '424243' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { buildId: string };

    const build = await getBuild(env.db, json.buildId);
    expect(build!.check_run_id).toBe(CHECK_RUN_ID);
  });

  // A check-run create is BEST-EFFORT: the deploy is the critical path and the
  // check is cosmetic. A failed create (5xx here) must NOT fail the OIDC exchange
  // or block the deploy token — the exchange still returns 200 + a token, and the
  // build simply carries a NULL check_run_id (finalizers no-op on it).
  it('does not fail the exchange when check-run creation fails', async () => {
    const user = await createTestUser(env.db, 'octo-check-fail');
    const project = await createTestProject(env.db, user.id, 'oidc-check-fail');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ run_id: '424244' }));
    // The check-run POST fails; createCheckRun returns null.
    setCheckRunCreateStatus(500);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { token: string; buildId: string };
    expect(json.token).toBeTruthy();

    const build = await getBuild(env.db, json.buildId);
    expect(build!.check_run_id).toBeNull();
  });

  // Rerun-correctness — the exchange captures the OIDC `run_attempt` claim onto
  // the build row so the workflow_run completion handler can match a redelivered
  // completion to the right attempt. A token without the claim is rejected.
  it('captures the github_run_attempt claim onto the created build', async () => {
    const user = await createTestUser(env.db, 'octo-attempt');
    const project = await createTestProject(env.db, user.id, 'oidc-attempt');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ run_id: '525252', run_attempt: '3' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(1);
    expect(projectBuilds[0]!.github_run_id).toBe('525252');
    expect(projectBuilds[0]!.github_run_attempt).toBe('3');
  });

  it('returns 401 and creates no build when the run_attempt claim is missing', async () => {
    const user = await createTestUser(env.db, 'octo-no-attempt');
    const project = await createTestProject(env.db, user.id, 'oidc-no-attempt');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult({
      ...makeClaims({ run_id: '626262' }),
      run_attempt: undefined,
    } as unknown as GithubOidcClaims);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe('oidc token missing run_attempt');
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  // The minted deploy token is exchanged BEFORE the workflow runs
  // install + build + upload + finalize, so its TTL must cover the owner's plan
  // build timeout (+ margin), NOT the fixed 15-min default. A tier with a build
  // timeout > 15 min (sponsored = 20) would otherwise expire mid-deploy.
  it('sizes the deploy token TTL to the owner plan build timeout, not the 15-min default', async () => {
    // sponsored plan: buildTimeoutMinutes = 20 (> 15). Expected TTL is
    // 20*60 + 300 margin = 1500s.
    const user = await createTestUser(env.db, 'octo-sponsored', 'github', undefined, 'sponsored');
    const project = await createTestProject(env.db, user.id, 'oidc-ttl');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);

    const json = (await res.json()) as { token: string };
    const payload = await verifyDeployToken(json.token, JWT_SECRET);
    expect(payload).not.toBeNull();
    // exp - iat is the token TTL. sponsored = 20*60 + 300 margin = 1500s.
    const ttl = payload!.exp - payload!.iat;
    expect(ttl).toBeGreaterThan(15 * 60); // strictly longer than the old default
    // A few seconds of slack for any clock rounding across the mint.
    expect(Math.abs(ttl - (20 * 60 + 5 * 60))).toBeLessThanOrEqual(5);
  });

  it('freezes a newly admitted Actions token timeout before later plan edits', async () => {
    const catalog = createDefaultPlanCatalog();
    const source = catalog.plans.find((plan) => plan.id === 'sponsored')!;
    const studio = { ...source, id: 'studio', name: 'Studio' };
    await writePlanCatalog(env.db, { ...catalog, plans: [...catalog.plans, studio] });
    const user = await createTestUser(env.db, 'snapshot-builder', 'github', undefined, 'studio');
    const project = await createTestProject(env.db, user.id, 'oidc-timeout-snapshot');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    checkRunSideEffect = async () => {
      await writePlanCatalog(env.db, {
        ...catalog,
        plans: [
          ...catalog.plans,
          { ...studio, limits: { ...studio.limits, buildTimeoutMinutes: 1 } },
        ],
      });
    };
    setVerifyResult(makeClaims());
    const response = await exchange(makeApp(env), env, {
      oidcToken: 'good',
      project: project.slug,
    });
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const payload = await verifyDeployToken(token, JWT_SECRET);
    expect(payload!.exp - payload!.iat).toBe(20 * 60 + 5 * 60);
  });

  it('accepts the exchange when no project slug is supplied in the body', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-noslug');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { projectId: string };
    expect(json.projectId).toBe(project.id);
  });

  // ---------------------------------------------------------------------------
  // The OIDC exchange must honor GitHub App revocation / repo removal.
  // GitHub Actions OIDC is independent of the App, so without these guards a
  // repo workflow could keep minting deploy tokens after the App is suspended/
  // deleted or the repo dropped from the installation.
  // ---------------------------------------------------------------------------

  it('returns 401 and creates no build when the installation is suspended', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-suspended');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await markGitHubInstallationStatus(env.db, '1', 'suspended');

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 and creates no build when the installation is deleted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-deleted');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await markGitHubInstallationStatus(env.db, '1', 'deleted');

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 when the repo is not in a populated installation selection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-not-selected');
    // Populated selection that does NOT include octo/repo (neither its id 42 nor
    // its name).
    await seedActiveInstallation(env.db, '1', [{ full_name: 'octo/other', id: 999 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('mints a token when the installation is active and the repo is selected', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-selected');
    // Populated selection that DOES include octo/repo by its immutable id 42
    // (membership is matched by id when the claim carries one — see
    // getGitHubActionsConnectionsByRepo).
    await seedActiveInstallation(env.db, '1', [{ full_name: 'octo/repo', id: 42 }]);
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(1);
  });

  it('mints a token for an "all repositories" install regardless of the cache', async () => {
    // An `all`-repos install grants every repo; the empty `repositories` cache
    // must NOT be treated as "repo removed" in that mode.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-allrepos');
    await seedActiveInstallation(env.db, '1', [], 'all');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
  });

  // A revocation that commits in the LATER-tx window (after the resolver
  // and the live-install checks, before the build tx) must still be caught. The
  // compare-fetch side effect suspends the install in exactly that window; the
  // live `getRepoInstallation` reads the (still-active) fetch mock, so only the
  // in-tx re-check sees the DB suspend. The exchange returns 401 and mints no
  // token / creates no build.
  it('returns 401 and creates no build when the install is revoked between the resolver and the build tx', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-late-revoke');
    await seedActiveInstallation(env.db, '1', [], 'all');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    setCompareSideEffect(async () => {
      await markGitHubInstallationStatus(env.db, '1', 'suspended');
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  // The connection the route resolves can be DISCONNECTED and RECONNECTED
  // (to a different repo) between resolution and the build tx. `project_id` is
  // UNIQUE, so the reconnect DELETEs the old row and CREATEs a new one with a fresh
  // id. Same installation_id + repository_id => the live-install check AND the
  // in-tx install re-check both PASS; only the in-tx id-match catches the swap. The
  // compare-fetch side effect performs the swap in exactly that window; the
  // exchange returns 409 and mints no token / creates no build.
  it('returns 409 and creates no build when the connection is replaced between the resolver and the build tx', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-replaced');
    await seedActiveInstallation(env.db, '1', [], 'all');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    // Swap the connection for a fresh row (same project/install/repo/branch, new id)
    // in the resolver->tx window — proving the install check does NOT catch it.
    setCompareSideEffect(async () => {
      await deleteGitHubConnection(env.db, project.id);
      await createGitHubConnection(env.db, {
        projectId: project.id,
        installationId: '1',
        repoFullName: 'octo/repo',
        repositoryId: '42',
        branch: 'main',
        buildExecutor: 'github_actions',
      });
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // An empty `repositories` array does not mean "all repos".
  // installation_repositories can legitimately reduce a `selected`
  // install's cache to [] when the last selected repo is removed; that repo's
  // workflow must STOP minting tokens, not keep minting because the array is
  // empty. The `repository_selection` enum disambiguates the two cases.
  // ---------------------------------------------------------------------------

  it('returns 401 when the last selected repo was removed (selected + empty cache)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-removed');
    // `selected` install whose cache is now empty (the repo was removed). The
    // installation itself is still active.
    await seedActiveInstallation(env.db, '1', [], 'selected');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 after installation_repositories removes the last selected repo', async () => {
    // End-to-end: a `selected` install that had the repo, then the webhook
    // delta removes it (leaving repositories=[]), must reject the next exchange.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-removed-delta');
    await seedActiveInstallation(env.db, '1', [{ full_name: 'octo/repo', id: 42 }], 'selected');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    // The last selected repo is removed; the install stays `selected`.
    await setGitHubInstallationRepositories(env.db, '1', [], 'selected');

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
  });

  it('returns 409 and creates no build when the project is being deleted', async () => {
    // Concurrent teardown flipped the project to `deleting` (lockAndMarkDeleting
    // holds projects FOR UPDATE). The connection resolver does NOT filter on
    // project status, so the exchange still reaches the build tx; the in-tx
    // projects FOR UPDATE check must reject rather than mint a token / orphan a
    // `building` row that teardown's cascade already raced past.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-deleting');
    await seedActiveInstallation(env.db, '1', [{ full_name: 'octo/repo', id: 42 }], 'selected');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Repeated OIDC exchanges for the same GitHub run must be idempotent.
  // Without reuse, each exchange inserts a fresh `building` row; the
  // workflow_run webhook only finalizes the newest, so older rows stay
  // `building` forever and consume the owner's active-build slots.
  // ---------------------------------------------------------------------------

  it('reuses the existing in-flight build on a repeated exchange for the same run', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-idempotent');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    setVerifyResult(makeClaims({ run_id: '555' }));
    const first = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { buildId: string };

    setVerifyResult(makeClaims({ run_id: '555' }));
    const second = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { token: string; buildId: string };

    // Second exchange returns a token without creating a duplicate build.
    expect(secondJson.token).toBeTruthy();
    expect(secondJson.buildId).toBe(firstJson.buildId);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(1);
    expect(projectBuilds[0]!.github_run_id).toBe('555');
  });

  // A repeated exchange for the SAME run reuses the in-flight build (above). That
  // reused row already carries the check_run_id its creating exchange persisted,
  // so the check-run create MUST be skipped — otherwise a retry POSTs a SECOND
  // "Void Build" run and overwrites the id, orphaning the first `in_progress`
  // forever. Distinct per-call ids make an accidental duplicate visible (both the
  // POST count and the persisted id would change).
  it('creates the "Void Build" check run exactly once across repeated exchanges for the same run', async () => {
    const user = await createTestUser(env.db, 'octo-check-dup');
    const project = await createTestProject(env.db, user.id, 'oidc-check-dup');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    setVerifyResult(makeClaims({ run_id: '556' }));
    const first = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { buildId: string };
    // The creating exchange POSTed the check run once and persisted its id.
    expect(checkRunCreateCount).toBe(1);
    const firstBuild = await getBuild(env.db, firstJson.buildId);
    expect(firstBuild!.check_run_id).toBe('999001');

    setVerifyResult(makeClaims({ run_id: '556' }));
    const second = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { buildId: string };
    expect(secondJson.buildId).toBe(firstJson.buildId);

    // No SECOND check-run POST — the reused build already had one.
    expect(checkRunCreateCount).toBe(1);
    // check_run_id is unchanged (NOT overwritten with a second run's id).
    const reusedBuild = await getBuild(env.db, secondJson.buildId);
    expect(reusedBuild!.check_run_id).toBe('999001');
  });

  // Hardening for the pathological concurrent same-(run, attempt) residual: two
  // truly overlapping exchanges can both read a null id and both POST, but
  // setBuildCheckRunId is CAS `check_run_id IS NULL`, so the second (racing)
  // persist no-ops rather than clobbering the first — the DB keeps ONE stable,
  // completion-tracked id.
  it('setBuildCheckRunId is immutable once set (never overwrites a persisted id)', async () => {
    const user = await createTestUser(env.db, 'octo-check-immutable');
    const project = await createTestProject(env.db, user.id, 'oidc-check-immutable');
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      commitSha: 'sha-immutable',
      branch: 'main',
      githubRunId: '777',
    });

    await setBuildCheckRunId(env.db, build.id, '900001');
    expect((await getBuild(env.db, build.id))!.check_run_id).toBe('900001');

    // A racing second write for the same build must NOT clobber the persisted id.
    await setBuildCheckRunId(env.db, build.id, '900002');
    expect((await getBuild(env.db, build.id))!.check_run_id).toBe('900001');
  });

  it('enforces a single build row per project+GitHub run ATTEMPT at the DB layer', async () => {
    // Durability guard for the composite partial-unique index (migration 0025):
    // even if the get-existing reuse path were bypassed, the DB must reject a
    // second row for the same (project_id, github_run_id, github_run_attempt).
    // Two `building` rows for one run ATTEMPT is the state that leaks an
    // active-build slot — but two DIFFERENT attempts of the same run may coexist
    // (a rerun), and NULL-attempt rows are exempt entirely.
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-unique-index');
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      githubRunId: '888',
      githubRunAttempt: '1',
    });

    // A second active row for the SAME run_id + attempt is rejected.
    await expect(
      createTestBuild(env.db, {
        projectId: project.id,
        userId: user.id,
        executor: 'github_actions',
        status: 'building',
        githubRunId: '888',
        githubRunAttempt: '1',
      }),
    ).rejects.toThrow();

    // A DIFFERENT attempt of the same run_id is allowed to be transiently active
    // (a redelivered late completion for attempt 1 while attempt 2 builds).
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      githubRunId: '888',
      githubRunAttempt: '2',
    });

    // A NULL github_run_id (the container-build path) is exempt: many rows are
    // allowed, so the partial WHERE clause does not break container builds.
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });
    await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
    });
    const all = await getProjectBuilds(env.db, project.id);
    expect(all.filter((b) => b.github_run_id === null).length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Build identity is scoped to the project, because a GitHub `run_id` is
  // unique only WITHIN a repository, not globally. Two different connected
  // repos/projects that happen to share a numeric run_id must each get their
  // own build with no cross-project collision on the composite unique index.
  // ---------------------------------------------------------------------------

  it('lets two different projects share a run_id without colliding', async () => {
    const userA = await createTestUser(env.db, 'octo-a');
    const userB = await createTestUser(env.db, 'octo-b');
    const projectA = await createTestProject(env.db, userA.id, 'oidc-collide-a');
    const projectB = await createTestProject(env.db, userB.id, 'oidc-collide-b');
    await seedActiveInstallation(env.db, '1');
    await seedActiveInstallation(env.db, '2');
    await createGitHubConnection(env.db, {
      projectId: projectA.id,
      installationId: '1',
      repoFullName: 'octo/a',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: projectB.id,
      installationId: '2',
      repoFullName: 'octo/b',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    // Same run_id for two different repos/projects.
    setVerifyResult(makeClaims({ repository: 'octo/a', run_id: '777' }));
    setLiveInstall({ installationId: '1' });
    const resA = await exchange(app, env, { oidcToken: 'good', project: projectA.slug });
    expect(resA.status).toBe(200);

    setVerifyResult(makeClaims({ repository: 'octo/b', run_id: '777' }));
    // Project B is backed by installation '2'; the live check must agree.
    setLiveInstall({ installationId: '2' });
    const resB = await exchange(app, env, { oidcToken: 'good', project: projectB.slug });
    expect(resB.status).toBe(200);

    const buildsA = await getProjectBuilds(env.db, projectA.id);
    const buildsB = await getProjectBuilds(env.db, projectB.id);
    expect(buildsA.length).toBe(1);
    expect(buildsB.length).toBe(1);
    expect(buildsA[0]!.github_run_id).toBe('777');
    expect(buildsB[0]!.github_run_id).toBe('777');
    expect(buildsA[0]!.id).not.toBe(buildsB[0]!.id);
  });

  // ---------------------------------------------------------------------------
  // GitHub Actions builds must respect the owner's per-tier build
  // concurrency. A free user (concurrentBuilds=1) at their cap gets 429 on a
  // NEW run for a DIFFERENT project (which can't free the slot via the per
  // project+branch supersede), but an idempotent repeat of an already-active run
  // still returns its token (reuse does not double-count the slot).
  // (A NEW run for the SAME project+branch instead supersedes the active build —
  // latest-wins — and is covered separately below.)
  // ---------------------------------------------------------------------------

  it('returns 429 for a NEW run on another project when the owner is at their cap', async () => {
    const user = await createTestUser(env.db); // free => concurrentBuilds = 1
    const project = await createTestProject(env.db, user.id, 'oidc-concurrency');
    const otherProject = await createTestProject(env.db, user.id, 'oidc-concurrency-2');
    await seedActiveInstallation(env.db, '1');
    await seedActiveInstallation(env.db, '2');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: otherProject.id,
      installationId: '2',
      repoFullName: 'octo/other',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    // First run occupies the single free-tier slot.
    setVerifyResult(makeClaims({ run_id: '111' }));
    const first = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(first.status).toBe(200);

    // A NEW run for a DIFFERENT project is rejected — would exceed the cap, and
    // can't supersede the active build (different project). Mints no build/token.
    setVerifyResult(makeClaims({ repository: 'octo/other', run_id: '222' }));
    setLiveInstall({ installationId: '2' });
    const second = await exchange(app, env, { oidcToken: 'good', project: otherProject.slug });
    expect(second.status).toBe(429);

    // An idempotent repeat of the already-active run still returns its token.
    setVerifyResult(makeClaims({ run_id: '111' }));
    setLiveInstall({ installationId: '1' });
    const repeat = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(repeat.status).toBe(200);

    // Only the first run's build exists (the capped run created nothing).
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
    expect((await getProjectBuilds(env.db, otherProject.id)).length).toBe(0);
    expect((await getProjectBuilds(env.db, project.id))[0]!.github_run_id).toBe('111');
  });

  it('supersedes the active build when a NEW run targets the SAME project+branch (latest-wins)', async () => {
    const user = await createTestUser(env.db); // free => concurrentBuilds = 1
    const project = await createTestProject(env.db, user.id, 'oidc-supersede');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    setVerifyResult(makeClaims({ run_id: '111' }));
    const first = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { buildId: string };

    // A NEWER run for the same project+branch supersedes the first (freeing the
    // single free-tier slot) rather than being capped.
    setVerifyResult(makeClaims({ run_id: '222' }));
    const second = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { buildId: string };

    const builds111 = await getBuild(env.db, firstJson.buildId);
    expect(builds111!.status).toBe('cancelled');
    expect(builds111!.error).toBe('superseded by newer run');
    expect((await getBuild(env.db, secondJson.buildId))!.status).toBe('building');
  });

  // ---------------------------------------------------------------------------
  // Build-slot acquisition must be ATOMIC per user. A count-then-insert flow
  // would let two PARALLEL exchanges for DIFFERENT run_ids each read capacity
  // below the cap before either inserted, then both insert, bypassing
  // `concurrentBuilds`. Slot acquisition runs in one transaction under a
  // per-user FOR UPDATE lock, so concurrent exchanges serialize.
  // ---------------------------------------------------------------------------

  it('admits only ONE of two concurrent exchanges for different runs at a cap of 1', async () => {
    const user = await createTestUser(env.db); // free => concurrentBuilds = 1
    const project = await createTestProject(env.db, user.id, 'oidc-race');
    await seedActiveInstallation(env.db, '1');
    const connection = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    // The OIDC verifier stub is a shared module-level value, so two genuinely
    // concurrent exchanges can't each carry their own claims through a single
    // `verifyResult`. Drive the race at the db layer instead — the route's
    // entire slot-acquisition + insert is `createGithubActionsBuildWithinLimit`,
    // so racing it directly exercises the exact code path the route runs.
    const [a, b] = await Promise.all([
      createGithubActionsBuildWithinLimit(env.db, {
        projectId: project.id,
        githubRunId: '301',
        githubRunAttempt: '1',
        connectionId: connection.id,
        installationId: '1',
        repositoryId: '42',
        expectedWorkflowPath: '.github/workflows/void-deploy.yml',
      }),
      createGithubActionsBuildWithinLimit(env.db, {
        projectId: project.id,
        githubRunId: '302',
        githubRunAttempt: '1',
        connectionId: connection.id,
        installationId: '1',
        repositoryId: '42',
        expectedWorkflowPath: '.github/workflows/void-deploy.yml',
      }),
    ]);

    // Exactly one created, one limit-exceeded — never two creates.
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['created', 'limit-exceeded']);

    // Only one active build exists for the owner.
    const projectBuilds = await getProjectBuilds(env.db, project.id);
    const active = projectBuilds.filter((bld) =>
      ['starting', 'building', 'deploying'].includes(bld.status),
    );
    expect(active.length).toBe(1);
  });

  // The connected branch can be re-pointed by a PATCH after the route's pre-tx
  // branch check (which reads the OLD connection snapshot and passes) but before
  // the helper acquires the FOR UPDATE row lock. The locked row is authoritative:
  // the helper sees the new branch, returns `branch-mismatch`, the route maps it
  // to 409, and NO build is created from the now-untrusted old branch. Drives the
  // race deterministically by committing the PATCH inside the `/compare/` fetch
  // mock, which the route calls AFTER the pre-tx branch check and BEFORE the
  // helper's locked re-read.
  it('returns 409 and creates no build when the branch is re-pointed mid-exchange', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-branch-race');
    await seedActiveInstallation(env.db, '1');
    // Connection starts on branch A ('main').
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    const app = makeApp(env);
    setVerifyResult(makeClaims({ ref: 'refs/heads/main', sha: 'sha-oidc' }));

    // Re-point the connection from A ('main') to B ('release') inside the compare
    // fetch — landing AFTER the route's pre-tx branch check (which saw 'main') and
    // BEFORE the helper's FOR UPDATE lock re-read.
    let patched = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/access_tokens')) {
          return Response.json({
            token: 'installation-token-stub',
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          });
        }
        if (url.includes('/compare/')) {
          if (!patched) {
            patched = true;
            await updateGitHubConnection(env.db, project.id, { branch: 'release' });
          }
          return Response.json({ status: 'identical' });
        }
        if (url.includes('/installation')) {
          return Response.json({ id: '1', account: { id: 'octo-id' } });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'connected branch changed concurrently',
    });

    // No build was created from the now-untrusted old branch.
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // A completed GitHub Actions run must be re-runnable. The composite
  // partial-unique index is scoped to ACTIVE statuses, so once the prior
  // attempt is terminal a RERUN of the same run_id can start a FRESH build
  // (instead of colliding on a persisted terminal row and throwing). The
  // workflow_run webhook then finalizes the active rerun, not the old row.
  // ---------------------------------------------------------------------------

  it('lets a run be re-run after the prior attempt reaches a terminal status', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-rerun');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);

    // First exchange for run 700 creates a building build.
    setVerifyResult(makeClaims({ run_id: '700' }));
    const first = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { buildId: string };

    // Finalize that build terminal (mirrors the workflow_run webhook outcome).
    await updateBuildStatus(env.db, firstJson.buildId, 'failed', {
      completedAt: new Date().toISOString(),
    });

    // A RERUN of the SAME run_id must mint a token with a NEW active build,
    // not 500 on the persisted terminal row.
    setVerifyResult(makeClaims({ run_id: '700' }));
    const rerun = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(rerun.status).toBe(200);
    const rerunJson = (await rerun.json()) as { token: string; buildId: string };
    expect(rerunJson.token).toBeTruthy();
    expect(rerunJson.buildId).not.toBe(firstJson.buildId);

    // Both rows persist (one terminal, one active) for the same run_id.
    const projectBuilds = await getProjectBuilds(env.db, project.id);
    const run700 = projectBuilds.filter((bld) => bld.github_run_id === '700');
    expect(run700.length).toBe(2);
    const rerunBuild = run700.find((bld) => bld.id === rerunJson.buildId)!;
    expect(rerunBuild.status).toBe('building');
  });

  // ---------------------------------------------------------------------------
  // The OIDC exchange must bind the deploy token to the SCAFFOLDED deploy
  // workflow (`.github/workflows/void-deploy.yml`). Otherwise any other workflow
  // in the connected repo that can request `id-token: write` on the connected
  // branch (a hand-added workflow, an unsafe `pull_request_target`, a manual
  // `workflow_dispatch` of a different file) could mint a deploy token and act
  // as a deploy oracle.
  // ---------------------------------------------------------------------------

  it('returns 401 and creates no build when the workflow is not void-deploy.yml', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-wrong-workflow');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      // repositoryId set so the connection resolves and the request reaches the
      // (post-lookup) workflow-path gate — the point of THIS test.
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    // A DIFFERENT workflow file in the same repo on the connected branch — the
    // token is otherwise valid (right repo, right branch, right audience).
    const otherWorkflow = 'octo/repo/.github/workflows/other.yml@refs/heads/main';
    setVerifyResult(makeClaims({ workflow_ref: otherWorkflow, job_workflow_ref: otherWorkflow }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);

    const projectBuilds = await getProjectBuilds(env.db, project.id);
    expect(projectBuilds.length).toBe(0);
  });

  it('returns 401 when a void-deploy.yml path is spoofed under a different repo prefix', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-spoof-prefix');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      // repositoryId set so the connection resolves and the spoofed path is
      // rejected by the workflow-path gate (not by connection-not-found).
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    // The path component is void-deploy.yml but the repo prefix is NOT the
    // running repo (`claims.repository`), so the binding must reject it.
    const spoofed = 'attacker/evil/.github/workflows/void-deploy.yml@refs/heads/main';
    setVerifyResult(makeClaims({ workflow_ref: spoofed, job_workflow_ref: spoofed }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 401 when the workflow_ref claim is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-no-workflow-ref');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ workflow_ref: '', job_workflow_ref: '' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('mints a token for the scaffolded void-deploy.yml workflow on the connected branch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-good-workflow');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    // makeClaims defaults workflow_ref/job_workflow_ref to the scaffolded path.
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  it('mints a token when the run matches the connection custom workflow_path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-custom-workflow');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
      // Owner pinned a non-scaffolded workflow file.
      workflowPath: '.github/workflows/ci.yml',
    });

    const app = makeApp(env);
    const ciRef = 'octo/repo/.github/workflows/ci.yml@refs/heads/main';
    setVerifyResult(makeClaims({ workflow_ref: ciRef, job_workflow_ref: ciRef }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  it('returns 401 for the scaffolded void-deploy.yml when the connection pins a custom path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-custom-rejects-default');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
      workflowPath: '.github/workflows/ci.yml',
    });

    const app = makeApp(env);
    // makeClaims defaults to the scaffolded void-deploy.yml path, which this
    // connection no longer authorizes (it pins ci.yml) — REPLACE semantics.
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('pins each connection to its own workflow_path when two projects share a repo', async () => {
    const user = await createTestUser(env.db);
    const projectDefault = await createTestProject(env.db, user.id, 'oidc-iso-default');
    const projectCustom = await createTestProject(env.db, user.id, 'oidc-iso-custom');
    await seedActiveInstallation(env.db, '1');
    // Both projects connect to the SAME repo via the same installation; each
    // pins a DIFFERENT workflow. A global constant could not produce the
    // asymmetric rejections below.
    await createGitHubConnection(env.db, {
      projectId: projectDefault.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
      // default workflow_path === '.github/workflows/void-deploy.yml'
    });
    await createGitHubConnection(env.db, {
      projectId: projectCustom.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
      workflowPath: '.github/workflows/ci.yml',
    });

    const app = makeApp(env);
    const defaultRef = 'octo/repo/.github/workflows/void-deploy.yml@refs/heads/main';
    const ciRef = 'octo/repo/.github/workflows/ci.yml@refs/heads/main';

    // The default-pinned project rejects a ci.yml run...
    setVerifyResult(makeClaims({ workflow_ref: ciRef, job_workflow_ref: ciRef }));
    const crossA = await exchange(app, env, { oidcToken: 'good', project: projectDefault.slug });
    expect(crossA.status).toBe(401);

    // ...and the ci.yml-pinned project rejects the scaffolded void-deploy.yml run.
    setVerifyResult(makeClaims({ workflow_ref: defaultRef, job_workflow_ref: defaultRef }));
    const crossB = await exchange(app, env, { oidcToken: 'good', project: projectCustom.slug });
    expect(crossB.status).toBe(401);

    // No build was created for either cross-workflow attempt.
    expect((await getProjectBuilds(env.db, projectDefault.id)).length).toBe(0);
    expect((await getProjectBuilds(env.db, projectCustom.id)).length).toBe(0);

    // Each still mints for ITS OWN workflow (custom pins ci.yml).
    setVerifyResult(makeClaims({ workflow_ref: ciRef, job_workflow_ref: ciRef }));
    const own = await exchange(app, env, { oidcToken: 'good', project: projectCustom.slug });
    expect(own.status).toBe(200);
    expect((await getProjectBuilds(env.db, projectCustom.id)).length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Connection identity must be keyed on the IMMUTABLE numeric repository
  // id, not the mutable `repo_full_name`. A repo whose full_name now matches a
  // connection but whose id differs (name reuse) must NOT mint a token; a
  // renamed repo (same id, new full_name) must STILL resolve.
  // ---------------------------------------------------------------------------

  it('returns 401 when the full_name matches but the repository_id differs (name reuse)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-id-mismatch');
    await seedActiveInstallation(env.db, '1');
    // Connection pinned to repository_id '100' for octo/repo.
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '100',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    // A token for the same full_name but a DIFFERENT repo id (octo/repo was
    // deleted and recreated, reusing the name) — must be rejected.
    setVerifyResult(makeClaims({ repository: 'octo/repo', repository_id: '999' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('still resolves a renamed repo by its immutable id (same id, new full_name)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-renamed');
    // The installation now caches the repo under its NEW name; the connection
    // still stores the OLD full_name but the immutable id is unchanged.
    await seedActiveInstallation(env.db, '1', [{ full_name: 'octo/renamed', id: 100 }], 'selected');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/old-name',
      repositoryId: '100',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    // OIDC token carries the NEW full_name but the SAME repository_id.
    setVerifyResult(makeClaims({ repository: 'octo/renamed', repository_id: '100' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // A repo may back MULTIPLE github_actions projects (only project_id is
  // unique). Resolution must select the connection by the workflow's requested
  // project slug, so an OLDER project still deploys (it must not always lose to
  // the newest connection). With no slug, an ambiguous repo must be rejected.
  // ---------------------------------------------------------------------------

  it('mints a token for the OLDER project when two projects share a repo and a slug is given', async () => {
    const user = await createTestUser(env.db);
    const projectOld = await createTestProject(env.db, user.id, 'oidc-multi-old');
    const projectNew = await createTestProject(env.db, user.id, 'oidc-multi-new');
    await seedActiveInstallation(env.db, '1');
    // Old connection created first; new connection created second (newest).
    await createGitHubConnection(env.db, {
      projectId: projectOld.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: projectNew.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: projectOld.slug });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { projectId: string };
    expect(json.projectId).toBe(projectOld.id);

    // The build was created for the older project, not the newest connection.
    expect((await getProjectBuilds(env.db, projectOld.id)).length).toBe(1);
    expect((await getProjectBuilds(env.db, projectNew.id)).length).toBe(0);
  });

  it('returns 401 (ambiguous) when two projects share a repo and no slug is supplied', async () => {
    const user = await createTestUser(env.db);
    const projectA = await createTestProject(env.db, user.id, 'oidc-ambig-a');
    const projectB = await createTestProject(env.db, user.id, 'oidc-ambig-b');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: projectA.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });
    await createGitHubConnection(env.db, {
      projectId: projectB.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good' });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toContain('multiple projects');

    expect((await getProjectBuilds(env.db, projectA.id)).length).toBe(0);
    expect((await getProjectBuilds(env.db, projectB.id)).length).toBe(0);
  });

  it('returns 401 when the repository_id claim is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-no-repo-id');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ repository_id: '' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 401 when the repository_owner_id claim is missing', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-no-owner-id');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ repository_owner_id: '' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // A repo TRANSFER keeps the immutable `repository_id` but changes the
  // owning account. Without binding the connection's installation account to the
  // OIDC `repository_owner_id`, a workflow in the NEW owner's repo would match
  // the OLD owner's stale `all`-repos connection (same id) and mint a deploy
  // token for the wrong project.
  // ---------------------------------------------------------------------------

  it('returns 401 when a transferred repo (same id, new owner) hits a stale all-repos connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-transferred');
    // Alice's `all`-repos install owns the connection, pinned to repository_id 42.
    await seedActiveInstallation(env.db, '1', [], 'all', 'alice-id');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    // The repo was transferred to Bob: SAME repository_id, but the OIDC owner id
    // is now Bob's. Must not match Alice's stale connection.
    setVerifyResult(makeClaims({ repository_id: '42', repository_owner_id: 'bob-id' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('mints a token when the OIDC repository_owner_id matches the installation account', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-owner-match');
    // `all`-repos install owned by alice-id; the OIDC token's owner id matches.
    await seedActiveInstallation(env.db, '1', [], 'all', 'alice-id');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ repository_id: '42', repository_owner_id: 'alice-id' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // The cached `github_installations` state can lag a missed/delayed
  // installation / suspend / installation_repositories webhook, so the OIDC
  // exchange ALSO makes a live App-JWT `GET /repos/{repo}/installation` call
  // and fails closed when the App no longer covers the repo (404), the covering
  // installation id changed, or the live owner differs from the OIDC owner claim.
  // ---------------------------------------------------------------------------

  it('returns 401 and creates no build when the live install check 404s (App removed)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-live-404');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    // The cache still says active, but the App was uninstalled/suspended on the
    // repo — GitHub returns 404 for the live lookup.
    setLiveInstall({ status: 404 });

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 401 and creates no build when the live installation id mismatches', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-live-id-mismatch');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    // The repo is now covered by a DIFFERENT installation than the connection's.
    setLiveInstall({ installationId: '999' });

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 401 and creates no build when the live owner differs from the OIDC owner claim', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-live-owner-mismatch');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    // The live install resolves, with the right installation id, but to a
    // DIFFERENT owning account than the OIDC `repository_owner_id` claim.
    setLiveInstall({ accountId: 'someone-else-id' });

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Stale-SHA guard (FAIL-CLOSED) — the auto-deploy OIDC exchange must proceed
  // ONLY when the live branch head IS `claims.sha` ('identical'). Every other
  // verdict is rejected 409: 'ahead' (sha behind the head — stale), 'behind' (the
  // branch head no longer contains the sha — moved BACKWARD off it via force-
  // push/rollback, so the sha is an abandoned commit), and 'diverged' (sha force-
  // pushed off-branch). An unverifiable verdict (null = compare API unreachable)
  // is rejected 503 (retryable). Failing open here would let an OLDER or abandoned
  // run supersede the newer active build + mint a token during a GitHub API
  // outage, rolling the project back.
  // ---------------------------------------------------------------------------

  it('returns 409 and creates no build when claims.sha is behind the branch head (compare === ahead)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-stale-sha');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ sha: 'old-commit' }));
    // The live branch head is AHEAD of this run's sha — it was superseded.
    setCompareStatus('ahead');

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('mints a token when the run sha IS the branch head (compare === identical)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-head-sha');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    // The run's sha IS the live head — proceed and mint.
    setCompareStatus('identical');

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  it('returns 503 and creates no build when the compare API is unreachable (compare === null)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-compare-unreachable');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    // The compare API is unreachable (404/error → helper returns null). We can't
    // prove freshness, so fail closed with a retryable 503 — never proceed.
    setCompareStatus(null);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(503);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 409 and creates no build when claims.sha is off-branch (compare === diverged)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-diverged-sha');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ sha: 'force-pushed-away' }));
    // The sha was force-pushed off the branch — it is no longer an ancestor of
    // the head. Definitively stale; reject 409.
    setCompareStatus('diverged');

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 409 and creates no build when the branch head was moved backward off the sha (compare === behind)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-behind-head');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ sha: 'abandoned-commit' }));
    // The branch head is BEHIND the run's sha — i.e. the branch was moved
    // BACKWARD off the sha (force-push / rollback), so the sha is an abandoned
    // commit the owner moved away from. Definitively not the head; reject 409.
    setCompareStatus('behind');

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Compare→insert TOCTOU — a newer push landing between the pre-check and the
  // build INSERT is invisible to the push webhook's terminateBuildsForProject
  // cleanup (no row exists yet), so the route re-checks freshness AFTER the row
  // is created and cancels it itself instead of minting a token for the stale run.
  // ---------------------------------------------------------------------------

  it('returns 409, mints no token, and cancels the created build when a newer push lands between the pre-check and the insert', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-toctou-ahead');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    // Pre-check sees the sha as the head ('identical'); by the post-create
    // re-check a newer push has landed ('ahead') — the stale run must not mint.
    setCompareStatusQueue(['identical', 'ahead']);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'oidc sha is not the current branch head',
    });

    // The row WAS created (it passed the pre-check) but must be terminal —
    // holding neither a concurrency slot nor a live deploy token.
    const rows = await getProjectBuilds(env.db, project.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('cancelled');
    expect(rows[0]!.error).toBe('superseded by newer push during token exchange');
  });

  it('returns 503, mints no token, and cancels the created build when the post-create re-check is unverifiable', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-toctou-null');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());
    // Pre-check passes; the re-check can't reach the compare API (null). Fail
    // closed AND cancel the row — an orphaned active row would hold a slot until
    // the reaper. The retried exchange re-inserts cleanly (terminal rows are
    // outside the partial-unique index and skipped by idempotent reuse).
    setCompareStatusQueue(['identical', null]);

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'unable to verify branch head; retry',
    });

    const rows = await getProjectBuilds(env.db, project.id);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('cancelled');
    expect(rows[0]!.error).toBe('superseded by newer push during token exchange');
  });

  it('mints a token when the live install check confirms App coverage (default mock)', async () => {
    const user = await createTestUser(env.db, 'octo-live-ok');
    const project = await createTestProject(env.db, user.id, 'oidc-live-ok');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims());

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // The exchange must allowlist the GitHub Actions trigger event. A
  // `pull_request_target` run executes in the BASE-branch context, so its OIDC
  // claims carry `ref=refs/heads/<connected-branch>` and `sha=<branch head>` —
  // it passes the `refs/heads/` check, the branch-match check, AND the
  // 'identical' freshness gate, yet can check out untrusted PR-head code. Only
  // `push` (scaffolded) and `workflow_dispatch` (collaborator-only) may mint.
  // ---------------------------------------------------------------------------

  it('returns 401 and creates no build for a pull_request_target trigger (freshness gate would pass)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-pr-target');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    // Leave ref at the connected branch and compare at the default 'identical'
    // so the branch-match + freshness gates would BOTH pass — proving ONLY the
    // event check rejects this otherwise-valid-looking token.
    setVerifyResult(makeClaims({ event_name: 'pull_request_target' }));
    setCompareStatus('identical');

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('returns 401 and creates no build for a pull_request trigger', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-pr');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    // Keep ref at the default connected branch so the EVENT check is what
    // rejects, isolating it from the branch/freshness gates.
    setVerifyResult(makeClaims({ event_name: 'pull_request' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });

  it('mints a token for a workflow_dispatch trigger (trusted manual run)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-dispatch');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ event_name: 'workflow_dispatch' }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(200);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(1);
  });

  it('returns 401 and creates no build when the event_name claim is missing (fail-closed)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'oidc-no-event');
    await seedActiveInstallation(env.db, '1');
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: '1',
      repoFullName: 'octo/repo',
      repositoryId: '42',
      branch: 'main',
      buildExecutor: 'github_actions',
    });

    const app = makeApp(env);
    setVerifyResult(makeClaims({ event_name: '' as never }));

    const res = await exchange(app, env, { oidcToken: 'good', project: project.slug });
    expect(res.status).toBe(401);
    expect((await getProjectBuilds(env.db, project.id)).length).toBe(0);
  });
});
