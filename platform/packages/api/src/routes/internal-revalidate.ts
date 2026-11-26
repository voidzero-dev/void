import { Hono } from 'hono';
import { getProject } from '../db.ts';
import type { ApiEnv } from '../env.ts';
import { isProjectId } from '../id.ts';
import { checkTenantProxyToken } from '../internal-proxy-auth.ts';
import { runRevalidate } from '../revalidate-core.ts';

const app = new Hono<ApiEnv>();

/**
 * Internal revalidation endpoint — called by the proxy via service binding.
 * Authenticated by the tenant project token the proxy forwards in the
 * X-Void-Internal header (no JWT/userId).
 */
app.post('/:id', async (context) => {
  const projectId = context.req.param('id');

  const token = context.req.header('x-void-internal');
  if (!token) {
    return context.json({ error: 'missing internal auth' }, 401);
  }
  if (!isProjectId(projectId)) {
    return context.json({ error: 'invalid internal auth' }, 403);
  }
  const tokenCheck = await checkTenantProxyToken(context.env, projectId, token);
  if (tokenCheck === 'unavailable') {
    return context.json({ error: 'project token state unavailable' }, 503);
  }
  if (tokenCheck === 'invalid') {
    return context.json({ error: 'invalid internal auth' }, 403);
  }

  const project = await getProject(context.get('db'), projectId);
  if (!project) {
    return context.json({ error: 'project not found' }, 404);
  }

  const body = await context.req.json<{ paths?: Array<string>; all?: boolean }>();
  return runRevalidate(context, projectId, project, body);
});

export default app;
