import { and, eq } from 'drizzle-orm';
import { getProjectResources } from './db.ts';
import type { Db } from './db.ts';
import { deployments } from './schema.ts';
import type { Project } from './types.ts';

export const isQueueId = (value: string): boolean =>
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value);

export async function hasLiveDeployment(db: Db, projectId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.project_id, projectId), eq(deployments.status, 'live')))
    .limit(1);
  return !!row;
}

export class ProjectRequiresNormalizationError extends Error {
  readonly code = 'project_requires_normalization';

  constructor(projectId: string, reason: string) {
    super(
      `${reason} Ask a platform operator to run void platform project normalize ${projectId} --plan, then apply it with --yes.`,
    );
  }
}

/** Admission never chooses an active deployment or repairs provider identities. */
export async function requireNormalizedProject(db: Db, project: Project): Promise<void> {
  if (!project.active_deployment_id) {
    if (await hasLiveDeployment(db, project.id)) {
      throw new ProjectRequiresNormalizationError(
        project.id,
        'The active deployment is not recorded.',
      );
    }
  } else {
    // Rollback changes the authoritative pointer without rewriting the target's
    // historical status. An owned retained failed row may therefore be serving.
    const [active] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.id, project.active_deployment_id),
          eq(deployments.project_id, project.id),
        ),
      )
      .limit(1);
    if (!active) {
      throw new ProjectRequiresNormalizationError(
        project.id,
        'The recorded active deployment is invalid.',
      );
    }
  }
  if (
    (await getProjectResources(db, project.id)).some(
      (resource) => resource.type === 'queue' && !isQueueId(resource.cf_id),
    )
  ) {
    throw new ProjectRequiresNormalizationError(
      project.id,
      'A queue is recorded by name instead of its provider ID.',
    );
  }
}
