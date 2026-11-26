import { and, eq, sql } from 'drizzle-orm';
import { generateId } from '../id.ts';
import { getProjectQueueName } from '../naming.ts';
import {
  projects,
  deployments,
  projectSecrets,
  projectCleanupJobs,
  resources,
  domains,
  builds,
} from '../schema.ts';
import type { Resource } from '../types.ts';
import { terminateBuildsForProject } from './builds.ts';
import type { TerminatedBuild } from './builds.ts';
import type { Db, DbOrTx } from './client.ts';

// --- Resources ---

export async function createResource(
  db: Db,
  projectId: string,
  type: Resource['type'],
  cfId: string,
  bindingName: string,
): Promise<Resource> {
  const id = generateId('res');
  const [row] = await db
    .insert(resources)
    .values({ id, project_id: projectId, type, cf_id: cfId, binding_name: bindingName })
    .returning();
  return row;
}

export async function getProjectResources(
  db: Db,
  projectId: string,
): Promise<ReadonlyArray<Resource>> {
  return db.select().from(resources).where(eq(resources.project_id, projectId));
}

export async function getResourceByBinding(
  db: Db,
  projectId: string,
  type: 'd1' | 'kv' | 'r2' | 'queue',
  bindingName: string,
): Promise<{ cf_id: string } | undefined> {
  return db
    .select({ cf_id: resources.cf_id })
    .from(resources)
    .where(
      and(
        eq(resources.project_id, projectId),
        eq(resources.type, type),
        eq(resources.binding_name, bindingName),
      ),
    )
    .then((rows) => rows[0]);
}

// --- Deletion ---

export type ProjectCleanupJobInput = typeof projectCleanupJobs.$inferInsert;

export function cleanupJobsForResource(
  projectId: string,
  resource: Resource,
): Array<ProjectCleanupJobInput> {
  if (resource.type === 'container') {
    return [];
  }
  const jobs: Array<ProjectCleanupJobInput> = [
    {
      target: `cf-resource:${projectId}:${resource.type}:${resource.cf_id}`,
      project_id: projectId,
      kind: 'cf-resource',
      payload: {
        type: resource.type,
        cfId: resource.cf_id,
        ...(resource.type === 'durable-object'
          ? { className: resource.binding_name, metadata: JSON.stringify(resource.metadata) }
          : {}),
      },
    },
  ];
  if (resource.type === 'queue') {
    const key = `queue:${getProjectQueueName(projectId, resource.binding_name)}`;
    jobs.push({
      target: `routing-key:${projectId}:${key}`,
      project_id: projectId,
      kind: 'routing-key',
      payload: { key },
    });
  }
  return jobs;
}

export async function enqueueProjectCleanupJobs(
  db: DbOrTx,
  jobs: ReadonlyArray<ProjectCleanupJobInput>,
): Promise<void> {
  if (jobs.length === 0) {
    return;
  }
  await db
    .insert(projectCleanupJobs)
    .values([...jobs])
    .onConflictDoNothing();
}

/**
 * Cascade-delete a project and everything that references it. Returns:
 *  - `cancelledBuilds`: the in-flight builds terminalized here, so the caller can
 *    best-effort stop their still-running container BuildManager DOs (see
 *    {@link cancelContainerBuildDos}) AFTER this tx commits.
 *  - `deletedResources`: every `resources` row this tx removed. Because the
 *    project FOR UPDATE lock below conflicts with the `FOR KEY SHARE` a resources
 *    INSERT takes on the same project row (FK), this is the COMPLETE set of
 *    resources that ever committed — a row created concurrently either committed
 *    before this lock (so the DELETE sees it) or blocks then FK-fails. The caller
 *    deletes the CF object for any resource not already cleaned by the pre-cascade
 *    best-effort sweep, closing the orphan-on-concurrent-create window (a
 *    provisioning route or deploy that raced teardown and inserted a row after the
 *    sweep's one-time snapshot). See design-doc 0067 for the broader race.
 */
export async function deleteProjectCascade(
  db: Db,
  projectId: string,
  processedResourceCfIds: ReadonlySet<string> = new Set(),
): Promise<{
  cancelledBuilds: ReadonlyArray<TerminatedBuild>;
  deletedResources: ReadonlyArray<Resource>;
}> {
  return await db.transaction(async (tx) => {
    // Lock the project row FOR UPDATE — the SAME lock the build-creation paths
    // take FIRST (supersedeAndCreateContainerBuild, createGithubActionsBuildWithinLimit)
    // — so a concurrent push/OIDC can't insert a fresh build BETWEEN the
    // terminalize below and the builds delete. A build that committed before this
    // lock is caught by terminateBuildsForProject; one that lost the race blocks
    // until this tx commits, then finds the project (and its ON DELETE CASCADE
    // github_connections row) gone and creates nothing.
    await tx.execute(sql`SELECT id FROM ${projects} WHERE id = ${projectId} FOR UPDATE`);
    // Terminalize + capture in-flight builds BEFORE deleting their rows. The build
    // row is the only durable handle the reaper/cancel path uses to stop a running
    // container DO; once the row is gone the DO (or a GitHub Actions runner) would
    // keep building until its own timeout, burning fleet/runner capacity for a
    // project that no longer exists. The caller stops the container DOs after this
    // tx commits; github_actions builds have no DO, so terminalizing (then
    // deleting) their row to revoke the deploy token is all that's possible.
    const cancelled = await terminateBuildsForProject(tx, projectId, {
      reason: 'project deleted',
    });
    await tx.delete(domains).where(eq(domains.project_id, projectId));
    // RETURNING the deleted rows so the caller can clean up the CF object behind
    // any resource that raced teardown's one-time best-effort snapshot (its row
    // is removed here, so without this it would have no durable handle left).
    const deletedResources = await tx
      .delete(resources)
      .where(eq(resources.project_id, projectId))
      .returning();
    // Record resources that appeared after the pre-cascade cleanup snapshot in
    // the same transaction that removes their only durable handles. A failed
    // provider delete after COMMIT can then be retried by the scheduled worker.
    await enqueueProjectCleanupJobs(
      tx,
      deletedResources
        .filter((resource) => !processedResourceCfIds.has(resource.cf_id))
        .flatMap((resource) => cleanupJobsForResource(projectId, resource)),
    );
    await tx.delete(projectSecrets).where(eq(projectSecrets.project_id, projectId));
    // builds reference both projects and deployments with ON DELETE NO ACTION,
    // so they must be removed before the deployments delete below (otherwise the
    // build->deployment FK aborts the teardown transaction).
    await tx.delete(builds).where(eq(builds.project_id, projectId));
    await tx.delete(deployments).where(eq(deployments.project_id, projectId));
    await tx.delete(projects).where(eq(projects.id, projectId));
    return { cancelledBuilds: cancelled, deletedResources };
  });
}
