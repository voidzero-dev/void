import { and, desc, eq, ne, inArray, isNull, or, sql, getTableColumns } from 'drizzle-orm';
import { generateId } from '../id.ts';
import {
  projects,
  githubConnections,
  githubInstallations,
  githubInstallationMembers,
  githubInstallationRevocations,
  githubWebhookRedeliveries,
} from '../schema.ts';
import type { GitHubInstallationRepository } from '../schema.ts';
import type { GitHubConnection, GitHubInstallation, GitHubInstallationMember } from '../types.ts';
import { terminateBuildsForProject } from './builds.ts';
import type { TerminatedBuild } from './builds.ts';
import type { Db } from './client.ts';
import {
  githubConnectionAuthorityClause,
  installationSelectionCoversRepoClause,
} from './github-authority.ts';

/**
 * Invalidate provenance that no longer names a project owner/admin. Membership
 * mutations call this while holding the project row lock, so they serialize with
 * connection CRUD/build creation (which use the same project-first order).
 * Active build rows are terminalized before the connection is removed,
 * which immediately revokes their build-bound deploy tokens.
 */
export async function invalidateGitHubConnectionAuthorizedBy(
  db: Db,
  projectId: string,
  userId: string,
  reason: string,
): Promise<ReadonlyArray<TerminatedBuild>> {
  const [connection] = await db
    .select({ id: githubConnections.id })
    .from(githubConnections)
    .where(
      and(
        eq(githubConnections.project_id, projectId),
        eq(githubConnections.authorized_by_user_id, userId),
      ),
    )
    .for('update')
    .limit(1);
  if (!connection) {
    return [];
  }
  const cancelledBuilds = await terminateBuildsForProject(db, projectId, { reason });
  await db.delete(githubConnections).where(eq(githubConnections.id, connection.id));
  return cancelledBuilds;
}

// ---------------------------------------------------------------------------
// github_connections
// ---------------------------------------------------------------------------

export async function createGitHubConnection(
  db: Db,
  args: {
    projectId: string;
    installationId: string;
    repoFullName: string;
    // The repo's immutable numeric GitHub id (as text), resolved at connect time.
    // Webhook/OIDC resolution keys on it (full_name is mutable).
    repositoryId: string;
    // The project owner or administrator who proved repository access while
    // connecting. Runtime authority requires this user to remain the owner or
    // an administrator.
    authorizedByUserId: string;
    branch?: string;
    buildExecutor?: GitHubConnection['build_executor'];
    // The `.github/workflows/*.yml` file the OIDC exchange binds the deploy
    // token to. Optional: when omitted the column default applies (the
    // scaffolded `void-deploy.yml`). Validated by the connect route before it
    // reaches here.
    workflowPath?: string;
  },
): Promise<GitHubConnection> {
  const id = generateId('ghc');
  const [row] = await db
    .insert(githubConnections)
    .values({
      id,
      project_id: args.projectId,
      installation_id: args.installationId,
      repo_full_name: args.repoFullName,
      repository_id: args.repositoryId,
      authorized_by_user_id: args.authorizedByUserId,
      branch: args.branch ?? 'main',
      build_executor: args.buildExecutor ?? 'container',
      ...(args.workflowPath !== undefined ? { workflow_path: args.workflowPath } : {}),
    })
    .returning();
  return row;
}

export async function getGitHubConnection(
  db: Db,
  projectId: string,
): Promise<GitHubConnection | null> {
  const [row] = await db
    .select()
    .from(githubConnections)
    .where(eq(githubConnections.project_id, projectId))
    .limit(1);
  return row ?? null;
}

export async function hasGitHubConnectionAuthority(
  db: Db,
  connectionId: string,
  projectId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: githubConnections.id })
    .from(githubConnections)
    .innerJoin(projects, eq(githubConnections.project_id, projects.id))
    .innerJoin(
      githubInstallations,
      eq(githubConnections.installation_id, githubInstallations.installation_id),
    )
    .where(
      and(
        eq(githubConnections.id, connectionId),
        eq(githubConnections.project_id, projectId),
        githubConnectionAuthorityClause(),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Look up the connection for a webhook-delivered repo within an installation,
 * joining `projects` to surface the owning `user_id` (needed to attribute a
 * build and enforce that user's tier concurrency). Returns the connection
 * fields plus `user_id`, or null when no project is connected to that repo.
 *
 * Resolution keys ONLY on the IMMUTABLE numeric repository id (`repository.id`
 * in webhook payloads) so a repo rename/delete/name-reuse under the same
 * installation can't match a DIFFERENT repository to this connection. The
 * mutable `repo_full_name` is never a routing key.
 *
 * Returns ALL connections for the repo within the installation: a repo may back
 * multiple projects (only `project_id` is unique), so the caller disambiguates
 * (e.g. by push branch or workflow run id).
 *
 * The push webhook is App-lifecycle driven but a SIGNED, redelivered/delayed
 * push can still arrive AFTER the App is suspended/uninstalled or the repo
 * dropped from the install — and within the ~55-min installation-token cache
 * window it would otherwise resolve a connection, mint a fresh deploy token, and
 * deploy. Guard against that by INNER JOINing `github_installations` (via the
 * connection's `installation_id`) and requiring `status = 'active'`, plus
 * confirming the repo is still in the installation's selection — mirroring the
 * OIDC resolver. An `all`-repos install grants every repo (the `repositories`
 * cache is irrelevant); a `selected` install requires membership in the cached
 * set (an empty array under `selected` means "no repos" and is rejected).
 *
 * Unlike the OIDC resolver, this does NOT bind to a repo-owner id: the push path
 * resolves by `installation_id` (a repo transfer creates a NEW installation) and
 * the push payload carries no owner field. It also does NOT filter by
 * `build_executor` — the push handler legitimately branches on both executors.
 */
export async function getGitHubConnectionsByRepo(
  db: Db,
  installationId: string,
  repositoryId: string,
): Promise<Array<GitHubConnection & { user_id: string }>> {
  const rows = await db
    .select({
      ...getTableColumns(githubConnections),
      user_id: projects.user_id,
    })
    .from(githubConnections)
    .innerJoin(projects, eq(githubConnections.project_id, projects.id))
    .innerJoin(
      githubInstallations,
      eq(githubConnections.installation_id, githubInstallations.installation_id),
    )
    .where(
      and(
        eq(githubConnections.installation_id, installationId),
        eq(githubConnections.repository_id, repositoryId),
        eq(githubInstallations.status, 'active'),
        githubConnectionAuthorityClause(),
        installationSelectionCoversRepoClause(repositoryId),
      ),
    );
  return rows;
}

/**
 * Self-heal stored repo names after a GitHub repository rename. A push is routed
 * by the immutable repository id, but the container build fetches its source
 * tarball from the stored `repo_full_name`; correct every connection in this
 * installation that points at this repository id but carries a stale name.
 */
export async function updateGitHubConnectionRepoNamesByRepoId(
  db: Db,
  installationId: string,
  repositoryId: string,
  newRepoFullName: string,
): Promise<void> {
  await db
    .update(githubConnections)
    .set({ repo_full_name: newRepoFullName, updated_at: sql`now()` })
    .where(
      and(
        eq(githubConnections.installation_id, installationId),
        eq(githubConnections.repository_id, repositoryId),
        ne(githubConnections.repo_full_name, newRepoFullName),
      ),
    );
}

/**
 * Resolve the GitHub Actions connection for a repo at OIDC-exchange time.
 *
 * The Actions executor authenticates by presenting a GitHub OIDC token whose
 * `repository_id` claim names the repo; there is no installation id in that
 * flow, so we look up by the immutable repository id and require
 * `build_executor = 'github_actions'` (a `container`-executor connection must
 * never be driven by the OIDC endpoint). Joins `projects` to surface the owning `user_id` (to
 * attribute the build) and `slug` (to cross-check the workflow's declared
 * `--project <slug>`). When multiple connections name the same repo, the
 * newest by `created_at` wins.
 *
 * GitHub Actions OIDC is independent of the GitHub App lifecycle, so a repo
 * workflow could otherwise keep exchanging OIDC tokens for Void deploy tokens
 * after the App is suspended/deleted or the repo dropped from the install.
 * Guard against that by INNER JOINing `github_installations` (via the
 * connection's `installation_id`) and requiring `status = 'active'`, plus
 * confirming the repo is still in the installation's selection. Selection is
 * keyed off GitHub's `repository_selection`: an `all`-repos install grants
 * every repo (membership is not enforced — the `repositories` cache is
 * irrelevant), while a `selected` install requires the repo to be a member of
 * the cached set. An empty `repositories` array under `selected` therefore
 * means "no repos" and is rejected.
 *
 * Returns ALL github_actions connections for the repo; a repo may back multiple
 * projects (only `project_id` is unique). The caller disambiguates by the
 * workflow's requested project slug.
 *
 * A match also requires the repo's CURRENT owner account (the OIDC
 * `repository_owner_id` claim) to equal the installation's `account_id`. The
 * `repository_id` is immutable across a repo TRANSFER, so without this an
 * org→org transfer (same id, new owner) would match the OLD owner's stale
 * `all`-repos connection and mint a deploy token for the wrong project.
 */
export async function getGitHubActionsConnectionsByRepo(
  db: Db,
  repositoryId: string,
  repositoryOwnerId: string,
): Promise<Array<GitHubConnection & { user_id: string; project_slug: string }>> {
  const rows = await db
    .select({
      ...getTableColumns(githubConnections),
      user_id: projects.user_id,
      project_slug: projects.slug,
    })
    .from(githubConnections)
    .innerJoin(projects, eq(githubConnections.project_id, projects.id))
    .innerJoin(
      githubInstallations,
      eq(githubConnections.installation_id, githubInstallations.installation_id),
    )
    .where(
      and(
        eq(githubConnections.repository_id, repositoryId),
        // Bind the connection's installation account to the OIDC repo owner. The
        // `repository_id` is immutable across a repo TRANSFER, so this top-level
        // condition (applies to BOTH the 'all' and 'selected' branches below)
        // rejects a transferred repo (same id, NEW owner) that would otherwise
        // match the old owner's stale connection.
        eq(githubInstallations.account_id, repositoryOwnerId),
        eq(githubConnections.build_executor, 'github_actions'),
        eq(githubInstallations.status, 'active'),
        githubConnectionAuthorityClause(),
        installationSelectionCoversRepoClause(repositoryId),
      ),
    );
  return rows;
}

export async function updateGitHubConnection(
  db: Db,
  projectId: string,
  updates: {
    branch?: string;
    buildExecutor?: GitHubConnection['build_executor'];
    workflowPath?: string;
  },
): Promise<void> {
  await db
    .update(githubConnections)
    .set({
      branch: updates.branch === undefined ? sql`${githubConnections.branch}` : updates.branch,
      build_executor:
        updates.buildExecutor === undefined
          ? sql`${githubConnections.build_executor}`
          : updates.buildExecutor,
      workflow_path:
        updates.workflowPath === undefined
          ? sql`${githubConnections.workflow_path}`
          : updates.workflowPath,
      updated_at: sql`now()`,
    })
    .where(eq(githubConnections.project_id, projectId));
}

export async function deleteGitHubConnection(db: Db, projectId: string): Promise<void> {
  await db.delete(githubConnections).where(eq(githubConnections.project_id, projectId));
}

// ---------------------------------------------------------------------------
// github_installations
// ---------------------------------------------------------------------------

export async function upsertGitHubInstallation(
  db: Db,
  args: {
    installationId: string;
    userId?: string | null;
    accountLogin: string;
    accountId: string;
    accountType: GitHubInstallation['account_type'];
    repositories: ReadonlyArray<GitHubInstallationRepository>;
    // GitHub's `repository_selection` (`all` | `selected`). Optional so callers
    // that don't carry it (e.g. the OAuth callback re-upsert) preserve the
    // existing value on conflict; defaults to `selected` on insert, the safe
    // direction (requires explicit membership unless proven all-repos).
    repositorySelection?: GitHubInstallation['repository_selection'];
    // When true, the conflict path ALSO rolls repo membership forward to the
    // fresh `repositories` / `repositorySelection` carried in args. Only the
    // OAuth callback caller sets this — it just refetched the LIVE membership via
    // `listInstallationRepositories`, so its data is authoritative on reconnect /
    // `setup_action=update`. The webhook `installation.created` caller leaves it
    // off (default), keeping the stale-`created` membership guard below intact.
    refreshMembership?: boolean;
  },
): Promise<GitHubInstallation> {
  const id = generateId('ghi');
  const [row] = await db
    .insert(githubInstallations)
    .values({
      id,
      installation_id: args.installationId,
      user_id: args.userId ?? null,
      account_login: args.accountLogin,
      account_id: args.accountId,
      account_type: args.accountType,
      repositories: args.repositories,
      repository_selection: args.repositorySelection ?? 'selected',
    })
    .onConflictDoUpdate({
      target: githubInstallations.installation_id,
      set: {
        // Only personal (account_type='User') installs carry an owner. A
        // personal account converted into an organization arrives here with the
        // organization type, so it drops its owner. Otherwise preserve an
        // already-linked user_id when a webhook upsert arrives with no user
        // (install-before-signin can be backfilled later). When a user is
        // provided, adopt it ONLY if the row is unowned or already owned by the
        // same user — never re-own a row linked to a DIFFERENT user, even if two
        // callbacks race. (Done in the column expression, not setWhere: setWhere
        // would freeze repositories/status refreshes on the webhook re-upsert,
        // and `user_id = NULL` is never true.)
        user_id:
          args.accountType === 'Organization'
            ? null
            : args.userId === undefined || args.userId === null
              ? sql`${githubInstallations.user_id}`
              : sql`CASE WHEN ${githubInstallations.user_id} IS NULL OR ${githubInstallations.user_id} = ${args.userId} THEN ${args.userId} ELSE ${githubInstallations.user_id} END`,
        account_login: args.accountLogin,
        account_id: args.accountId,
        account_type: args.accountType,
        // By default, do NOT overwrite repo-membership (`repositories` /
        // `repository_selection`) on the conflict path. GitHub never reuses
        // installation_ids, so a `created` that conflicts with an existing row is
        // ALWAYS a stale/redelivered event and its payload membership is never
        // newer than what we already hold. The INSERT above seeds both on the
        // genuine first install, and the `installation_repositories` webhook
        // handler is the authoritative writer for every membership/selection
        // change thereafter (under a FOR UPDATE lock). Overwriting here would let
        // a redelivered original `created` (e.g. repos [A]) roll back a cache the
        // handler correctly advanced (e.g. [A, B]), or downgrade an `all`
        // selection back to `selected` — silently rejecting pushes/OIDC for the
        // dropped repos until the next selection refresh.
        //
        // EXCEPTION: the OAuth callback caller (routes/github.ts) sets
        // `refreshMembership: true`. It just refetched the LIVE membership via
        // `listInstallationRepositories`, so on reconnect / `setup_action=update`
        // its data IS authoritative and must roll the cache forward (otherwise
        // newly-added repos / a widen-to-`all` stay rejected until the next
        // webhook). The membership keys are spread in only for that caller, so the
        // generated SQL is byte-identical to the webhook path when the flag is off.
        ...(args.refreshMembership
          ? {
              repositories: args.repositories,
              // NULL-safe: never blank an existing selection if the caller omitted it.
              repository_selection:
                args.repositorySelection ?? sql`${githubInstallations.repository_selection}`,
            }
          : {}),
        // Do NOT let a conflict-update revive a terminal/suspended row. A genuine
        // reinstall ALWAYS gets a NEW installation_id from GitHub (ids are never
        // reused), so it hits the INSERT branch above (status defaults to active),
        // never this conflict path. Therefore a `created` that conflicts with an
        // existing row is always a stale/redelivered event — and if that row is
        // currently `deleted` (uninstalled) or `suspended`, a LATER lifecycle event
        // set it so. Flipping it back to `active` here would re-enable push/OIDC
        // resolution (the resolvers gate only on status='active') for an App the
        // user already removed. Keep `deleted`/`suspended` terminal; only the real
        // `installation.unsuspend` webhook (markGitHubInstallationStatus) clears a
        // suspension. `active` rows stay active (the common create-before-callback
        // backfill case is a no-op).
        status: sql`CASE WHEN ${githubInstallations.status} IN ('deleted', 'suspended') THEN ${githubInstallations.status} ELSE 'active' END`,
        updated_at: sql`now()`,
      },
    })
    .returning();
  return row;
}

export async function getGitHubInstallation(
  db: Db,
  installationId: string,
): Promise<GitHubInstallation | null> {
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installation_id, installationId))
    .limit(1);
  return row ?? null;
}

export async function getGitHubInstallationsByUser(
  db: Db,
  userId: string,
): Promise<ReadonlyArray<GitHubInstallation>> {
  // Personal-account owner OR active member. Organization installs have no
  // owner (`user_id` is null), so they are visible only through a live
  // membership. The EXISTS correlates on the NUMERIC
  // `installation_id` (githubInstallations.installation_id) — the key the
  // membership cache is stored under — NOT the surrogate `.id`. The membership
  // arm honors the TTL (`expires_at > now()`, DB clock). owner-OR-EXISTS yields
  // each installation at most once (the row is from githubInstallations, deduped
  // by its own PK), so a caller who is both owner and member still sees one row.
  return db
    .select()
    .from(githubInstallations)
    .where(
      or(
        and(eq(githubInstallations.account_type, 'User'), eq(githubInstallations.user_id, userId)),
        sql`EXISTS (SELECT 1 FROM ${githubInstallationMembers} m
             WHERE m.installation_id = ${githubInstallations.installation_id}
               AND m.user_id = ${userId}
               AND m.expires_at > now())`,
      ),
    )
    .orderBy(desc(githubInstallations.created_at));
}

export async function setGitHubInstallationRepositories(
  db: Db,
  installationId: string,
  repositories: ReadonlyArray<GitHubInstallationRepository>,
  // Optional `repository_selection` (`all` | `selected`) delivered alongside the
  // installation_repositories delta. When provided it is updated atomically with
  // the cached set so an install that flips to `all` (or back to `selected`)
  // stays in sync; when omitted the stored selection is preserved.
  repositorySelection?: GitHubInstallation['repository_selection'],
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({
      repositories,
      repository_selection:
        repositorySelection === undefined
          ? sql`${githubInstallations.repository_selection}`
          : repositorySelection,
      updated_at: sql`now()`,
    })
    .where(eq(githubInstallations.installation_id, installationId));
}

export async function markGitHubInstallationStatus(
  db: Db,
  installationId: string,
  status: GitHubInstallation['status'],
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ status, updated_at: sql`now()` })
    .where(eq(githubInstallations.installation_id, installationId));
}

/**
 * Apply a suspension (installation.suspend), guarded so it NEVER overwrites a
 * `deleted` row. A delayed/redelivered `suspend` landing AFTER a later
 * `installation.deleted` would otherwise walk the terminal row back to
 * `suspended`, which then re-satisfies unsuspendGitHubInstallation's
 * `status='suspended'` guard — letting a subsequent stale `unsuspend` reactivate
 * an App the user already removed. GitHub never reuses installation_ids, so a
 * suspend hitting a `deleted` row is always stale; leave it terminal. The
 * `deleted` webhook keeps using markGitHubInstallationStatus (deleted is the
 * terminalizing write and must apply unconditionally).
 */
export async function suspendGitHubInstallation(db: Db, installationId: string): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ status: 'suspended', updated_at: sql`now()` })
    .where(
      and(
        eq(githubInstallations.installation_id, installationId),
        ne(githubInstallations.status, 'deleted'),
      ),
    );
}

/**
 * Clear a suspension (installation.unsuspend), guarded to the `suspended`→`active`
 * transition ONLY. A delayed or redelivered `unsuspend` that lands AFTER a later
 * `installation.deleted` must NOT revive the terminal row — the connection
 * resolvers gate solely on status='active', so reviving a deleted install would
 * let a removed App resume push/OIDC deploys (the same class as the stale-`created`
 * guard in upsertGitHubInstallation, which this path bypasses). GitHub never
 * reuses installation_ids, so a genuine reinstall is a NEW row, never an
 * unsuspend; an unsuspend hitting a `deleted` (or already-`active`) row is always
 * stale and is left untouched.
 */
export async function unsuspendGitHubInstallation(db: Db, installationId: string): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ status: 'active', updated_at: sql`now()` })
    .where(
      and(
        eq(githubInstallations.installation_id, installationId),
        eq(githubInstallations.status, 'suspended'),
      ),
    );
}

/**
 * Backfill the owning user on installations created before sign-in. Matches by
 * `account_id` and only adopts the user where `user_id` is still NULL, so a
 * later sign-in by the GitHub account that performed the install claims its
 * unlinked installation(s) without clobbering already-linked ones.
 */
export async function linkGitHubInstallationToUser(
  db: Db,
  accountId: string,
  userId: string,
): Promise<void> {
  await db
    .update(githubInstallations)
    .set({ user_id: userId, updated_at: sql`now()` })
    .where(
      and(
        eq(githubInstallations.account_id, accountId),
        eq(githubInstallations.account_type, 'User'),
        isNull(githubInstallations.user_id),
      ),
    );
}

/**
 * All installations under a GitHub account, scoped by type. Revocation resolves
 * an org's installs via (account_id, 'Organization').
 */
export async function getGitHubInstallationsByAccount(
  db: Db,
  accountId: string,
  accountType: GitHubInstallation['account_type'],
): Promise<ReadonlyArray<GitHubInstallation>> {
  return db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.account_id, accountId),
        eq(githubInstallations.account_type, accountType),
      ),
    );
}

// ---------------------------------------------------------------------------
// github_installation_members — cached org co-membership (TTL, no stored token)
//
// Canonical helper surface for the org-shared GitHub App flow. A row records
// that a Void user was verified as a member of the GitHub account behind a
// numeric installation. It is a TTL cache: access is re-verified per-repo, and
// these helpers only short-circuit the org-membership check while fresh.
// ---------------------------------------------------------------------------

/**
 * Insert (or refresh) a cached membership for `(installationId, userId)`.
 *
 * `expires_at` is computed from the DB clock (`now() + ttlSeconds`), never the
 * app clock, so a skewed worker cannot mint a longer- or shorter-lived
 * membership than intended. A re-join hits the unique `(installation_id,
 * user_id)` index and refreshes `github_account_id`/`verified_at`/`expires_at`
 * in place (count stays 1).
 */
export async function upsertGitHubInstallationMember(
  db: Db,
  args: {
    installationId: string;
    userId: string;
    githubAccountId: string;
    ttlSeconds: number;
  },
): Promise<GitHubInstallationMember> {
  const id = generateId('ghm');
  const [row] = await db
    .insert(githubInstallationMembers)
    .values({
      id,
      installation_id: args.installationId,
      user_id: args.userId,
      github_account_id: args.githubAccountId,
      expires_at: sql`now() + (${args.ttlSeconds} * interval '1 second')`,
    })
    .onConflictDoUpdate({
      target: [githubInstallationMembers.installation_id, githubInstallationMembers.user_id],
      set: {
        github_account_id: args.githubAccountId,
        verified_at: sql`now()`,
        expires_at: sql`now() + (${args.ttlSeconds} * interval '1 second')`,
      },
    })
    .returning();
  return row;
}

/**
 * TTL-checked membership predicate used by the connect gate: true iff a
 * non-expired row exists for `(installationId, userId)`.
 */
export async function hasActiveInstallationMembership(
  db: Db,
  installationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(githubInstallationMembers)
    .where(
      and(
        eq(githubInstallationMembers.installation_id, installationId),
        eq(githubInstallationMembers.user_id, userId),
        sql`${githubInstallationMembers.expires_at} > now()`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Bulk-remove a user's cached memberships across several installations (used by
 * revocation). No-op on an empty id list so we never emit a `WHERE ... IN ()`.
 */
export async function deleteGitHubInstallationMembers(
  db: Db,
  installationIds: ReadonlyArray<string>,
  userId: string,
): Promise<void> {
  if (installationIds.length === 0) {
    return;
  }
  await db
    .delete(githubInstallationMembers)
    .where(
      and(
        inArray(githubInstallationMembers.installation_id, installationIds),
        eq(githubInstallationMembers.user_id, userId),
      ),
    );
}

/**
 * Bulk-remove the cached memberships across `installationIds` whose captured
 * browser proof (`github_account_id`) equals `githubAccountId`, regardless of
 * which Void user bears them. member_removed uses this to void the LISTING
 * memberships keyed by a removed GitHub identity X: these rows are TTL cache
 * metadata that NEVER back a `github_connections` row or an installation owner
 * pointer (those are backed by the connecting user's IMMUTABLE oauth GitHub id
 * and are severed via `getUserByOAuthAccount('github', X)` — the single insert
 * site `createGitHubConnection` is only ever reached after that oauth id is
 * proven). Deleting only the X-keyed rows therefore leaves every Z-keyed
 * membership and every connection untouched. No-op on an empty id list so we
 * never emit a `WHERE ... IN ()`.
 */
export async function deleteGitHubInstallationMembersByGithubAccount(
  db: Db,
  installationIds: ReadonlyArray<string>,
  githubAccountId: string,
): Promise<void> {
  if (installationIds.length === 0) {
    return;
  }
  await db
    .delete(githubInstallationMembers)
    .where(
      and(
        inArray(githubInstallationMembers.installation_id, installationIds),
        eq(githubInstallationMembers.github_account_id, githubAccountId),
      ),
    );
}

// ---------------------------------------------------------------------------
// github_installation_revocations — durable monotonic revocation tombstone
//
// A row records the high-water mark `revoked_at` for `(installation_id,
// user_id)`. `member_removed` upserts `revoked_at = greatest(existing, now())`
// (never regresses); join/complete + the connect gate compare an artifact's
// `iat` (mint time, DB-clock ms via `getDbNowMs`) against this to reject any
// artifact minted AT OR BEFORE the last revocation. A legit re-join AFTER re-add
// mints a fresh artifact (iat > revoked_at) → kept.
// ---------------------------------------------------------------------------

/**
 * Current DB time as EPOCH MILLISECONDS. Used to stamp an artifact's `iat` from
 * the SAME clock as the revocation tombstone's `revoked_at` (also DB `now()`),
 * so the `iat <= revoked_at` revocation check never crosses clock domains (a
 * Worker/DB skew could otherwise let a pre-removal artifact slip the check).
 *
 * Uses `db.execute` rather than the query builder: a from-less `db.select(...)`
 * returns a non-executable builder in drizzle, so `execute` is the driver-safe
 * way to run a from-less scalar select on BOTH the pg and PGlite drivers
 * (mirrors the `select now()` fence in routes/webhooks.ts). `extract(epoch from
 * now()) * 1000` returns numeric — a string over the wire on both drivers — so
 * `Number(...)` normalizes it to a JS millisecond number. A row is always
 * returned; the `?? 0` is a defensive fail-closed fallback (a 0 `iat` can only
 * ever be rejected by an existing tombstone, never let a stale artifact pass).
 */
export async function getDbNowMs(db: Db): Promise<number> {
  const result = (await db.execute(sql`select extract(epoch from now()) * 1000 as now_ms`)) as {
    rows: ReadonlyArray<{ now_ms: number | string }>;
  };
  const value = result.rows[0]?.now_ms;
  return value === null || value === undefined ? 0 : Number(value);
}

/**
 * Record (or advance) the revocation tombstone for a removed GitHub ACCOUNT id
 * across a set of installations. Upserts one row per install; the inserted
 * `revoked_at` is `clock_timestamp()` — the ACTUAL write moment, NOT Postgres
 * `now()` (which freezes at TRANSACTION-START). `member_removed` writes this
 * AFTER a possibly lock-waiting `FOR UPDATE` on the org install rows, so an
 * artifact (join_code/connect_grant) minted DURING that tx window has
 * `iat < revoked_at` and is rejected — closing the contention-amplified
 * replay window that a tx-start `now()` would leave open. onConflict sets
 * `revoked_at` to `greatest(existing, excluded)`: a reordered/redelivered webhook
 * still carries a `clock_timestamp()` >= the earlier one, and `greatest(...)`
 * pins the high-water mark so it can only move forward. No-op on an empty id list
 * so we never emit a values-less insert. Id via `generateId('ghr')` (mirrors
 * `ghm` for members).
 *
 * Keyed by `githubAccountId` — the durable identity the stateless artifacts
 * carry — NOT a Void user id (which may not exist when a soon-to-be-removed member
 * pre-mints artifacts). `member_removed` calls this ONCE with the removed GitHub
 * id, always known from the webhook payload.
 */
export async function recordInstallationRevocations(
  db: Db,
  installationIds: ReadonlyArray<string>,
  githubAccountId: string,
): Promise<void> {
  if (installationIds.length === 0) {
    return;
  }
  await db
    .insert(githubInstallationRevocations)
    .values(
      installationIds.map((installationId) => ({
        id: generateId('ghr'),
        installation_id: installationId,
        github_account_id: githubAccountId,
        revoked_at: sql`clock_timestamp()`,
      })),
    )
    .onConflictDoUpdate({
      target: [
        githubInstallationRevocations.installation_id,
        githubInstallationRevocations.github_account_id,
      ],
      set: {
        revoked_at: sql`greatest(${githubInstallationRevocations.revoked_at}, excluded.revoked_at)`,
      },
    });
}

/**
 * The subset of `guids` we have already redelivered (i.e. already recorded in
 * the `github_webhook_redeliveries` ledger). Returns an empty Set for an empty
 * input WITHOUT issuing a query — a bare `inArray(col, [])` would emit `IN ()`.
 */
export async function getRedeliveredGuids(
  db: Db,
  guids: ReadonlyArray<string>,
): Promise<Set<string>> {
  if (guids.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ guid: githubWebhookRedeliveries.guid })
    .from(githubWebhookRedeliveries)
    .where(inArray(githubWebhookRedeliveries.guid, [...guids]));
  return new Set(rows.map((r) => r.guid));
}

/**
 * Record a redelivered webhook in the ledger. Idempotent: `onConflictDoNothing`
 * on the `guid` unique index, so a concurrent run / re-scan that races on the
 * same guid never double-inserts (and the caller never double-redelivers).
 */
export async function recordWebhookRedelivery(
  db: Db,
  entry: {
    guid: string;
    deliveryId: string;
    event: string | null;
    statusCode: number | null;
  },
): Promise<void> {
  await db
    .insert(githubWebhookRedeliveries)
    .values({
      id: generateId('ghwr'),
      guid: entry.guid,
      delivery_id: entry.deliveryId,
      event: entry.event,
      status_code: entry.statusCode,
    })
    .onConflictDoNothing({ target: githubWebhookRedeliveries.guid });
}

/**
 * The revocation tombstone's `revoked_at` for `(installationId, githubAccountId)`
 * as EPOCH MILLISECONDS (so the caller can compare it directly to an artifact
 * `iat`, itself DB-clock ms via `getDbNowMs`), or null when no tombstone exists.
 * `extract(epoch from ...) * 1000` keeps the PGlite test driver and the pg
 * production driver in agreement on the millisecond value.
 */
export async function getInstallationRevocationAt(
  db: Db,
  installationId: string,
  githubAccountId: string,
): Promise<number | null> {
  const rows = await db
    .select({
      revokedAtMs: sql<number>`extract(epoch from ${githubInstallationRevocations.revoked_at}) * 1000`,
    })
    .from(githubInstallationRevocations)
    .where(
      and(
        eq(githubInstallationRevocations.installation_id, installationId),
        eq(githubInstallationRevocations.github_account_id, githubAccountId),
      ),
    )
    .limit(1);
  const value = rows[0]?.revokedAtMs;
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Batch revocation tombstones for `(installationIds, githubAccountId)` as a Map
 * installation_id → revoked_at-epoch-ms. Installs with no tombstone are simply
 * absent from the Map. Empty id list → empty Map (never emits `WHERE ... IN ()`).
 */
export async function getInstallationRevocationsForAccount(
  db: Db,
  installationIds: ReadonlyArray<string>,
  githubAccountId: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (installationIds.length === 0) {
    return result;
  }
  const rows = await db
    .select({
      installationId: githubInstallationRevocations.installation_id,
      revokedAtMs: sql<number>`extract(epoch from ${githubInstallationRevocations.revoked_at}) * 1000`,
    })
    .from(githubInstallationRevocations)
    .where(
      and(
        inArray(githubInstallationRevocations.installation_id, installationIds),
        eq(githubInstallationRevocations.github_account_id, githubAccountId),
      ),
    );
  for (const row of rows) {
    result.set(row.installationId, Number(row.revokedAtMs));
  }
  return result;
}

export { installationCoversRepoInTx, installationCoversRepo } from './github-authority.ts';
