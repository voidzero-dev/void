import { defineHandler } from 'void';
import { env } from 'void/env';
import { queues } from 'void/queues';
import { queueCases, queueResultKey, validQueueRun } from '../../../lib/queue-acceptance.ts';

export const POST = defineHandler(async (c) => {
  const secret = env.SECRET_KEY;
  if (typeof secret !== 'string' || !secret || c.req.header('x-void-e2e-token') !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await c.req.json<{ run?: unknown }>().catch(() => null);
  const run = body?.run;
  if (!validQueueRun(run)) {
    return c.json({ error: 'run must contain 16 hexadecimal characters' }, 400);
  }
  for (const scenario of queueCases) {
    await queues['acceptance-queue'].send({ run, scenario });
  }
  return c.json({ ok: true, run, cases: queueCases });
});

export const GET = defineHandler(async (c) => {
  const secret = env.SECRET_KEY;
  if (typeof secret !== 'string' || !secret || c.req.header('x-void-e2e-token') !== secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const run = c.req.query('run');
  if (!validQueueRun(run)) {
    return c.json({ error: 'run must contain 16 hexadecimal characters' }, 400);
  }
  const rows = await c.env.DB.prepare(
    'SELECT value FROM queue_results WHERE key = ? ORDER BY id LIMIT 100',
  )
    .bind(queueResultKey(run))
    .all<{ value: string }>();
  return c.json({ run, observations: rows.results.map(({ value }): unknown => JSON.parse(value)) });
});
