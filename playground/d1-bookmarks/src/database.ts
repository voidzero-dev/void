import { pressureChunks, profiles } from '@schema';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { defineHandler, type CloudContext } from 'void';
import { createDb, db, getBookmark, sql } from 'void/db';
import {
  BOOKMARK_COOKIE,
  experimentForQuery,
  pressureMiBForQuery,
  variantForPath,
  type Observation,
  type Variant,
} from './demo.ts';

function variant(c: CloudContext): Variant {
  const value = variantForPath(c.req.path);
  if (!value) {
    throw new HTTPException(404);
  }
  return value;
}

function profileId(c: CloudContext): string {
  const suffix = experimentForQuery(c.req.query('experiment')) === 'immediate' ? ':immediate' : '';
  return `${String(c.get('demoVisitor'))}:${variant(c)}${suffix}`;
}

async function readObservation(
  c: CloudContext,
  client: typeof db,
  expected: string | null,
  incomingBookmark: string | null,
  writeBookmark: string | null = null,
): Promise<Observation> {
  const mode = variant(c);
  const started = performance.now();
  // Keep the raw D1 metadata from the very read being compared with the write receipt.
  const result = await client.run(sql`
    SELECT revision, saved_at FROM ${profiles} WHERE ${profiles.id} = ${profileId(c)}
  `);
  const row = result.results[0] as { revision: string; saved_at: string } | undefined;
  const observed = row?.revision ?? null;
  return {
    experiment: experimentForQuery(c.req.query('experiment')),
    pressureMiB: pressureMiBForQuery(c.req.query('pressure')),
    variant: mode,
    expected,
    observed,
    savedAt: row?.saved_at ?? null,
    outcome: expected === null ? 'idle' : observed === expected ? 'fresh' : 'stale',
    incomingBookmark,
    writeBookmark,
    outgoingBookmark: getBookmark(client),
    servedByPrimary: result.meta.served_by_primary ?? null,
    servedByRegion: result.meta.served_by_region ?? null,
    metadata: { ...result.meta },
    elapsedMs: performance.now() - started,
    workerColo:
      c.req.header('cf-placement') ??
      (typeof c.req.raw.cf?.colo === 'string' ? c.req.raw.cf.colo : null),
  };
}

export const loader = defineHandler(async (c): Promise<Observation> => {
  const immediate = experimentForQuery(c.req.query('experiment')) === 'immediate';
  return readObservation(
    c,
    immediate ? createDb(c.env.DB) : db,
    c.req.query('expected') ?? null,
    !immediate && variant(c) === 'with-bookmark' ? (getCookie(c, BOOKMARK_COOKIE) ?? null) : null,
  );
});

export const action = defineHandler(async (c) => {
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) {
    throw new HTTPException(403, { message: 'Use the demo from the same origin.' });
  }
  const mode = variant(c);
  const revision = crypto.randomUUID();
  const savedAt = new Date().toISOString();
  const pressureMiB = pressureMiBForQuery(c.req.query('pressure'));
  const immediate = experimentForQuery(c.req.query('experiment')) === 'immediate';
  // Both immediate variants start an independent, unconstrained write session.
  const writer = immediate ? createDb(c.env.DB) : db;
  const save = writer
    .insert(profiles)
    .values({ id: profileId(c), revision, savedAt })
    .onConflictDoUpdate({ target: profiles.id, set: { revision, savedAt } });
  // One transaction per trial, including optional BLOB pressure. No parallel writers.
  // Reuse up to eight 256 KiB slots; existing larger experiments are left untouched.
  if (pressureMiB) {
    await writer.batch([
      save,
      ...Array.from({ length: pressureMiB * 4 }, (_, id) =>
        writer
          .insert(pressureChunks)
          .values({ id, payload: sql`randomblob(262144)` })
          .onConflictDoUpdate({
            target: pressureChunks.id,
            set: { payload: sql`randomblob(262144)` },
          }),
      ),
    ]);
  } else {
    await save;
  }
  // Mark the acknowledged write before reading so failures keep the write receipt.
  c.set('demoWriteRevision', revision);
  if (immediate) {
    const writeBookmark = getBookmark(writer);
    c.set('demoWriteBookmark', writeBookmark);
    if (mode === 'with-bookmark' && writeBookmark === null) {
      throw new Error('D1 did not return a bookmark for the acknowledged write.');
    }
    const incomingBookmark = mode === 'with-bookmark' ? writeBookmark : null;
    c.set('demoReadBookmark', incomingBookmark);
    const reader = createDb(c.env.DB, { session: incomingBookmark ?? 'first-unconstrained' });
    const observation = await readObservation(c, reader, revision, incomingBookmark, writeBookmark);
    if (observation.outgoingBookmark) c.header('X-D1-Bookmark', observation.outgoingBookmark);
    return c.json(observation);
  }

  // Carry only the expected revision in the URL, not the observed value or a D1 bookmark.
  // Following this redirect issues a genuinely separate read request.
  const path = c.req.path.startsWith('/api/') ? `/api/${mode}` : `/${mode}`;
  return c.redirect(
    `${path}?expected=${revision}${pressureMiB ? `&pressure=${pressureMiB}` : ''}`,
    303,
  );
});
