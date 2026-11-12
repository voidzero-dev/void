import { eq } from 'drizzle-orm';
import { isAiLoggingMode, type AiLoggingMode } from './ai-logging-policy.ts';
import type { DbOrTx } from './db.ts';
import { projectAiLogging, projects } from './schema.ts';

/** Authoritative policy; a missing override inherits the installation gateway settings. */
export async function readProjectAiLogging(db: DbOrTx, projectId: string) {
  const [project] = await db
    .select({ mode: projectAiLogging.mode })
    .from(projects)
    .leftJoin(projectAiLogging, eq(projectAiLogging.project_id, projects.id))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    return null;
  }
  const mode = project.mode ?? 'inherit';
  if (!isAiLoggingMode(mode)) {
    throw new Error('Invalid saved AI logging policy.');
  }
  return { mode };
}

export async function writeProjectAiLogging(db: DbOrTx, projectId: string, mode: AiLoggingMode) {
  if (mode === 'inherit') {
    await db.delete(projectAiLogging).where(eq(projectAiLogging.project_id, projectId));
  } else {
    await db
      .insert(projectAiLogging)
      .values({ project_id: projectId, mode })
      .onConflictDoUpdate({ target: projectAiLogging.project_id, set: { mode } });
  }
}
