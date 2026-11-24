import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  importLegacyAuthentication,
  readLoginConnection,
  readLoginRevision,
  stageLoginConfiguration,
} from '../../src/auth/configuration.ts';
import {
  disableLoginConnection,
  enableLoginConnection,
  linkTestedIdentity,
} from '../../src/auth/management.ts';
import type { AuthenticationActor } from '../../src/auth/management.ts';
import { createHumanSession, validateHumanSession } from '../../src/auth/sessions.ts';
import { createUserForPlatform } from '../../src/db.ts';
import {
  platformAuthSettings,
  platformLoginConnections,
  platformLoginIdentities,
  platformLoginTests,
} from '../../src/schema.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
let admin: Awaited<ReturnType<typeof createTestUser>>;
let actor: AuthenticationActor;
const company = {
  id: 'company',
  kind: 'oidc',
  label: 'Company',
  clientId: 'client',
  issuer: 'https://identity.example.com',
};
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  admin = await createTestUser(env.db, 'admin', 'github', '123', 'custom', 'admin');
  await importLegacyAuthentication(env.db, env);
  const minted = await createHumanSession(env.db, env.JWT_SECRET, {
    userId: admin.id,
    connectionId: 'github',
    revision: 1,
    generation: 1,
    audience: 'api',
  });
  actor = { userId: admin.id, sessionId: minted.session.id, audience: 'api' };
});
async function proof(connectionId: string, subject: string, revision = 1, userId = admin.id) {
  const configuration = (await readLoginRevision(env.db, connectionId, revision))!.configuration;
  const id = crypto.randomUUID();
  await env.db.insert(platformLoginTests).values({
    id,
    user_id: userId,
    connection_id: connectionId,
    revision,
    issuer: configuration.issuer ?? 'https://github.com',
    subject,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  return { connectionId, revision, testId: id };
}

describe('platform authentication management', () => {
  it('rejects legacy signup callbacks that race authentication initialization', async () => {
    await expect(
      env.db.transaction((tx) =>
        createUserForPlatform(tx, 'github', 'late-legacy-user', 'late-user', null),
      ),
    ).rejects.toThrow('signup is restricted');
  });
  it('requires a real test of the exact pending revision and preserves the active method on failure', async () => {
    await stageLoginConfiguration(env.db, env, company, 'secret', null);
    await expect(
      enableLoginConnection(env.db, actor, {
        connectionId: 'company',
        revision: 1,
        testId: 'missing',
      }),
    ).rejects.toMatchObject({ code: 'login_test_required' });
    const tested = await proof('company', 'oidc-user');
    await stageLoginConfiguration(env.db, env, company, 'changed-secret', 1);
    await expect(enableLoginConnection(env.db, actor, tested)).rejects.toMatchObject({
      code: 'revision_conflict',
    });
    expect((await readLoginConnection(env.db, 'company'))?.enabled).toBe(false);
    expect((await readLoginConnection(env.db, 'github'))?.enabled).toBe(true);
  });

  it('separates provider testing, explicit account linking, and enabling', async () => {
    await stageLoginConfiguration(env.db, env, company, 'secret', null);
    const tested = await proof('company', 'oidc-user');
    expect(
      await env.db
        .select()
        .from(platformLoginIdentities)
        .where(eq(platformLoginIdentities.connection_id, 'company')),
    ).toEqual([]);
    await linkTestedIdentity(env.db, actor, tested);
    expect((await readLoginConnection(env.db, 'company'))?.enabled).toBe(false);
    await enableLoginConnection(env.db, actor, tested);
    expect(await readLoginConnection(env.db, 'company')).toMatchObject({
      enabled: true,
      active_revision: 1,
      generation: 2,
    });
    expect(
      await env.db
        .select()
        .from(platformLoginTests)
        .where(eq(platformLoginTests.connection_id, 'company')),
    ).toEqual([]);
  });

  it('refuses disable until the administrator has freshly verified a linked alternative', async () => {
    await expect(
      disableLoginConnection(env.db, actor, { connectionId: 'github', revision: 1 }),
    ).rejects.toMatchObject({ code: 'alternative_login_required' });
    const tested = await proof('google', 'google-admin');
    await expect(
      disableLoginConnection(env.db, actor, { connectionId: 'github', revision: 1 }),
    ).rejects.toMatchObject({ code: 'alternative_login_required' });
    await linkTestedIdentity(env.db, actor, tested);
    await disableLoginConnection(env.db, actor, { connectionId: 'github', revision: 1 });
    expect((await readLoginConnection(env.db, 'github'))?.enabled).toBe(false);
    expect(
      await validateHumanSession(env.db, { sub: actor.userId, sid: actor.sessionId, aud: 'api' }),
    ).toBe(false);
    expect((await readLoginRevision(env.db, 'github', 1))?.secret.ciphertext).toBeTruthy();
  });

  it('never disables the last method and does not count merely imported identities as fresh proof', async () => {
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'google'));
    await expect(
      disableLoginConnection(env.db, actor, { connectionId: 'github', revision: 1 }),
    ).rejects.toMatchObject({ code: 'last_login_method' });
  });

  it('will not change company admission into public signup by disabling its required connection', async () => {
    const tested = await proof('google', 'google-admin');
    await linkTestedIdentity(env.db, actor, tested);
    await env.db
      .update(platformAuthSettings)
      .set({ admission: { mode: 'company', connections: ['github'], access: false } });
    await expect(
      disableLoginConnection(env.db, actor, { connectionId: 'github', revision: 1 }),
    ).rejects.toThrow('enabled connection');
    expect((await readLoginConnection(env.db, 'github'))?.enabled).toBe(true);
  });

  it('rejects another administrator’s test and conflicting linked identities', async () => {
    const other = await createTestUser(
      env.db,
      'other',
      'google',
      'someone-else',
      'custom',
      'admin',
    );
    const tested = await proof('google', 'someone-else', 1, other.id);
    await expect(linkTestedIdentity(env.db, actor, tested)).rejects.toMatchObject({
      code: 'login_test_required',
    });
    const conflict = await proof('google', 'someone-else');
    await expect(linkTestedIdentity(env.db, actor, conflict)).rejects.toMatchObject({
      code: 'identity_conflict',
    });
  });

  it('cannot replace the administrator’s only usable identity with a different account', async () => {
    const previous = (await readLoginRevision(env.db, 'github', 1))!.configuration;
    await stageLoginConfiguration(env.db, env, previous, 'new-secret', 1);
    const wrong = await proof('github', 'other-github-user', 2);
    await expect(enableLoginConnection(env.db, actor, wrong)).rejects.toMatchObject({
      code: 'last_admin_login',
    });
    const correct = await proof('github', '123', 2);
    await enableLoginConnection(env.db, actor, correct);
    expect((await readLoginConnection(env.db, 'github'))?.active_revision).toBe(2);
  });
});
