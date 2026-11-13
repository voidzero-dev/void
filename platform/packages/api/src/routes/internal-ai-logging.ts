import { Hono } from 'hono';
import { readPublishedAiLogging } from '../ai-logging.ts';
import type { ApiEnv } from '../env.ts';
import { requireProxyInternalAuth } from '../internal-proxy-auth.ts';

/**
 * Kept for 1.8.x proxies, which ask the API on every AI call and parse exactly
 * `{ mode }`. It answers from the published ROUTING key, the same value newer
 * proxies read themselves, so it needs no database and no uncached-database flag.
 * Remove it only once no supported upgrade source or hosted rollback target is 1.8.x.
 */
const app = new Hono<ApiEnv>();
app.get('/:projectId', async (context) => {
  const projectId = context.req.param('projectId');
  const denied = await requireProxyInternalAuth(context, 'ai-logging', projectId);
  if (denied) {
    return denied;
  }
  context.header('Cache-Control', 'no-store');
  let mode;
  try {
    mode = await readPublishedAiLogging(context.env.ROUTING, projectId);
  } catch (error) {
    console.error('[ai-logging] logging setting unavailable', {
      projectId,
      reason: 'kv_error',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return context.json({ error: 'ai_logging_policy_unavailable' }, 503);
  }
  if (mode === undefined) {
    console.error('[ai-logging] logging setting unavailable', {
      projectId,
      reason: 'invalid_value',
    });
    return context.json({ error: 'ai_logging_policy_invalid' }, 503);
  }
  return context.json({ mode });
});
export default app;
