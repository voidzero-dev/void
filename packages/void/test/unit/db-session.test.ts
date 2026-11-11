import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { drizzlePlugin } from '../../src/plugin-drizzle.ts';
import * as runtimeDb from '../../src/runtime/db.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

const roots: Array<string> = [];
const profile = sqliteTable('profile', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function loadGeneratedDb(bindingName: string): Promise<typeof runtimeDb> {
  const root = mkdtempSync(join(tmpdir(), 'void-db-session-'));
  roots.push(root);
  const plugin = drizzlePlugin(root, false, 'sqlite', {
    d1BindingName: bindingName,
    forceVirtualDb: true,
  });
  const load = getHookHandler(plugin.load) as (id: string) => string;
  const path = join(root, 'db.mjs');
  writeFileSync(
    path,
    load('\0virtual:void-db').replace(
      JSON.stringify(fileURLToPath(import.meta.resolve('#self/_env'))),
      JSON.stringify(new URL('../../src/runtime/env.ts', import.meta.url).href),
    ),
  );
  return import(pathToFileURL(path).href);
}

// Miniflare executes real D1 SQL but does not provide controllable replica lag.
// Model only the session boundary here, as in auth-d1-database.test.ts:
// PRIMARY advances after a write, REPLICA stays at the original profile.
// These opaque tokens belong to this fixture, not to Miniflare's Sessions API.
const BEFORE_SAVE = 'test-bookmark-before-save';
const AFTER_SAVE = 'test-bookmark-after-save';

function laggingBinding(primary: D1Database, replica: D1Database) {
  const sessions: Array<D1DatabaseSession> = [];
  const withSession = vi.fn((start: string = 'first-unconstrained') => {
    if (!['first-unconstrained', 'first-primary', BEFORE_SAVE, AFTER_SAVE].includes(start)) {
      throw new Error(`Unexpected test session start: ${start}`);
    }
    let fresh = start === 'first-primary' || start === AFTER_SAVE;
    let bookmark: string | null = start === BEFORE_SAVE || start === AFTER_SAVE ? start : null;
    const session = {
      getBookmark: () => bookmark,
      prepare(sql: string) {
        const write = /^update\b/i.test(sql);
        if (!write && !/^select\b/i.test(sql)) {
          throw new Error(`Unexpected test query: ${sql}`);
        }
        function statement(params: Array<unknown>) {
          // Choose at execution time, so a session's reads observe its previous writes.
          async function execute(method: 'run' | 'raw') {
            const database = write || fresh ? primary : replica;
            const prepared = database.prepare(sql).bind(...params);
            const result = await prepared[method]();
            if (write) {
              fresh = true;
            }
            bookmark = fresh ? AFTER_SAVE : BEFORE_SAVE;
            return result;
          }
          return {
            bind: (...values: Array<unknown>) => statement(values),
            run: () => execute('run'),
            raw: () => execute('raw'),
          };
        }
        return statement([]);
      },
    } as unknown as D1DatabaseSession;
    sessions.push(session);
    return session;
  });
  // Only the D1 operations used by this reproduction are implemented.
  return { binding: { withSession } as unknown as D1Database, withSession, sessions };
}

describe('D1 cross-request bookmark reproduction (#783)', () => {
  it.each([
    { module: 'runtime', bindingName: 'DB' },
    { module: 'generated', bindingName: 'DB' },
    { module: 'generated', bindingName: 'APP_DB' },
  ])(
    '$module / $bindingName: preserves read-your-writes at the next request',
    async (testCase) => {
      const miniflare = new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          script: 'export default { fetch() { return new Response("ok") } }',
          d1Databases: ['PRIMARY', 'REPLICA'],
        }),
      );
      try {
        const primary = await miniflare.getD1Database('PRIMARY');
        const replica = await miniflare.getD1Database('REPLICA');
        for (const database of [primary, replica]) {
          await database
            .prepare('CREATE TABLE profile (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
            .run();
          await database.prepare("INSERT INTO profile VALUES (1, 'Old name')").run();
        }
        const { binding, withSession, sessions } = laggingBinding(
          primary as unknown as D1Database,
          replica as unknown as D1Database,
        );
        const { db, createDb } =
          testCase.module === 'runtime' ? runtimeDb : await loadGeneratedDb(testCase.bindingName);
        const env = { [testCase.bindingName]: binding };
        const readProfile = () => db.select().from(profile);

        // Request A: POST /profile. The write and subsequent read share a session.
        await withRuntimeEnv(env, async () => {
          expect(await readProfile()).toEqual([{ id: 1, name: 'Old name' }]);
          await db.update(profile).set({ name: 'Alice' }).run();
          expect(await readProfile()).toEqual([{ id: 1, name: 'Alice' }]);
        });
        expect(withSession).toHaveBeenCalledExactlyOnceWith('first-unconstrained');
        // Test instrumentation captures what Void currently has no public helper to expose.
        const bookmark = sessions[0]!.getBookmark();
        expect(bookmark).toBe(AFTER_SAVE);

        // Request B: GET /profile after the redirect should observe the saved profile.
        // Red reproduction: bookmark propagation is missing. Keep running the controls
        // below so the failure also demonstrates that carrying the bookmark would help.
        expect.soft(await withRuntimeEnv(env, readProfile)).toEqual([{ id: 1, name: 'Alice' }]);
        expect(withSession.mock.calls.map(([start]) => start)).toEqual([
          'first-unconstrained',
          'first-unconstrained',
        ]);

        // Control: starting on primary avoids the stale read.
        expect(
          await createDb(binding, { session: 'first-primary' }).select().from(profile),
        ).toEqual([{ id: 1, name: 'Alice' }]);

        // Control: a carried bookmark also avoids it. The cast deliberately bypasses
        // today's public type restriction; db-session.typecheck.ts records that gap.
        expect(
          await createDb(binding, { session: bookmark as D1SessionConstraint })
            .select()
            .from(profile),
        ).toEqual([{ id: 1, name: 'Alice' }]);
        expect(withSession).toHaveBeenLastCalledWith(AFTER_SAVE);

        // Neither control secretly caught up the stale replica.
        expect(await withRuntimeEnv(env, readProfile)).toEqual([{ id: 1, name: 'Old name' }]);
      } finally {
        await miniflare.dispose();
      }
    },
    30_000,
  );
});
