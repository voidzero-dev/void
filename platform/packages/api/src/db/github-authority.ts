import { and, eq, or, sql } from 'drizzle-orm';
import { projects, projectMembers, githubConnections, githubInstallations } from '../schema.ts';
import type { Db } from './client.ts';

/** The connection's recorded authorizer is still the project owner or an admin. */
export function githubConnectionAuthorityClause() {
  return or(
    eq(githubConnections.authorized_by_user_id, projects.user_id),
    sql`exists (
      select 1
      from ${projectMembers}
      where ${projectMembers.project_id} = ${projects.id}
        and ${projectMembers.user_id} = ${githubConnections.authorized_by_user_id}
        and ${projectMembers.role} = 'admin'
    )`,
  );
}

/**
 * The installation's repository selection grants the repo: an `all` install
 * covers every repo; a `selected` install needs the immutable numeric repo id
 * (rename-safe) in its cached `repositories` jsonb, which stores `id` as a number.
 */
export function installationSelectionCoversRepoClause(repositoryId: string) {
  return or(
    eq(githubInstallations.repository_selection, 'all'),
    sql`${githubInstallations.repositories} @> ${JSON.stringify([{ id: Number(repositoryId) }])}::jsonb`,
  );
}

/**
 * Re-check, INSIDE a build-creation transaction, that the GitHub App installation
 * still grants access to the repo. Both build txns already hold a `FOR UPDATE`
 * lock on the `github_connections` row, which serializes against the revocation
 * webhooks (App suspend/uninstall, repo removal) — they lock the same connection
 * rows BEFORE flipping `github_installations` status / repo set. So a PLAIN
 * (non-locking) read here, under READ COMMITTED, observes the committed
 * installation state: a revocation that committed AFTER the resolver's checks but
 * BEFORE this tx is caught. The same lock order in both paths means no deadlock,
 * and the plain read avoids any lock-order concern on `github_installations`.
 *
 * FAILS CLOSED unless the exact connection still belongs to the project, has
 * durable authority, and its active installation still covers the repo. Every
 * connection records the project owner/admin who completed the repository proof;
 * that authorizer must still be the owner or an admin.
 * An `all` install covers every repo; a `selected` install requires the immutable
 * repo id in its cache. This is the shared predicate used by webhook and OIDC
 * resolvers as well as enqueue and final startup checks.
 */
export async function installationCoversRepoInTx(
  tx: Db,
  connectionId: string,
  projectId: string,
  installationId: string,
  repositoryId: string,
): Promise<boolean> {
  const [row] = await tx
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
        eq(githubInstallations.installation_id, installationId),
        eq(githubInstallations.status, 'active'),
        githubConnectionAuthorityClause(),
        installationSelectionCoversRepoClause(repositoryId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Non-transaction sibling of `installationCoversRepoInTx`: a fresh, plain
 * (non-locking) read with the same fail-closed predicate. A stored build config
 * without a connection id fails closed.
 *
 * Used by the container `BuildManager.startBuild` to re-verify coverage at token
 * mint, AFTER a queue wait during which an uninstall/suspension/repo-removal
 * webhook may have committed an update to the row (a TOCTOU the enqueue-time
 * `installationCoversRepoInTx` check can't catch). Under READ COMMITTED this
 * plain read observes that committed revocation, so the build fails closed
 * before minting a deploy token.
 */
export async function installationCoversRepo(
  db: Db,
  connectionId: string,
  projectId: string,
  installationId: string,
  repositoryId: string,
): Promise<boolean> {
  if (!connectionId) {
    return false;
  }
  return installationCoversRepoInTx(db, connectionId, projectId, installationId, repositoryId);
}
