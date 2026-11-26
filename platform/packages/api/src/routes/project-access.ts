import type { Context } from 'hono';
import type { Db } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import {
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  projectAccessErrorBody,
  requireProjectCapability,
} from '../project-access.ts';
import type { ProjectAccess } from '../project-access.ts';
import type { ProjectCapability } from '../types.ts';

export async function requireProjectRouteCapability(
  context: Context<ApiEnv>,
  projectId: string,
  capability: ProjectCapability,
  db: Db = context.get('db'),
): Promise<ProjectAccess | Response> {
  try {
    return await requireProjectCapability(db, projectId, context.get('user').id, capability);
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof ProjectAccessDeniedError) {
      return context.json(projectAccessErrorBody(error), error.status);
    }
    throw error;
  }
}
