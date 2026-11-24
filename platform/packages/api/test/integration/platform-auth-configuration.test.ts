import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  importLegacyAuthentication,
  readAuthSettings,
  readEnabledLoginConnections,
  readLoginRevision,
  readLoginSecret,
  stageLoginConfiguration,
} from '../../src/auth/configuration.ts';
import {
  decryptPlatformCredential,
  decryptProjectSecret,
  encryptPlatformCredential,
} from '../../src/project-secrets.ts';
import {
  platformAuthSettings,
  platformLoginConnections,
  platformLoginIdentities,
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
const company = {
  id: 'company',
  kind: 'oidc',
  label: 'Company',
  clientId: 'client',
  issuer: 'https://identity.example.com/',
};

describe('platform authentication storage', () => {
  it('imports existing identity links and encrypted credentials once without enabling session enforcement', async () => {
    const user = await createTestUser(env.db, 'existing', 'github', '123');
    const settings = await importLegacyAuthentication(env.db, env);
    expect(settings.sessions_required).toBe(false);
    expect(settings.admission).toEqual({ mode: 'public' });
    const identities = await env.db.select().from(platformLoginIdentities);
    expect(identities).toMatchObject([
      { user_id: user.id, connection_id: 'github', subject: '123', issuer: 'https://github.com' },
    ]);
    const revision = (await readLoginRevision(env.db, 'github', 1))!;
    expect(JSON.stringify(revision.secret)).not.toContain(env.GITHUB_CLIENT_SECRET);
    expect(await readLoginSecret(env, revision)).toBe(env.GITHUB_CLIENT_SECRET);
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: false })
      .where(eq(platformLoginConnections.id, 'github'));
    await env.db.update(platformAuthSettings).set({ admission: { mode: 'restricted' } });
    await importLegacyAuthentication(env.db, {
      ...env,
      GITHUB_CLIENT_SECRET: 'stale-workstation-secret',
    });
    expect((await readEnabledLoginConnections(env.db)).map((row) => row.connection.id)).toEqual([
      'google',
    ]);
    expect((await readAuthSettings(env.db))?.admission).toEqual({ mode: 'restricted' });
    expect(await readLoginSecret(env, (await readLoginRevision(env.db, 'github', 1))!)).toBe(
      env.GITHUB_CLIENT_SECRET,
    );
  });

  it('keeps self-hosted signup restricted unless explicitly opened', async () => {
    const installed = { ...env, PLATFORM_INSTALLATION_ID: 'team' };
    expect((await importLegacyAuthentication(env.db, installed)).admission).toEqual({
      mode: 'restricted',
    });
  });

  it('rolls back an incomplete legacy import', async () => {
    await expect(
      importLegacyAuthentication(env.db, { ...env, GOOGLE_CLIENT_SECRET: '' }),
    ).rejects.toThrow('existing Google credentials');
    expect(await readAuthSettings(env.db)).toBeNull();
    expect(await readEnabledLoginConnections(env.db)).toEqual([]);
  });

  it('stages new and edited secrets without changing active login', async () => {
    await importLegacyAuthentication(env.db, env);
    const staged = await stageLoginConfiguration(env.db, env, company, 'new-secret', null);
    expect(staged).toMatchObject({ enabled: false, active_revision: null, revision: 1 });
    expect((await readEnabledLoginConnections(env.db)).map((entry) => entry.connection.id)).toEqual(
      ['github', 'google'],
    );
    const prior = (await readLoginRevision(env.db, 'github', 1))!;
    const edited = await stageLoginConfiguration(
      env.db,
      env,
      prior.configuration,
      'replacement-secret',
      1,
    );
    expect(edited).toMatchObject({ enabled: true, active_revision: 1, revision: 2, generation: 1 });
    expect(await readLoginSecret(env, (await readLoginRevision(env.db, 'github', 1))!)).toBe(
      env.GITHUB_CLIENT_SECRET,
    );
    expect(await readLoginSecret(env, (await readLoginRevision(env.db, 'github', 2))!)).toBe(
      'replacement-secret',
    );
  });

  it('rejects stale edits and identity namespace replacement', async () => {
    await importLegacyAuthentication(env.db, env);
    await stageLoginConfiguration(env.db, env, company, 'secret', null);
    await expect(
      stageLoginConfiguration(env.db, env, company, 'secret', null),
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(
      stageLoginConfiguration(
        env.db,
        env,
        { ...company, issuer: 'https://other.example.com' },
        'secret',
        1,
      ),
    ).rejects.toThrow('identity namespace');
    await expect(
      stageLoginConfiguration(env.db, env, { ...company, clientId: 'other' }, 'secret', 1),
    ).rejects.toThrow('identity namespace');
    expect(await readLoginRevision(env.db, 'company', 2)).toBeNull();
  });

  it('binds ciphertext to its installation and credential revision across key rotation', async () => {
    const credential = await encryptPlatformCredential(
      env,
      'installation',
      'company:1',
      'secret-value',
    );
    const rotated = {
      ...env,
      PROJECT_SECRET_KEYS_JSON: JSON.stringify({
        ...JSON.parse(env.PROJECT_SECRET_KEYS_JSON),
        next: Buffer.alloc(32, 9).toString('base64'),
      }),
      PROJECT_SECRET_ACTIVE_KEY_VERSION: 'next',
    };
    expect(await decryptPlatformCredential(rotated, 'installation', 'company:1', credential)).toBe(
      'secret-value',
    );
    for (const [installation, id] of [
      ['different', 'company:1'],
      ['installation', 'company:2'],
    ]) {
      await expect(
        decryptPlatformCredential(rotated, installation!, id!, credential),
      ).rejects.toThrow('Failed to decrypt');
    }
    await expect(
      decryptProjectSecret(env, 'installation', {
        name: 'company:1',
        ciphertext: credential.ciphertext,
        iv: credential.iv,
        key_version: credential.keyVersion,
      }),
    ).rejects.toThrow();
    expect(
      (await encryptPlatformCredential(rotated, 'installation', 'company:2', 'rotated')).keyVersion,
    ).toBe('next');
  });
});
