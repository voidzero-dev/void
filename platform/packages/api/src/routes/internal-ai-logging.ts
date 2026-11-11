import { Hono } from 'hono';
import { readProjectAiLogging } from '../ai-logging.ts';
import type { ApiEnv } from '../env.ts';
import { requireProxyInternalAuth } from '../internal-proxy-auth.ts';

const app = new Hono<ApiEnv>();
app.get('/:projectId', async (context) => {
  const projectId = context.req.param('projectId');
  const denied = await requireProxyInternalAuth(context, 'ai-logging', projectId);
  if (denied) {
    return denied;
  }
  if (context.env.PLATFORM_AUTH_DATABASE_UNCACHED !== 'true') {
    return context.json(
      {
        error: 'ai_logging_database_cached',
        message:
          'Upgrade the platform or configure cache-disabled Hyperdrive to read AI logging policies.',
      },
      503,
    );
  }
  context.header('Cache-Control', 'no-store');
  const policy = await readProjectAiLogging(context.get('db'), projectId);
  return policy ? context.json(policy) : context.json({ error: 'project not found' }, 404);
});
export default app;
