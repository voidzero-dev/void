import { and, eq } from 'drizzle-orm';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
} from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
// oxlint-disable-next-line import/no-namespace -- The test replaces or spies on members of the module object.
import * as dbModule from '../../src/db.ts';
import {
  createOAuthAccount,
  getUserByOAuthAccount,
  upsertGitHubInstallation,
} from '../../src/db.ts';
import app from '../../src/index.ts';
import {
  emailDestinations,
  githubInstallations,
  invitations,
  oauthAccounts,
  users,
} from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  clearTables,
  createTestUser,
  createTestProject,
  createMockExecutionContext,
  seedOAuthNonce,
  JWT_SECRET,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
const executionCtx = createMockExecutionContext();

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  // github_installations isn't known to the shared clearTables helper; clear it
  // before it removes the users they reference (mirrors the routes test).
  await env.db.delete(githubInstallations);
  await clearTables(env.db);
  delete (env as TestEnv & { GITHUB_PREVIEW_REPO_PAT?: string }).GITHUB_PREVIEW_REPO_PAT;
  await env.ROUTING.delete('signup:enabled');
  await env.ROUTING.delete('signup:allowlist');
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildSignedState(provider: string): Promise<string> {
  const redirect = 'http://localhost:9999/callback';
  const stateData = JSON.stringify({ redirect, nonce: 'test-nonce', provider });
  const stateEncoded = btoa(stateData);
  const signature = await hmacSignState(stateEncoded, JWT_SECRET);
  return `${stateEncoded}.${signature}`;
}

function mockGitHubApi(ghUser: {
  id: number;
  login: string;
  email: string | null;
  emailVerified: boolean;
  publicEmail?: boolean;
}) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('github.com/login/oauth/access_token')) {
      return Response.json({ access_token: 'test-gh-token' });
    }

    if (url === 'https://api.github.com/user') {
      return Response.json({
        id: ghUser.id,
        login: ghUser.login,
        email: ghUser.publicEmail ? ghUser.email : null,
      });
    }

    if (url === 'https://api.github.com/user/emails') {
      if (ghUser.email) {
        return Response.json([
          { email: ghUser.email, primary: true, verified: ghUser.emailVerified },
        ]);
      }
      return Response.json([]);
    }

    throw new Error(`Unmocked fetch: ${url}`);
  });
}

describe('email verification gating on account linking', () => {
  it.each([true, false])(
    'uses the platform allowlist for restricted signup (allowed: %s)',
    async (allowed) => {
      // A stale legacy secret must neither bypass access control nor trigger repository API calls.
      Object.assign(env, { GITHUB_PREVIEW_REPO_PAT: 'test-legacy-pat' });
      await env.ROUTING.put('signup:enabled', 'true');
      await env.ROUTING.put(
        'signup:allowlist',
        JSON.stringify(allowed ? [{ type: 'github', pattern: 'invited-user' }] : []),
      );
      const fetchMock = mockGitHubApi({
        id: 44_444,
        login: 'invited-user',
        email: 'invited@example.com',
        emailVerified: true,
      });
      const state = await buildSignedState('github');
      await seedOAuthNonce(env.db, 'test-nonce');
      vi.stubGlobal('fetch', fetchMock);
      const res = await app.fetch(
        new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
          headers: { Cookie: 'oauth_nonce=test-nonce' },
        }),
        env,
        executionCtx,
      );
      expect(res.status).toBe(302);
      if (allowed) {
        expect(res.headers.get('Location')).toContain('http://localhost:9999/callback?token=');
        expect(await getUserByOAuthAccount(env.db, 'github', '44444')).not.toBeNull();
      } else {
        expect(res.headers.get('Location')).toBe('/signup-restricted');
        expect(await getUserByOAuthAccount(env.db, 'github', '44444')).toBeNull();
      }
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/repos/'))).toBe(false);
    },
  );

  it('does not link to existing account when GitHub email is unverified', async () => {
    const existing = await createTestUser(env.db, 'existing-user');
    await env.db
      .update(users)
      .set({ email: 'shared@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 99_999,
        login: 'new-gh-user',
        email: 'shared@example.com',
        emailVerified: false,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;

    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).not.toBe(existing.id);
  });

  it('links to existing account when GitHub has public email that is verified', async () => {
    const existing = await createTestUser(env.db, 'public-email-user');
    await env.db
      .update(users)
      .set({ email: 'public@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 77_777,
        login: 'public-email-gh-user',
        email: 'public@example.com',
        emailVerified: true,
        publicEmail: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;

    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);
  });

  it('links to existing account when GitHub email is verified (private email)', async () => {
    const existing = await createTestUser(env.db, 'linkable-user');
    await env.db
      .update(users)
      .set({ email: 'verified@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 88_888,
        login: 'verified-gh-user',
        email: 'verified@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;

    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);
  });

  it('accepts a pending invitation when an existing account logs in with a verified email', async () => {
    const inviter = await createTestUser(env.db, 'inviter');
    const existing = await createTestUser(env.db, 'invited-existing', 'github', '424242');
    await env.db
      .update(users)
      .set({ email: 'invited-existing@example.com' })
      .where(eq(users.id, existing.id));
    await env.db.insert(invitations).values({
      id: 'inv_existing_login',
      email: 'invited-existing@example.com',
      invited_by: inviter.id,
    });

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 424_242,
        login: 'invited-existing',
        email: 'invited-existing@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const [invitation] = await env.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, 'inv_existing_login'));
    expect(invitation.status).toBe('accepted');
    expect(invitation.accepted_by).toBe(existing.id);
    expect(invitation.accepted_at).toBeTruthy();
  });

  it('does not grant source repository access after an unrestricted signup', async () => {
    Object.assign(env, { GITHUB_PREVIEW_REPO_PAT: 'test-legacy-pat' });
    const fetchMock = mockGitHubApi({
      id: 55_555,
      login: 'new-user',
      email: 'new@example.com',
      emailVerified: true,
    });
    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );
    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/repos/'))).toBe(false);
  });

  it('sends a welcome from the configured platform after a successful signup', async () => {
    const send = vi.fn(async () => {});
    const pending: Array<Promise<unknown>> = [];
    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 55_556,
        login: 'new-member',
        email: 'member@example.com',
        emailVerified: true,
      }),
    );
    const response = await app.fetch(
      new Request(`https://api.example.com/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce', 'X-Forwarded-Host': 'attacker.example' },
      }),
      {
        ...env,
        AUTH_REDIRECT_URI: 'https://api.example.com/auth/callback',
        PLATFORM_DISPLAY_NAME: 'Example Platform',
        EMAIL_FROM: 'Example Platform <platform@example.com>',
        EMAIL: { send } as unknown as SendEmail,
      },
      {
        ...executionCtx,
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
      },
    );
    await Promise.all(pending);
    expect(response.status).toBe(302);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Example Platform <platform@example.com>',
        subject: 'Welcome to Example Platform',
        text: expect.stringContaining("void connect 'api.example.com'"),
      }),
    );
  });

  it('does not link a SECOND github identity when the existing account already has one (RFC 0074 one-github invariant)', async () => {
    // Alice signed in via google, then linked github id X.
    const existing = await createTestUser(env.db, 'one-github-alice', 'google', 'google-alice');
    await env.db
      .update(users)
      .set({ email: 'one-github@example.com' })
      .where(eq(users.id, existing.id));
    await createOAuthAccount(env.db, existing.id, 'github', '111111'); // X

    // An UNOWNED installation whose account_id is the REJECTED github id Y.
    // Because Y is rejected as an identity, the backfill must NOT claim it.
    await upsertGitHubInstallation(env.db, {
      installationId: '600',
      userId: null,
      accountLogin: 'another-gh-account',
      accountId: '222222', // Y
      accountType: 'User',
      repositories: [{ full_name: 'another-gh-account/app', id: 1 }],
    });

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    // Now log in with a DIFFERENT github id Y whose verified email matches Alice.
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 222_222, // Y != X
        login: 'another-gh-account',
        email: 'one-github@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    // Signed into the EXISTING account (not a new user)...
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;
    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);

    // ...and NO github row for Y was created (still exactly one github row, X).
    const githubRows = await env.db
      .select({ providerId: oauthAccounts.provider_id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.user_id, existing.id), eq(oauthAccounts.provider, 'github')));
    expect(githubRows.length).toBe(1);
    expect(githubRows[0]!.providerId).toBe('111111');
    expect(await getUserByOAuthAccount(env.db, 'github', '222222')).toBeNull();

    // ...and the unowned installation for the REJECTED id Y was NOT claimed.
    const [install] = await env.db
      .select({ userId: githubInstallations.user_id })
      .from(githubInstallations)
      .where(eq(githubInstallations.installation_id, '600'));
    expect(install?.userId).toBeNull();
  });

  it('consolidates a github login onto an existing account that has NO github yet (cross-provider link unchanged)', async () => {
    // Bob signed in via google, has NO github identity.
    const existing = await createTestUser(env.db, 'no-github-bob', 'google', 'google-bob');
    await env.db
      .update(users)
      .set({ email: 'no-github@example.com' })
      .where(eq(users.id, existing.id));

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 333_333,
        login: 'bob-gh',
        email: 'no-github@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    // Signed into the existing account...
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;
    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload).toBeDefined();
    expect(payload!.sub).toBe(existing.id);

    // ...and the github row WAS created and is owned by the existing account.
    const owner = await getUserByOAuthAccount(env.db, 'github', '333333');
    expect(owner?.id).toBe(existing.id);
  });

  it('revokes owner-inherited email destinations when the verified primary email changes', async () => {
    // `users.email` is NOT a signup-time constant: this callback re-reads the
    // provider's current primary address on every login and writes it straight
    // back. Destination rows minted by the Option C owner branch
    // (`routes/email.ts`) and by `autoAddOwnerDestination`
    // (`routes/projects.ts`) are verified purely on "this address IS the
    // owner's" — so once the owner's address moves, the old mailbox (possibly
    // reassigned to someone else) must lose its per-project send grant.
    const existing = await createTestUser(env.db, 'rotating-user', 'github', '717171');
    await env.db
      .update(users)
      .set({ email: 'old-owner@example.com' })
      .where(eq(users.id, existing.id));
    const project = await createTestProject(env.db, existing.id, 'owner-email-rotate');

    await env.db.insert(emailDestinations).values([
      {
        id: 'edst_owner_inherited',
        project_id: project.id,
        address: 'old-owner@example.com',
        status: 'verified',
        cf_destination_id: 'cf-tag-old-owner',
        verified_at: '2026-04-25T00:00:00Z',
        verification_source: 'cf',
        verified_by_user_id: existing.id,
        verified_by_email_snapshot: 'Old-Owner@Example.com',
      },
      // Per-recipient consent — independent of who the owner is. Must survive.
      {
        id: 'edst_third_party',
        project_id: project.id,
        address: 'teammate@example.com',
        status: 'verified',
        cf_destination_id: 'cf-tag-teammate',
        verified_at: '2026-04-25T00:00:00Z',
        verification_source: 'platform',
      },
    ]);
    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    // Same GitHub identity, DIFFERENT verified primary email.
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 717_171,
        login: 'rotating-user',
        email: 'new-owner@example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    // Login still succeeds, as the same user.
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    const token = new URL(location).searchParams.get('token')!;
    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload!.sub).toBe(existing.id);

    const [updated] = await env.db.select().from(users).where(eq(users.id, existing.id));
    expect(updated!.email).toBe('new-owner@example.com');

    const rows = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.project_id, project.id));
    const byId = new Map(rows.map((r) => [r.id, r]));

    const revoked = byId.get('edst_owner_inherited');
    expect(revoked?.status).toBe('pending');
    // 'platform' is load-bearing: a row left at 'cf' falls back into the
    // destinations GET's CF refresh filter and is re-promoted on the next
    // listing, because CF still reports the address verified.
    expect(revoked?.verification_source).toBe('platform');
    expect(revoked?.verified_at).toBeNull();
    expect(revoked?.verified_by_user_id).toBeNull();
    expect(revoked?.verified_by_email_snapshot).toBeNull();

    expect(byId.get('edst_third_party')?.status).toBe('verified');
  });

  it('leaves owner-inherited destinations alone when the primary email is unchanged', async () => {
    const existing = await createTestUser(env.db, 'stable-user', 'github', '818181');
    await env.db
      .update(users)
      .set({ email: 'stable-owner@example.com' })
      .where(eq(users.id, existing.id));
    const project = await createTestProject(env.db, existing.id, 'owner-email-stable');
    await env.db.insert(emailDestinations).values({
      id: 'edst_owner_stable',
      project_id: project.id,
      address: 'stable-owner@example.com',
      status: 'verified',
      cf_destination_id: 'cf-tag-stable',
      verified_at: '2026-04-25T00:00:00Z',
      verification_source: 'cf',
      verified_by_user_id: existing.id,
      verified_by_email_snapshot: 'stable-owner@example.com',
    });

    const state = await buildSignedState('github');
    await seedOAuthNonce(env.db, 'test-nonce');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 818_181,
        login: 'stable-user',
        // Same address, different case — a case flip is not a reassignment.
        email: 'Stable-Owner@Example.com',
        emailVerified: true,
      }),
    );

    const res = await app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce' },
      }),
      env,
      executionCtx,
    );

    expect(res.status).toBe(302);
    const [row] = await env.db
      .select()
      .from(emailDestinations)
      .where(eq(emailDestinations.id, 'edst_owner_stable'));
    expect(row?.status).toBe('verified');
    expect(row?.verification_source).toBe('cf');
  });

  describe('owner email change survives a transient failure', () => {
    // Shared fixture: owner-inherited consent plus independent recipient consent.
    async function seedRotatingOwner(providerId: string, login: string) {
      const existing = await createTestUser(env.db, login, 'github', providerId);
      await env.db
        .update(users)
        .set({ email: 'old-owner@example.com' })
        .where(eq(users.id, existing.id));
      const project = await createTestProject(env.db, existing.id, `owner-rotate-${providerId}`);
      await env.db.insert(emailDestinations).values([
        {
          id: `edst_inherited_${providerId}`,
          project_id: project.id,
          address: 'old-owner@example.com',
          status: 'verified',
          cf_destination_id: `cf-tag-old-${providerId}`,
          verified_at: '2026-04-25T00:00:00Z',
          verification_source: 'cf',
          verified_by_user_id: existing.id,
          verified_by_email_snapshot: 'old-owner@example.com',
        },
        {
          id: `edst_teammate_${providerId}`,
          project_id: project.id,
          address: 'teammate@example.com',
          status: 'verified',
          cf_destination_id: `cf-tag-teammate-${providerId}`,
          verified_at: '2026-04-25T00:00:00Z',
          verification_source: 'platform',
        },
      ]);
      return { existing, project };
    }

    async function loginWithNewEmail(providerId: string, login: string): Promise<Response> {
      const state = await buildSignedState('github');
      await seedOAuthNonce(env.db, 'test-nonce');
      vi.stubGlobal(
        'fetch',
        mockGitHubApi({
          id: Number(providerId),
          login,
          email: 'new-owner@example.com',
          emailVerified: true,
        }),
      );
      return app.fetch(
        new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
          headers: { Cookie: 'oauth_nonce=test-nonce' },
        }),
        env,
        executionCtx,
      );
    }

    async function readState(userId: string, inheritedId: string) {
      const [user] = await env.db.select().from(users).where(eq(users.id, userId));
      const [row] = await env.db
        .select()
        .from(emailDestinations)
        .where(eq(emailDestinations.id, inheritedId));
      return {
        email: user!.email,
        status: row!.status,
        source: row!.verification_source,
      };
    }

    it('retries the demotion on the next login when the Postgres demotion failed once', async () => {
      // A transient Postgres failure in the demotion must not be permanent.
      // `users.email` and the owner-inherited demotion are committed
      // together: if the demotion cannot run, the email change rolls back
      // too, so the next login still sees `previousEmail !== email` and
      // retries. Committing `users.email` alone would make every later login
      // see `previousEmail === email`, and the stale grant would survive.
      const { existing } = await seedRotatingOwner('919191', 'blip-user');
      const inheritedId = 'edst_inherited_919191';

      const revokeSpy = vi
        .spyOn(dbModule, 'revokeOwnerVerifiedDestinationsForUserChange')
        .mockRejectedValueOnce(new Error('pg blip'));

      const first = await loginWithNewEmail('919191', 'blip-user');
      expect(revokeSpy).toHaveBeenCalledTimes(1);
      // The sign-in fails the way a failed `updateUser` write always has...
      expect(first.status).toBe(500);

      // ...and NOTHING of the change is committed: the email still reads the
      // old address, so the stale grant is not sitting next to a rotated
      // `users.email` that would hide it from every later comparison.
      const afterFirst = await readState(existing.id, inheritedId);
      expect(afterFirst.email).toBe('old-owner@example.com');
      expect(afterFirst.status).toBe('verified');
      expect(afterFirst.source).toBe('cf');

      // Second login, same new email — the retry.
      const second = await loginWithNewEmail('919191', 'blip-user');
      expect(second.status).toBe(302);
      expect(revokeSpy).toHaveBeenCalledTimes(2);

      const afterSecond = await readState(existing.id, inheritedId);
      expect(afterSecond.email).toBe('new-owner@example.com');
      expect(afterSecond.status).toBe('pending');
      expect(afterSecond.source).toBe('platform');
    });

    it('revokes owner-inherited consent across projects while retaining recipient consent', async () => {
      const { existing, project: first } = await seedRotatingOwner('929393', 'multi-project-user');
      const second = await createTestProject(env.db, existing.id, 'owner-rotate-929393-b');
      await env.db.insert(emailDestinations).values({
        id: 'edst_inherited_929393_b',
        project_id: second.id,
        address: 'old-owner@example.com',
        status: 'verified',
        cf_destination_id: 'cf-tag-old-929393-b',
        verified_at: '2026-04-25T00:00:00Z',
        verification_source: 'cf',
        verified_by_user_id: existing.id,
        verified_by_email_snapshot: 'old-owner@example.com',
      });

      const login = await loginWithNewEmail('929393', 'multi-project-user');
      expect(login.status).toBe(302);
      const [user] = await env.db.select().from(users).where(eq(users.id, existing.id));
      expect(user?.email).toBe('new-owner@example.com');
      const destinations = await env.db
        .select()
        .from(emailDestinations)
        .where(eq(emailDestinations.verified_by_user_id, existing.id));
      expect(destinations).toHaveLength(0);
      const firstRows = await env.db
        .select()
        .from(emailDestinations)
        .where(eq(emailDestinations.project_id, first.id));
      expect(firstRows.find((row) => row.address === 'old-owner@example.com')?.status).toBe(
        'pending',
      );
      expect(firstRows.find((row) => row.address === 'teammate@example.com')?.status).toBe(
        'verified',
      );
      const [secondRow] = await env.db
        .select()
        .from(emailDestinations)
        .where(eq(emailDestinations.project_id, second.id));
      expect(secondRow?.status).toBe('pending');
      expect(secondRow?.verification_source).toBe('platform');
    });
  });

  describe('owner email change racing an owner-inherited grant', () => {
    // `autoAddOwnerDestination` (`routes/projects.ts`) captures the owner's
    // address BEFORE its unbounded Cloudflare call and only inserts after it.
    // The demotion above runs `UPDATE users` + the revoke in one transaction,
    // but it can only demote rows that EXIST when it runs. A login that
    // changes the address while the auto-add is parked at Cloudflare commits
    // first and finds nothing; the auto-add must not insert the OLD address as
    // `verified`, attributed to the OLD identity. Every later login compares
    // equal and never revisits that grant.
    //
    // Interleaves at the Cloudflare stub: the projects route awaits the stub,
    // and the stub drives the real `/auth/callback` before answering. Both
    // routes run against the same PGlite session, so the login's transaction
    // has fully committed before the auto-add gets its answer.
    const emailEnv = () => ({
      ...env,
      EMAIL_GATEWAY_ORIGIN: 'https://void-email-gateway-staging.voidzer0.workers.dev',
      EMAIL_SENDER_DOMAIN: 'mail.voidcloud.dev',
    });

    function stubEmailRoutingOver(
      base: typeof fetch,
      respond: (method: string) => Response | Promise<Response>,
    ): Array<{ method: string; url: string }> {
      const calls: Array<{ method: string; url: string }> = [];
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/email/routing/addresses')) {
          const method = init?.method ?? 'GET';
          calls.push({ method, url });
          return respond(method);
        }
        return base(input, init);
      });
      return calls;
    }

    async function completeGitHubCallback(): Promise<Response> {
      const state = await buildSignedState('github');
      await seedOAuthNonce(env.db, 'test-nonce');
      return app.fetch(
        new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
          headers: { Cookie: 'oauth_nonce=test-nonce' },
        }),
        env,
        executionCtx,
      );
    }

    it('does not inherit verification for an address the owner gave up while the add was in flight', async () => {
      const existing = await createTestUser(env.db, 'racing-user', 'github', '939393');
      await env.db
        .update(users)
        .set({ email: 'old-owner@example.com' })
        .where(eq(users.id, existing.id));

      // The provider now reports the NEW address; every login below rotates
      // (or confirms) it.
      const github = mockGitHubApi({
        id: 939_393,
        login: 'racing-user',
        email: 'new-owner@example.com',
        emailVerified: true,
      });
      let loginDuringAdd: Response | undefined;
      const calls = stubEmailRoutingOver(github, async (method) => {
        if (method === 'POST') {
          // Second-or-later project: Cloudflare already holds the address.
          return Response.json(
            {
              success: false,
              errors: [{ code: 10_037, message: 'destination address already exists' }],
              messages: [],
              result: null,
            },
            { status: 400 },
          );
        }
        // The owner's email changes while the add is recovering the tag.
        loginDuringAdd = await completeGitHubCallback();
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          // ...and Cloudflare reports the OLD address verified: the owner
          // clicked its link on a prior project.
          result: [
            {
              tag: 'cf-tag-racing',
              email: 'old-owner@example.com',
              verified: '2026-01-01T00:00:00Z',
            },
          ],
        });
      });

      // No execution context: `scheduleAfterResponse` awaits the add inline,
      // so the 201 below means the add has finished.
      const created = await app.fetch(
        new Request('http://localhost/projects', {
          method: 'POST',
          headers: { Authorization: `Bearer ${existing.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: 'owner-email-racing' }),
        }),
        emailEnv(),
      );
      expect(created.status).toBe(201);
      const project = (await created.json()) as { id: string };
      expect(loginDuringAdd?.status).toBe(302);
      const [user] = await env.db.select().from(users).where(eq(users.id, existing.id));
      expect(user!.email).toBe('new-owner@example.com');

      // The grant the login could not see must not exist: the row would say
      // the OLD identity consented to mail reaching a mailbox the owner no
      // longer holds, and no later login would ever revisit it.
      const rows = await env.db
        .select()
        .from(emailDestinations)
        .where(eq(emailDestinations.project_id, project.id));
      expect(rows.filter((r) => r.status === 'verified')).toEqual([]);
      // Nothing references the tag any more, so the add released it — the
      // same rollback every other post-allocation failure takes.
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
        expect.stringContaining('/email/routing/addresses/cf-tag-racing'),
      ]);

      // A later login sees no change and revokes nothing — which is exactly
      // why the row must never have been written.
      const later = await completeGitHubCallback();
      expect(later.status).toBe(302);
      const after = await env.db
        .select()
        .from(emailDestinations)
        .where(eq(emailDestinations.project_id, project.id));
      expect(after.filter((r) => r.status === 'verified')).toEqual([]);
    });

    it('answers 409 instead of inheriting when the owner address rotates under the manual add', async () => {
      // The Option C branch of `POST /projects/:id/email/destinations` reads
      // the owner AFTER its Cloudflare calls, so its window is only the gap
      // between that read and the insert — but the read is unlocked, and the
      // same login can commit inside it. The helper's locked re-check is
      // what closes it; the route then takes the same rollback + 409 it
      // takes when the row it just inserted vanished, and a retry re-reads
      // the owner and lands on the Option B platform link.
      const existing = await createTestUser(env.db, 'racing-manual', 'github', '949494');
      await env.db
        .update(users)
        .set({ email: 'old-owner@example.com' })
        .where(eq(users.id, existing.id));
      const project = await createTestProject(env.db, existing.id, 'owner-email-racing-manual');

      const github = mockGitHubApi({
        id: 949_494,
        login: 'racing-manual',
        email: 'new-owner@example.com',
        emailVerified: true,
      });
      let deleted = false;
      const calls = stubEmailRoutingOver(github, (method) => {
        if (method === 'DELETE') {
          deleted = true;
          return Response.json({
            success: true,
            errors: [],
            messages: [],
            result: { tag: 'cf-tag-racing-manual' },
          });
        }
        if (method === 'POST') {
          if (deleted) {
            return Response.json({
              success: true,
              errors: [],
              messages: [],
              result: {
                tag: 'cf-tag-racing-manual-recreated',
                email: 'old-owner@example.com',
                verified: null,
              },
            });
          }
          return Response.json(
            {
              success: false,
              errors: [{ code: 10_037, message: 'destination address already exists' }],
              messages: [],
              result: null,
            },
            { status: 400 },
          );
        }
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [
            {
              tag: 'cf-tag-racing-manual',
              email: 'old-owner@example.com',
              verified: '2026-01-01T00:00:00Z',
            },
          ],
        });
      });
      // Rotate the owner after the route captures its access snapshot. PGlite
      // has one session, so update through the route's existing transaction.
      const realTryCreate = dbModule.tryCreateEmailDestination;
      let rotatedDuringAdd = false;
      vi.spyOn(dbModule, 'tryCreateEmailDestination').mockImplementation(async (...args) => {
        if (!rotatedDuringAdd) {
          rotatedDuringAdd = true;
          await dbModule.updateUser(args[0], existing.id, 'racing-manual', 'new-owner@example.com');
        }
        return realTryCreate(...args);
      });

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/email/destinations`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${existing.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: 'old-owner@example.com' }),
        }),
        emailEnv(),
        executionCtx,
      );
      expect(rotatedDuringAdd).toBe(true);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'destination concurrently modified, try again' });

      const [rotatedOwner] = await env.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, existing.id));
      expect(rotatedOwner?.email).toBe('new-owner@example.com');

      const rows = await env.db
        .select()
        .from(emailDestinations)
        .where(eq(emailDestinations.project_id, project.id));
      expect(rows).toEqual([]);
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
        expect.stringContaining('/email/routing/addresses/cf-tag-racing-manual'),
      ]);

      // The rollback deleted the old provider tag. The retry creates a fresh
      // provider destination and waits on its new verification email.
      const retry = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/email/destinations`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${existing.jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: 'old-owner@example.com' }),
        }),
        emailEnv(),
        executionCtx,
      );
      expect(retry.status).toBe(201);
      expect(await retry.json()).toMatchObject({
        status: 'pending',
        verification_source: 'cf',
      });
    });

    it('leaves a pending row pending when the owner address rotates under the listing refresh', async () => {
      // Third Option C site: the GET refresh adopts a recreated tag for the
      // owner's own address off an unlocked owner read. The login's revoke
      // skips a `pending` row, so a promotion that lands after the rotation
      // would be the same never-revisited grant. Fire the login on the
      // route's owner read (the second `getUser`; the first is the auth
      // middleware) and expect the locked helper to write nothing.
      const existing = await createTestUser(env.db, 'racing-listing', 'github', '959595');
      await env.db
        .update(users)
        .set({ email: 'old-owner@example.com' })
        .where(eq(users.id, existing.id));
      const project = await createTestProject(env.db, existing.id, 'owner-email-racing-listing');
      await env.db.insert(emailDestinations).values({
        id: 'edst_racing_listing',
        project_id: project.id,
        address: 'old-owner@example.com',
        status: 'pending',
        cf_destination_id: 'cf-tag-racing-listing-dead',
        verification_source: 'cf',
      });

      const github = mockGitHubApi({
        id: 959_595,
        login: 'racing-listing',
        email: 'new-owner@example.com',
        emailVerified: true,
      });
      stubEmailRoutingOver(github, () =>
        Response.json({
          success: true,
          errors: [],
          messages: [],
          // The address is verified on the account under a tag this row
          // never registered — the owner-adopt branch of the refresh.
          result: [
            {
              tag: 'cf-tag-racing-listing-live',
              email: 'old-owner@example.com',
              verified: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      );
      const realGetUser = dbModule.getUser;
      let loginDuringRefresh: Response | undefined;
      let reads = 0;
      vi.spyOn(dbModule, 'getUser').mockImplementation(async (...args) => {
        const owner = await realGetUser(...args);
        reads += 1;
        if (reads === 2) {
          loginDuringRefresh = await completeGitHubCallback();
        }
        return owner;
      });

      const res = await app.fetch(
        new Request(`http://localhost/projects/${project.id}/email/destinations`, {
          headers: { Authorization: `Bearer ${existing.jwt}` },
        }),
        emailEnv(),
        executionCtx,
      );
      expect(loginDuringRefresh?.status).toBe(302);
      expect(res.status).toBe(200);
      const listed = (await res.json()) as Array<{ id: string; status: string }>;
      expect(listed.find((r) => r.id === 'edst_racing_listing')?.status).toBe('pending');

      const [row] = await env.db
        .select()
        .from(emailDestinations)
        .where(eq(emailDestinations.id, 'edst_racing_listing'));
      expect(row).toMatchObject({
        status: 'pending',
        cf_destination_id: 'cf-tag-racing-listing-dead',
        verified_by_user_id: null,
        verified_by_email_snapshot: null,
      });
    });
  });
});

describe('email match never reaches an administrator account', () => {
  async function createAdminWithEmail(login: string, provider: string, providerId: string) {
    const admin = await createTestUser(env.db, login, provider, providerId, 'custom', 'admin');
    await env.db.update(users).set({ email: 'admin@example.com' }).where(eq(users.id, admin.id));
    return admin;
  }

  async function callback(provider: string, accept?: string): Promise<Response> {
    const state = await buildSignedState(provider);
    await seedOAuthNonce(env.db, 'test-nonce');
    return app.fetch(
      new Request(`http://localhost/auth/callback?code=test-code&state=${state}`, {
        headers: { Cookie: 'oauth_nonce=test-nonce', ...(accept ? { Accept: accept } : {}) },
      }),
      env,
      executionCtx,
    );
  }

  async function githubIdsFor(userId: string): Promise<Array<string>> {
    const rows = await env.db
      .select({ providerId: oauthAccounts.provider_id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.user_id, userId), eq(oauthAccounts.provider, 'github')));
    return rows.map((row) => row.providerId);
  }

  it('refuses a new GitHub login whose verified email matches a Google-first administrator', async () => {
    await createAdminWithEmail('admin-g', 'google', 'google-admin');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 444_001,
        login: 'lookalike',
        email: 'admin@example.com',
        emailVerified: true,
      }),
    );

    const res = await callback('github');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'identity_link_required' });
    expect(await getUserByOAuthAccount(env.db, 'github', '444001')).toBeNull();
    expect(await env.db.select().from(users)).toHaveLength(1);
  });

  it('refuses a second GitHub login whose verified email matches an administrator', async () => {
    const admin = await createAdminWithEmail('admin-gh', 'github', '111');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 222,
        login: 'lookalike',
        email: 'admin@example.com',
        emailVerified: true,
      }),
    );

    const res = await callback('github');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'identity_link_required' });
    expect(await githubIdsFor(admin.id)).toEqual(['111']);
    expect(await getUserByOAuthAccount(env.db, 'github', '222')).toBeNull();
  });

  it('tells an administrator in the browser to use the account they used before', async () => {
    await createAdminWithEmail('admin-gh', 'github', '111');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 222,
        login: 'lookalike',
        email: 'admin@example.com',
        emailVerified: true,
      }),
    );

    const res = await callback('github', 'text/html,application/xhtml+xml');

    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('This login is not linked');
    expect(html).toContain('Sign in again with the GitHub or Google account you used before.');
    expect(html).not.toContain('contact your platform administrator');
  });

  it('refuses a new Google login whose verified email matches a GitHub-first administrator', async () => {
    await createAdminWithEmail('admin-gh', 'github', '111');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url === 'https://oauth2.googleapis.com/token') {
          return Response.json({ access_token: 't' });
        }
        if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
          return Response.json({
            id: 'g-new',
            email: 'admin@example.com',
            name: 'x',
            verified_email: true,
          });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const res = await callback('google');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'identity_link_required' });
    expect(await getUserByOAuthAccount(env.db, 'google', 'g-new')).toBeNull();
  });

  it('still signs an administrator in with an already linked login', async () => {
    const admin = await createAdminWithEmail('admin-ok', 'github', '333');
    vi.stubGlobal(
      'fetch',
      mockGitHubApi({
        id: 333,
        login: 'admin-ok',
        email: 'admin@example.com',
        emailVerified: true,
      }),
    );

    const res = await callback('github');

    expect(res.status).toBe(302);
    const token = new URL(res.headers.get('Location')!).searchParams.get('token')!;
    const { verifyJwt } = await import('../../src/auth/jwt.ts');
    const payload = await verifyJwt(token, JWT_SECRET);
    expect(payload?.sub).toBe(admin.id);
  });
});
