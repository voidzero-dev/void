import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import app from '../../src/index.ts';
import { deployments } from '../../src/schema.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { setGetProjectOverride } from './setup.ts';

// A JSON deploy keeps running after its response is returned until the NDJSON
// body is read. A test that only checks the status leaves that work running
// into the next test. On PostgreSQL, the deploy locks the project row and then
// the deployment row, while clearTables deletes deployments before projects:
// opposite orders, so the two transactions deadlock. PGlite has one connection,
// so only a real PostgreSQL database can show this.
const postgres = it.runIf(Boolean(process.env.VOID_TEST_DATABASE_URL));
const HASH = (n: number) => n.toString(16).padStart(32, '0');

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  setGetProjectOverride(null);
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
});

/** Resolves once another backend of this database waits on a lock, or after `limitMs`. */
async function lockWaitOrTimeout(limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const { rows } = (await env.db.execute(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    )) as unknown as { rows: Array<{ n: number }> };
    if (rows[0]!.n > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('fixture cleanup after an unread deploy stream', () => {
  postgres('leaves a JSON deploy unread while it holds the project row lock', async () => {
    const user = await createTestUser(env.db);
    const project = await createTestProject(env.db, user.id, 'unread-deploy');
    mockCfApi();
    const bytes = new TextEncoder().encode('<h1>hi</h1>');
    await env.STATIC_ASSETS_R2.put(`assets/${project.id}/${HASH(1)}`, bytes.buffer as ArrayBuffer);

    let reached!: () => void;
    const locked = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    setGetProjectOverride(async ({ original, argsList }) => {
      const [db, id] = argsList;
      if (db !== env.db) {
        // A saved placeholder row means this is the manifest transaction, which
        // already holds `SELECT ... FROM projects ... FOR UPDATE`.
        const { rows } = (await env.db.execute(
          sql`select count(*)::int as n from deployments where project_id = ${id}`,
        )) as unknown as { rows: Array<{ n: number }> };
        if (rows[0]!.n > 0) {
          setGetProjectOverride(null);
          reached();
          await gate;
        }
      }
      return original(...argsList);
    });

    const res = await app.fetch(
      new Request(`http://localhost/projects/${project.id}/deploy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manifest: {
            version: 3,
            assetManifestVersion: 2,
            bindings: {},
            type: 'spa',
            assetConfig: { not_found_handling: 'single-page-application' },
          },
          assetManifest: {
            '/index.html': { blake3: HASH(1), md5: HASH(2), size: bytes.byteLength },
          },
          source: null,
          commit: null,
          preflight: null,
        }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    await locked;
    // Let the deploy continue once the next cleanup waits on its lock, or after
    // a short bound when the harness finishes the deploy before cleanup.
    void lockWaitOrTimeout(1000).then(release);
    // Return without reading `res`, as a status-only test does.
  });

  postgres('starts the next test only after that deploy finished', async () => {
    // The harness drains the unread deploy before beforeEach(clearTables), which
    // would otherwise deadlock with it (40P01).
    expect(await env.db.select().from(deployments)).toEqual([]);
  });
});
