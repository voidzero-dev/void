import { platformProtectionProofMessage } from '@void/platform';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { importLegacyAuthentication, readAuthSettings } from '../../src/auth/configuration.ts';
import { hmacSignState } from '../../src/auth/hmac.ts';
import type { AuthenticationActor } from '../../src/auth/management.ts';
import {
  updatePlatformProtection,
  verifyProtectionAuthority,
} from '../../src/auth/protection-management.ts';
import { createHumanSession, validateHumanSession } from '../../src/auth/sessions.ts';
import {
  platformAuthSettings,
  platformHumanSessions,
  platformLoginConnections,
} from '../../src/schema.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
let actor: AuthenticationActor;
const origins = ['https://api.example.com', 'https://proxy.example.com'];
const protection = {
  teamDomain: 'https://company.cloudflareaccess.com',
  applications: origins.map((origin) => ({ origin, audience: 'company-audience' })),
};
const identity = { issuer: protection.teamDomain, subject: 'employee' };
beforeAll(async () => {
  env = await setupEnv();
  await env.db.execute(sql`CREATE TABLE IF NOT EXISTS __void_platform_installation (
    singleton boolean PRIMARY KEY, installation_id text NOT NULL, ownership_nonce text NOT NULL,
    lifecycle_manifest jsonb
  )`);
});
afterAll(async () => {
  await env.db.execute(sql`DROP TABLE IF EXISTS __void_platform_installation`);
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  await env.db.execute(sql`DELETE FROM __void_platform_installation`);
  await env.db.execute(
    sql`INSERT INTO __void_platform_installation VALUES (true, 'team', 'nonce', '{"generation":1}')`,
  );
  const admin = await createTestUser(env.db, 'admin', 'github', '123', 'custom', 'admin');
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

describe('live platform protection', () => {
  it('requires coverage and a verified company human, then revokes sessions without changing login methods', async () => {
    const input = { revision: 1, protection, origins, verifiedIdentity: identity };
    await expect(
      updatePlatformProtection(env.db, actor, {
        ...input,
        proofExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'protection_verification_required' });
    await expect(
      updatePlatformProtection(env.db, actor, { ...input, verifiedIdentity: undefined }),
    ).rejects.toMatchObject({ code: 'access_human_identity_required' });
    await expect(
      updatePlatformProtection(env.db, actor, {
        ...input,
        protection: { ...protection, applications: protection.applications.slice(0, 1) },
      }),
    ).rejects.toMatchObject({ code: 'invalid_protection' });
    await updatePlatformProtection(env.db, actor, input, true);
    expect(
      await validateHumanSession(env.db, { sub: actor.userId, sid: actor.sessionId, aud: 'api' }),
    ).toBe(true);
    await updatePlatformProtection(env.db, actor, input);
    expect(await readAuthSettings(env.db)).toMatchObject({
      revision: 2,
      protection,
      sessions_required: true,
    });
    expect(
      await validateHumanSession(
        env.db,
        { sub: actor.userId, sid: actor.sessionId, aud: 'api' },
        identity,
      ),
    ).toBe(false);
    expect(
      (await env.db.select().from(platformLoginConnections)).every((method) => method.enabled),
    ).toBe(true);
    expect(
      (await env.db.select().from(platformHumanSessions)).every(
        (session) => session.revoked_at !== null,
      ),
    ).toBe(true);
    await expect(updatePlatformProtection(env.db, actor, input)).rejects.toMatchObject({
      code: 'revision_conflict',
    });
  });

  it('fails closed when company signup relies on Access and requires an explicit admission change to remove it', async () => {
    await updatePlatformProtection(env.db, actor, {
      revision: 1,
      protection,
      origins,
      verifiedIdentity: identity,
    });
    const minted = await createHumanSession(env.db, env.JWT_SECRET, {
      userId: actor.userId,
      connectionId: 'github',
      revision: 1,
      generation: 1,
      audience: 'api',
      companyIdentity: identity,
    });
    actor = { ...actor, sessionId: minted.session.id, companyIdentity: identity };
    await env.db
      .update(platformAuthSettings)
      .set({ admission: { mode: 'company', connections: [], access: true } });
    await expect(
      updatePlatformProtection(env.db, actor, { revision: 2, protection: null, origins }),
    ).rejects.toMatchObject({ code: 'company_admission_requires_protection' });
    expect((await readAuthSettings(env.db))?.protection).toEqual(protection);
    await env.db.update(platformAuthSettings).set({ admission: { mode: 'restricted' } });
    await updatePlatformProtection(env.db, actor, { revision: 2, protection: null, origins });
    expect(await readAuthSettings(env.db)).toMatchObject({
      revision: 3,
      protection: null,
      admission: { mode: 'restricted' },
    });
    expect(
      await validateHumanSession(env.db, { sub: actor.userId, sid: actor.sessionId, aud: 'api' }),
    ).toBe(false);
  });

  it('cannot reuse authority for another actor, revision, origin, configuration, or expired verification', async () => {
    const fields = {
      installationId: 'team',
      origin: origins[0],
      userId: actor.userId,
      sessionId: actor.sessionId,
      revision: 1,
      lifecycleVersion: 'installation-generation-1',
      protection,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const secret = 'installation-recovery-secret';
    const signature = await hmacSignState(platformProtectionProofMessage(fields), secret);
    const input = { ...fields, actor, secret, signature };
    await verifyProtectionAuthority(input);
    for (const change of [
      { revision: 2 },
      { lifecycleVersion: 'installation-generation-2' },
      { origin: origins[1] },
      { protection: null },
      { actor: { ...actor, sessionId: 'another-session' } },
      { actor: { ...actor, userId: 'another-user' } },
      { expiresAt: new Date(Date.now() - 1000).toISOString() },
      { secret: 'wrong-secret' },
    ]) {
      await expect(verifyProtectionAuthority({ ...input, ...change })).rejects.toMatchObject({
        code: 'protection_verification_required',
      });
    }
  });

  it('rejects a protection proof if installation maintenance changed its verified origin generation', async () => {
    const before = await env.db.execute<{ version: string }>(
      sql`SELECT md5(lifecycle_manifest::text) AS version FROM __void_platform_installation`,
    );
    const input = {
      revision: 1,
      installationId: 'team',
      lifecycleVersion: before.rows[0].version,
      protection,
      origins,
      verifiedIdentity: identity,
    };
    await env.db.execute(
      sql`UPDATE __void_platform_installation SET lifecycle_manifest = '{"generation":2}'`,
    );
    await expect(updatePlatformProtection(env.db, actor, input)).rejects.toMatchObject({
      code: 'revision_conflict',
    });
    expect((await readAuthSettings(env.db))?.protection).toBeNull();
  });

  it('rejects changing company subject and refuses an already revoked session', async () => {
    await updatePlatformProtection(env.db, actor, {
      revision: 1,
      protection,
      origins,
      verifiedIdentity: identity,
    });
    const minted = await createHumanSession(env.db, env.JWT_SECRET, {
      userId: actor.userId,
      connectionId: 'github',
      revision: 1,
      generation: 1,
      audience: 'api',
      companyIdentity: identity,
    });
    actor = { ...actor, sessionId: minted.session.id, companyIdentity: identity };
    await expect(
      updatePlatformProtection(env.db, actor, {
        revision: 2,
        protection,
        origins,
        verifiedIdentity: { ...identity, subject: 'another-employee' },
      }),
    ).rejects.toMatchObject({ code: 'company_identity_changed' });
    await env.db
      .update(platformHumanSessions)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(platformHumanSessions.id, actor.sessionId));
    await expect(
      updatePlatformProtection(env.db, actor, { revision: 2, protection: null, origins }),
    ).rejects.toMatchObject({ code: 'reauthentication_required' });
  });
});
