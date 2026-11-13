import { defineHandler } from 'void';
import { createDb, getBookmark, sql } from 'void/db';
import { serializeError, type RoutingProbe } from '../../src/demo.ts';

export const GET = defineHandler(async (c) => {
  c.header('Cache-Control', 'private, no-store');
  // No writes, pressure, request-scoped db, or incoming bookmark cookies here.
  // Each probe reads one indexed row through one fresh session.
  const query = 'SELECT revision, saved_at FROM bookmark_profiles ORDER BY id LIMIT 1';
  const workerColo =
    c.req.header('cf-placement') ??
    (typeof c.req.raw.cf?.colo === 'string' ? c.req.raw.cf.colo : null);
  const path = 'void-run';
  const started = performance.now();
  try {
    const client = createDb(c.env.DB, { session: 'first-unconstrained' });
    const result = await client.run(sql.raw(query));
    const probe: RoutingProbe = {
      path,
      workerColo,
      elapsedMs: performance.now() - started,
      metadata: { ...result.meta },
      rows: result.results,
      bookmark: getBookmark(client),
    };
    console.log(JSON.stringify({ event: 'd1-routing-probe', ...probe }));
    return c.json(probe);
  } catch (cause) {
    const probe: RoutingProbe = {
      path,
      workerColo,
      elapsedMs: performance.now() - started,
      metadata: null,
      rows: [],
      bookmark: null,
      error: {
        phase: 'probe',
        status: 500,
        requestId: c.req.header('cf-ray') ?? null,
        causes: serializeError(cause),
      },
    };
    console.error(JSON.stringify({ event: 'd1-routing-probe-error', ...probe }));
    return c.json(probe, 500);
  }
});
