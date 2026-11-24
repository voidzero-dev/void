import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  GitHubIdentityAlreadyLinkedError,
  GitHubIdentityConflictError,
  linkGitHubIdentity,
} from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import { oauthAccounts } from '../../src/schema.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

async function getGitHubRows(db: Db, providerId: string) {
  return db
    .select()
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.provider, 'github'), eq(oauthAccounts.provider_id, providerId)));
}

async function getGitHubRowsForUser(db: Db, userId: string) {
  return db
    .select()
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.user_id, userId), eq(oauthAccounts.provider, 'github')));
}

describe('linkGitHubIdentity', () => {
  it('links a new identity', async () => {
    // Use a non-github login provider so the user has no pre-existing github
    // oauth row (createTestUser seeds an oauth_accounts row for its provider).
    const user = await createTestUser(env.db, 'alice', 'google', 'google-alice');

    const result = await linkGitHubIdentity(env.db, user.id, '12345');
    expect(result).toBe('linked');

    const rows = await getGitHubRows(env.db, '12345');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('github');
    expect(rows[0]!.provider_id).toBe('12345');
    expect(rows[0]!.user_id).toBe(user.id);
  });

  it('is idempotent on re-link (no duplicate row)', async () => {
    const user = await createTestUser(env.db, 'alice', 'google', 'google-alice');

    const first = await linkGitHubIdentity(env.db, user.id, '12345');
    expect(first).toBe('linked');

    const second = await linkGitHubIdentity(env.db, user.id, '12345');
    expect(second).toBe('already_linked');

    const rows = await getGitHubRows(env.db, '12345');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(user.id);
  });

  it('throws GitHubIdentityConflictError when the identity belongs to another user', async () => {
    const userA = await createTestUser(env.db, 'alice', 'google', 'google-alice');
    const userB = await createTestUser(env.db, 'bob', 'google', 'google-bob');

    const linked = await linkGitHubIdentity(env.db, userA.id, '12345');
    expect(linked).toBe('linked');

    await expect(linkGitHubIdentity(env.db, userB.id, '12345')).rejects.toBeInstanceOf(
      GitHubIdentityConflictError,
    );

    // Ownership is unchanged — the identity still belongs to user A.
    const rows = await getGitHubRows(env.db, '12345');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(userA.id);
  });

  it('throws GitHubIdentityAlreadyLinkedError when the same user links a different identity', async () => {
    // RFC 0074: one GitHub identity per Void account. A user who already linked
    // 'A' must not be able to link a second, different id 'B'.
    const user = await createTestUser(env.db, 'alice', 'google', 'google-alice');

    const linkedA = await linkGitHubIdentity(env.db, user.id, 'A');
    expect(linkedA).toBe('linked');

    await expect(linkGitHubIdentity(env.db, user.id, 'B')).rejects.toBeInstanceOf(
      GitHubIdentityAlreadyLinkedError,
    );

    // No second row was created — the user still has exactly one github row ('A').
    const rows = await getGitHubRowsForUser(env.db, user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider_id).toBe('A');

    // 'B' was never inserted.
    expect(await getGitHubRows(env.db, 'B')).toHaveLength(0);

    // Re-linking the SAME id 'A' is still the idempotent no-op.
    const reLinkA = await linkGitHubIdentity(env.db, user.id, 'A');
    expect(reLinkA).toBe('already_linked');
    expect(await getGitHubRowsForUser(env.db, user.id)).toHaveLength(1);
  });
});
