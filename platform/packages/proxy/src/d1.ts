import { Hono } from 'hono';
import { asString } from './body.ts';
import { dispatchToWorker } from './dispatch.ts';
import { resolveResource } from './resolve.ts';
import type { ProxyEnv } from './types.ts';

const CF_API = 'https://api.cloudflare.com/client/v4';

const d1 = new Hono<ProxyEnv>();

d1.post('/query', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const binding = asString(body.binding);
  const sql = asString(body.sql);

  if (!binding || !sql) {
    return context.json({ error: 'binding and sql required' }, 400);
  }

  // Try WfP dispatch first (native bindings, ~1-5ms)
  const dispatchRes = await dispatchToWorker(context.env, projectId, '/d1/query', body);
  if (dispatchRes) {
    return dispatchRes;
  }

  // Fallback: CF REST API (for old deploys without /__void handler)
  let dbId: string;
  try {
    dbId = await resolveResource(context.env.API, context.env.JWT_SECRET, projectId, 'd1', binding);
  } catch {
    return context.json({ error: `unknown binding "${binding}"` }, 404);
  }

  const cfRes = await fetch(
    `${CF_API}/accounts/${context.env.CF_ACCOUNT_ID}/d1/database/${dbId}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${context.env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params: body.params ?? [] }),
    },
  );

  if (!cfRes.ok) {
    return context.json({ error: 'D1 query failed', status: cfRes.status }, 502);
  }

  const cfData = await cfRes.json<{
    result?: ReadonlyArray<{
      results?: ReadonlyArray<Record<string, unknown>>;
      meta?: Record<string, unknown>;
    }>;
  }>();
  const queryResult = cfData.result?.[0];

  if (!queryResult) {
    return context.json({ error: 'unexpected D1 response' }, 502);
  }

  switch (body.method) {
    case 'first':
      return context.json(queryResult.results?.[0] ?? null);
    case 'raw': {
      const columns = queryResult.results?.length ? Object.keys(queryResult.results[0]) : [];
      const values = (queryResult.results ?? []).map((row) => Object.values(row));
      return context.json({ columns, results: values, meta: queryResult.meta });
    }
    case 'run':
      return context.json({ success: true, meta: queryResult.meta });
    case 'all':
    default:
      return context.json({
        results: queryResult.results ?? [],
        success: true,
        meta: queryResult.meta,
      });
  }
});

d1.post('/batch', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const binding = asString(body.binding);

  if (!binding || !Array.isArray(body.statements)) {
    return context.json({ error: 'binding and statements required' }, 400);
  }

  // Try WfP dispatch first (native db.batch() with transactional guarantees)
  const dispatchRes = await dispatchToWorker(context.env, projectId, '/d1/batch', body);
  if (dispatchRes) {
    return dispatchRes;
  }

  // There is no sequential fallback: D1Database.batch() promises one atomic
  // native batch. If the active worker cannot provide that capability, fail
  // before issuing any statement rather than partially applying the batch.
  return context.json({ error: 'atomic D1 batch unavailable for active deployment' }, 503);
});

export { d1 };
