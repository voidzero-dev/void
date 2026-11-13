import { and, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { lockAuthSettings } from '../auth/configuration.ts';
import { generateId } from '../id.ts';
import { getDefaultPlan, lockPlanCatalog, requireAssignablePlan } from '../plans.ts';
import { users, oauthAccounts, projects, deployments } from '../schema.ts';
import type { PlanId } from '../tiers.ts';
import type { OAuthAccount, User } from '../types.ts';
import { type Db, type Tx } from './client.ts';

// --- Users ---

export async function createUser(
  db: Db,
  provider: string,
  providerId: string,
  login: string,
  email: string | null,
  role: 'user' | 'admin' = 'user',
  plan?: PlanId,
): Promise<User> {
  return db.transaction(async (tx) => {
    await lockPlanCatalog(tx);
    const assignedPlan =
      plan === undefined ? await getDefaultPlan(tx) : await requireAssignablePlan(tx, plan);
    const id = generateId('user');
    const [row] = await tx
      .insert(users)
      .values({ id, provider, provider_id: providerId, login, email, role, plan: assignedPlan.id })
      .returning();
    return row;
  });
}

/**
 * Creates a user and grants the first account on a self-hosted installation
 * the admin role. Call this inside the same transaction that links the OAuth
 * identity. The table lock makes concurrent first logins observe one winner.
 * Hosted Void Cloud retains its existing user default. Both paths reject an
 * old callback racing the migration to configurable authentication.
 */
export async function createUserForPlatform(
  db: Db,
  provider: string,
  providerId: string,
  login: string,
  email: string | null,
  installationId?: string,
  options?: {
    additionalSignupAllowed: boolean;
    bootstrapGitHubId: string;
  },
): Promise<User> {
  await lockPlanCatalog(db);
  if (await lockAuthSettings(db)) {
    throw new SelfHostedSignupRestrictedError();
  }
  if (!installationId) {
    return createUser(db, provider, providerId, login, email);
  }
  await db.execute(sql`LOCK TABLE ${users} IN SHARE ROW EXCLUSIVE MODE`);
  const [existing] = await db.select({ id: users.id }).from(users).limit(1);
  if (!existing) {
    if (
      provider !== 'github' ||
      !options?.bootstrapGitHubId ||
      providerId !== options.bootstrapGitHubId
    ) {
      throw new SelfHostedSignupRestrictedError();
    }
  } else if (!options?.additionalSignupAllowed) {
    throw new SelfHostedSignupRestrictedError();
  }
  const defaultPlan = await getDefaultPlan(db, 'custom');
  return createUser(
    db,
    provider,
    providerId,
    login,
    email,
    existing ? 'user' : 'admin',
    defaultPlan.id,
  );
}

/** Bootstrap the configured owner through admin OAuth without opening general signup. */
export async function bootstrapPlatformAdmin(
  db: Db,
  provider: string,
  providerId: string,
  login: string,
  email: string | null,
  installationId?: string,
  bootstrapGitHubId?: string,
): Promise<User | null> {
  if (
    !installationId ||
    provider !== 'github' ||
    !bootstrapGitHubId ||
    providerId !== bootstrapGitHubId
  ) {
    return null;
  }
  return db.transaction(async (tx) => {
    let user: User;
    try {
      // Share the first-user lock and identity check with normal signup. Keep
      // the user and OAuth identity in one transaction so neither can be orphaned.
      user = await createUserForPlatform(tx, provider, providerId, login, email, installationId, {
        additionalSignupAllowed: false,
        bootstrapGitHubId,
      });
    } catch (error) {
      if (!(error instanceof SelfHostedSignupRestrictedError)) {
        throw error;
      }
      // A concurrent dashboard/CLI login may have created the owner after the
      // callback's initial lookup. Re-read under the lock, never promote a user.
      return getUserByOAuthAccount(tx, provider, providerId);
    }
    await createOAuthAccount(tx, user.id, provider, providerId);
    return user;
  });
}

export class SelfHostedSignupRestrictedError extends Error {
  constructor() {
    super('Self-hosted platform signup is restricted.');
    this.name = 'SelfHostedSignupRestrictedError';
  }
}

export async function getUserByEmail(db: Db, email: string): Promise<User | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return row ?? null;
}

export async function getUser(db: Db, id: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function getUsersByIds(
  db: Db,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyArray<User>> {
  if (ids.length === 0) {
    return [];
  }

  return db.select().from(users).where(inArray(users.id, ids));
}

export async function updateUser(
  db: Db,
  id: string,
  login: string,
  email: string | null,
): Promise<void> {
  await db.update(users).set({ login, email }).where(eq(users.id, id));
}

// --- OAuth Accounts ---

export async function getUserByOAuthAccount(
  db: Db,
  provider: string,
  providerId: string,
): Promise<User | null> {
  const [row] = await db
    .select({ user: users })
    .from(oauthAccounts)
    .innerJoin(users, eq(oauthAccounts.user_id, users.id))
    .where(and(eq(oauthAccounts.provider, provider), eq(oauthAccounts.provider_id, providerId)))
    .limit(1);
  return row?.user ?? null;
}

export async function createOAuthAccount(
  db: Db,
  userId: string,
  provider: string,
  providerId: string,
): Promise<OAuthAccount> {
  const id = generateId('oa');
  const [row] = await db
    .insert(oauthAccounts)
    .values({ id, user_id: userId, provider, provider_id: providerId })
    .returning();
  return row;
}

/**
 * Thrown by {@link linkGitHubIdentity} when the requested GitHub identity is
 * already linked to a *different* Void user. Routes map this to HTTP 409 — it
 * is the stable contract for that mapping.
 */
export class GitHubIdentityConflictError extends Error {
  constructor() {
    super('GitHub account already linked to another user');
    this.name = 'GitHubIdentityConflictError';
  }
}

/**
 * Thrown by {@link linkGitHubIdentity} when *this* Void user already has a
 * DIFFERENT GitHub identity linked. RFC 0074 models a single GitHub identity per
 * Void account; routes map this to HTTP 409 with a code distinct from
 * {@link GitHubIdentityConflictError} (which is the other-user case).
 */
export class GitHubIdentityAlreadyLinkedError extends Error {
  constructor() {
    super('Void account already has a different GitHub identity linked');
    this.name = 'GitHubIdentityAlreadyLinkedError';
  }
}

/** Postgres `unique_violation` SQLSTATE — surfaced by both `pg` and PGlite. */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Link a GitHub OAuth identity to an *already-authenticated* Void user
 * (RFC 0074 — decouple GitHub-for-deploys from the login provider).
 *
 * Returns `'linked'` when a new row was created and `'already_linked'` when the
 * identity is already owned by `userId` (idempotent no-op). Throws
 * {@link GitHubIdentityConflictError} when the identity belongs to a different
 * user, and {@link GitHubIdentityAlreadyLinkedError} when this user already has a
 * DIFFERENT github identity (RFC 0074: one GitHub identity per Void account).
 *
 * Concurrency: the whole check-then-insert runs in a transaction that first
 * takes a `SELECT … FOR UPDATE` lock on the `userId` row. That serializes
 * concurrent links for the SAME user — `oauth_accounts` is unique only on
 * `(provider, provider_id)`, so without the lock two parallel links of DIFFERENT
 * github ids for one user could both pass the existing-github check and insert,
 * leaving two github rows (breaking RFC 0074's one-github-per-account invariant).
 * The lock makes the second link block until the first commits, then observe its
 * row and reject. A concurrent DIFFERENT-user link of the SAME github id is not
 * serialized by the per-user lock; that collides on the `(provider, provider_id)`
 * unique index instead — the insert raises a unique violation, we roll back,
 * re-resolve ownership OUTSIDE the aborted transaction, and map to the same
 * return/throw contract so a raw pg `23505` never escapes.
 */
export async function linkGitHubIdentity(
  db: Db,
  userId: string,
  providerId: string,
): Promise<'linked' | 'already_linked'> {
  try {
    return await db.transaction(async (tx) => {
      // Serialize concurrent same-user links (see doc comment). Mirrors the
      // deploy/build per-user FOR UPDATE pattern.
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update')
        .limit(1);

      const owner = await getUserByOAuthAccount(tx, 'github', providerId);
      if (owner) {
        if (owner.id === userId) {
          return 'already_linked';
        }
        throw new GitHubIdentityConflictError();
      }

      // Enforce one github identity per Void account: a pre-existing github row
      // for this user must be a DIFFERENT provider_id (the same-id case is the
      // `owner.id === userId` short-circuit above), so reject.
      if ((await getGitHubAccountIdForUser(tx, userId)) !== null) {
        throw new GitHubIdentityAlreadyLinkedError();
      }

      await createOAuthAccount(tx, userId, 'github', providerId);
      return 'linked';
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    // Lost the `(provider, provider_id)` insert race to a concurrent
    // DIFFERENT-user link of the same github id (the per-user FOR UPDATE lock
    // does not serialize across users). The transaction rolled back; re-resolve
    // ownership outside it.
    const winner = await getUserByOAuthAccount(db, 'github', providerId);
    if (winner?.id === userId) {
      return 'already_linked';
    }
    throw new GitHubIdentityConflictError();
  }
}

/**
 * Saves an account's plan under the plan lock. `inTransaction` runs before the
 * commit with the plan the account had, read through a write so Hyperdrive cannot
 * answer it from its cache (`null` when the account does not exist).
 */
export async function updateUserPlan(
  db: Db,
  id: string,
  plan: PlanId,
  inTransaction?: (tx: Tx, previousPlan: string | null) => Promise<void>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPlanCatalog(tx);
    await requireAssignablePlan(tx, plan);
    const before = inTransaction
      ? await tx
          .update(users)
          .set({ id: sql`${users.id}` })
          .where(eq(users.id, id))
          .returning({ plan: users.plan })
      : [];
    await tx.update(users).set({ plan }).where(eq(users.id, id));
    await inTransaction?.(tx, before[0]?.plan ?? null);
  });
}

export async function countUserDeploymentsToday(db: Db, userId: string): Promise<number> {
  // Excludes precheck placeholder rows (manifest IS NULL). Those represent
  // in-flight deploys that have passed serialization but not yet validated
  // against quota; counting them would charge a deploy against quota BEFORE
  // the quota check fires for that same request, dropping the effective
  // daily limit by one for both streamed-static and worker-backed paths.
  const [result] = await db
    .select({ count: count() })
    .from(deployments)
    .innerJoin(projects, eq(deployments.project_id, projects.id))
    .where(
      and(
        // billing_user_id is authoritative after the team migration. Keep the
        // owner fallback during the additive rollout for a placeholder created
        // by an older API revision before the backfill converges.
        sql`COALESCE(${deployments.billing_user_id}, ${projects.user_id}) = ${userId}`,
        sql`${deployments.created_at} >= CURRENT_DATE`,
        isNotNull(deployments.manifest),
      ),
    );
  return result?.count ?? 0;
}

/**
 * Resolve a Void user's linked GitHub account id (the numeric provider id, as
 * text), or null when the user has no linked GitHub identity. Used for the audit
 * column on membership rows and the connect-authz caller-identity bind.
 */
export async function getGitHubAccountIdForUser(db: Db, userId: string): Promise<string | null> {
  return getOAuthAccountIdForUser(db, userId, 'github');
}

/**
 * Resolve the provider id of a user's linked identity for `provider`, or null
 * when the user has never signed in with that provider.
 */
export async function getOAuthAccountIdForUser(
  db: Db,
  userId: string,
  provider: string,
): Promise<string | null> {
  const existing = await db
    .select({ providerId: oauthAccounts.provider_id })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.user_id, userId), eq(oauthAccounts.provider, provider)))
    .limit(1);
  return existing[0]?.providerId ?? null;
}
