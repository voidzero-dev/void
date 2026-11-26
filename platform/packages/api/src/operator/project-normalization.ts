import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { getActiveDeployment, getDeployment, getProject, getProjectResources } from '../db.ts';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { getProjectDeploymentWorkerName, getProjectQueueName } from '../naming.ts';
import { hasLiveDeployment, isQueueId } from '../project-state.ts';
import { getQueueByName } from '../provisioning/cloudflare-api.ts';
import { projectRouteKey } from '../routing.ts';
import { projects, resources } from '../schema.ts';
import type { Project } from '../types.ts';
import { OperatorError, preview } from './common.ts';

async function servingDeployment(
  context: Context<ApiEnv>,
  db: Db,
  project: Project,
): Promise<string | null> {
  if (project.active_deployment_id) {
    // Keep committed pointer authority: rollback preserves historical status,
    // including a retained failed target that now serves the project.
    const active = await getDeployment(db, project.active_deployment_id);
    if (!active || active.project_id !== project.id) {
      throw new OperatorError(
        409,
        'The recorded active deployment is invalid; investigate it before normalization.',
        'normalization_unverified',
      );
    }
    return active.id;
  }
  if (!(await hasLiveDeployment(db, project.id))) {
    return null;
  }
  const raw = await context.env.ROUTING.get(projectRouteKey(project));
  let route: Record<string, unknown>;
  try {
    route = JSON.parse(raw ?? '') as Record<string, unknown>;
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new Error();
    }
  } catch {
    throw new OperatorError(
      409,
      'Live deployment history exists but the serving route cannot be verified.',
      'normalization_unverified',
    );
  }
  const fields = [route.staticDeploymentId, route.deploymentId, route.version].filter(
    (value) => value !== undefined,
  );
  const ids = new Set(fields);
  if (
    ids.size !== 1 ||
    fields.some((value) => typeof value !== 'string') ||
    (route.projectId !== undefined && route.projectId !== project.id)
  ) {
    throw new OperatorError(
      409,
      'The serving route has conflicting or foreign deployment identities.',
      'normalization_unverified',
    );
  }
  const id = fields[0] as string;
  const deployment = await getDeployment(db, id);
  if (
    !deployment ||
    deployment.project_id !== project.id ||
    deployment.status !== 'live' ||
    (route.workerName !== undefined &&
      route.workerName !== getProjectDeploymentWorkerName(project.slug, id))
  ) {
    throw new OperatorError(
      409,
      'The serving route does not identify a live deployment owned by this project.',
      'normalization_unverified',
    );
  }
  return id;
}

/** Explicit, database-only repair. A project lock excludes deploy/rollback/delete. */
export async function normalizeOperatorProject(
  context: Context<ApiEnv>,
  projectId: string,
  dryRun: boolean,
  expected?: unknown,
) {
  return context.get('db').transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const project = await getProject(tx, projectId);
    if (!project) {
      throw new OperatorError(404, 'Project not found.', 'not_found');
    }
    if (project.status === 'deleting' || (await getActiveDeployment(tx, projectId))) {
      throw new OperatorError(
        409,
        'Wait for project deletion, deployment, or recovery to finish before normalization.',
        'project_busy',
      );
    }
    const activeDeploymentId = await servingDeployment(context, tx, project);
    const queues: Array<{ resourceId: string; from: string; to: string }> = [];
    for (const resource of await getProjectResources(tx, projectId)) {
      if (resource.type !== 'queue' || isQueueId(resource.cf_id)) {
        continue;
      }
      let queue;
      try {
        queue = await getQueueByName(
          context.env.CF_ACCOUNT_ID,
          context.env.CF_API_TOKEN,
          resource.cf_id,
        );
      } catch {
        throw new OperatorError(
          409,
          `Queue ${resource.cf_id} could not be verified by its recorded name.`,
          'normalization_unverified',
        );
      }
      if (queue.queue_name !== resource.cf_id || !isQueueId(queue.queue_id)) {
        throw new OperatorError(
          409,
          `Queue ${resource.cf_id} returned a different name or an invalid provider ID.`,
          'normalization_unverified',
        );
      }
      const expectedName = getProjectQueueName(projectId, resource.binding_name);
      if (queue.queue_name !== expectedName) {
        throw new OperatorError(
          409,
          `Queue ${resource.cf_id} was verified, but delivery routing expects ${expectedName}. Reconcile the queue's routing before normalization; no resource records were changed.`,
          'queue_routing_requires_reconciliation',
        );
      }
      queues.push({ resourceId: resource.id, from: resource.cf_id, to: queue.queue_id });
    }
    queues.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    const changes = {
      activeDeployment: { from: project.active_deployment_id, to: activeDeploymentId },
      queues,
    };
    if (dryRun) {
      return preview('project.normalize', projectId, { changes });
    }
    if (JSON.stringify(expected) !== JSON.stringify(changes)) {
      throw new OperatorError(
        409,
        'The normalization plan changed or was not supplied. Preview the project again.',
        'preview_changed',
      );
    }
    if (project.active_deployment_id !== activeDeploymentId) {
      await tx
        .update(projects)
        .set({ active_deployment_id: activeDeploymentId })
        .where(eq(projects.id, projectId));
    }
    for (const queue of queues) {
      await tx.update(resources).set({ cf_id: queue.to }).where(eq(resources.id, queue.resourceId));
    }
    return { dryRun: false, action: 'project.normalize', target: projectId, changes };
  });
}
