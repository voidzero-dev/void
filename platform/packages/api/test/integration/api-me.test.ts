import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vite-plus/test';
import { signJwt } from '../../src/auth/jwt.ts';
import app from '../../src/index.ts';
import { users } from '../../src/schema.ts';
import { setupEnv, teardownEnv, clearTables, createTestUser, JWT_SECRET } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

type MeResponse = {
  login: string;
  plan: string;
  provider: string;
  limits: { requestsPerMonth: number };
};

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

describe('GET /me', () => {
  it('returns 401 without auth header', async () => {
    const res = await app.fetch(new Request('http://localhost/me'), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'unauthorized',
      message: expect.stringMatching(/sign in to this platform/i),
    });
  });

  it('returns 401 with invalid JWT', async () => {
    const res = await app.fetch(
      new Request('http://localhost/me', {
        headers: { Authorization: 'Bearer not-a-real-jwt' },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'invalid or expired token',
      message: expect.stringMatching(/sign in again.*replace the credential/i),
    });
  });

  it('returns 401 with expired JWT', async () => {
    // Insert user with real timers
    const userId = 'user_expired';
    await env.db.insert(users).values({
      id: userId,
      provider: 'github',
      provider_id: '99999',
      login: 'expired',
      email: null,
    });

    // Sign JWT in the past so it's expired
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01'));
    const jwt = await signJwt({ sub: userId, login: 'expired', aud: 'api' }, JWT_SECRET);
    vi.useRealTimers();

    const res = await app.fetch(
      new Request('http://localhost/me', {
        headers: { Authorization: `Bearer ${jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when user has been deleted', async () => {
    const user = await createTestUser(env.db, 'deleted-user');
    await env.db.delete(users).where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/me', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'user not found',
      message: expect.stringMatching(/sign in with an active account/i),
    });
  });

  it('returns 403 when user is admin-suspended', async () => {
    const user = await createTestUser(env.db, 'suspended-user');
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/me', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'account suspended',
      message: expect.stringMatching(/contact a platform administrator/i),
    });
  });

  it('allows usage-suspended user through', async () => {
    const user = await createTestUser(env.db, 'usage-limited');
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, user.id));

    const res = await app.fetch(
      new Request('http://localhost/me', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json<MeResponse>();
    expect(body.login).toBe('usage-limited');
  });

  it('returns user login with valid JWT', async () => {
    const user = await createTestUser(env.db, 'alice');

    const res = await app.fetch(
      new Request('http://localhost/me', {
        headers: { Authorization: `Bearer ${user.jwt}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json<MeResponse>();
    expect(body.login).toBe('alice');
    expect(body.plan).toBe('free');
    expect(body.provider).toBe('github');
    expect(body.limits).toBeDefined();
    expect(body.limits.requestsPerMonth).toBe(3_000_000);
  });
});
