import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { importLegacyAuthentication } from '../../src/auth/configuration.ts';
import { resolvePlatformLogin } from '../../src/auth/identities.ts';
import { suspendUser } from '../../src/db.ts';
import {
  platformAuthSettings,
  platformCompanyIdentities,
  platformLoginConnections,
  users,
} from '../../src/schema.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  await env.ROUTING.delete('signup:enabled');
});
const attempt = { connectionId: 'github', revision: 1, generation: 1 };
const identity = {
  issuer: 'https://github.com',
  subject: 'new-user',
  login: 'person',
  email: 'personal@example.net',
  emailVerified: true,
  groups: [],
};
const company = { issuer: 'https://company.cloudflareaccess.com', subject: 'employee-123' };
const protection = {
  teamDomain: company.issuer,
  applications: [{ origin: 'https://api.example.com', audience: 'api-aud' }],
};

describe('platform company enrollment', () => {
  it('automatically creates an ordinary account for an Access-approved GitHub user without an invitation', async () => {
    const installed = { ...env, PLATFORM_INSTALLATION_ID: 'installation' };
    await importLegacyAuthentication(env.db, installed);
    await env.db
      .update(platformAuthSettings)
      .set({ protection, admission: { mode: 'company', access: true, connections: [] } });
    const result = await resolvePlatformLogin(env.db, installed, attempt, identity, company);
    expect(result.created).toBe(true);
    expect(result.user).toMatchObject({
      provider: 'github',
      provider_id: 'new-user',
      email: 'personal@example.net',
      role: 'user',
      plan: 'custom',
    });
    expect(await env.db.select().from(platformCompanyIdentities)).toMatchObject([
      { user_id: result.user.id, subject: 'employee-123' },
    ]);
    expect(
      (await resolvePlatformLogin(env.db, installed, attempt, identity, company)).user.id,
    ).toBe(result.user.id);
  });

  it('rejects signup and existing login without the required company proof', async () => {
    await importLegacyAuthentication(env.db, env);
    const result = await resolvePlatformLogin(env.db, env, attempt, identity);
    await env.db
      .update(platformAuthSettings)
      .set({ protection, admission: { mode: 'company', access: true, connections: [] } });
    await expect(resolvePlatformLogin(env.db, env, attempt, identity)).rejects.toMatchObject({
      code: 'company_identity_required',
    });
    await expect(
      resolvePlatformLogin(env.db, env, attempt, { ...identity, subject: 'different' }),
    ).rejects.toMatchObject({ code: 'company_identity_required' });
    expect((await env.db.select().from(users)).map((user) => user.id)).toEqual([result.user.id]);
  });

  it('keeps restricted admission separate from provider configuration', async () => {
    await importLegacyAuthentication(env.db, { ...env, PLATFORM_INSTALLATION_ID: 'installation' });
    await expect(resolvePlatformLogin(env.db, env, attempt, identity)).rejects.toMatchObject({
      code: 'signup_restricted',
    });
    await env.ROUTING.put(
      'signup:allowlist',
      JSON.stringify([{ type: 'github', pattern: 'person' }]),
    );
    expect((await resolvePlatformLogin(env.db, env, attempt, identity)).user.role).toBe('user');
  });

  it('admits an individually invited verified email as an exception to company-only signup', async () => {
    await importLegacyAuthentication(env.db, env);
    await env.db
      .update(platformAuthSettings)
      .set({ admission: { mode: 'company', access: false, connections: ['google'] } });
    await env.ROUTING.put(
      'signup:allowlist',
      JSON.stringify([{ type: 'email', pattern: identity.email }]),
    );
    await expect(
      resolvePlatformLogin(env.db, env, attempt, {
        ...identity,
        subject: 'unverified',
        emailVerified: false,
      }),
    ).rejects.toMatchObject({ code: 'signup_restricted' });
    await expect(
      resolvePlatformLogin(env.db, env, attempt, {
        ...identity,
        subject: 'different-email',
        email: 'different@example.net',
      }),
    ).rejects.toMatchObject({ code: 'signup_restricted' });
    expect((await resolvePlatformLogin(env.db, env, attempt, identity)).user.email).toBe(
      identity.email,
    );
  });

  it('does not merge with an existing administrator based on a verified email', async () => {
    const admin = await createTestUser(env.db, 'admin', 'google', 'google-user', 'custom', 'admin');
    await env.db.update(users).set({ email: identity.email }).where(eq(users.id, admin.id));
    await importLegacyAuthentication(env.db, env);
    await expect(resolvePlatformLogin(env.db, env, attempt, identity)).rejects.toMatchObject({
      code: 'identity_link_required',
    });
    expect(await env.db.select().from(users)).toHaveLength(1);
  });

  it('prevents another company identity from taking over a linked GitHub account', async () => {
    await importLegacyAuthentication(env.db, env);
    await env.db.update(platformAuthSettings).set({ protection });
    const original = await resolvePlatformLogin(env.db, env, attempt, identity, company);
    await expect(
      resolvePlatformLogin(env.db, env, attempt, identity, {
        ...company,
        subject: 'other-employee',
      }),
    ).rejects.toMatchObject({ code: 'identity_conflict' });
    await expect(
      resolvePlatformLogin(
        env.db,
        env,
        attempt,
        { ...identity, subject: 'other-github', email: 'different@example.net' },
        company,
      ),
    ).rejects.toMatchObject({ code: 'identity_conflict' });
    expect((await env.db.select().from(users)).map((user) => user.id)).toEqual([original.user.id]);
  });

  it('rejects an in-flight login after connection disable or revision changes', async () => {
    await importLegacyAuthentication(env.db, env);
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'github'));
    await expect(resolvePlatformLogin(env.db, env, attempt, identity)).rejects.toMatchObject({
      code: 'login_changed',
    });
    expect(await env.db.select().from(users)).toHaveLength(0);
  });

  it('will not remove the last administrator with a usable login method', async () => {
    const reachable = await createTestUser(env.db, 'reachable', 'github', '123', 'custom', 'admin');
    await createTestUser(env.db, 'unreachable', 'google', '456', 'custom', 'admin');
    await importLegacyAuthentication(env.db, env);
    await env.db.update(platformAuthSettings).set({ sessions_required: true });
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'google'));
    await expect(suspendUser(env.db, reachable.id, 'admin_suspended')).rejects.toThrow(
      'last active administrator',
    );
  });
});
