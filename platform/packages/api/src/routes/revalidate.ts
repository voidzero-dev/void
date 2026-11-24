import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { ApiEnv } from '../env.ts';
import { runRevalidate } from '../revalidate-core.ts';
import { requireProjectRouteCapability } from './project-access.ts';

const app = new Hono<ApiEnv>();

app.post('/:id/revalidate', async (context) => {
  const projectId = context.req.param('id');
  const access = await requireProjectRouteCapability(context, projectId, 'deploy');
  if (access instanceof Response) {
    return access;
  }

  const body = await context.req.json<{ paths?: Array<string>; all?: boolean }>();
  return context.get('db').transaction(async (tx) => {
    // Membership and ownership changes use the same project lock. Holding it
    // through the R2/KV/edge purge gives revalidation one live authorization
    // point instead of letting a revoked deploy credential keep mutating
    // externally visible cache state after removal or downgrade.
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
    const lockedAccess = await requireProjectRouteCapability(context, projectId, 'deploy', tx);
    if (lockedAccess instanceof Response) {
      return lockedAccess;
    }
    if (lockedAccess.project.status === 'deleting') {
      return context.json({ error: 'Project is being deleted' }, 409);
    }
    return runRevalidate(context, projectId, lockedAccess.project, body, tx);
  });
});

export default app;
