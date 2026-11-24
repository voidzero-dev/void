import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { MEMBERSHIP_TTL_SECONDS } from '../../src/constants.ts';
import {
  deleteGitHubInstallationMembers,
  deleteGitHubInstallationMembersByGithubAccount,
  getGitHubAccountIdForUser,
  getDbNowMs,
  getGitHubInstallationsByAccount,
  getInstallationRevocationAt,
  getInstallationRevocationsForAccount,
  hasActiveInstallationMembership,
  recordInstallationRevocations,
  upsertGitHubInstallation,
  upsertGitHubInstallationMember,
} from '../../src/db.ts';
import type { Db } from '../../src/db.ts';
import { generateId } from '../../src/id.ts';
import { githubInstallationMembers, githubInstallationRevocations } from '../../src/schema.ts';
import {
  getTestGitHubInstallationMembers,
  clearTables,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
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

// Seed an installation row so a membership references a real install (the table
// keys on the numeric installation id as text with no FK, but the tests keep
// the fixtures coherent).
async function seedInstall(db: Db, installationId: string): Promise<void> {
  await upsertGitHubInstallation(db, {
    installationId,
    userId: null,
    accountLogin: `acct-${installationId}`,
    accountId: installationId,
    accountType: 'Organization',
    repositories: [],
    repositorySelection: 'all',
  });
}

describe('github_installation_members', () => {
  it('upsert inserts a fresh membership (ghm_ id, TTL expiry, verified_at, account round-trip)', async () => {
    const user = await createTestUser(env.db);
    await seedInstall(env.db, '100');

    const row = await upsertGitHubInstallationMember(env.db, {
      installationId: '100',
      userId: user.id,
      githubAccountId: 'gh-acct-1',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });

    expect(row.id.startsWith('ghm_')).toBe(true);
    expect(row.installation_id).toBe('100');
    expect(row.user_id).toBe(user.id);
    expect(row.github_account_id).toBe('gh-acct-1');
    expect(row.verified_at).not.toBeNull();

    // Both timestamps use the DB clock. Compare there instead of interpreting
    // a timestamp without timezone as the JavaScript process's local time.
    const [lifetime] = await env.db
      .select({
        seconds: sql<string>`extract(epoch from (${githubInstallationMembers.expires_at} - ${githubInstallationMembers.verified_at}))`,
      })
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.id, row.id));
    expect(Number(lifetime.seconds)).toBe(MEMBERSHIP_TTL_SECONDS);
  });

  it('upsert on the same (installation, user) refreshes in place and keeps count == 1', async () => {
    const user = await createTestUser(env.db);
    await seedInstall(env.db, '100');

    const first = await upsertGitHubInstallationMember(env.db, {
      installationId: '100',
      userId: user.id,
      githubAccountId: 'gh-acct-1',
      ttlSeconds: 1, // short TTL so the refresh visibly moves expires_at forward
    });

    const second = await upsertGitHubInstallationMember(env.db, {
      installationId: '100',
      userId: user.id,
      githubAccountId: 'gh-acct-2',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });

    // Same row (onConflict update, not a new insert).
    expect(second.id).toBe(first.id);
    expect(second.github_account_id).toBe('gh-acct-2');
    expect(new Date(second.verified_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first.verified_at).getTime(),
    );
    expect(new Date(second.expires_at).getTime()).toBeGreaterThan(
      new Date(first.expires_at).getTime(),
    );

    const all = await getTestGitHubInstallationMembers(env.db, '100');
    expect(all).toHaveLength(1);
  });

  it('hasActiveInstallationMembership: true when fresh, false when absent, false when expired', async () => {
    const user = await createTestUser(env.db);
    await seedInstall(env.db, '100');

    // Absent.
    expect(await hasActiveInstallationMembership(env.db, '100', user.id)).toBe(false);

    // Fresh.
    await upsertGitHubInstallationMember(env.db, {
      installationId: '100',
      userId: user.id,
      githubAccountId: 'gh-acct-1',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });
    expect(await hasActiveInstallationMembership(env.db, '100', user.id)).toBe(true);

    // Expired: seed a row directly with a past expiry on a second install.
    await seedInstall(env.db, '200');
    await env.db.insert(githubInstallationMembers).values({
      id: generateId('ghm'),
      installation_id: '200',
      user_id: user.id,
      github_account_id: 'gh-member',
      expires_at: sql`now() - interval '1 second'`,
    });
    expect(await hasActiveInstallationMembership(env.db, '200', user.id)).toBe(false);
  });

  it('getTestGitHubInstallationMembers scopes to one install', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob', 'google', 'google-bob');
    await seedInstall(env.db, '100');
    await seedInstall(env.db, '200');

    await upsertGitHubInstallationMember(env.db, {
      installationId: '100',
      userId: alice.id,
      githubAccountId: 'gh-member',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '100',
      userId: bob.id,
      githubAccountId: 'gh-member',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '200',
      userId: alice.id,
      githubAccountId: 'gh-member',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });

    const install100 = await getTestGitHubInstallationMembers(env.db, '100');
    expect(install100).toHaveLength(2);
    expect(install100.every((r) => r.installation_id === '100')).toBe(true);
    expect(new Set(install100.map((r) => r.user_id))).toEqual(new Set([alice.id, bob.id]));
  });

  it('deleteGitHubInstallationMembers bulk-deletes for (installIds, user) and no-ops on empty ids', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob', 'google', 'google-bob');
    await seedInstall(env.db, '100');
    await seedInstall(env.db, '200');
    await seedInstall(env.db, '300');

    for (const inst of ['100', '200', '300']) {
      await upsertGitHubInstallationMember(env.db, {
        installationId: inst,
        userId: alice.id,
        githubAccountId: 'gh-member',
        ttlSeconds: MEMBERSHIP_TTL_SECONDS,
      });
    }
    // Bob shares install 100 — must survive a delete scoped to alice.
    await upsertGitHubInstallationMember(env.db, {
      installationId: '100',
      userId: bob.id,
      githubAccountId: 'gh-member',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });

    // Empty ids: no-op (alice's rows all intact).
    await deleteGitHubInstallationMembers(env.db, [], alice.id);
    expect(
      await env.db
        .select()
        .from(githubInstallationMembers)
        .where(eq(githubInstallationMembers.user_id, alice.id)),
    ).toHaveLength(3);

    await deleteGitHubInstallationMembers(env.db, ['100', '200'], alice.id);
    const aliceLeft = await env.db
      .select()
      .from(githubInstallationMembers)
      .where(eq(githubInstallationMembers.user_id, alice.id));
    expect(aliceLeft).toHaveLength(1);
    expect(aliceLeft[0].installation_id).toBe('300');

    // Bob's membership on install 100 is untouched (scoped to alice).
    expect(await hasActiveInstallationMembership(env.db, '100', bob.id)).toBe(true);
  });

  it('a raw duplicate insert with a new id raises a unique violation', async () => {
    const user = await createTestUser(env.db);
    await seedInstall(env.db, '100');

    await upsertGitHubInstallationMember(env.db, {
      installationId: '100',
      userId: user.id,
      githubAccountId: 'gh-member',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });

    // A second physical row for the same (installation_id, user_id) must be
    // rejected by the unique index, proving onConflict is load-bearing.
    await expect(
      env.db.insert(githubInstallationMembers).values({
        id: generateId('ghm'),
        installation_id: '100',
        user_id: user.id,
        github_account_id: 'gh-member',
        expires_at: sql`now() + interval '1 hour'`,
      }),
    ).rejects.toThrow();
  });

  it('deleteGitHubInstallationMembersByGithubAccount: deletes X-keyed rows for any bearer, spares Z-keyed + out-of-scope + empty ids', async () => {
    const alice = await createTestUser(env.db, 'alice');
    const bob = await createTestUser(env.db, 'bob', 'google', 'google-bob');
    const carol = await createTestUser(env.db, 'carol', 'google', 'google-carol');
    await seedInstall(env.db, '100');
    await seedInstall(env.db, '200');
    await seedInstall(env.db, '300');

    // Alice: X-keyed membership under BOTH 100 and 200 (two different bearers can
    // share the same browser-proof id) — both must be deleted when in scope.
    await upsertGitHubInstallationMember(env.db, {
      installationId: '100',
      userId: alice.id,
      githubAccountId: 'X',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });
    await upsertGitHubInstallationMember(env.db, {
      installationId: '200',
      userId: alice.id,
      githubAccountId: 'X',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });
    // Bob: X-keyed membership under 100 too — a DIFFERENT bearer of the same proof
    // id, must also be deleted (helper keys on the github id, not the user id).
    await upsertGitHubInstallationMember(env.db, {
      installationId: '100',
      userId: bob.id,
      githubAccountId: 'X',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });
    // Carol: Z-keyed membership under 100 — a DIFFERENT proof id, must SURVIVE.
    await upsertGitHubInstallationMember(env.db, {
      installationId: '100',
      userId: carol.id,
      githubAccountId: 'Z',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });
    // Bob also holds a Y-keyed membership under 300 — out of scope and not
    // X-keyed, must SURVIVE.
    await upsertGitHubInstallationMember(env.db, {
      installationId: '300',
      userId: bob.id,
      githubAccountId: 'Y',
      ttlSeconds: MEMBERSHIP_TTL_SECONDS,
    });

    // Empty id list → no-op (never emits `WHERE ... IN ()`); nothing deleted.
    await deleteGitHubInstallationMembersByGithubAccount(env.db, [], 'X');
    expect(await getTestGitHubInstallationMembers(env.db, '100')).toHaveLength(3);

    // Scope to [100,200]: deletes ALL X-keyed rows on those installs (alice@100,
    // alice@200, bob@100), keyed by the github id regardless of bearer.
    await deleteGitHubInstallationMembersByGithubAccount(env.db, ['100', '200'], 'X');

    // Install 100: only Carol's Z-keyed row survives.
    const m100 = await getTestGitHubInstallationMembers(env.db, '100');
    expect(m100).toHaveLength(1);
    expect(m100[0].user_id).toBe(carol.id);
    expect(m100[0].github_account_id).toBe('Z');
    // Install 200: alice's X-keyed row is gone.
    expect(await getTestGitHubInstallationMembers(env.db, '200')).toHaveLength(0);
    // Install 300: bob's Y-keyed row was out of scope AND not X-keyed → survives.
    const m300 = await getTestGitHubInstallationMembers(env.db, '300');
    expect(m300).toHaveLength(1);
    expect(m300[0].user_id).toBe(bob.id);
  });

  it('getGitHubAccountIdForUser returns the github provider_id and null otherwise', async () => {
    // createTestUser seeds an oauth_accounts row for its provider, so a github
    // user has a github oauth row and a google user does not.
    const ghUser = await createTestUser(env.db, 'octo', 'github', 'gh-provider-42');
    const googleUser = await createTestUser(env.db, 'goog', 'google', 'google-99');

    expect(await getGitHubAccountIdForUser(env.db, ghUser.id)).toBe('gh-provider-42');
    expect(await getGitHubAccountIdForUser(env.db, googleUser.id)).toBeNull();
    expect(await getGitHubAccountIdForUser(env.db, 'user_does_not_exist')).toBeNull();
  });
});

// Seed an unowned installation with an explicit account (id + type).
async function seedInstallForAccount(
  db: Db,
  installationId: string,
  accountId: string,
  accountType: 'User' | 'Organization',
): Promise<void> {
  await upsertGitHubInstallation(db, {
    installationId,
    userId: null,
    accountLogin: `acct-${installationId}`,
    accountId,
    accountType,
    repositories: [],
    repositorySelection: 'all',
  });
}

describe('github_installations account queries', () => {
  it('getGitHubInstallationsByAccount scopes by BOTH account_id and account_type', async () => {
    // Two ORG1 org installs, one ORG2 org install, one ORG1 *User* install.
    await seedInstallForAccount(env.db, '100', 'ORG1', 'Organization');
    await seedInstallForAccount(env.db, '200', 'ORG1', 'Organization');
    await seedInstallForAccount(env.db, '300', 'ORG2', 'Organization');
    await seedInstallForAccount(env.db, '400', 'ORG1', 'User');

    const rows = await getGitHubInstallationsByAccount(env.db, 'ORG1', 'Organization');

    // Exactly the two ORG1 org installs — the ORG2 row (account_id filter) and
    // the ORG1/User row (account_type filter) are both excluded.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.installation_id))).toEqual(new Set(['100', '200']));
    expect(rows.every((r) => r.account_id === 'ORG1')).toBe(true);
    expect(rows.every((r) => r.account_type === 'Organization')).toBe(true);
  });

  it('getGitHubInstallationsByAccount returns an empty array when nothing matches', async () => {
    await seedInstallForAccount(env.db, '100', 'ORG1', 'Organization');

    expect(await getGitHubInstallationsByAccount(env.db, 'ORG_NONE', 'Organization')).toEqual([]);
    // Right account, wrong type → still empty (type filter bites).
    expect(await getGitHubInstallationsByAccount(env.db, 'ORG1', 'User')).toEqual([]);
  });
});

describe('github_installation_revocations — monotonic revocation tombstone', () => {
  // The tombstone is keyed by the GitHub ACCOUNT id (X), NOT a Void user id.
  // These helpers take that github account id as their third arg.
  const X = 'gh-acct-42';
  const Y = 'gh-acct-99';

  it('records a tombstone per install (ghr_ id, revoked_at readable as epoch ms)', async () => {
    await seedInstall(env.db, '100');
    await seedInstall(env.db, '200');

    const before = Date.now();
    await recordInstallationRevocations(env.db, ['100', '200'], X);
    const after = Date.now();

    const rows = await env.db
      .select()
      .from(githubInstallationRevocations)
      .where(eq(githubInstallationRevocations.github_account_id, X));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.id.startsWith('ghr_'))).toBe(true);
    expect(new Set(rows.map((r) => r.installation_id))).toEqual(new Set(['100', '200']));

    // revoked_at, read back as epoch ms, sits within the record window (allow a
    // generous skew for the DB vs app clock).
    const at100 = await getInstallationRevocationAt(env.db, '100', X);
    expect(at100).not.toBeNull();
    expect(at100!).toBeGreaterThan(before - 60_000);
    expect(at100!).toBeLessThan(after + 60_000);
  });

  it('getInstallationRevocationAt returns null when no tombstone exists', async () => {
    await seedInstall(env.db, '100');

    expect(await getInstallationRevocationAt(env.db, '100', X)).toBeNull();
    // Record for one install; a DIFFERENT install still reports null.
    await recordInstallationRevocations(env.db, ['100'], X);
    expect(await getInstallationRevocationAt(env.db, '999', X)).toBeNull();
  });

  it('a re-call ADVANCES revoked_at in place (high-water mark, count stays 1)', async () => {
    await seedInstall(env.db, '100');

    await recordInstallationRevocations(env.db, ['100'], X);
    const first = await getInstallationRevocationAt(env.db, '100', X);
    expect(first).not.toBeNull();

    // A tiny wait so the DB clock advances measurably between the two now()s.
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    await recordInstallationRevocations(env.db, ['100'], X);
    const second = await getInstallationRevocationAt(env.db, '100', X);
    expect(second).not.toBeNull();
    // Monotonic: never regresses, and here strictly advanced.
    expect(second!).toBeGreaterThan(first!);

    // Still exactly one row (onConflict updated in place, not a second insert).
    const rows = await env.db
      .select({ id: githubInstallationRevocations.id })
      .from(githubInstallationRevocations)
      .where(eq(githubInstallationRevocations.github_account_id, X));
    expect(rows).toHaveLength(1);
  });

  it('getDbNowMs returns a plausible epoch-ms sourced from the DB clock', async () => {
    const before = Date.now();
    const dbNow = await getDbNowMs(env.db);
    const after = Date.now();

    // A positive number of the same magnitude as JS epoch ms, sitting within a
    // sane window of the test's own clock (a generous few-minute skew for the DB
    // vs app clock) — proves the from-less `select extract(epoch from now())`
    // executes and normalizes to a JS millisecond number (NOT a stray 0).
    expect(dbNow).toBeGreaterThan(before - 300_000);
    expect(dbNow).toBeLessThan(after + 300_000);
  });

  it('F4b: a reordered re-call NEVER regresses a newer tombstone (greatest wins)', async () => {
    await seedInstall(env.db, '100');

    await recordInstallationRevocations(env.db, ['100'], X);

    // Simulate a redelivery/reorder having already advanced the tombstone to a
    // FUTURE instant (well ahead of the next call's transaction-start `now()`).
    await env.db
      .update(githubInstallationRevocations)
      .set({ revoked_at: sql`now() + interval '1 hour'` })
      .where(eq(githubInstallationRevocations.github_account_id, X));
    const future = await getInstallationRevocationAt(env.db, '100', X);
    expect(future).not.toBeNull();

    // A stale/reordered redelivery whose `now()` is EARLIER than the stored
    // future value must NOT overwrite it — `greatest(existing, excluded)` keeps
    // the newer high-water mark. A bare `now()` upsert would regress here.
    await recordInstallationRevocations(env.db, ['100'], X);
    const after = await getInstallationRevocationAt(env.db, '100', X);
    expect(after).toBe(future);

    // Still exactly one row (onConflict updated in place).
    const rows = await env.db
      .select({ id: githubInstallationRevocations.id })
      .from(githubInstallationRevocations)
      .where(eq(githubInstallationRevocations.github_account_id, X));
    expect(rows).toHaveLength(1);
  });

  it('is scoped by github account — one account’s tombstone does not leak to another', async () => {
    await seedInstall(env.db, '100');

    await recordInstallationRevocations(env.db, ['100'], X);

    expect(await getInstallationRevocationAt(env.db, '100', X)).not.toBeNull();
    expect(await getInstallationRevocationAt(env.db, '100', Y)).toBeNull();
  });

  it('recordInstallationRevocations no-ops on an empty id list', async () => {
    await seedInstall(env.db, '100');

    await recordInstallationRevocations(env.db, [], X);
    const rows = await env.db.select().from(githubInstallationRevocations);
    expect(rows).toHaveLength(0);
  });

  it('getInstallationRevocationsForAccount returns the right Map and empty Map for empty ids', async () => {
    await seedInstall(env.db, '100');
    await seedInstall(env.db, '200');
    await seedInstall(env.db, '300');

    // Revoke 100 + 200 only; 300 has no tombstone.
    await recordInstallationRevocations(env.db, ['100', '200'], X);

    const map = await getInstallationRevocationsForAccount(env.db, ['100', '200', '300'], X);
    expect(map.size).toBe(2);
    expect(map.has('100')).toBe(true);
    expect(map.has('200')).toBe(true);
    // No tombstone for 300 → absent from the Map.
    expect(map.has('300')).toBe(false);
    // Values are epoch ms matching the single-row getter.
    expect(map.get('100')).toBe(await getInstallationRevocationAt(env.db, '100', X));

    // Empty id list → empty Map.
    expect((await getInstallationRevocationsForAccount(env.db, [], X)).size).toBe(0);
  });

  it('a raw duplicate insert with a new id raises a unique violation', async () => {
    await seedInstall(env.db, '100');

    await recordInstallationRevocations(env.db, ['100'], X);

    // A second physical row for (installation_id, github_account_id) must be
    // rejected by the unique index, proving onConflict is load-bearing.
    await expect(
      env.db.insert(githubInstallationRevocations).values({
        id: generateId('ghr'),
        installation_id: '100',
        github_account_id: X,
      }),
    ).rejects.toThrow();
  });
});
