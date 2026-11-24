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
import { signDeployToken } from '../../src/auth/deploy-token.ts';
import { hmacSignState } from '../../src/auth/hmac.ts';
import { createCodeChallenge } from '../../src/auth/pkce.ts';
import type { Db } from '../../src/db.ts';
import {
  createGitHubConnection,
  getBuild,
  getGitHubConnection,
  getGitHubInstallation,
  getInstallationRevocationAt,
  getProjectBuilds,
  hasGitHubConnectionAuthority,
  recordInstallationRevocations,
  removeProjectMember,
  setProjectMemberRole,
  upsertGitHubInstallation,
  upsertGitHubInstallationMember,
} from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { generateId } from '../../src/id.ts';
import { authMiddleware } from '../../src/middleware/auth.ts';
import { githubProjectRoutes, githubRoutes } from '../../src/routes/github.ts';
import { webhookRoutes } from '../../src/routes/webhooks.ts';
import {
  builds,
  githubConnections,
  githubInstallations,
  githubInstallationMembers,
  githubInstallationRevocations,
  oauthAccounts,
  projectMembers,
  projects,
} from '../../src/schema.ts';
import {
  getTestGitHubInstallationMembers,
  createTestBuild,
  JWT_SECRET,
  clearTables,
  createTestProject,
  createTestUser,
  recordingBuildManager,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

// The callback mints an installation token (which would otherwise require a
// real RS256 PKCS#8 key via createAppJwt). Stub it so the test only exercises
// the route's ownership logic; the repo list is served by the mocked fetch.
// `getInstallationAccount` (App-JWT account lookup for empty-repos installs) is
// stubbed to skip createAppJwt while still hitting the test's stubbed global
// fetch for `GET /app/installations/:id`, so the route's real fail-open/closed
// branching is exercised against a mocked GitHub response.
vi.mock('../../src/github/installation-token.ts', () => ({
  getInstallationToken: async () => 'test-installation-token',
  getInstallationAccount: async (_env: unknown, installationId: string) => {
    const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as {
      account?: { id?: number | string; login?: string; type?: string };
    };
    const account = data.account;
    if (!account || (typeof account.id !== 'number' && typeof account.id !== 'string')) {
      return null;
    }
    if (typeof account.login !== 'string' || account.login === '') {
      return null;
    }
    return {
      accountId: String(account.id),
      login: account.login,
      type: account.type === 'Organization' ? 'Organization' : 'User',
    };
  },
}));

let env: TestEnv;

// Self-contained app that mirrors how index.ts mounts the github routers:
//   - /github            -> githubRoutes (auth applied per-route inside)
//   - /projects/* (auth) -> githubProjectRoutes (ownership check inside)
// Mounting here keeps the test independent of the parent integrator's wiring.
const app = new Hono<ApiEnv>()
  .use('*', async (context, next) => {
    context.set('db', env.db);
    await next();
  })
  .route('/github', githubRoutes)
  // Mounted so the proof-id deploy-close test can drive the REAL member_removed webhook
  // end-to-end (webhook writes the tombstone) and then attempt the member connect
  // against the SAME app. No other test hits this route.
  .route('/webhooks', webhookRoutes)
  .use('/projects/*', authMiddleware)
  .route('/projects', githubProjectRoutes);

// The webhook signature secret used by the deploy-close end-to-end tests.
const WEBHOOK_SECRET = 'test-webhook-secret';

// Sign a webhook body the way GitHub does (HMAC-SHA256 hex, `sha256=` prefix).
async function signWebhook(secret: string, body: string): Promise<string> {
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

// POST a signed webhook to the mounted /webhooks/github route, injecting the
// webhook secret into env (the shared TestEnv does not carry it by default).
async function postWebhook(event: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return app.fetch(
    new Request('http://localhost/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': event,
        'X-Hub-Signature-256': await signWebhook(WEBHOOK_SECRET, body),
      },
      body,
    }),
    { ...env, GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET },
    {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  );
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

// github_* tables aren't known to the shared clearTables helper; clear them
// (in FK-safe order) before it removes the projects/users they reference.
async function clearGitHubTables(db: Db): Promise<void> {
  await db.delete(builds);
  await db.delete(githubConnections);
  await db.delete(githubInstallationMembers);
  await db.delete(githubInstallations);
}

beforeEach(async () => {
  await clearGitHubTables(env.db);
  await clearTables(env.db);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function authed(jwt: string, body?: unknown): RequestInit {
  return {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

// Minimal GitHub App env so isGitHubAppConfigured() is true. The private key is
// never parsed because getInstallationToken is mocked above.
const GITHUB_APP_ENV = {
  GITHUB_APP_ID: '123456',
  GITHUB_APP_PRIVATE_KEY: 'unused-because-token-is-mocked',
} as const;

// The App's user-to-server OAuth credentials. Present only when the App is
// configured for "Request user authorization (OAuth) during installation" — the
// callback's org-install path is inert without these.
const GITHUB_APP_USER_OAUTH_ENV = {
  GITHUB_APP_CLIENT_ID: 'Iv1.testappclientid',
  GITHUB_APP_CLIENT_SECRET: 'test-app-client-secret',
} as const;

// Build a valid signed state exactly the way GET /install-url mints it.
async function mintInstallState(userId: string, githubAccountId: string): Promise<string> {
  const encoded = btoa(JSON.stringify({ userId, githubAccountId, nonce: crypto.randomUUID() }));
  const signature = await hmacSignState(encoded, JWT_SECRET);
  return `${encoded}.${signature}`;
}

// A valid 43-char RFC 7636 code_verifier (matches the connect-authorize tests).
const CONNECT_VERIFIER = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'; // 43 chars

// Forge a signed `connect_grant` the same `${btoa(json)}.${hmac(JWT_SECRET)}` way
// the public connect-authorize callback mints it — used to drive the
// member connect-redemption path and to forge wrong-repo / wrong-purpose
// / expired / mismatched-identity grants. Defaults produce a VALID grant whose
// codeChallenge is S256(CONNECT_VERIFIER), so passing `codeVerifier:
// CONNECT_VERIFIER` in the body satisfies PKCE.
async function mintConnectGrant(
  overrides: {
    purpose?: string;
    installationId?: string;
    repoFullName?: string;
    repositoryId?: number;
    githubAccountId?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    iat?: number;
    exp?: number;
  } = {},
): Promise<string> {
  const encoded = btoa(
    JSON.stringify({
      purpose: overrides.purpose ?? 'connect',
      installationId: overrides.installationId ?? '3000',
      repoFullName: overrides.repoFullName ?? 'org/app',
      repositoryId: overrides.repositoryId ?? 4242,
      githubAccountId: overrides.githubAccountId ?? '5551234',
      codeChallenge: overrides.codeChallenge ?? (await createCodeChallenge(CONNECT_VERIFIER)),
      codeChallengeMethod: overrides.codeChallengeMethod ?? 'S256',
      // `iat` = the moment GitHub access was proven (the connect-authorize
      // callback). The connect gate rejects a grant whose iat <= the revocation
      // tombstone. Default to "now" so no-revocation tests are inert.
      iat: overrides.iat ?? Date.now(),
      exp: overrides.exp ?? Date.now() + 5 * 60 * 1000,
    }),
  );
  const signature = await hmacSignState(encoded, JWT_SECRET);
  return `${encoded}.${signature}`;
}

// Seed the org-shared install scenario a non-owner member connects against:
// an install the member does not own, a project OWNED by the connecting member, and
// (unless `seedMembership: false`) an active membership row binding the member to
// the install. The member's linked GitHub id is seeded via createTestUser's
// provider/providerId args so getGitHubAccountIdForUser returns a known value
// (use `memberProvider: 'google'` to seed a caller with NO linked GitHub id).
async function seedMemberScenario(opts: {
  installationId: string;
  memberProvider?: string;
  memberGithubId?: string;
  membershipTtlSeconds?: number;
  repositories?: Array<{ full_name: string; id: number }>;
  repositorySelection?: 'all' | 'selected';
  status?: 'active' | 'suspended';
  seedMembership?: boolean;
  // Defaults to 'Organization' (the only account type org-share admits). Pass
  // 'User' to seed a personal install for the Organization-only connect-gate guard.
  accountType?: 'User' | 'Organization';
}): Promise<{
  owner: Awaited<ReturnType<typeof createTestUser>>;
  member: Awaited<ReturnType<typeof createTestUser>>;
  project: Awaited<ReturnType<typeof createTestProject>>;
}> {
  const owner = await createTestUser(
    env.db,
    `owner-${opts.installationId}`,
    'github',
    `gh-owner-${opts.installationId}`,
  );
  const member = await createTestUser(
    env.db,
    `member-${opts.installationId}`,
    opts.memberProvider ?? 'github',
    opts.memberGithubId,
  );
  const project = await createTestProject(env.db, member.id, `gh-member-${opts.installationId}`);
  const accountType = opts.accountType ?? 'Organization';
  await upsertGitHubInstallation(env.db, {
    installationId: opts.installationId,
    // Only a personal install has an owner.
    userId: accountType === 'User' ? owner.id : null,
    accountLogin: 'org',
    accountId: `acc_${opts.installationId}`,
    accountType,
    repositories: opts.repositories ?? [{ full_name: 'org/app', id: 1 }],
    repositorySelection: opts.repositorySelection,
  });
  if (opts.status === 'suspended') {
    await env.db
      .update(githubInstallations)
      .set({ status: 'suspended' })
      .where(eq(githubInstallations.installation_id, opts.installationId));
  }
  if (opts.seedMembership !== false) {
    await upsertGitHubInstallationMember(env.db, {
      installationId: opts.installationId,
      userId: member.id,
      githubAccountId: opts.memberGithubId ?? 'gh_member',
      ttlSeconds: opts.membershipTtlSeconds ?? 3600,
    });
  }
  return { owner, member, project };
}

// POST a member connect-redemption request as the given member. The member
// connect path is gated on App user OAuth being configured, so this helper
// sends the CONFIGURED env — the redemption paths honor the kill switch, and
// the member-connect tests exercise the config-present case. The dedicated
// fail-closed test drives the UNCONFIGURED case inline with bare `env`.
async function memberConnect(
  member: Awaited<ReturnType<typeof createTestUser>>,
  projectId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/projects/${projectId}/github`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${member.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
  );
}

// Stub global fetch so the callback's `GET /installation/repositories` returns
// the given repos/owner. Anything else throws so an unexpected call is loud.
function mockInstallationRepos(owner: { login: string; id: number; type: string }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/installation/repositories')) {
        return Response.json({
          repositories: [{ full_name: `${owner.login}/app`, id: 1, owner }],
        });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
}

// Stub global fetch for the user-authorization-on-install path. Serves:
//   - `GET /installation/repositories` (repo list + owner; here an org)
//   - `POST login/oauth/access_token` (install code -> user token), unless the
//     code is rejected (`acceptCode === false`, mimicking a bad/expired code)
//   - `GET /user` (the code-holder's own numeric account id — bound against the
//     signed state to prove the code-holder IS the install initiator)
//   - `GET /user/installations` (the installations the user can manage)
// Captures the token-exchange `code` so a test can assert it was attempted.
function mockUserAuthInstall(opts: {
  owner: { login: string; id: number; type: string };
  // Installation ids returned by GET /user/installations for the user token.
  userInstallationIds: ReadonlyArray<number>;
  // The numeric account id returned by GET /user for the code-holder. Defaults
  // to the owner id so the legitimate-initiator case needs no extra wiring.
  callerAccountId?: number;
  // When false, the token exchange returns a GitHub `{ error }` body.
  acceptCode?: boolean;
}): { calls: { tokenExchange: boolean; userInstallations: boolean; user: boolean } } {
  const calls = { tokenExchange: false, userInstallations: false, user: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/installation/repositories')) {
        return Response.json({
          repositories: [{ full_name: `${opts.owner.login}/app`, id: 1, owner: opts.owner }],
        });
      }
      if (url.includes('login/oauth/access_token')) {
        calls.tokenExchange = true;
        if (opts.acceptCode === false) {
          return Response.json({ error: 'bad_verification_code' });
        }
        return Response.json({ access_token: 'user-to-server-token' });
      }
      if (url.includes('/user/installations')) {
        calls.userInstallations = true;
        return Response.json({
          installations: opts.userInstallationIds.map((id) => ({ id })),
        });
      }
      // The bare `GET /user` endpoint — checked AFTER `/user/installations` so
      // the more specific path wins.
      if (url.endsWith('/user')) {
        calls.user = true;
        return Response.json({ id: opts.callerAccountId ?? opts.owner.id });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
  return { calls };
}

// Stub global fetch for an EMPTY-repos installation callback. `GET
// /installation/repositories` returns no repos (so the owner can't be derived
// from a repo), forcing the callback onto the authoritative App-JWT account
// lookup `GET /app/installations/:id`. When `account` is null, that endpoint
// fails (500) so the callback must fail closed (502).
function mockEmptyInstallAccount(opts: {
  account: { login: string; id: number; type: string } | null;
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/installation/repositories')) {
        // No repositories → owner is undefined → derive returns null.
        return Response.json({ repositories: [] });
      }
      // The App-JWT account lookup: `GET /app/installations/:id` (must NOT match
      // the `/access_tokens` sub-path; that's the token mint, which is mocked).
      if (/\/app\/installations\/[^/]+$/.test(new URL(url).pathname)) {
        if (opts.account === null) {
          return new Response('boom', { status: 500 });
        }
        return Response.json({ account: opts.account });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    }),
  );
}

describe('POST /projects/:id/github', () => {
  it('rejects connection mutations while the project is being deleted', async () => {
    const owner = await createTestUser(env.db, 'deleting-github-owner');
    const project = await createTestProject(env.db, owner.id, 'deleting-github');
    await upsertGitHubInstallation(env.db, {
      installationId: 'deleting-111',
      userId: owner.id,
      accountLogin: owner.login,
      accountId: 'deleting-owner-account',
      accountType: 'User',
      repositories: [{ full_name: `${owner.login}/app`, id: 9101 }],
    });
    await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'deleting-111',
      repoFullName: `${owner.login}/app`,
      repositoryId: '9101',
      authorizedByUserId: owner.id,
    });
    await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

    const requests = [
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: 'deleting-111',
          repoFullName: `${owner.login}/app`,
        }),
      }),
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'release' }),
      }),
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${owner.jwt}` },
      }),
    ];

    for (const request of requests) {
      const response = await app.fetch(request, env);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'project is being deleted' });
    }
    expect((await getGitHubConnection(env.db, project.id))?.branch).toBe('main');
  });

  it('lets project admins manage connections while readers and collaborators can only read them', async () => {
    const owner = await createTestUser(env.db, 'team-github-owner');
    const admin = await createTestUser(env.db, 'team-github-admin');
    const collaborator = await createTestUser(env.db, 'team-github-collaborator');
    const reader = await createTestUser(env.db, 'team-github-reader');
    const project = await createTestProject(env.db, owner.id, 'team-github');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: admin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: collaborator.id,
        role: 'collaborator',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: reader.id,
        role: 'reader',
        added_by_user_id: owner.id,
      },
    ]);
    await upsertGitHubInstallation(env.db, {
      installationId: 'team-111',
      userId: admin.id,
      accountLogin: admin.login,
      accountId: 'team-admin-account',
      accountType: 'User',
      repositories: [{ full_name: `${admin.login}/app`, id: 9001 }],
    });

    const connect = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: 'team-111',
          repoFullName: `${admin.login}/app`,
        }),
      }),
      env,
    );
    expect(connect.status).toBe(200);
    expect((await getGitHubConnection(env.db, project.id))?.authorized_by_user_id).toBe(admin.id);

    for (const user of [reader, collaborator]) {
      const read = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/github`, authed(user.jwt)),
        env,
      );
      expect(read.status).toBe(200);
    }

    const collaboratorPatch = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${collaborator.jwt}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ branch: 'blocked' }),
      }),
      env,
    );
    expect(collaboratorPatch.status).toBe(403);

    const adminPatch = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${admin.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'release' }),
      }),
      env,
    );
    expect(adminPatch.status).toBe(200);

    const readerDelete = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${reader.jwt}` },
      }),
      env,
    );
    expect(readerDelete.status).toBe(403);

    const adminDelete = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${admin.jwt}` },
      }),
      env,
    );
    expect(adminDelete.status).toBe(200);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('connects a project to a repo within the caller installation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-app');
    await upsertGitHubInstallation(env.db, {
      installationId: '111',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '111',
          repoFullName: 'acme/app',
          branch: 'release',
          buildExecutor: 'github_actions',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const connection = (await res.json()) as {
      project_id: string;
      installation_id: string;
      repo_full_name: string;
      branch: string;
      build_executor: string;
    };
    expect(connection.project_id).toBe(project.id);
    expect(connection.installation_id).toBe('111');
    expect(connection.repo_full_name).toBe('acme/app');
    expect(connection.branch).toBe('release');
    expect(connection.build_executor).toBe('github_actions');

    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repo_full_name).toBe('acme/app');
  });

  // the connect handler must capture the repo's IMMUTABLE numeric id from
  // the installation's cached repository list so webhook/OIDC routing keys on it
  // (full_name is mutable). Without it, a rename/name-reuse could misroute a
  // deploy.
  it('captures the immutable repository_id at connect time', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-repo-id');
    await upsertGitHubInstallation(env.db, {
      installationId: '112',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 4242 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '112', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repository_id).toBe('4242');
  });

  // an empty branch must be rejected at the POST guard. createGitHubConnection
  // uses `args.branch ?? 'main'`, and `??` does NOT catch '', so an empty string
  // would be stored verbatim and no push/OIDC ref could ever match it → a silent
  // dead connection. PATCH already rejects '' the same way.
  it('returns 400 when the branch is an empty string', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-empty-branch');
    await upsertGitHubInstallation(env.db, {
      installationId: '113',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '113', repoFullName: 'acme/app', branch: '' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid branch');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('persists a custom workflow_path (.yaml accepted)', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-custom');
    await upsertGitHubInstallation(env.db, {
      installationId: '211',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '211',
          repoFullName: 'acme/app',
          workflowPath: '.github/workflows/deploy.yaml',
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const connection = (await res.json()) as { workflow_path: string };
    expect(connection.workflow_path).toBe('.github/workflows/deploy.yaml');
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/deploy.yaml');
  });

  it('defaults workflow_path to the scaffolded void-deploy.yml when omitted', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-default');
    await upsertGitHubInstallation(env.db, {
      installationId: '212',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '212', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/void-deploy.yml');
  });

  it('returns 400 when workflowPath is outside .github/workflows/', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-badprefix');
    await upsertGitHubInstallation(env.db, {
      installationId: '213',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // No `.github/workflows/` prefix — GitHub could never run it, so it could
        // never match a real OIDC workflow_ref.
        body: JSON.stringify({
          installationId: '213',
          repoFullName: 'acme/app',
          workflowPath: 'ci.yml',
        }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid workflowPath');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 400 when workflowPath contains a .. traversal', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-wf-traversal');
    await upsertGitHubInstallation(env.db, {
      installationId: '214',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '214',
          repoFullName: 'acme/app',
          workflowPath: '.github/workflows/../../evil.yml',
        }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid workflowPath');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // connecting against a suspended/deleted installation must be rejected.
  // getGitHubInstallation returns suspended/deleted rows, and a `selected` install
  // keeps its cached repos, so the connect would otherwise succeed — but every
  // build resolver requires status='active', so the connection would never build.
  it('returns 409 when the installation is not active', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-suspended');
    await upsertGitHubInstallation(env.db, {
      installationId: '114',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await env.db
      .update(githubInstallations)
      .set({ status: 'suspended' })
      .where(eq(githubInstallations.installation_id, '114'));

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '114', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('installation is not active');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('defaults branch to main and executor to container', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-defaults');
    await upsertGitHubInstallation(env.db, {
      installationId: '111',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_1',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '111', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const connection = (await res.json()) as { branch: string; build_executor: string };
    expect(connection.branch).toBe('main');
    expect(connection.build_executor).toBe('container');
  });

  it('returns 403 when the project belongs to another user', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id, 'gh-403');
    await upsertGitHubInstallation(env.db, {
      installationId: '222',
      userId: other.id,
      accountLogin: 'other',
      accountId: 'acc_2',
      accountType: 'User',
      repositories: [{ full_name: 'other/app', id: 9 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${other.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '222', repoFullName: 'other/app' }),
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it('rejects an installation that does not belong to the caller', async () => {
    const user = await createTestUser(env.db, 'caller');
    const stranger = await createTestUser(env.db, 'stranger');
    const project = await createTestProject(env.db, user.id, 'gh-foreign-install');
    // Installation linked to a different user.
    await upsertGitHubInstallation(env.db, {
      installationId: '333',
      userId: stranger.id,
      accountLogin: 'stranger',
      accountId: 'acc_3',
      accountType: 'User',
      repositories: [{ full_name: 'stranger/app', id: 7 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '333', repoFullName: 'stranger/app' }),
      }),
      // Non-owner path is gated on App user OAuth; send the configured env
      // so this test reaches the membership gate (opaque 404), not the kill switch.
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(404);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('rejects a repo not accessible by the installation', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-no-repo');
    await upsertGitHubInstallation(env.db, {
      installationId: '444',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_4',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '444', repoFullName: 'acme/not-granted' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // An `all`-repos install covers every repo in the account, including ones not
  // in the cached `repositories` array (e.g. created after install). The connect
  // route must skip array membership and resolve the id LIVE via GET /repos.
  it('connects a repo absent from the cache under an all-repos install', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-all');
    await upsertGitHubInstallation(env.db, {
      installationId: '888',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_8',
      accountType: 'User',
      // Cache lists a DIFFERENT repo; the target is not in it.
      repositories: [{ full_name: 'acme/old', id: 1 }],
      repositorySelection: 'all',
    });

    // The route resolves the id via GET /repos/:full_name for `all` installs.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/acme/new')) {
          return Response.json({ id: 9999 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '888', repoFullName: 'acme/new' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repo_full_name).toBe('acme/new');
    // The id must come from the LIVE lookup, not the (stale) cache.
    expect(persisted?.repository_id).toBe('9999');
  });

  // Fail-closed: even under an `all` install, a repo the installation can't
  // actually see (GET /repos 404s) is rejected rather than connected blindly.
  it('rejects a repo whose live lookup 404s under an all-repos install', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-all-404');
    await upsertGitHubInstallation(env.db, {
      installationId: '999',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_9',
      accountType: 'User',
      repositories: [{ full_name: 'acme/old', id: 1 }],
      repositorySelection: 'all',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/acme/missing')) {
          return new Response('Not Found', { status: 404 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '999', repoFullName: 'acme/missing' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // The `selected` path keys off the cached array and never hits the network.
  // An unmocked fetch here would throw, so reaching 200 also proves no live
  // lookup happens for `selected` installs.
  it('uses the cached array (no live lookup) for a selected install', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-selected');
    await upsertGitHubInstallation(env.db, {
      installationId: '1010',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_10',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 5151 }],
      repositorySelection: 'selected',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '1010', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repository_id).toBe('5151');
  });

  it('returns 409 when the project is already connected', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-dup');
    await upsertGitHubInstallation(env.db, {
      installationId: '555',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_5',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });

    const body = { installationId: '555', repoFullName: 'acme/app' };
    const first = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(first.status).toBe(200);

    const second = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(second.status).toBe(409);
  });
});

describe('GitHub connection project-admin provenance', () => {
  it('invalidates the connection and active builds when its authorizer loses admin access', async () => {
    const owner = await createTestUser(env.db, 'provenance-owner');
    const admin = await createTestUser(env.db, 'provenance-admin');
    const project = await createTestProject(env.db, owner.id, 'provenance-project');
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: admin.id,
      role: 'admin',
      added_by_user_id: owner.id,
    });
    await upsertGitHubInstallation(env.db, {
      installationId: 'provenance-install',
      userId: admin.id,
      accountLogin: admin.login,
      accountId: 'provenance-account',
      accountType: 'User',
      repositories: [{ full_name: `${admin.login}/app`, id: 9101 }],
    });
    const connection = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'provenance-install',
      repoFullName: `${admin.login}/app`,
      repositoryId: '9101',
      authorizedByUserId: admin.id,
    });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: owner.id,
      executor: 'container',
      status: 'building',
    });
    expect(await hasGitHubConnectionAuthority(env.db, connection.id, project.id)).toBe(true);

    await setProjectMemberRole(env.db, {
      projectId: project.id,
      subjectUserId: admin.id,
      role: 'collaborator',
      actorUserId: owner.id,
    });

    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
    expect((await getBuild(env.db, build.id))?.status).toBe('cancelled');
  });

  it('keeps a connection reauthorized by another current admin', async () => {
    const owner = await createTestUser(env.db, 'reauthorize-owner');
    const firstAdmin = await createTestUser(env.db, 'reauthorize-first');
    const secondAdmin = await createTestUser(env.db, 'reauthorize-second');
    const project = await createTestProject(env.db, owner.id, 'reauthorize-project');
    await env.db.insert(projectMembers).values([
      {
        project_id: project.id,
        user_id: firstAdmin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
      {
        project_id: project.id,
        user_id: secondAdmin.id,
        role: 'admin',
        added_by_user_id: owner.id,
      },
    ]);
    await upsertGitHubInstallation(env.db, {
      installationId: 'reauthorize-install',
      userId: secondAdmin.id,
      accountLogin: secondAdmin.login,
      accountId: 'reauthorize-account',
      accountType: 'User',
      repositories: [{ full_name: `${secondAdmin.login}/app`, id: 9201 }],
    });
    const connection = await createGitHubConnection(env.db, {
      projectId: project.id,
      installationId: 'reauthorize-install',
      repoFullName: `${secondAdmin.login}/app`,
      repositoryId: '9201',
      authorizedByUserId: firstAdmin.id,
    });
    await env.db
      .update(githubConnections)
      .set({ authorized_by_user_id: secondAdmin.id })
      .where(eq(githubConnections.id, connection.id));

    await removeProjectMember(env.db, {
      projectId: project.id,
      subjectUserId: firstAdmin.id,
      actorUserId: owner.id,
    });

    expect((await getGitHubConnection(env.db, project.id))?.id).toBe(connection.id);
    expect(await hasGitHubConnectionAuthority(env.db, connection.id, project.id)).toBe(true);
  });
});

// Org-shared installs (RFC 0074): a non-owner ORG MEMBER connects THEIR project
// to a repo in an install owned by someone else, by redeeming a per-repo
// `connect_grant` minted under the member's OWN GitHub token. The grant's
// `repositoryId` is authoritative — the member path NEVER touches the installation
// token or the install's cached repositories (the confused-deputy close).
describe('POST /projects/:id/github — non-owner member connect grant', () => {
  // A non-member gets the SAME opaque 404 the owner-miss returns — the response
  // must never reveal the install exists to someone with no membership.
  it('returns opaque 404 (installation not found) for a non-member', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3001',
      memberGithubId: '5551234',
      seedMembership: false, // no membership row
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3001',
      repoFullName: 'org/app',
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('installation not found');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // No install-EXISTENCE oracle. With App user OAuth UNCONFIGURED (the kill
  // switch), a non-owner NON-member probing an EXISTING active Organization
  // install must get the SAME opaque 404 a NONEXISTENT installationId returns —
  // NOT a 503, which would leak that the install exists. The membership 404 runs
  // BEFORE the OAuth 503, so the two are indistinguishable.
  it('oracle-closed: non-member with App user OAuth unconfigured gets 404 (not 503), same as a nonexistent install', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3050',
      memberGithubId: '5551234',
      seedMembership: false, // caller is NOT a member of the existing install
    });

    // Existing install, non-member, OAuth OFF → opaque 404 (NOT 503).
    const existing = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${member.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '3050', repoFullName: 'org/app' }),
      }),
      env, // App user OAuth OMITTED — the kill switch is off.
    );
    expect(existing.status).toBe(404);
    expect(((await existing.json()) as { error: string }).error).toBe('installation not found');

    // Nonexistent install, SAME unset-OAuth env → identical opaque 404, so the
    // response leaks nothing about install existence.
    const nonexistent = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${member.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '9999-nonexistent', repoFullName: 'org/app' }),
      }),
      env,
    );
    expect(nonexistent.status).toBe(404);
    expect(((await nonexistent.json()) as { error: string }).error).toBe('installation not found');

    // Neither probe created a connection.
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // A member with no grant is told (via the FROZEN stable code the CLI catches)
  // to run the connect-authorize round-trip.
  it('returns 403 connect_authorization_required for a member with no grant', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3002',
      memberGithubId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3002',
      repoFullName: 'org/app',
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('connect_authorization_required');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // A grant with no matching codeVerifier is inert — both must be present strings
  // to leave the connect_authorization_required gate.
  it('returns 403 connect_authorization_required when codeVerifier is missing', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3003',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({ installationId: '3003', repoFullName: 'org/app' });

    const res = await memberConnect(member, project.id, {
      installationId: '3003',
      repoFullName: 'org/app',
      connectGrant: grant,
      // codeVerifier omitted
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('connect_authorization_required');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // The crux: a VALID grant connects, and the grant's repositoryId WINS even
  // though the installation-token / cached path would have produced a different
  // answer (here it would have 400'd — the cache does NOT list the target repo).
  // Reaching 200 with the grant's id proves resolveRepositoryId / the cached
  // lookup were skipped entirely — the confused-deputy close.
  it('connects via a valid grant and trusts the grant repositoryId (confused-deputy proof)', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3004',
      memberGithubId: '5551234',
      // Cache lists a DIFFERENT repo — the owner path would 400 on 'org/app'.
      repositories: [{ full_name: 'org/other', id: 111 }],
      repositorySelection: 'selected',
    });
    const grant = await mintConnectGrant({
      installationId: '3004',
      repoFullName: 'org/app',
      repositoryId: 424_242,
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3004',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
      branch: 'release',
      buildExecutor: 'github_actions',
    });

    expect(res.status).toBe(200);
    const connection = (await res.json()) as {
      project_id: string;
      repo_full_name: string;
      repository_id: string;
      branch: string;
      build_executor: string;
    };
    expect(connection.project_id).toBe(project.id);
    expect(connection.repo_full_name).toBe('org/app');
    // The GRANT's id wins — not the cache's 111, and no live lookup happened.
    expect(connection.repository_id).toBe('424242');
    expect(connection.branch).toBe('release');
    expect(connection.build_executor).toBe('github_actions');

    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.repository_id).toBe('424242');
  });

  // Org-share connect is Organization-only, defense-in-depth. Even a
  // caller with an ACTIVE membership row + a VALID connect_grant for a personal
  // (account_type='User') install is rejected with the SAME opaque 404 the
  // non-member miss returns (never reveal the install exists / its type). A
  // personal membership cannot be minted by the join paths, but a pre-existing /
  // stale one must still be caught here — a personal install has no member_removed
  // revocation path.
  it('returns opaque 404 for a member connecting a personal (account_type=User) install', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3009',
      memberGithubId: '5551234',
      accountType: 'User', // personal install — the guarded case
    });
    const grant = await mintConnectGrant({
      installationId: '3009',
      repoFullName: 'org/app',
      repositoryId: 424_242,
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3009',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('installation not found');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // The Organization-only guard must NOT touch the owner path. A PERSONAL-account
  // (account_type='User') OWNER connecting their OWN install still SUCCEEDS —
  // owners connect directly (no JOIN, no membership) and the Organization-only
  // guard lives inside `if (!isOwner)`, so the owner never reaches it.
  it('OWNER connecting their own personal (account_type=User) install still succeeds', async () => {
    const owner = await createTestUser(env.db, 'personal-owner', 'github', 'gh-personal-owner');
    const project = await createTestProject(env.db, owner.id, 'personal-owner-proj');
    await upsertGitHubInstallation(env.db, {
      installationId: '3010',
      userId: owner.id,
      accountLogin: 'personal-owner',
      accountId: 'acc_3010',
      accountType: 'User', // a personal install owned by the connecting user
      repositories: [{ full_name: 'personal-owner/app', id: 4242 }],
      repositorySelection: 'selected',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '3010', repoFullName: 'personal-owner/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('4242');
  });

  // A connected project keeps its connection: a second organization connect is
  // rejected exactly like a personal-install connect, and the row is unchanged.
  it('returns 409 when an organization project is already connected', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3011',
      memberGithubId: '5551234',
    });
    const connect = async () =>
      memberConnect(member, project.id, {
        installationId: '3011',
        repoFullName: 'org/app',
        connectGrant: await mintConnectGrant({
          installationId: '3011',
          repoFullName: 'org/app',
          githubAccountId: '5551234',
        }),
        codeVerifier: CONNECT_VERIFIER,
      });

    const first = await connect();
    expect(first.status).toBe(200);
    const original = await getGitHubConnection(env.db, project.id);
    expect(original?.authorized_by_user_id).toBe(member.id);

    const second = await connect();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'project already connected' });
    expect(await getGitHubConnection(env.db, project.id)).toEqual(original);
  });

  // A grant minted for a DIFFERENT repo than the one being connected is rejected.
  it('returns 403 invalid connect grant when the grant is for a different repo', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3005',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '3005',
      repoFullName: 'org/other', // grant proves a different repo
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3005',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // A grant bound to a DIFFERENT installation than the one being connected.
  it('returns 403 invalid connect grant when the grant is for a different installation', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3006',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '9999', // grant proves a different install
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3006',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // PKCE: a code_verifier that does NOT hash to the grant's challenge is rejected.
  it('returns 403 invalid connect grant when the PKCE verifier is wrong', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3007',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '3007',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3007',
      repoFullName: 'org/app',
      connectGrant: grant,
      // A valid-shaped but WRONG verifier (43 chars, does not hash to challenge).
      codeVerifier: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ0',
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // A tampered grant signature fails HMAC verification (verifyLinkPayload → null).
  it('returns 403 invalid connect grant when the grant signature is tampered', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3008',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '3008',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });
    const dot = grant.lastIndexOf('.');
    const sig = grant.slice(dot + 1);
    const first = sig[0] === 'A' ? 'B' : 'A';
    const tampered = `${grant.slice(0, dot + 1)}${first}${sig.slice(1)}`;

    const res = await memberConnect(member, project.id, {
      installationId: '3008',
      repoFullName: 'org/app',
      connectGrant: tampered,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // A non-connect-purpose grant must not drive the connect redemption.
  it('returns 403 invalid connect grant for a non-connect purpose', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3009',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      purpose: 'join',
      installationId: '3009',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3009',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Threat L1: A initiates, B authorizes in the browser, A redeems B's proof.
  // The grant's githubAccountId (B's) must equal the REDEEMING caller's OWN linked
  // GitHub id (A's) — a mismatch is rejected.
  it('returns 403 invalid connect grant when grant githubAccountId != caller linked id', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3010',
      memberGithubId: '900777', // caller's OWN linked github id
    });
    const grant = await mintConnectGrant({
      installationId: '3010',
      repoFullName: 'org/app',
      githubAccountId: '5551234', // a DIFFERENT github identity's proof
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3010',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // A caller with NO linked GitHub identity can never satisfy the Threat L1 bind.
  it('returns 403 invalid connect grant when the caller has no linked GitHub id', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3011',
      memberProvider: 'google', // linked via google, NOT github
      memberGithubId: 'google-nolink',
    });
    const grant = await mintConnectGrant({
      installationId: '3011',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3011',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // An expired grant is rejected (exp is enforced against Date.now()).
  it('returns 403 invalid connect grant for an expired grant', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3012',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '3012',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
      exp: Date.now() - 1000, // already expired
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3012',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // The status gate is reached BEFORE grant verification (the member is already
  // authorized), so a suspended install yields 409 even with a valid grant.
  it('returns 409 installation is not active for an authorized member', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3013',
      memberGithubId: '5551234',
      status: 'suspended',
    });
    const grant = await mintConnectGrant({
      installationId: '3013',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3013',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('installation is not active');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // An expired membership (TTL lapsed) is NOT active → the caller is treated as a
  // non-member and gets the same opaque 404.
  it('returns opaque 404 when the membership has expired', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3014',
      memberGithubId: '5551234',
      membershipTtlSeconds: -3600, // lands in the past
    });
    const grant = await mintConnectGrant({
      installationId: '3014',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3014',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('installation not found');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // Monotonic revocation: a member who kept a valid TTL membership row
  // but whose grant was minted BEFORE a revocation tombstone (iat <= revoked_at)
  // is replaying a stale artifact from a removal — the in-tx recheck rejects it
  // with the FROZEN stable 'invalid connect grant', and NO connection is created.
  it('returns 403 invalid connect grant when the grant predates a revocation tombstone', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3015',
      memberGithubId: '5551234',
    });
    // The member was removed AFTER minting the grant: tombstone at now() keyed by
    // the member's GitHub account id, grant stamped a minute in the past.
    await recordInstallationRevocations(env.db, ['3015'], '5551234');
    const grant = await mintConnectGrant({
      installationId: '3015',
      repoFullName: 'org/app',
      githubAccountId: '5551234',
      iat: Date.now() - 60_000,
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3015',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // High-water mark, not a permanent ban: a legit re-authorize AFTER re-add mints
  // a FRESH grant (iat > revoked_at) which connects normally.
  it('connects when the grant post-dates the revocation tombstone (legit re-authorize)', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3016',
      memberGithubId: '5551234',
    });
    await recordInstallationRevocations(env.db, ['3016'], '5551234');
    const grant = await mintConnectGrant({
      installationId: '3016',
      repoFullName: 'org/app',
      repositoryId: 987_654,
      githubAccountId: '5551234',
      iat: Date.now() + 60_000, // fresh proof, after the tombstone
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3016',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(200);
    const connection = (await res.json()) as { repository_id: string };
    expect(connection.repository_id).toBe('987654');
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('987654');
  });

  // DEPLOY-CLOSE, end-to-end. The deferred-bind hole: V joins a shared
  // install with X's browser proof (membership github_account_id = X) but V's Void
  // account is NOT oauth-linked to X. A member_removed(X) delivery is driven for
  // REAL here — X has no oauth link, so ONLY the membership-proof-id route
  // catches V, deletes the membership, and stamps a durable tombstone for
  // (install, V). V then escalates: oauth-links X (they control it) and regains
  // membership (a re-join), but replays a PRE-removal connect_grant (iat < the
  // tombstone). The connect gate's in-tx tombstone recheck rejects the stale grant.
  it('deploy-close: a proof-id sever tombstones (install, V) so a pre-removal grant cannot connect', async () => {
    const ORG = '6100';
    const INSTALL = '6100i';
    const X = '6551234'; // the removed GitHub id V proved at join — NOT V's own id

    await createTestUser(env.db, 'f1-owner', 'github', 'gh-owner-6100');
    // V is a google-only account at join time — the deferred-bind case.
    const v = await createTestUser(env.db, 'f1-v', 'google', 'google-f1-v');
    await upsertGitHubInstallation(env.db, {
      installationId: INSTALL,
      userId: null,
      accountLogin: 'org',
      accountId: ORG,
      accountType: 'Organization',
      repositories: [{ full_name: 'org/app', id: 1 }],
      repositorySelection: 'selected',
    });
    const project = await createTestProject(env.db, v.id, 'f1-v-proj');
    await upsertGitHubInstallationMember(env.db, {
      installationId: INSTALL,
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });

    // Drive the REAL member_removed(X). X has no oauth link → only the proof-id route catches V.
    const webhookRes = await postWebhook('organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });
    expect(webhookRes.status).toBe(200);
    // The webhook wrote the tombstone (keyed by the removed GitHub id X) + deleted
    // V's membership.
    expect(
      (await getTestGitHubInstallationMembers(env.db, INSTALL)).some((m) => m.user_id === v.id),
    ).toBe(false);
    const tombstone = await getInstallationRevocationAt(env.db, INSTALL, X);
    expect(tombstone).not.toBeNull();

    // Escalation: V oauth-links X and re-obtains membership (a fresh re-join),
    // then replays a PRE-removal grant (iat strictly before the tombstone).
    await env.db.insert(oauthAccounts).values({
      id: generateId('oa'),
      user_id: v.id,
      provider: 'github',
      provider_id: X,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: INSTALL,
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });
    const staleGrant = await mintConnectGrant({
      installationId: INSTALL,
      repoFullName: 'org/app',
      githubAccountId: X,
      iat: tombstone! - 60_000,
    });

    const res = await memberConnect(v, project.id, {
      installationId: INSTALL,
      repoFullName: 'org/app',
      connectGrant: staleGrant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // DEPLOY-CLOSE, end-to-end. The pre-mint hole: a soon-to-be-removed org
  // member pre-mints a join_code + connect_grant carrying their GitHub id X while
  // still in the org, WITHOUT any Void user / membership / oauth-link. member_removed(X)
  // then finds an EMPTY affected set. The tombstone is keyed by X (durable, known
  // from the payload), so the REAL member_removed(X) below records (install, X)
  // even with nobody to sever. After removal the attacker binds a Void account V,
  // links X, and replays the two PRE-removal artifacts (iat < the tombstone):
  //   (a) /join/complete SKIPS the install (no membership resurrected), AND
  //   (b) even after we FORCE a membership to exist, the connect gate 403s and
  //       creates NO connection.
  // Driving the real webhook + real redemptions proves the write-side String(X)
  // and the read-side join/grant githubAccountId are the SAME string form.
  it('deploy-close: a pre-mint (empty-affected-set) removal tombstones (install, X) and blocks BOTH replay gates', async () => {
    const ORG = '6200';
    const INSTALL = '6200i';
    const X = '6559999'; // the attacker's GitHub id — NO Void user exists at removal

    // The install exists (owned by someone else). X has no oauth link and no
    // membership row → member_removed(X) resolves an EMPTY affected-user set.
    await createTestUser(env.db, 't19-owner', 'github', 'gh-owner-6200');
    await upsertGitHubInstallation(env.db, {
      installationId: INSTALL,
      userId: null,
      accountLogin: 'org',
      accountId: ORG,
      accountType: 'Organization',
      repositories: [{ full_name: 'org/app', id: 1 }],
      repositorySelection: 'selected',
    });

    // The attacker pre-mints BOTH artifacts while still in the org (iat = T0). No
    // Void user/membership/oauth yet — purely stateless HMAC artifacts.
    const T0 = Date.now() - 60_000;
    const challenge = await createCodeChallenge(CONNECT_VERIFIER);
    const joinEncoded = btoa(
      JSON.stringify({
        purpose: 'join',
        installationIds: [INSTALL],
        githubAccountId: X,
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        iat: T0,
        exp: Date.now() + 5 * 60 * 1000,
      }),
    );
    const preJoinCode = `${joinEncoded}.${await hmacSignState(joinEncoded, JWT_SECRET)}`;
    const preGrant = await mintConnectGrant({
      installationId: INSTALL,
      repoFullName: 'org/app',
      githubAccountId: X,
      iat: T0,
    });

    // Drive the REAL member_removed(X): EMPTY affected set, but the tombstone for
    // (INSTALL, X) is written anyway (the hole is closed).
    const webhookRes = await postWebhook('organization', {
      action: 'member_removed',
      organization: { id: Number(ORG) },
      membership: { user: { id: Number(X) } },
    });
    expect(webhookRes.status).toBe(200);
    expect(await webhookRes.json()).toEqual({ ok: true });
    const tombstone = await getInstallationRevocationAt(env.db, INSTALL, X);
    expect(tombstone).not.toBeNull();
    expect(tombstone!).toBeGreaterThan(T0); // strictly after the pre-mint moment

    // The attacker binds a Void account V and links X (they control it).
    const v = await createTestUser(env.db, 't19-v', 'google', 'google-t19-v');
    await env.db.insert(oauthAccounts).values({
      id: generateId('oa'),
      user_id: v.id,
      provider: 'github',
      provider_id: X,
    });
    const project = await createTestProject(env.db, v.id, 't19-v-proj');

    // (a) Replay the pre-removal join_code → the install is SKIPPED (iat < tombstone),
    // so NO membership is resurrected.
    const joinRes = await app.fetch(
      new Request('http://localhost/github/join/complete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${v.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ join_code: preJoinCode, code_verifier: CONNECT_VERIFIER }),
      }),
      // /join/complete is gated on App user OAuth; send the configured
      // env so this test exercises the tombstone-skip behavior, not the kill switch.
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );
    expect(joinRes.status).toBe(200);
    expect(await joinRes.json()).toEqual({ status: 'joined', count: 0 });
    expect(
      (await getTestGitHubInstallationMembers(env.db, INSTALL)).some((m) => m.user_id === v.id),
    ).toBe(false);

    // (b) Even if a membership DID exist (force one — e.g. a concurrent re-join),
    // the connect gate's in-tx tombstone recheck (keyed by the grant's X) rejects
    // the pre-removal grant and creates NO connection.
    await upsertGitHubInstallationMember(env.db, {
      installationId: INSTALL,
      userId: v.id,
      githubAccountId: X,
      ttlSeconds: 3600,
    });
    const connectRes = await memberConnect(v, project.id, {
      installationId: INSTALL,
      repoFullName: 'org/app',
      connectGrant: preGrant,
      codeVerifier: CONNECT_VERIFIER,
    });
    expect(connectRes.status).toBe(403);
    expect(((await connectRes.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // A connect_grant without `iat` cannot be compared with revocation tombstones,
  // so it is rejected with the FROZEN stable 'invalid connect grant' even when no
  // revocation exists — no connection is created. Mint inline so the property is
  // truly ABSENT from the signed payload (mintConnectGrant would inject one).
  it('returns 403 invalid connect grant when the grant carries no iat', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3019',
      memberGithubId: '5551234',
    });
    const encoded = btoa(
      JSON.stringify({
        purpose: 'connect',
        installationId: '3019',
        repoFullName: 'org/app',
        repositoryId: 4242,
        githubAccountId: '5551234',
        codeChallenge: await createCodeChallenge(CONNECT_VERIFIER),
        codeChallengeMethod: 'S256',
        // NO `iat` field.
        exp: Date.now() + 5 * 60 * 1000,
      }),
    );
    const signature = await hmacSignState(encoded, JWT_SECRET);
    const grantWithoutIat = `${encoded}.${signature}`;

    const res = await memberConnect(member, project.id, {
      installationId: '3019',
      repoFullName: 'org/app',
      connectGrant: grantWithoutIat,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('invalid connect grant');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // With NO revocation recorded, a valid grant still connects (the tombstone gate
  // is inert when there is no tombstone).
  it('connects a member with a valid grant and no revocation', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '3017',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '3017',
      repoFullName: 'org/app',
      repositoryId: 555_111,
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '3017',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(200);
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('555111');
  });

  // The OWNER path takes no membership/tombstone recheck. Even with a revocation
  // recorded for the owner (which never happens in practice), the owner still
  // connects — the in-tx recheck is gated on `!isOwner`.
  it('OWNER path is unaffected by a revocation tombstone', async () => {
    const owner = await createTestUser(env.db, 'owner-3018', 'github', 'gh-owner-3018');
    const project = await createTestProject(env.db, owner.id, 'owner-proj-3018');
    await upsertGitHubInstallation(env.db, {
      installationId: '3018',
      userId: owner.id,
      accountLogin: 'acme',
      accountId: 'acc_3018',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 42 }],
      repositorySelection: 'selected',
    });
    // A tombstone for the owner's GitHub account id must not block the owner path.
    await recordInstallationRevocations(env.db, ['3018'], 'gh-owner-3018');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '3018', repoFullName: 'acme/app' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('42');
  });

  // The App user-OAuth config is a TRUE kill switch: the pure signed-
  // artifact REDEMPTION paths (which make no live GitHub call) must also fail
  // closed when the config is removed, not just the BEGIN routes. A join_code /
  // connect_grant minted BEFORE the config disappeared must stop working
  // immediately, not linger until its TTL. The OWNER connect path takes no user
  // OAuth and must stay UNAFFECTED.

  // /join/complete with a VALID join_code but OAuth unconfigured → 503, and NO
  // membership is bound (the guard runs before the membership tx). With the config
  // present this same join_code would bind a membership, so the 503 + empty members
  // proves the redemption honors the kill switch.
  it('fail-closed: /join/complete with App user OAuth unconfigured returns 503 and creates no membership', async () => {
    const INSTALL = '7100i';
    await createTestUser(env.db, 'r101-join-owner', 'github', 'gh-owner-7100');
    await upsertGitHubInstallation(env.db, {
      installationId: INSTALL,
      userId: null,
      accountLogin: 'org',
      accountId: 'acc_7100',
      accountType: 'Organization',
      repositories: [{ full_name: 'org/app', id: 1 }],
      repositorySelection: 'selected',
    });
    const caller = await createTestUser(env.db, 'r101-join-caller', 'github', 'gh-caller-7100');
    // A well-formed, non-tombstoned join_code (iat=now) that WOULD bind a membership
    // were the config present — minted the same way GET /join-callback does.
    const joinEncoded = btoa(
      JSON.stringify({
        purpose: 'join',
        installationIds: [INSTALL],
        githubAccountId: 'gh-caller-7100',
        codeChallenge: await createCodeChallenge(CONNECT_VERIFIER),
        codeChallengeMethod: 'S256',
        iat: Date.now(),
        exp: Date.now() + 5 * 60 * 1000,
      }),
    );
    const joinCode = `${joinEncoded}.${await hmacSignState(joinEncoded, JWT_SECRET)}`;

    const res = await app.fetch(
      new Request('http://localhost/github/join/complete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${caller.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ join_code: joinCode, code_verifier: CONNECT_VERIFIER }),
      }),
      env, // App user OAuth OMITTED — the kill switch is off.
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'github_oauth_not_configured',
      message: 'GitHub App user OAuth is not configured',
    });
    expect(
      (await getTestGitHubInstallationMembers(env.db, INSTALL)).some(
        (m) => m.user_id === caller.id,
      ),
    ).toBe(false);
  });

  // Member connect (non-owner, active membership + a VALID connect_grant) with
  // OAuth unconfigured → 503, and NO connection. The identical setup connects
  // (200) with the config present (see the no-revocation test above), so the
  // 503 + null connection proves the member redemption honors the kill switch.
  it('fail-closed: member connect with App user OAuth unconfigured returns 503 and creates no connection', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '7200',
      memberGithubId: '5551234',
    });
    const grant = await mintConnectGrant({
      installationId: '7200',
      repoFullName: 'org/app',
      repositoryId: 777_001,
      githubAccountId: '5551234',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${member.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '7200',
          repoFullName: 'org/app',
          connectGrant: grant,
          codeVerifier: CONNECT_VERIFIER,
        }),
      }),
      env, // App user OAuth OMITTED — the kill switch is off.
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'github_oauth_not_configured',
      message: 'GitHub App user OAuth is not configured',
    });
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // OWNER connect is UNGATED — the guard lives inside `if (!isOwner)`, so an owner
  // (who uses no user OAuth) never reaches it. With OAuth unconfigured the owner
  // still connects (200 + connection), proving the kill switch does not touch the
  // owner path.
  it('OWNER connect is UNGATED — succeeds with App user OAuth unconfigured', async () => {
    const owner = await createTestUser(env.db, 'r101-owner', 'github', 'gh-owner-7300');
    const project = await createTestProject(env.db, owner.id, 'r101-owner-proj');
    await upsertGitHubInstallation(env.db, {
      installationId: '7300',
      userId: owner.id,
      accountLogin: 'acme',
      accountId: 'acc_7300',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 4242 }],
      repositorySelection: 'selected',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '7300', repoFullName: 'acme/app' }),
      }),
      env, // App user OAuth OMITTED — the owner path must be unaffected.
    );

    expect(res.status).toBe(200);
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('4242');
  });
});

// The connect gate re-derives ownership from the install row it locks
// FOR UPDATE inside the go-live transaction, not the stale pre-tx snapshot. If a
// personal install's owner pointer changes while a connect waits on that lock,
// the pre-tx owner path is stale: repositoryId was resolved via the installation
// token with NO member grant, so falling through to the member insert would be a
// confused-deputy. The re-read fails closed (opaque 404) on the
// `isOwner && !lockedIsOwner` transition.
describe('POST /projects/:id/github — locked-row ownership re-derivation', () => {
  // Sequential fail-closed: a personal install with no linked owner (user_id
  // NULL) + a caller who is NOT a member fails closed with the opaque 404 and
  // creates no connection. Pre-tx isOwner is false (null !== caller), so the
  // owner path is never taken and the non-member gate rejects it.
  it('returns opaque 404 for an unlinked personal install when the caller is not a member', async () => {
    const caller = await createTestUser(env.db, 'caller-3020', 'github', 'gh-caller-3020');
    const project = await createTestProject(env.db, caller.id, 'gh-cleared-3020');
    await upsertGitHubInstallation(env.db, {
      installationId: '3020',
      userId: null,
      accountLogin: 'someone',
      accountId: 'acc_3020',
      accountType: 'User',
      repositories: [{ full_name: 'someone/app', id: 1 }],
      repositorySelection: 'selected',
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${caller.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '3020', repoFullName: 'someone/app' }),
      }),
      // Non-owner path is gated on App user OAuth; send the configured env
      // so this test reaches the membership gate (opaque 404), not the kill switch.
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('installation not found');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // The true race branch, driven deterministically. On the owner + all-repos
  // path the route resolves the repo id via a live GET /repos fetch BETWEEN the
  // pre-tx read (isOwner=true) and the go-live transaction's FOR UPDATE re-read.
  // The stubbed fetch clears the owner pointer as its side effect, so the locked
  // read sees user_id=NULL and `isOwner && !lockedIsOwner` fails closed with a
  // 404 and NO connection. The fetch is a real await point in the owner path, so
  // the locked read observes a change made after the pre-tx snapshot without any
  // timing race.
  it('fails closed (404, no connection) when the owner pointer is cleared between the pre-tx read and the locked read', async () => {
    const owner = await createTestUser(env.db, 'owner-3021', 'github', 'gh-owner-3021');
    const project = await createTestProject(env.db, owner.id, 'gh-race-3021');
    await upsertGitHubInstallation(env.db, {
      installationId: '3021',
      userId: owner.id,
      accountLogin: 'owner-3021',
      accountId: 'acc_3021',
      accountType: 'User',
      repositories: [{ full_name: 'owner-3021/old', id: 1 }],
      // `all` forces the live GET /repos resolution — the interposition seam.
      repositorySelection: 'all',
    });

    // The fetch stub interposes between the pre-tx owner read and the locked
    // re-read: it nulls the owner pointer before returning the id.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/owner-3021/new')) {
          await env.db
            .update(githubInstallations)
            .set({ user_id: null })
            .where(eq(githubInstallations.installation_id, '3021'));
          return Response.json({ id: 9999 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '3021', repoFullName: 'owner-3021/new' }),
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('installation not found');
    // The stale-owner connect must NOT have planted a connection.
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
    // The live repo id was actually resolved, so the owner path really ran.
    expect(fetch).toHaveBeenCalled();
  });
});

// The go-live transaction re-reads the MUTABLE install gates
// (status + repository_selection + repositories) on the row it locks FOR UPDATE,
// not the stale pre-tx snapshot. A teardown handler (installation.deleted/suspend
// marks status inactive; a repository-selection change de-scopes the repo) locks
// the SAME install row install-first, so a teardown that wins the lock first is
// observed by the waiting connect. Two of these tests drive that seam
// DETERMINISTICALLY: on the OWNER + all-repos path `resolveRepositoryId` performs
// a live GET /repos fetch BETWEEN the pre-tx read and the locked re-read, so the
// stub mutates the install (exactly as a concurrent teardown commit would while
// the connect blocked on the lock) and the locked read observes it. The member
// test proves the asymmetry: the coverage re-check is OWNER-only, so a member's
// live-proved grant for a repo absent from the (lagging) cache still connects.
describe('POST /projects/:id/github — post-lock status + coverage re-check', () => {
  // POST-LOCK STATUS gate (owner, deterministic seam). Pre-tx read sees an ACTIVE
  // all-repos install; the live GET /repos side-effect flips status to 'deleted'
  // (installation.deleted keeps the row but marks it inactive — the
  // missing-row guard does NOT catch it). The locked read sees status='deleted'
  // and rejects with 409, so no orphan connection is planted into a torn-down
  // install. This exercises the LOCKED-row status gate, not the pre-tx one.
  it('rejects with 409 when the install is torn down (status→deleted) between the pre-tx read and the locked read', async () => {
    const owner = await createTestUser(env.db, 'owner-r91a', 'github', 'gh-owner-r91a');
    const project = await createTestProject(env.db, owner.id, 'gh-r91a');
    await upsertGitHubInstallation(env.db, {
      installationId: '4001',
      userId: owner.id,
      accountLogin: 'org',
      accountId: 'acc_4001',
      accountType: 'User',
      repositories: [{ full_name: 'org/old', id: 1 }],
      // `all` forces the live GET /repos resolution — the interposition seam.
      repositorySelection: 'all',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/org/new')) {
          // A concurrent installation.deleted committing while we blocked on the
          // install-row lock: the row survives, its status is marked inactive.
          await env.db
            .update(githubInstallations)
            .set({ status: 'deleted' })
            .where(eq(githubInstallations.installation_id, '4001'));
          return Response.json({ id: 9999 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '4001', repoFullName: 'org/new' }),
      }),
      env,
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('installation is not active');
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // POST-LOCK COVERAGE gate (owner, deterministic seam). Pre-tx read sees an
  // ACTIVE all-repos install (all repos covered, so the live resolve succeeds);
  // the GET /repos side-effect narrows the install to `selected` with a cache that
  // EXCLUDES the target repo (a repository-selection change de-scoping the repo).
  // The locked read re-checks the cache under the lock and rejects with 400, so
  // the owner cannot connect a repo the install no longer covers. OWNER-only gate.
  it('rejects with 400 when a selection change de-scopes the repo between the pre-tx read and the locked read', async () => {
    const owner = await createTestUser(env.db, 'owner-r91b', 'github', 'gh-owner-r91b');
    const project = await createTestProject(env.db, owner.id, 'gh-r91b');
    await upsertGitHubInstallation(env.db, {
      installationId: '4002',
      userId: owner.id,
      accountLogin: 'org',
      accountId: 'acc_4002',
      accountType: 'User',
      repositories: [{ full_name: 'org/old', id: 1 }],
      repositorySelection: 'all',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/repos/org/new')) {
          // Narrow to `selected` and DROP org/new from the cache — the de-scoping
          // teardown committing while we blocked on the lock.
          await env.db
            .update(githubInstallations)
            .set({
              repository_selection: 'selected',
              repositories: [{ full_name: 'org/other', id: 7 }],
            })
            .where(eq(githubInstallations.installation_id, '4002'));
          return Response.json({ id: 9999 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '4002', repoFullName: 'org/new' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'repository not accessible by installation',
    );
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // ASYMMETRY GUARD — the coverage re-check is OWNER-only. A member holds a grant
  // for a repo they LIVE-proved under their OWN token at connect-authorize, and
  // the install's cached `repositories` set can LAG that live proof (the
  // installation_repositories webhook updates the cache asynchronously). Here the
  // ACTIVE `selected` install's cache does NOT list org/app, yet the member's
  // valid grant for org/app must still connect (200). If a future change added the
  // owner coverage check to the member path, this legitimate connect would
  // false-reject — this test locks the asymmetry in place.
  it('MEMBER connects a repo ABSENT from the selected cache via a live-proved grant (coverage check is owner-only)', async () => {
    const { member, project } = await seedMemberScenario({
      installationId: '4003',
      memberGithubId: '5551234',
      // Cache EXCLUDES the target repo — the owner path would 400 on org/app.
      repositories: [{ full_name: 'org/other', id: 111 }],
      repositorySelection: 'selected',
    });
    const grant = await mintConnectGrant({
      installationId: '4003',
      repoFullName: 'org/app',
      repositoryId: 909_090,
      githubAccountId: '5551234',
    });

    const res = await memberConnect(member, project.id, {
      installationId: '4003',
      repoFullName: 'org/app',
      connectGrant: grant,
      codeVerifier: CONNECT_VERIFIER,
    });

    expect(res.status).toBe(200);
    // The grant's live-proved id wins even though org/app is not in the cache.
    expect((await getGitHubConnection(env.db, project.id))?.repository_id).toBe('909090');
  });
});

describe('GET /projects/:id/github', () => {
  it('returns the connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-get');
    await upsertGitHubInstallation(env.db, {
      installationId: '666',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_6',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '666', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const connection = (await res.json()) as Record<string, unknown>;
    expect(connection.repo_full_name).toBe('acme/app');
    expect(connection).not.toHaveProperty('requires_reconnect');
  });

  it('returns 404 when there is no connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-get-404');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 for a project owned by someone else', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id, 'gh-get-403');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, authed(other.jwt)),
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /projects/:id/github', () => {
  it('updates branch and build executor', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch');
    await upsertGitHubInstallation(env.db, {
      installationId: '777',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_7',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '777', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop', buildExecutor: 'github_actions' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const updated = (await res.json()) as { branch: string; build_executor: string };
    expect(updated.branch).toBe('develop');
    expect(updated.build_executor).toBe('github_actions');
  });

  it('updates workflow_path', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-wf');
    await upsertGitHubInstallation(env.db, {
      installationId: '778',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_7',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '778', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowPath: '.github/workflows/ci.yml' }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { workflow_path: string }).workflow_path).toBe(
      '.github/workflows/ci.yml',
    );
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/ci.yml');
  });

  it('returns 400 when workflowPath is invalid on PATCH', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-wf-bad');
    await upsertGitHubInstallation(env.db, {
      installationId: '779',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_7',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '779', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowPath: 'not-under-workflows.yml' }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid workflowPath');
    // The connection's workflow_path is unchanged (still the default).
    const persisted = await getGitHubConnection(env.db, project.id);
    expect(persisted?.workflow_path).toBe('.github/workflows/void-deploy.yml');
  });

  it('returns 404 when there is no connection to patch', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-404');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop' }),
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  // A branch change orphans in-flight builds for the OLD branch — their deploy
  // tokens must be revoked. Builds on a DIFFERENT branch keep running.
  it('cancels OLD-branch in-flight builds on a branch change', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-branch');
    await upsertGitHubInstallation(env.db, {
      installationId: '780',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_b',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // Connection starts on `main`.
        body: JSON.stringify({ installationId: '780', repoFullName: 'acme/app', branch: 'main' }),
      }),
      env,
    );

    const mainBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'main',
    });
    const developBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'develop',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { branch: string }).branch).toBe('develop');

    // The OLD-branch (main) build is cancelled; the develop build is untouched.
    expect((await getBuild(env.db, mainBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, mainBuild.id))!.error).toBe('branch changed');
    expect((await getBuild(env.db, developBuild.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([mainBuild.id]);
  });

  // An executor change orphans in-flight builds for the OLD executor.
  it('cancels OLD-executor in-flight builds on an executor change', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-exec');
    await upsertGitHubInstallation(env.db, {
      installationId: '781',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_e',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // Connection starts on the `container` executor.
        body: JSON.stringify({
          installationId: '781',
          repoFullName: 'acme/app',
          buildExecutor: 'container',
        }),
      }),
      env,
    );

    const containerBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    const actionsBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ buildExecutor: 'github_actions' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);

    // The OLD-executor (container) build is cancelled; the actions build is untouched.
    expect((await getBuild(env.db, containerBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, containerBuild.id))!.error).toBe('executor changed');
    expect((await getBuild(env.db, actionsBuild.id))!.status).toBe('building');
    // DO cancel attempted for the cancelled CONTAINER build.
    expect(cancelledIds).toEqual([containerBuild.id]);
  });

  // A workflow_path change is a trust-boundary change: it must orphan in-flight
  // github_actions builds authorized under the OLD pin (their deploy token stays
  // valid while the build is active), the SAME way branch/executor changes do.
  // Container builds don't use the workflow gate, so they keep running.
  it('cancels in-flight github_actions builds on a workflow_path change', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-workflow');
    await upsertGitHubInstallation(env.db, {
      installationId: '783',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_w',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // github_actions executor, default workflow (.github/workflows/void-deploy.yml).
        body: JSON.stringify({
          installationId: '783',
          repoFullName: 'acme/app',
          buildExecutor: 'github_actions',
        }),
      }),
      env,
    );

    const actionsBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
    });
    const containerBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowPath: '.github/workflows/ci.yml' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workflow_path: string }).workflow_path).toBe(
      '.github/workflows/ci.yml',
    );

    // The github_actions build (authorized under the OLD pin) is cancelled; the
    // container build is untouched (it never used the workflow gate).
    expect((await getBuild(env.db, actionsBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, actionsBuild.id))!.error).toBe('workflow path changed');
    expect((await getBuild(env.db, containerBuild.id))!.status).toBe('building');
    // github_actions builds have no container DO, so no DO cancel is attempted.
    expect(cancelledIds).toEqual([]);
  });

  // A no-op PATCH (values unchanged) must terminalize NOTHING.
  it('cancels no builds on a no-op PATCH', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-noop');
    await upsertGitHubInstallation(env.db, {
      installationId: '782',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_n',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '782',
          repoFullName: 'acme/app',
          branch: 'main',
          buildExecutor: 'container',
        }),
      }),
      env,
    );

    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'main',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // Same branch + executor the connection already has.
        body: JSON.stringify({ branch: 'main', buildExecutor: 'container' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);

    // Nothing terminalized, no DO cancel attempted.
    expect((await getBuild(env.db, build.id))!.status).toBe('building');
    expect(cancelledIds).toHaveLength(0);
  });

  // The terminate decision is computed from the connection row read UNDER the
  // FOR UPDATE lock (`current`), not a pre-tx snapshot. To prove it, drive the
  // PATCH's locked `current.branch` to differ from what the connection looked
  // like earlier: connect on `main`, then re-point the branch to `release`
  // directly in the DB (modeling a concurrent PATCH that committed first). A
  // PATCH `release` -> `develop` must terminate the `release` build (the locked
  // current branch) and leave a stray `main` build untouched — if it keyed off a
  // stale `main` snapshot it would cancel the wrong build.
  it('terminates builds for the LOCKED current branch, not a stale snapshot', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-patch-locked');
    await upsertGitHubInstallation(env.db, {
      installationId: '783',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_l',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        // Connection starts on `main`.
        body: JSON.stringify({ installationId: '783', repoFullName: 'acme/app', branch: 'main' }),
      }),
      env,
    );

    // Re-point the connection to `release` out-of-band (models another PATCH that
    // committed first). The handler's pre-tx 404 guard read still sees the row;
    // its locked re-read inside the tx sees `release`.
    await env.db
      .update(githubConnections)
      .set({ branch: 'release' })
      .where(eq(githubConnections.project_id, project.id));

    // A stray build on the OLD branch (`main`) that must NOT be terminated, and a
    // build on the CURRENT locked branch (`release`) that MUST be terminated.
    const mainBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'main',
    });
    const releaseBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
      branch: 'release',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: 'develop' }),
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { branch: string }).branch).toBe('develop');

    // Terminated the LOCKED-current branch (`release`); the stale `main` build is
    // untouched — termination keyed off `current.branch`, not the snapshot.
    expect((await getBuild(env.db, releaseBuild.id))!.status).toBe('cancelled');
    expect((await getBuild(env.db, releaseBuild.id))!.error).toBe('branch changed');
    expect((await getBuild(env.db, mainBuild.id))!.status).toBe('building');
    expect(cancelledIds).toEqual([releaseBuild.id]);
  });
});

describe('DELETE /projects/:id/github', () => {
  it('removes the connection', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-delete');
    await upsertGitHubInstallation(env.db, {
      installationId: '888',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_8',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '888', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  it('returns 403 when deleting a connection on another user project', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const other = await createTestUser(env.db, 'other');
    const project = await createTestProject(env.db, owner.id, 'gh-delete-403');

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${other.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  // Disconnecting must terminalize ALL in-flight builds (queued +
  // active, both executors). A still-running container build already minted a
  // VOID_TOKEN, and its build row staying active would keep the middleware
  // guard passing, so the container could keep publishing from a now-disconnected
  // repo. Terminalizing the row (→ cancelled) revokes the token; the DO `/cancel`
  // is a best-effort container teardown on top. github_actions builds are also
  // terminalized so they stop pinning a concurrency slot.
  it('terminalizes ALL in-flight builds (container + github_actions) on disconnect', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-delete-terminate');
    await upsertGitHubInstallation(env.db, {
      installationId: '889',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_9',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId: '889',
          repoFullName: 'acme/app',
          buildExecutor: 'github_actions',
        }),
      }),
      env,
    );

    const actionsBuild = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'github_actions',
      status: 'building',
      githubRunId: '1000',
    });
    const activeContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    const queuedContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'queued',
    });
    const deployingContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'deploying',
    });
    // Terminal — left untouched, never sent to the DO.
    const completeContainer = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'complete',
    });

    const { namespace, cancelledIds } = recordingBuildManager({ recordFetchCancel: true });
    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      { ...env, BUILD_MANAGER: namespace },
    );
    expect(res.status).toBe(200);

    // Every in-flight build (both executors) is cancelled + stamped.
    for (const id of [
      actionsBuild.id,
      activeContainer.id,
      queuedContainer.id,
      deployingContainer.id,
    ]) {
      const row = await getBuild(env.db, id);
      expect(row!.status).toBe('cancelled');
      expect(row!.completed_at).not.toBeNull();
    }
    // The terminal build is left alone.
    expect((await getBuild(env.db, completeContainer.id))!.status).toBe('complete');

    // Sanity: exactly the four in-flight rows were terminalized.
    const all = await getProjectBuilds(env.db, project.id);
    expect(all.filter((b) => b.status === 'cancelled').length).toBe(4);

    // The DO `/cancel` was attempted for the cancelled CONTAINER builds only —
    // never the github_actions build, never the already-terminal build.
    expect([...cancelledIds].sort()).toEqual(
      [activeContainer.id, queuedContainer.id, deployingContainer.id].sort(),
    );

    // Terminate + delete run in one tx (locked on the connection row); the
    // connection is gone.
    expect(await getGitHubConnection(env.db, project.id)).toBeNull();
  });

  // End-to-end: after disconnect cancels a build, a deploy token bound to
  // that build must be rejected by the central middleware guard. This proves the
  // status flip actually revokes the token — not just that the row is terminal.
  it('rejects a deploy token bound to a build that disconnect cancelled', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'gh-delete-token');
    await upsertGitHubInstallation(env.db, {
      installationId: '890',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_10',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationId: '890', repoFullName: 'acme/app' }),
      }),
      env,
    );

    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: user.id,
      executor: 'container',
      status: 'building',
    });
    const deployToken = await signDeployToken(
      { projectId: project.id, userId: user.id, login: user.login, buildId: build.id },
      JWT_SECRET,
    );

    // A deploy-token endpoint guarded by the same authMiddleware. Before
    // disconnect the build is active, so the guard lets the token through (the
    // stub handler returns 200).
    const guardApp = new Hono<ApiEnv>()
      .use('*', async (context, next) => {
        context.set('db', env.db);
        await next();
      })
      .use('/projects/*', authMiddleware)
      .post('/projects/:id/database', (context) => context.json({ ok: true }));

    const before = await guardApp.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deployToken}` },
      }),
      env,
    );
    expect(before.status).toBe(200);

    // Disconnect cancels the build.
    const del = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/github`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(del.status).toBe(200);
    expect((await getBuild(env.db, build.id))!.status).toBe('cancelled');

    // Now the same token is rejected by the guard (build no longer active).
    const after = await guardApp.fetch(
      new Request(`http://localhost/projects/${project.id}/database`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deployToken}` },
      }),
      env,
    );
    expect(after.status).toBe(403);
  });
});

describe('GET /github/installations', () => {
  it('lists the caller installations only', async () => {
    const user = await createTestUser(env.db, 'lister');
    const other = await createTestUser(env.db, 'other-lister');
    await upsertGitHubInstallation(env.db, {
      installationId: '901',
      userId: user.id,
      accountLogin: 'acme',
      accountId: 'acc_901',
      accountType: 'User',
      repositories: [{ full_name: 'acme/app', id: 1 }],
    });
    await upsertGitHubInstallation(env.db, {
      installationId: '902',
      userId: other.id,
      accountLogin: 'other',
      accountId: 'acc_902',
      accountType: 'User',
      repositories: [],
    });

    const res = await app.fetch(
      new Request('http://localhost/github/installations', authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const installations = (await res.json()) as Array<{ installation_id: string }>;
    expect(installations).toHaveLength(1);
    expect(installations[0]!.installation_id).toBe('901');
  });

  // (a) A member of a shared org installation sees it via the
  // owner-OR-active-member gate.
  it('includes an installation the caller has an active membership in', async () => {
    const userA = await createTestUser(env.db, 'member-a');
    await upsertGitHubInstallation(env.db, {
      installationId: '910',
      userId: null,
      accountLogin: 'org',
      accountId: 'acc_910',
      accountType: 'Organization',
      repositories: [{ full_name: 'org/app', id: 1 }],
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '910',
      userId: userA.id,
      githubAccountId: 'gh_a',
      ttlSeconds: 3600,
    });

    const res = await app.fetch(
      new Request('http://localhost/github/installations', authed(userA.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const installations = (await res.json()) as Array<{ installation_id: string }>;
    expect(installations).toHaveLength(1);
    expect(installations[0]!.installation_id).toBe('910');
  });

  // (b) A non-member (no membership row) does NOT see the installation.
  it('excludes an installation the caller has no membership in', async () => {
    const userA = await createTestUser(env.db, 'stranger-a');
    await upsertGitHubInstallation(env.db, {
      installationId: '911',
      userId: null,
      accountLogin: 'org2',
      accountId: 'acc_911',
      accountType: 'Organization',
      repositories: [],
    });

    const res = await app.fetch(
      new Request('http://localhost/github/installations', authed(userA.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const installations = (await res.json()) as Array<{ installation_id: string }>;
    expect(installations).toHaveLength(0);
  });

  // (c) An EXPIRED membership row is excluded (TTL honored via expires_at > now()).
  it('excludes an installation whose membership has expired', async () => {
    const userA = await createTestUser(env.db, 'expired-a');
    await upsertGitHubInstallation(env.db, {
      installationId: '912',
      userId: null,
      accountLogin: 'org3',
      accountId: 'acc_912',
      accountType: 'Organization',
      repositories: [],
    });
    // Negative ttl makes `now() + (-3600 * interval '1 second')` land in the past.
    await upsertGitHubInstallationMember(env.db, {
      installationId: '912',
      userId: userA.id,
      githubAccountId: 'gh_a',
      ttlSeconds: -3600,
    });

    const res = await app.fetch(
      new Request('http://localhost/github/installations', authed(userA.jwt)),
      env,
    );
    expect(res.status).toBe(200);
    const installations = (await res.json()) as Array<{ installation_id: string }>;
    expect(installations).toHaveLength(0);
  });

  // Installing the App on an organization confers no standing of its own. The
  // installer sees nothing without an active membership; once membership is
  // proven, the installer and other members see only the installation metadata.
  // Personal installation owners retain their repo list.
  it('never exposes organization repositories to the installer or members', async () => {
    const owner = await createTestUser(env.db, 'repo-owner');
    const member = await createTestUser(env.db, 'repo-member');
    const seededRepos = [
      { full_name: 'org/secret-app', id: 1 },
      { full_name: 'org/private-api', id: 2 },
    ];
    await upsertGitHubInstallation(env.db, {
      installationId: '920',
      userId: null,
      accountLogin: 'org5',
      accountId: 'acc_920',
      accountType: 'Organization',
      repositories: seededRepos,
      repositorySelection: 'selected',
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '920',
      userId: member.id,
      githubAccountId: 'gh_member',
      ttlSeconds: 3600,
    });

    type Row = {
      installation_id: string;
      repository_selection: string;
      repositories: Array<{ full_name: string; id: number }>;
    };

    // Having installed the App does not make the installation visible, much
    // less disclose every private repository in its cache.
    const ownerRes = await app.fetch(
      new Request('http://localhost/github/installations', authed(owner.jwt)),
      env,
    );
    expect(ownerRes.status).toBe(200);
    const ownerRows = (await ownerRes.json()) as Array<Row>;
    expect(ownerRows.find((r) => r.installation_id === '920')).toBeUndefined();

    await upsertGitHubInstallationMember(env.db, {
      installationId: '920',
      userId: owner.id,
      githubAccountId: 'gh_owner',
      ttlSeconds: 3600,
    });
    const provenOwnerRes = await app.fetch(
      new Request('http://localhost/github/installations', authed(owner.jwt)),
      env,
    );
    const provenOwnerRows = (await provenOwnerRes.json()) as Array<Row>;
    expect(provenOwnerRows.find((r) => r.installation_id === '920')?.repositories).toEqual([]);

    // Member sees the same install (visibility preserved) but repositories is [].
    const memberRes = await app.fetch(
      new Request('http://localhost/github/installations', authed(member.jwt)),
      env,
    );
    expect(memberRes.status).toBe(200);
    const memberRows = (await memberRes.json()) as Array<Row>;
    const memberRow = memberRows.find((r) => r.installation_id === '920');
    expect(memberRow).toBeDefined();
    expect(memberRow!.repositories).toEqual([]);
    // Redaction is tight: no other field is blanked.
    expect(memberRow!.installation_id).toBe('920');
    expect(memberRow!.repository_selection).toBe('selected');

    const personalRepos = [{ full_name: 'repo-owner/personal', id: 3 }];
    await upsertGitHubInstallation(env.db, {
      installationId: '921',
      userId: owner.id,
      accountLogin: 'repo-owner',
      accountId: 'acc_921',
      accountType: 'User',
      repositories: personalRepos,
    });
    const personalRes = await app.fetch(
      new Request('http://localhost/github/installations', authed(owner.jwt)),
      env,
    );
    const personalRows = (await personalRes.json()) as Array<Row>;
    expect(personalRows.find((r) => r.installation_id === '921')?.repositories).toEqual(
      personalRepos,
    );
  });

  it('requires auth', async () => {
    const res = await app.fetch(new Request('http://localhost/github/installations'), env);
    expect(res.status).toBe(401);
  });
});

describe('GET /github/install-url', () => {
  it('returns 503 when the GitHub App slug is unset', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/github/install-url', authed(user.jwt)),
      env,
    );
    expect(res.status).toBe(503);
  });

  it('returns a signed install url when the slug is configured', async () => {
    const user = await createTestUser(env.db);
    const res = await app.fetch(
      new Request('http://localhost/github/install-url', authed(user.jwt)),
      { ...env, GITHUB_APP_SLUG: 'void-deploy' },
    );
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url.startsWith('https://github.com/apps/void-deploy/installations/new?state=')).toBe(
      true,
    );
  });

  it('returns 403 github_identity_required when the caller has no github identity', async () => {
    // A user authed via a non-github provider has no linked github oauth row,
    // so getCallerGitHubAccountId resolves null and the gate must reject.
    const user = await createTestUser(env.db, 'nogithub', 'google');
    const res = await app.fetch(
      new Request('http://localhost/github/install-url', authed(user.jwt)),
      { ...env, GITHUB_APP_SLUG: 'void-deploy' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'github_identity_required' });
  });
});

describe('GET /github/callback', () => {
  it('returns 503 when the GitHub App is unconfigured', async () => {
    const res = await app.fetch(
      new Request('http://localhost/github/callback?installation_id=1&state=x.y'),
      env,
    );
    expect(res.status).toBe(503);
  });

  // A Void user (A) must not be able to claim — and re-own — an
  // installation that already belongs to another user (B) just by holding a
  // validly-signed state. Here the installation's GitHub account id is forced
  // to equal A's bound account id (a derivation gap / id collision), so the
  // primary account check passes — the owner-guard backstop is what must reject
  // the re-own and leave B's ownership intact.
  it('does not re-own another user installation (owner-guard backstop)', async () => {
    const userB = await createTestUser(env.db, 'victim', 'github', '5555');
    const userA = await createTestUser(env.db, 'attacker', 'github', '4242');

    // B already owns installation 999.
    await upsertGitHubInstallation(env.db, {
      installationId: '999',
      userId: userB.id,
      accountLogin: 'victim',
      accountId: '5555',
      accountType: 'User',
      repositories: [{ full_name: 'victim/app', id: 1 }],
    });

    // The installation's repos resolve to an account id (4242) that happens to
    // equal A's bound github account id, so the primary check would pass.
    mockInstallationRepos({ login: 'victim', id: 4242, type: 'User' });

    // A holds a valid state bound to A's own github account id (4242).
    const state = await mintInstallState(userA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=999&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(403);
    const persisted = await getGitHubInstallation(env.db, '999');
    expect(persisted?.user_id).toBe(userB.id);
    // Fallback path (no user-OAuth code → authResult.authorized false): the
    // different-user hit is an account-id collision, NOT proof of co-membership,
    // so NO cached membership may be granted.
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '999'));
    expect(members).toHaveLength(0);
  });

  // The primary account-ownership check rejects when the
  // installation's GitHub account does not match the caller's bound account id,
  // even for an installation that is not yet linked to anyone.
  it('rejects a callback whose installation account does not match the caller', async () => {
    const userA = await createTestUser(env.db, 'attacker', 'github', 'acc_a');
    // Installation belongs to some other GitHub account (id 9999), not A's.
    mockInstallationRepos({ login: 'stranger', id: 9999, type: 'User' });

    const state = await mintInstallState(userA.id, 'acc_a');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=888&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(403);
    expect(await getGitHubInstallation(env.db, '888')).toBeNull();
  });

  // Positive: a user installing on their own personal account (where the
  // installation's GitHub account id equals the user's bound account id)
  // succeeds and the installation is linked to them.
  it('links the installation when the account matches the caller', async () => {
    const user = await createTestUser(env.db, 'self', 'github', '7777');
    mockInstallationRepos({ login: 'self', id: 7777, type: 'User' });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=4242&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    // Redirects to the dashboard connections page on success.
    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '4242');
    expect(persisted?.user_id).toBe(user.id);
    expect(persisted?.account_id).toBe('7777');
  });

  // A reconnect / `setup_action=update` callback hits the EXISTING row
  // (conflict path). The callback just refetched the LIVE membership, so it
  // passes `refreshMembership: true` — the fresh repo list / selection MUST be
  // persisted, or newly-added repos / a widen-to-`all` stay rejected until the
  // next webhook.
  it('rolls fresh membership forward on a setup_action=update callback', async () => {
    const user = await createTestUser(env.db, 'reconnect', 'github', '7777');

    // Pre-seed a STALE existing install: only acme/app, selection 'selected'.
    await upsertGitHubInstallation(env.db, {
      installationId: '4243',
      userId: user.id,
      accountLogin: 'reconnect',
      accountId: '7777',
      accountType: 'User',
      repositories: [{ full_name: 'reconnect/app', id: 1 }],
      repositorySelection: 'selected',
    });

    // The callback refetches a WIDENED LIVE membership (a second repo added).
    const owner = { login: 'reconnect', id: 7777, type: 'User' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/installation/repositories')) {
          return Response.json({
            repository_selection: 'selected',
            repositories: [
              { full_name: 'reconnect/app', id: 1, owner },
              { full_name: 'reconnect/api', id: 2, owner },
            ],
          });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=4243&setup_action=update&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '4243');
    // Fresh membership rolled forward — the newly-added repo is now persisted.
    expect(persisted?.repositories).toEqual([
      { full_name: 'reconnect/app', id: 1 },
      { full_name: 'reconnect/api', id: 2 },
    ]);
    expect(persisted?.repository_selection).toBe('selected');
  });

  // An `all`-repository install must NOT enumerate or persist the
  // full repo list. Once page 1 reports `repository_selection: 'all'`, the
  // callback stops paginating — the cached array is never read for `all`
  // installs (every coverage check short-circuits on selection='all'; the
  // connect route resolves ids live) — and stores an empty `repositories`. This
  // guards against burning GitHub round trips + JSONB bloat for a large org.
  it('stops paginating and stores no repos for an all-repository install', async () => {
    const user = await createTestUser(env.db, 'allinstaller', 'github', '8888');
    const pagesFetched: Array<string> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/installation/repositories')) {
          pagesFetched.push(new URL(url).searchParams.get('page') ?? '1');
          // A FULL page (100 repos) would normally trigger a page-2 fetch; the
          // `all` early-break must stop here regardless of the page being full.
          const repositories = Array.from({ length: 100 }, (_, i) => ({
            full_name: `acme/repo-${i}`,
            id: i + 1,
            owner: { login: 'self8888', id: 8888, type: 'User' },
          }));
          return Response.json({ repository_selection: 'all', repositories });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const state = await mintInstallState(user.id, '8888');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=7000&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(302);
    // Only page 1 was fetched — the `all` branch broke before requesting page 2.
    expect(pagesFetched).toEqual(['1']);
    const persisted = await getGitHubInstallation(env.db, '7000');
    expect(persisted?.repository_selection).toBe('all');
    // The full repo list is NOT persisted for an `all` install.
    expect(persisted?.repositories).toEqual([]);
  });

  // (a): an ORGANIZATION install authorized via "user authorization on
  // install". The installation's derived account is the ORG (id 9001), which
  // differs from the caller's personal GitHub id (7777) — so the account-id
  // fallback would 403. But GitHub appends a `code`; exchanging it yields a user
  // token whose GET /user/installations includes installation_id 5000. That
  // proves only installation visibility, so the callback records membership
  // without making the caller an owner.
  it('links an org install authorized via user-auth-on-install code', async () => {
    const user = await createTestUser(env.db, 'orgadmin', 'github', '7777');
    const { calls } = mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9001, type: 'Organization' },
      userInstallationIds: [5000],
      // The code-holder IS the initiator: GET /user returns their personal id,
      // which matches the signed state's account id (7777).
      callerAccountId: 7777,
    });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=valid-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    expect(calls.tokenExchange).toBe(true);
    expect(calls.userInstallations).toBe(true);
    expect(calls.user).toBe(true);
    const persisted = await getGitHubInstallation(env.db, '5000');
    expect(persisted?.user_id).toBeNull();
    // Linked under the ORG account, not the caller's personal id.
    expect(persisted?.account_id).toBe('9001');
    expect(persisted?.account_type).toBe('Organization');
    expect(
      (await getTestGitHubInstallationMembers(env.db, '5000')).some(
        (row) => row.user_id === user.id,
      ),
    ).toBe(true);
  });

  // (b): a code is present but GET /user/installations does NOT include the
  // installation_id (the user cannot manage it). The user-token path fails and
  // the org account id (9001) does not match the caller's personal id (7777),
  // so the callback 403s and nothing is linked.
  it('rejects an install whose code does not list the installation_id', async () => {
    const user = await createTestUser(env.db, 'outsider', 'github', '7777');
    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9001, type: 'Organization' },
      // The user can manage some OTHER installation, but not 5000.
      userInstallationIds: [1234],
    });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=valid-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    expect(await getGitHubInstallation(env.db, '5000')).toBeNull();
  });

  // (c): the user-token path cannot re-own a victim's install. An attacker
  // holding a victim's installation_id presents a `code`, but exchanging it
  // yields a user token whose installations do NOT include the victim's
  // installation_id. The user-token path fails, the org account id does not
  // match the attacker's bound id, so the callback 403s and — crucially — the
  // victim's existing ownership is left intact.
  it('does not re-own a victim installation when the code does not authorize it', async () => {
    const userB = await createTestUser(env.db, 'victim', 'github', '5555');
    const userA = await createTestUser(env.db, 'attacker', 'github', '4242');

    // B already owns installation 999.
    await upsertGitHubInstallation(env.db, {
      installationId: '999',
      userId: userB.id,
      accountLogin: 'victim',
      accountId: '5555',
      accountType: 'User',
      repositories: [{ full_name: 'victim/app', id: 1 }],
    });

    // A's code is valid, but A's accessible installations do not include 999.
    mockUserAuthInstall({
      owner: { login: 'victim', id: 5555, type: 'User' },
      userInstallationIds: [777],
    });

    const state = await mintInstallState(userA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=999&code=attacker-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    const persisted = await getGitHubInstallation(env.db, '999');
    expect(persisted?.user_id).toBe(userB.id);
    // A `code` is present but the installation is NOT in the caller's accessible
    // list → authResult.authorized false → no membership granted either.
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '999'));
    expect(members).toHaveLength(0);
  });

  // SECURITY: a Void user (A) who is a real org co-member reaches an
  // existing organization installation. On the PROVEN user-token path
  // (GET /user/installations lists installation 5000 → authorized:true, and the
  // code-holder id matches the signed state) the backstop GRANTS a cached
  // membership row for A WITHOUT making A the owner, and returns the redirect.
  it('grants a cached membership (no ownership) when a co-member joins an org install via the user-token path', async () => {
    const userA = await createTestUser(env.db, 'orgmember', 'github', '4242');

    // The ORG installation 5000 (account id 9001) exists and has no owner.
    await upsertGitHubInstallation(env.db, {
      installationId: '5000',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9001',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
    });

    // A completes user-auth-on-install: the token can manage 5000 (authorized)
    // and A's own GET /user id (4242) matches A's signed state.
    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9001, type: 'Organization' },
      userInstallationIds: [5000],
      callerAccountId: 4242,
    });

    const state = await mintInstallState(userA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=member-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    // Owner-path success: a redirect to the dashboard connections page.
    expect(res.status).toBe(302);

    // A cached membership row exists for (5000, A) carrying A's caller id.
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '5000'));
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(userA.id);
    expect(members[0].github_account_id).toBe('4242');

    // The organization installation stays ownerless — A is NOT made the owner.
    const persisted = await getGitHubInstallation(env.db, '5000');
    expect(persisted?.user_id).toBeNull();
  });

  // The install-callback membership backstop is Organization-only. A
  // DIFFERENT Void user (A) reaching an existing PERSONAL (account_type='User')
  // install owned by someone else (B), even on the PROVEN user-token path
  // (authResult.authorized), is a non-shareable collision — a personal install has
  // no member_removed revocation path. It must fall through to the conflict 403 and
  // mint NO membership. Contrast with the Organization backstop above, which grants.
  it('403s and grants NO membership when a different user hits a personal (User) install on the user-token path', async () => {
    const userB = await createTestUser(env.db, 'personalowner', 'github', '5555');
    const userA = await createTestUser(env.db, 'collider', 'github', '4242');

    // B already owns the PERSONAL installation 5001 (account id 9002, type User).
    await upsertGitHubInstallation(env.db, {
      installationId: '5001',
      userId: userB.id,
      accountLogin: 'b-personal',
      accountId: '9002',
      accountType: 'User',
      repositories: [{ full_name: 'b-personal/app', id: 1 }],
    });

    // A completes user-auth-on-install: the token lists 5001 (authorized) and A's
    // own GET /user id (4242) matches A's signed state — the proven path.
    mockUserAuthInstall({
      owner: { login: 'b-personal', id: 9002, type: 'User' },
      userInstallationIds: [5001],
      callerAccountId: 4242,
    });

    const state = await mintInstallState(userA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5001&code=collider-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    // Conflict 403 — not shareable.
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('installation already linked to another user');

    // NO membership row minted for A (or anyone) on this personal install.
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '5001'));
    expect(members).toHaveLength(0);

    // B stays the sole owner — never re-owned.
    const persisted = await getGitHubInstallation(env.db, '5001');
    expect(persisted?.user_id).toBe(userB.id);
  });

  // SECURITY: repeated co-member joins are idempotent — the membership upsert's
  // onConflict refreshes the existing row in place (exactly ONE row) and pushes
  // expires_at forward, rather than inserting duplicates.
  it('is idempotent across repeat token-path co-member joins: one refreshed membership row', async () => {
    const userA = await createTestUser(env.db, 'orgmember', 'github', '4242');

    await upsertGitHubInstallation(env.db, {
      installationId: '5000',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9001',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
    });

    // Pre-seed a STALE membership (near-immediate expiry, an old account id) so
    // the join demonstrably REFRESHES expires_at + github_account_id in place
    // (24h ttl >> the 1s seeded ttl → strictly greater, no clock-granularity
    // flake).
    await upsertGitHubInstallationMember(env.db, {
      installationId: '5000',
      userId: userA.id,
      githubAccountId: 'stale',
      ttlSeconds: 1,
    });
    const [seeded] = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '5000'));

    const join = async () => {
      mockUserAuthInstall({
        owner: { login: 'acme-org', id: 9001, type: 'Organization' },
        userInstallationIds: [5000],
        callerAccountId: 4242,
      });
      const state = await mintInstallState(userA.id, '4242');
      return app.fetch(
        new Request(
          `http://localhost/github/callback?installation_id=5000&code=member-install-code&state=${encodeURIComponent(state)}`,
        ),
        { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
      );
    };

    // Two token-path joins in a row.
    expect((await join()).status).toBe(302);
    expect((await join()).status).toBe(302);

    // Exactly ONE row: the onConflict updated in place both times.
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '5000'));
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(userA.id);
    // Refreshed: account id rolled forward and expiry pushed well into the
    // future relative to the stale seed.
    expect(members[0].github_account_id).toBe('4242');
    expect(new Date(members[0].expires_at).getTime()).toBeGreaterThan(
      new Date(seeded.expires_at).getTime(),
    );

    // Still ownerless.
    expect((await getGitHubInstallation(env.db, '5000'))?.user_id).toBeNull();
  });

  // (d): personal install with NO code still succeeds via the account-id
  // fallback (the App is not configured for user-auth-on-install).
  it('links a personal install via the account-id fallback when no code is present', async () => {
    const user = await createTestUser(env.db, 'solo', 'github', '8888');
    mockInstallationRepos({ login: 'solo', id: 8888, type: 'User' });

    const state = await mintInstallState(user.id, '8888');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=6000&state=${encodeURIComponent(state)}`,
      ),
      // Note: user-OAuth env present but NO code -> fallback path is taken and
      // the token exchange is never attempted (mockInstallationRepos throws on
      // any non-repos fetch, proving the exchange is skipped).
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '6000');
    expect(persisted?.user_id).toBe(user.id);
    expect(persisted?.account_id).toBe('8888');
  });

  // Confused-deputy: an attacker mints an install URL bound to THEIR own GitHub
  // account id (111) and sends it to a victim org admin. The victim completes
  // the install, so the OAuth `code` exchanges to a token that CAN access the
  // org installation (user-token path is authorized). But the code-holder's own
  // GET /user id (222, the victim) does NOT match the signed state's account id
  // (111, the attacker) — so the install must be rejected and nothing linked.
  it('rejects an install whose code-holder is not the state initiator', async () => {
    const attacker = await createTestUser(env.db, 'attacker', 'github', '111');

    const { calls } = mockUserAuthInstall({
      owner: { login: 'acme-org', id: 999, type: 'Organization' },
      // The (victim's) token CAN access the org installation 5000.
      userInstallationIds: [5000],
      // ...but the code-holder is the VICTIM (222), not the attacker (111).
      callerAccountId: 222,
    });

    // State is bound to the ATTACKER's own GitHub account id.
    const state = await mintInstallState(attacker.id, '111');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=victim-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('does not belong to the caller');
    expect(calls.user).toBe(true);
    // Nothing was linked — the org installation stays unclaimed.
    expect(await getGitHubInstallation(env.db, '5000')).toBeNull();
  });

  // Legitimate org install via the token path with the binding enforced. The
  // initiator's state account id (111) matches their own GET /user id (111),
  // and the org installation 5000 is in their accessible list — even though the
  // installation's derived account is the ORG (999, != 111), proving org
  // installs still work once the code-holder is confirmed to be the initiator,
  // while remaining ownerless and requiring per-repo proof.
  it('links an org install when the code-holder matches the state initiator', async () => {
    const initiator = await createTestUser(env.db, 'orgadmin', 'github', '111');

    const { calls } = mockUserAuthInstall({
      owner: { login: 'acme-org', id: 999, type: 'Organization' },
      userInstallationIds: [5000],
      // The code-holder IS the initiator (111), matching the signed state.
      callerAccountId: 111,
    });

    const state = await mintInstallState(initiator.id, '111');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=5000&code=initiator-install-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    expect(calls.user).toBe(true);
    expect(calls.userInstallations).toBe(true);
    const persisted = await getGitHubInstallation(env.db, '5000');
    expect(persisted?.user_id).toBeNull();
    // Linked under the ORG account (999), not the initiator's personal id.
    expect(persisted?.account_id).toBe('999');
    expect(persisted?.account_type).toBe('Organization');
    expect(
      (await getTestGitHubInstallationMembers(env.db, '5000')).some(
        (row) => row.user_id === initiator.id,
      ),
    ).toBe(true);
  });

  // An install with NO repositories selected yet has no repo owner to derive the
  // account from. The callback must resolve the account AUTHORITATIVELY via the
  // App JWT (`GET /app/installations/:id`) and use that REAL id for the ownership
  // check + persistence — never fabricate `account_id = installationId`.
  it('resolves the real account via the App-JWT lookup for an empty-repos install', async () => {
    const user = await createTestUser(env.db, 'empty-install', 'github', '7777');
    // No repos → owner undefined; the App-JWT lookup returns the real account.
    mockEmptyInstallAccount({ account: { login: 'empty-owner', id: 7777, type: 'User' } });

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=6100&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    // The REAL account id (7777) matches the caller's bound id, so the ownership
    // check passes and the install links under the real account — NOT a
    // fabricated `account_id = installationId` (6100).
    expect(res.status).toBe(302);
    const persisted = await getGitHubInstallation(env.db, '6100');
    expect(persisted?.user_id).toBe(user.id);
    expect(persisted?.account_id).toBe('7777');
    expect(persisted?.account_login).toBe('empty-owner');
  });

  // Fail-closed: when the App-JWT account lookup fails for an empty-repos
  // install, the callback must 502 (not persist/check a fabricated account id).
  it('fails closed (502) when the App-JWT account lookup fails for an empty-repos install', async () => {
    const user = await createTestUser(env.db, 'empty-fail', 'github', '7777');
    mockEmptyInstallAccount({ account: null }); // lookup 500s → returns null

    const state = await mintInstallState(user.id, '7777');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=6200&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV },
    );

    expect(res.status).toBe(502);
    expect(await res.text()).toContain('unable to resolve installation account');
    // Nothing was persisted (no fabricated row).
    expect(await getGitHubInstallation(env.db, '6200')).toBeNull();
  });

  // The install callback's two org-shared grant
  // points (owner re-adopt + membership backstop) gate on the revocation
  // tombstone under the install-row lock. The callback stamps its own DB-clock
  // proof `iat` INTERNALLY, so — unlike the connect-gate tests that set the
  // artifact `iat` — these tests control the gate deterministically from the
  // TOMBSTONE side via an explicit revoked_at offset: a +offset (future) is
  // always >= the later-stamped proof iat (the concurrent race → reject), a
  // -offset (past) is always < it (a durable/legit re-add → allow). The true
  // proof-then-member_removed-then-grant interleaving is not deterministically
  // reproducible under PGlite's serialized txns; the pre-recorded tombstone
  // exercises the gate deterministically. PGlite runs in-process, so `now()` ==
  // `Date.now()` and the ±1h margin dwarfs any granularity.
  async function seedRevocationAt(
    installationId: string,
    githubAccountId: string,
    offsetMs: number,
  ): Promise<void> {
    await env.db.insert(githubInstallationRevocations).values({
      id: generateId('ghr'),
      installation_id: installationId,
      github_account_id: githubAccountId,
      revoked_at: new Date(Date.now() + offsetMs).toISOString(),
    });
  }

  // Org re-authorize, CONCURRENT: member_removed tombstoned (install,
  // installerGithubId) AFTER the callback's proof. The re-authorizing installer
  // must be rejected, the install stays ownerless, and no membership row is
  // minted.
  it('403s and does not re-adopt owner when the tombstone post-dates the proof (concurrent member_removed)', async () => {
    const owner = await createTestUser(env.db, 'org-owner', 'github', '7001');
    // Organization installs have no owner.
    await upsertGitHubInstallation(env.db, {
      installationId: '9100',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9001',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
      repositorySelection: 'selected',
    });
    // Tombstone keyed by the removed owner's GitHub id (7001), revoked_at AFTER
    // the proof (concurrent race).
    await seedRevocationAt('9100', '7001', 3_600_000);

    // The removed owner re-authorizes: token path lists the org install, caller
    // id (7001) matches the signed state; the org account (9001) forces the code
    // path (the account-id fallback would 403).
    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9001, type: 'Organization' },
      userInstallationIds: [9100],
      callerAccountId: 7001,
    });
    const state = await mintInstallState(owner.id, '7001');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9100&code=owner-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('installation access revoked');
    // NOT re-adopted — the owner pointer stays null.
    expect((await getGitHubInstallation(env.db, '9100'))?.user_id).toBeNull();
    // No membership backstop row either (this is the owner path, not the member
    // path — belt-and-suspenders).
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9100'));
    expect(members).toHaveLength(0);
  });

  // Org installs are MEMBER-ONLY: even the original installer re-authorizing after
  // a removal and re-add gets a MEMBERSHIP row and the owner pointer stays NULL (a
  // re-added installer reconnects via the member path with per-repo proof). The
  // tombstone pre-dates the proof (legit re-add), so the membership grant itself
  // is NOT over-blocked.
  it('org install is member-only: a re-added original installer gets membership, not ownership', async () => {
    const owner = await createTestUser(env.db, 'org-owner', 'github', '7002');
    await upsertGitHubInstallation(env.db, {
      installationId: '9101',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9002',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
      repositorySelection: 'selected',
    });
    await seedRevocationAt('9101', '7002', -3_600_000);

    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9002, type: 'Organization' },
      userInstallationIds: [9101],
      callerAccountId: 7002,
    });
    const state = await mintInstallState(owner.id, '7002');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9101&code=owner-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    // Org install is member-only: the owner pointer stays NULL...
    expect((await getGitHubInstallation(env.db, '9101'))?.user_id).toBeNull();
    // ...and the re-added owner is recorded as a MEMBER (per-repo-proof member path),
    // NOT re-adopted as owner.
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9101'));
    expect(members).toHaveLength(1);
    expect(members[0]?.user_id).toBe(owner.id);
    expect(members[0]?.github_account_id).toBe('7002');
  });

  // Confused-deputy guard: an org install (null owner + a revocation tombstone for
  // a removed member) reached by a DIFFERENT member B (own linked GitHub id, NO
  // tombstone for B) must NOT be owned by B — ownership would let B's OWNER
  // connect resolve org repos via the installation token and bypass the per-repo
  // connect_grant proof. B gets a MEMBERSHIP row (per-repo proof required to
  // connect), the owner pointer stays NULL, and B is NOT the owner.
  it('org install: a different member B gets membership, not ownership (confused-deputy closed)', async () => {
    const memberB = await createTestUser(env.db, 'org-member-b', 'github', '7011');
    // Null owner + tombstone for a removed member's GitHub id (7010). Member B
    // has NO tombstone.
    await upsertGitHubInstallation(env.db, {
      installationId: '9110',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9010',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
      repositorySelection: 'selected',
    });
    await seedRevocationAt('9110', '7010', -3_600_000);

    // B proves org co-membership on the user-token path (lists this install; caller
    // id 7011 matches the signed state).
    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9010, type: 'Organization' },
      userInstallationIds: [9110],
      callerAccountId: 7011,
    });
    const state = await mintInstallState(memberB.id, '7011');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9110&code=member-b-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    // Owner pointer stays NULL — B did NOT re-own the cleared install.
    const install = await getGitHubInstallation(env.db, '9110');
    expect(install?.user_id).toBeNull();
    expect(install?.user_id).not.toBe(memberB.id);
    // B is recorded as a MEMBER (must present a connect_grant to connect any repo).
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9110'));
    expect(members).toHaveLength(1);
    expect(members[0]?.user_id).toBe(memberB.id);
  });

  // A webhook-precreated organization row remains ownerless even when fresh.
  // Installation visibility cannot prove organization-wide repository access.
  it('fresh null-owner org install records membership without adopting ownership', async () => {
    const installer = await createTestUser(env.db, 'org-first-installer', 'github', '7020');
    // Precreated by the installation.created webhook: null owner, NO tombstone.
    await upsertGitHubInstallation(env.db, {
      installationId: '9120',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9020',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
      repositorySelection: 'selected',
    });

    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9020, type: 'Organization' },
      userInstallationIds: [9120],
      callerAccountId: 7020,
    });
    const state = await mintInstallState(installer.id, '7020');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9120&code=installer-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    expect((await getGitHubInstallation(env.db, '9120'))?.user_id).toBeNull();
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9120'));
    expect(members).toHaveLength(1);
    expect(members[0]?.user_id).toBe(installer.id);
  });

  // Membership backstop, CONCURRENT: a co-member (A) reaches an org install;
  // member_removed tombstoned (install, A's GitHub id) AFTER A's proof. A must be
  // rejected and NO membership row minted.
  it('403s and grants no membership when the tombstone post-dates the proof (backstop concurrent member_removed)', async () => {
    const memberA = await createTestUser(env.db, 'org-member', 'github', '4242');
    await upsertGitHubInstallation(env.db, {
      installationId: '9102',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9003',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
    });
    await seedRevocationAt('9102', '4242', 3_600_000);

    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9003, type: 'Organization' },
      userInstallationIds: [9102],
      callerAccountId: 4242,
    });
    const state = await mintInstallState(memberA.id, '4242');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9102&code=member-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('installation access revoked');
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9102'));
    expect(members).toHaveLength(0);
    // The installation stays ownerless.
    expect((await getGitHubInstallation(env.db, '9102'))?.user_id).toBeNull();
  });

  // Membership backstop, DURABLE/legit re-add (accepted residual pass-through):
  // a tombstone that PRE-dates the proof must NOT over-block the co-member grant.
  it('grants membership when the tombstone pre-dates the proof (backstop legit re-add)', async () => {
    const memberA = await createTestUser(env.db, 'org-member', 'github', '4243');
    await upsertGitHubInstallation(env.db, {
      installationId: '9103',
      userId: null,
      accountLogin: 'acme-org',
      accountId: '9004',
      accountType: 'Organization',
      repositories: [{ full_name: 'acme-org/app', id: 1 }],
    });
    await seedRevocationAt('9103', '4243', -3_600_000);

    mockUserAuthInstall({
      owner: { login: 'acme-org', id: 9004, type: 'Organization' },
      userInstallationIds: [9103],
      callerAccountId: 4243,
    });
    const state = await mintInstallState(memberA.id, '4243');

    const res = await app.fetch(
      new Request(
        `http://localhost/github/callback?installation_id=9103&code=member-code&state=${encodeURIComponent(state)}`,
      ),
      { ...env, ...GITHUB_APP_ENV, ...GITHUB_APP_USER_OAUTH_ENV },
    );

    expect(res.status).toBe(302);
    const members = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.installation_id, '9103'));
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(memberA.id);
    expect(members[0].github_account_id).toBe('4243');
    // The installation stays ownerless — the backstop never adopts it.
    expect((await getGitHubInstallation(env.db, '9103'))?.user_id).toBeNull();
  });
});
