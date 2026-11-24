import {
  and,
  count,
  desc,
  asc,
  eq,
  ne,
  inArray,
  notInArray,
  isNotNull,
  isNull,
  or,
  sql,
  getTableColumns,
} from 'drizzle-orm';
import { generateId } from '../id.ts';
import {
  projects,
  deployments,
  deploymentOperations,
  migrationRenames,
  projectMigrations,
} from '../schema.ts';
import type { Deployment, DeploymentStatus } from '../types.ts';
import type { Db } from './client.ts';
import { getProject } from './projects.ts';

export const TERMINAL_DEPLOYMENT_STATUSES: Array<DeploymentStatus> = ['live', 'failed', 'canceled'];

export const CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES: Array<DeploymentStatus> = [
  'canceling',
  'canceled',
];

// --- Deployments ---

export async function createDeployment(
  db: Db,
  projectId: string,
  manifest: string | null,
  source?: string | null,
  commit?: string | null,
  metadata?: {
    cliVersion?: string | null;
    commitUrl?: string | null;
    gitRef?: string | null;
    repositoryUrl?: string | null;
    assetHashes?: string;
    billingUserId?: string | null;
    initiatedByUserId?: string | null;
  },
): Promise<Deployment> {
  const id = generateId('dpl');
  const billingUserId =
    metadata?.billingUserId ?? (await getProject(db, projectId))?.user_id ?? null;
  const [row] = await db
    .insert(deployments)
    .values({
      id,
      project_id: projectId,
      manifest,
      source: source ?? null,
      commit: commit ?? null,
      repository_url: metadata?.repositoryUrl ?? null,
      commit_url: metadata?.commitUrl ?? null,
      git_ref: metadata?.gitRef ?? null,
      cli_version: metadata?.cliVersion ?? null,
      asset_hashes: metadata?.assetHashes ?? null,
      billing_user_id: billingUserId,
      initiated_by_user_id: metadata?.initiatedByUserId ?? null,
    })
    .returning();
  return row;
}

/**
 * Fill in the manifest/source/git metadata on a deployment row that was inserted
 * pre-parse as an atomic concurrent-deploy claim (see the early FOR UPDATE
 * precheck in `routes/deploy.ts`). The row is created with NULL values for
 * these columns; this helper writes them once the multipart manifest has
 * been parsed and validated.
 */
export async function updateDeploymentManifest(
  db: Db,
  id: string,
  manifest: string,
  source: string | null,
  commit: string | null,
  metadata?: {
    cliVersion?: string | null;
    commitUrl?: string | null;
    gitRef?: string | null;
    repositoryUrl?: string | null;
  },
): Promise<Deployment> {
  const [row] = await db
    .update(deployments)
    .set({
      manifest,
      source,
      commit,
      repository_url: metadata?.repositoryUrl ?? null,
      commit_url: metadata?.commitUrl ?? null,
      git_ref: metadata?.gitRef ?? null,
      cli_version: metadata?.cliVersion ?? null,
      updated_at: sql`now()`,
    })
    .where(eq(deployments.id, id))
    .returning();
  return row;
}

export async function updateDeploymentStatus(
  db: Db,
  id: string,
  status: Deployment['status'],
  errorMessage?: string,
  options?: { force?: boolean },
): Promise<void> {
  await db
    .update(deployments)
    .set({
      status,
      updated_at: sql`now()`,
      deployed_at:
        status === 'live'
          ? sql`COALESCE(${deployments.deployed_at}, now())`
          : sql`${deployments.deployed_at}`,
      error_message: sql`COALESCE(${errorMessage ?? null}, ${deployments.error_message})`,
    })
    .where(
      options?.force
        ? eq(deployments.id, id)
        : and(
            eq(deployments.id, id),
            notInArray(deployments.status, CANCELLATION_REQUESTED_DEPLOYMENT_STATUSES),
          ),
    );
}

/** Claim a protected cutover for compensation before reverting external state. */
export async function beginDeploymentCompensation(db: Db, id: string): Promise<boolean> {
  const updated = await db
    .update(deployments)
    .set({ status: 'compensating', updated_at: sql`now()` })
    .where(and(eq(deployments.id, id), eq(deployments.status, 'cutover')))
    .returning({ id: deployments.id });
  return updated.length === 1;
}

/** Atomically protect an owned nonterminal deployment before external cutover. */
export async function beginDeploymentCutover(db: Db, id: string): Promise<boolean> {
  const updated = await db
    .update(deployments)
    .set({ status: 'cutover', updated_at: sql`now()` })
    .where(
      and(
        eq(deployments.id, id),
        inArray(deployments.status, ['pending', 'uploading', 'migrating', 'prerendering']),
      ),
    )
    .returning({ id: deployments.id });
  return updated.length === 1;
}

export async function getDeployment(db: Db, id: string): Promise<Deployment | null> {
  const [row] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
  return row ?? null;
}

/** Remove an internal rollback fence only when this request still owns it. */
export async function deleteRollbackLease(db: Db, id: string, ownerId: string): Promise<boolean> {
  const deleted = await db
    .delete(deployments)
    .where(
      and(
        eq(deployments.id, id),
        eq(deployments.source, 'rollback-lease'),
        sql`${deployments.manifest}::jsonb ->> 'ownerId' = ${ownerId}`,
      ),
    )
    .returning({ id: deployments.id });
  return deleted.length === 1;
}

export async function updateRollbackLeaseState(
  db: Db,
  id: string,
  targetDeploymentId: string,
  state: 'running' | 'retryable' | 'applied',
  ownerId: string,
  expectedOwnerId: string,
  migrationDiff?: ReadonlyArray<string>,
): Promise<boolean> {
  const updated = await db
    .update(deployments)
    .set({
      manifest: JSON.stringify({
        version: 1,
        targetDeploymentId,
        state,
        ownerId,
        ...(migrationDiff ? { migrationDiff } : {}),
      }),
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(deployments.id, id),
        eq(deployments.source, 'rollback-lease'),
        sql`${deployments.manifest}::jsonb ->> 'ownerId' = ${expectedOwnerId}`,
      ),
    )
    .returning({ id: deployments.id });
  return updated.length === 1;
}

export async function getProjectDeployments(
  db: Db,
  projectId: string,
  limit = 5,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        or(isNull(deployments.source), ne(deployments.source, 'rollback-lease')),
      ),
    )
    .orderBy(desc(deployments.created_at))
    .limit(limit);
}

export async function getAllProjectDeployments(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.project_id, projectId))
    .orderBy(desc(deployments.created_at));
}

export async function getAllDeploymentsWithProject(
  db: Db,
  limit: number,
  offset: number,
): Promise<
  ReadonlyArray<Deployment & { project_slug: string | null; active_deployment_id: string | null }>
> {
  return db
    .select({
      ...getTableColumns(deployments),
      project_slug: projects.slug,
      active_deployment_id: projects.active_deployment_id,
    })
    .from(deployments)
    .leftJoin(projects, eq(deployments.project_id, projects.id))
    .orderBy(desc(deployments.created_at))
    .limit(limit)
    .offset(offset);
}

export async function countDeployments(db: Db): Promise<number> {
  const [result] = await db.select({ count: count() }).from(deployments);
  return result?.count ?? 0;
}

export async function failStaleDeployments(db: Db): Promise<number> {
  const result = await db
    .update(deployments)
    .set({
      status: 'failed',
      updated_at: sql`now()`,
      error_message: sql`COALESCE(${deployments.error_message}, 'timed out')`,
    })
    .where(
      and(
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
        ne(deployments.status, 'cutover'),
        ne(deployments.status, 'compensating'),
        or(isNull(deployments.source), ne(deployments.source, 'rollback-lease')),
        sql`${deployments.updated_at} < now() - interval '30 minutes'`,
        sql`NOT EXISTS (SELECT 1 FROM deployment_operations op WHERE op.id = ${deployments.id} AND op.status <> 'terminal')`,
      ),
    );
  return result.rowCount ?? 0;
}

export async function getActiveDeployment(db: Db, projectId: string): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
      ),
    )
    .orderBy(desc(deployments.created_at))
    .limit(1);
  return row ?? null;
}

export async function getPendingDeploymentOperation(
  db: Db,
  projectId: string,
): Promise<{ id: string } | null> {
  const [operation] = await db
    .select({ id: deploymentOperations.id })
    .from(deploymentOperations)
    .where(
      and(
        eq(deploymentOperations.project_id, projectId),
        ne(deploymentOperations.status, 'terminal'),
      ),
    )
    .limit(1);
  return operation ?? null;
}

/** Newest historical live row for verifying legacy Zero Trust routing freshness. */
export async function getLatestLiveDeployment(
  db: Db,
  projectId: string,
): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), eq(deployments.status, 'live')))
    .orderBy(desc(deployments.created_at))
    .limit(1);
  return row ?? null;
}

export async function cancelDeployment(
  db: Db,
  deploymentId: string,
  errorMessage = 'canceled',
): Promise<Deployment | null> {
  const [row] = await db
    .update(deployments)
    .set({
      status: 'canceling',
      updated_at: sql`now()`,
      error_message: sql`COALESCE(${deployments.error_message}, ${errorMessage})`,
    })
    .where(
      and(
        eq(deployments.id, deploymentId),
        ne(deployments.status, 'cutover'),
        ne(deployments.status, 'compensating'),
        or(isNull(deployments.source), ne(deployments.source, 'rollback-lease')),
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
      ),
    )
    .returning();
  return row ?? null;
}

export async function setActiveDeployment(
  db: Db,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  await db
    .update(projects)
    .set({ active_deployment_id: deploymentId })
    .where(eq(projects.id, projectId));
}

export async function markDeploymentRetained(
  db: Db,
  deploymentId: string,
  retained: boolean,
): Promise<void> {
  await db.update(deployments).set({ retained }).where(eq(deployments.id, deploymentId));
}

export async function setAppliedMigrations(
  db: Db,
  deploymentId: string,
  migrations: ReadonlyArray<string>,
): Promise<void> {
  await db
    .update(deployments)
    .set({ applied_migrations: JSON.stringify(migrations) })
    .where(eq(deployments.id, deploymentId));
}

export async function getProjectMigrationNames(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<string>> {
  const rows = await db
    .select({ name: projectMigrations.name })
    .from(projectMigrations)
    .where(eq(projectMigrations.project_id, projectId))
    .orderBy(asc(projectMigrations.applied_at), asc(projectMigrations.name));
  return rows.map((row) => row.name);
}

export async function getProjectMigrationRows(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<{ name: string; applied_at: string }>> {
  return db
    .select({ name: projectMigrations.name, applied_at: projectMigrations.applied_at })
    .from(projectMigrations)
    .where(eq(projectMigrations.project_id, projectId))
    .orderBy(asc(projectMigrations.applied_at), asc(projectMigrations.name));
}

export async function appendProjectMigrations(
  db: Db,
  projectId: string,
  names: ReadonlyArray<string>,
  sourceDeploymentId?: string,
): Promise<void> {
  const uniqueNames = [...new Set(names)];
  if (uniqueNames.length === 0) {
    return;
  }
  await db
    .insert(projectMigrations)
    .values(
      uniqueNames.map((name) => ({
        name,
        project_id: projectId,
        source_deployment_id: sourceDeploymentId,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Atomically append newly-applied migration names to a deployment's
 * applied_migrations JSON text column, de-duping against what's already there.
 *
 * The read-merge-write runs in a transaction behind `SELECT … FOR UPDATE` so
 * concurrent POST /migrations/apply requests serialize at the row level: the
 * second request waits for the first commit and observes its write instead of
 * overwriting it with its own partial union.
 *
 * No-op when `newMigrations` is empty or the deployment row doesn't exist.
 */
export async function appendAppliedMigrations(
  db: Db,
  deploymentId: string,
  newMigrations: ReadonlyArray<string>,
): Promise<void> {
  if (newMigrations.length === 0) {
    return;
  }
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ applied_migrations: deployments.applied_migrations })
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .for('update');
    if (rows.length === 0) {
      return;
    }
    const existing: Array<string> = rows[0].applied_migrations
      ? (JSON.parse(rows[0].applied_migrations) as Array<string>)
      : [];
    const existingSet = new Set(existing);
    const toAdd = newMigrations.filter((m) => !existingSet.has(m));
    if (toAdd.length === 0) {
      return;
    }
    const merged = [...existing, ...toAdd];
    await tx
      .update(deployments)
      .set({ applied_migrations: JSON.stringify(merged) })
      .where(eq(deployments.id, deploymentId));
  });
}

/**
 * Check whether the CURRENT active deployment of a project has `migrationName`
 * present in its `applied_migrations` JSON array. Used by the rename endpoint
 * to corroborate ambiguous `!fromExists && toExists` classifications against
 * pg before rewriting metadata — a legitimate idempotent retry of a rename
 * that landed in D1 but failed to commit to pg will still reference the old
 * name on the active deployment.
 *
 * Scoped to the active deployment only. Retained deployment rows can carry
 * historically inaccurate `applied_migrations` and would silently authorize
 * incorrect rename requests that happen to name a historically-present
 * migration. The active deployment is the only source of truth we can rely on
 * for corroboration.
 *
 * The column is stored as text (see `setAppliedMigrations`), so the query
 * casts at read time. `jsonb ? text` returns true iff the JSON array has
 * `migrationName` as a top-level element.
 */
export async function activeDeploymentContainsMigration(
  db: Db,
  projectId: string,
  migrationName: string,
): Promise<boolean> {
  const result = (await db.execute(sql`
    SELECT 1
    FROM ${projects}
    INNER JOIN ${deployments} ON ${deployments.id} = ${projects.active_deployment_id}
    WHERE ${projects.id} = ${projectId}
      AND ${deployments.applied_migrations} IS NOT NULL
      AND (${deployments.applied_migrations})::jsonb ? ${migrationName}
    LIMIT 1
  `)) as { rows: ReadonlyArray<unknown> };
  return result.rows.length > 0;
}

/**
 * Rewrite `applied_migrations` entries across every deployment of a project.
 *
 * The rename endpoint updates remote `_void_migrations` rows in D1 and must
 * also keep the platform-side record consistent. Rollback diffs compare
 * `applied_migrations` arrays, so retained and inactive deployments must not
 * keep the old names; every project deployment is rewritten in one transaction.
 */
export async function renameAppliedMigrationsForProject(
  db: Db,
  projectId: string,
  renames: ReadonlyArray<{ from: string; to: string }>,
): Promise<void> {
  if (renames.length === 0) {
    return;
  }
  const fromToMap = new Map(renames.map((r) => [r.from, r.to]));
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: deployments.id, applied_migrations: deployments.applied_migrations })
      .from(deployments)
      .where(eq(deployments.project_id, projectId))
      .for('update');
    for (const row of rows) {
      if (!row.applied_migrations) {
        continue;
      }
      const parsed = JSON.parse(row.applied_migrations) as Array<string>;
      let changed = false;
      const next = parsed.map((m) => {
        const to = fromToMap.get(m);
        if (to !== undefined) {
          changed = true;
          return to;
        }
        return m;
      });
      if (changed) {
        await tx
          .update(deployments)
          .set({ applied_migrations: JSON.stringify(next) })
          .where(eq(deployments.id, row.id));
      }
    }
  });
}

export async function renameProjectMigrations(
  db: Db,
  projectId: string,
  renames: ReadonlyArray<{ from: string; to: string }>,
): Promise<void> {
  for (const rename of renames) {
    await db
      .update(projectMigrations)
      .set({ name: rename.to })
      .where(
        and(eq(projectMigrations.project_id, projectId), eq(projectMigrations.name, rename.from)),
      );
  }
}

/**
 * Append committed /migrations/rename pairs to the audit log.
 *
 * The /rename partial-failure heal writes pg's `applied_migrations` before
 * surfacing a later pair's failure, which erases
 * `activeDeploymentContainsMigration(from)` as a corroboration source for
 * same-payload retries of an already-committed prefix. This audit log is
 * the durable, rename-specific second corroboration source:
 * `migrationRenameExists(project_id, from, to)` returning true means the
 * exact pair was already committed here in a previous locked tx, so an
 * idempotent retry must NOT be rejected as ambiguous.
 *
 * Called from the /rename handler inside the same locked tx as
 * `renameAppliedMigrationsForProject`, after every successful/idempotent
 * pair has been folded into `committed`. Uses ON CONFLICT DO NOTHING so
 * retries (and already-landed pairs from prior runs that land here again)
 * are no-ops. Note: the primary key is `(project_id, from_name, to_name)`
 * so this dedupes by the exact tuple — we never overwrite an existing row.
 */
export async function recordMigrationRenames(
  db: Db,
  projectId: string,
  pairs: ReadonlyArray<{ from: string; to: string }>,
): Promise<void> {
  if (pairs.length === 0) {
    return;
  }
  await db
    .insert(migrationRenames)
    .values(pairs.map((p) => ({ project_id: projectId, from_name: p.from, to_name: p.to })))
    .onConflictDoNothing();
}

/**
 * Returns true iff a committed rename from `from` to `to` has been recorded
 * for the given project. See `recordMigrationRenames` for the rationale.
 */
export async function migrationRenameExists(
  db: Db,
  projectId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const [row] = await db
    .select({ project_id: migrationRenames.project_id })
    .from(migrationRenames)
    .where(
      and(
        eq(migrationRenames.project_id, projectId),
        eq(migrationRenames.from_name, from),
        eq(migrationRenames.to_name, to),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Invalidate stale `migration_renames` rows whose `to_name` matches a
 * migration that is now being renamed AWAY.
 *
 * Migration names can be recycled: if `(a, a1)` is logged, then `a1` is
 * later renamed to `b`, then a different migration `x` is renamed INTO
 * `a1`, the original `(a, a1)` row is stale. A fat-fingered retry of
 * `a → a1` would then pass the classifier on corroborated-by-audit
 * grounds even though `a1` now represents `x`'s migration, not `a`'s
 * lineage — silently rewriting any retained-deployment rows that still
 * mention `a`.
 *
 * Invariant: whenever we record a new rename X→Y, delete any prior
 * `migration_renames` rows where `to_name = X`. Rationale: those rows
 * assume X is still the canonical landing spot, but X is now being
 * renamed away, so their "landed at X" claim is no longer valid.
 *
 * Only `to_name` is invalidated, not `from_name`. If the user previously
 * renamed `a → a1` and now renames `a → a2`, both intents should remain
 * auditable. The stale-lineage issue is specifically about a previously
 * logged LANDING being recycled as a new SOURCE.
 *
 * Must be called inside the same locked tx as `recordMigrationRenames`
 * and `renameAppliedMigrationsForProject` so a rollback also rolls back
 * the invalidation.
 */
export async function invalidateMigrationRenamesForOldName(
  db: Db,
  projectId: string,
  oldName: string,
): Promise<void> {
  await db
    .delete(migrationRenames)
    .where(and(eq(migrationRenames.project_id, projectId), eq(migrationRenames.to_name, oldName)));
}

export async function getRetainedDeploymentsExcluding(
  db: Db,
  projectId: string,
  excludeId: string,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        eq(deployments.retained, true),
        ne(deployments.id, excludeId),
      ),
    )
    .orderBy(desc(deployments.created_at));
}

export async function getInFlightDeploymentsExcluding(
  db: Db,
  projectId: string,
  excludeId?: string | null,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        notInArray(deployments.status, TERMINAL_DEPLOYMENT_STATUSES),
        excludeId ? ne(deployments.id, excludeId) : undefined,
      ),
    )
    .orderBy(desc(deployments.created_at));
}

/**
 * Every deployment that has ever reached `live` (deployed_at IS NOT NULL),
 * regardless of current retention. Used by the rollback queue sweep to
 * union every queue that was ever owned by an activated deployment.
 */
export async function getActivatedDeployments(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), isNotNull(deployments.deployed_at)))
    .orderBy(desc(deployments.created_at));
}

/**
 * Deployments that reached a terminal non-success state without ever
 * activating (deployed_at IS NULL, status in 'failed' | 'canceled').
 * Union'd with getActivatedDeployments at rollback to catch `queue:<name>`
 * KV routes a failed deploy wrote before the routing flip.
 */
export async function getTerminalFailedDeployments(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Deployment>> {
  return db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.project_id, projectId),
        isNull(deployments.deployed_at),
        inArray(deployments.status, ['failed', 'canceled']),
      ),
    )
    .orderBy(desc(deployments.created_at));
}

/**
 * The most recent deployment for a project at a given commit SHA. Used to link
 * a finished build back to the deployment the `void deploy` CLI created.
 */
export async function getDeploymentByProjectAndCommit(
  db: Db,
  projectId: string,
  commitSha: string,
): Promise<Deployment | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), eq(deployments.commit, commitSha)))
    .orderBy(desc(deployments.created_at))
    .limit(1);
  return row ?? null;
}
