import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { bootstrapPlatformAdmin, createUserForPlatform } from '../../src/db.ts';
import { oauthAccounts, users } from '../../src/schema.ts';
import { clearTables, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

afterAll(async () => {
  await teardownEnv();
});

describe('self-hosted first owner bootstrap', () => {
  it('atomically grants exactly the first self-hosted user admin access', async () => {
    const create = (id: string) =>
      env.db.transaction((tx) =>
        createUserForPlatform(tx, 'github', id, `user-${id}`, null, 'installation-a1b2c3d4', {
          additionalSignupAllowed: true,
          bootstrapGitHubId: id,
        }),
      );
    const users = await Promise.all([create('one'), create('two')]);
    expect(users.filter((user) => user.role === 'admin')).toHaveLength(1);
    expect(users.filter((user) => user.role === 'user')).toHaveLength(1);
    expect(users.every((user) => user.plan === 'custom')).toBe(true);
  });

  it('allows only the configured GitHub identity to claim an empty installation', async () => {
    await expect(
      env.db.transaction((tx) =>
        createUserForPlatform(tx, 'github', 'attacker', 'attacker', null, 'installation-a1b2c3d4', {
          additionalSignupAllowed: false,
          bootstrapGitHubId: 'owner-id',
        }),
      ),
    ).rejects.toThrow('signup is restricted');
    const owner = await env.db.transaction((tx) =>
      createUserForPlatform(tx, 'github', 'owner-id', 'owner', null, 'installation-a1b2c3d4', {
        additionalSignupAllowed: false,
        bootstrapGitHubId: 'owner-id',
      }),
    );
    expect(owner.role).toBe('admin');
  });

  it('binds bootstrap ownership to the immutable GitHub account id', async () => {
    await expect(
      env.db.transaction((tx) =>
        createUserForPlatform(tx, 'github', 'attacker-id', 'owner', null, 'installation-a1b2c3d4', {
          additionalSignupAllowed: false,
          bootstrapGitHubId: 'owner-id',
        }),
      ),
    ).rejects.toThrow('signup is restricted');
    const renamedOwner = await env.db.transaction((tx) =>
      createUserForPlatform(
        tx,
        'github',
        'owner-id',
        'renamed-owner',
        null,
        'installation-a1b2c3d4',
        { additionalSignupAllowed: false, bootstrapGitHubId: 'owner-id' },
      ),
    );
    expect(renamedOwner.role).toBe('admin');
  });

  it('preserves Void Cloud user defaults when no installation id is set', async () => {
    const user = await env.db.transaction((tx) =>
      createUserForPlatform(tx, 'github', 'hosted', 'hosted-user', null),
    );
    expect(user.role).toBe('user');
    expect(user.plan).toBe('free');
  });

  it('does not bootstrap a Google identity with the same provider id', async () => {
    await expect(
      bootstrapPlatformAdmin(
        env.db,
        'google',
        'owner-id',
        'owner',
        'owner@example.com',
        'installation-a1b2c3d4',
        'owner-id',
      ),
    ).resolves.toBeNull();
    expect(await env.db.select().from(users)).toHaveLength(0);
    expect(await env.db.select().from(oauthAccounts)).toHaveLength(0);
  });

  it('rolls back owner creation if its OAuth identity cannot be stored', async () => {
    await env.db.execute(
      sql`ALTER TABLE ${oauthAccounts} ADD CONSTRAINT bootstrap_test_reject CHECK (provider_id <> 'owner-id')`,
    );
    try {
      await expect(
        bootstrapPlatformAdmin(
          env.db,
          'github',
          'owner-id',
          'owner',
          null,
          'installation-a1b2c3d4',
          'owner-id',
        ),
      ).rejects.toThrow();
      expect(await env.db.select().from(users)).toHaveLength(0);
      expect(await env.db.select().from(oauthAccounts)).toHaveLength(0);
    } finally {
      await env.db.execute(sql`ALTER TABLE ${oauthAccounts} DROP CONSTRAINT bootstrap_test_reject`);
    }
  });
});
