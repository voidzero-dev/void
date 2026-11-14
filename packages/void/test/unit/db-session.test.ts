import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
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
    load('\0virtual:void-db')
      .replace(
        JSON.stringify(fileURLToPath(import.meta.resolve('#self/_env'))),
        JSON.stringify(new URL('../../src/runtime/env.ts', import.meta.url).href),
      )
      .replace(
        JSON.stringify(fileURLToPath(import.meta.resolve('#self/runtime/db-session'))),
        JSON.stringify(new URL('../../src/runtime/db-session.ts', import.meta.url).href),
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
    return session;
  });
  // Only the D1 operations used by this reproduction are implemented.
  return { binding: { withSession } as unknown as D1Database, withSession };
}

const clients = [
  { module: 'runtime', bindingName: 'DB' },
  { module: 'generated', bindingName: 'DB' },
  { module: 'generated', bindingName: 'APP_DB' },
];

describe('D1 cross-request bookmark reproduction (#783)', () => {
  it.each(clients)(
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
        const { binding, withSession } = laggingBinding(
          primary as unknown as D1Database,
          replica as unknown as D1Database,
        );
        const { db, createDb, setSession, getBookmark } =
          testCase.module === 'runtime' ? runtimeDb : await loadGeneratedDb(testCase.bindingName);
        const env = { [testCase.bindingName]: binding };
        const readProfile = () => db.select().from(profile);

        const app = new Hono();
        app.use(async (c, next) => {
          setSession(c.req.header('X-DB-Bookmark') ?? 'first-unconstrained');
          await next();
          const bookmark = getBookmark();
          if (bookmark) {
            c.header('X-DB-Bookmark', bookmark);
          }
        });
        // Request A: POST /profile. The write and subsequent read share a session.
        app.post('/profile', async (c) => {
          expect(await readProfile()).toEqual([{ id: 1, name: 'Old name' }]);
          await db.update(profile).set({ name: 'Alice' }).run();
          expect(await readProfile()).toEqual([{ id: 1, name: 'Alice' }]);
          return c.redirect('/profile', 303);
        });
        app.get('/profile', async (c) => c.json(await readProfile()));
        const saved = await withRuntimeEnv(env, () => app.request('/profile', { method: 'POST' }));
        expect(saved.status).toBe(303);
        expect(saved.headers.get('Location')).toBe('/profile');
        expect(withSession).toHaveBeenCalledExactlyOnceWith('first-unconstrained');
        const bookmark = saved.headers.get('X-DB-Bookmark');
        expect(bookmark).toBe(AFTER_SAVE);

        // Request B: GET /profile after the redirect should observe the saved profile.
        const loaded = await withRuntimeEnv(env, () =>
          app.request('/profile', {
            headers: { 'X-DB-Bookmark': bookmark! },
          }),
        );
        expect(await loaded.json()).toEqual([{ id: 1, name: 'Alice' }]);
        expect(withSession.mock.calls.map(([start]) => start)).toEqual([
          'first-unconstrained',
          AFTER_SAVE,
        ]);

        // Control: starting on primary avoids the stale read.
        expect(
          await createDb(binding, { session: 'first-primary' }).select().from(profile),
        ).toEqual([{ id: 1, name: 'Alice' }]);

        // Explicit clients accept the same carried bookmark without casts.
        const explicit = createDb(binding, { session: bookmark! });
        expect(getBookmark(explicit)).toBe(AFTER_SAVE);
        expect(await explicit.select().from(profile)).toEqual([{ id: 1, name: 'Alice' }]);
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

describe.each(clients)('$module / $bindingName session lifecycle', (testCase) => {
  async function loadClient() {
    return testCase.module === 'runtime' ? runtimeDb : loadGeneratedDb(testCase.bindingName);
  }

  function mockBinding() {
    const withSession = vi.fn((start: string) => ({
      getBookmark: () => (start === 'first-unconstrained' ? null : start),
    }));
    return { withSession, env: { [testCase.bindingName]: { withSession } } };
  }

  it('does not open a D1 session when middleware configures or inspects an unused db', async () => {
    const { db, getBookmark, setSession } = await loadClient();
    const { withSession, env } = mockBinding();
    withRuntimeEnv(env, () => {
      expect(getBookmark()).toBeNull();
      expect(getBookmark(db)).toBeNull();
      setSession(AFTER_SAVE);
      expect(getBookmark()).toBeNull();
    });
    expect(withSession).not.toHaveBeenCalled();
    expect(withRuntimeEnv(env, getBookmark)).toBeNull();
  });

  it('rejects reconfiguration after db is used and keeps the original session', async () => {
    const { db, getBookmark, setSession } = await loadClient();
    const { withSession, env } = mockBinding();
    withRuntimeEnv(env, () => {
      setSession(AFTER_SAVE);
      void db.select();
      expect(() => setSession(BEFORE_SAVE)).toThrow('before the first use of db');
      expect(getBookmark()).toBe(AFTER_SAVE);
      expect(getBookmark(db)).toBe(AFTER_SAVE);
    });
    expect(withSession).toHaveBeenCalledExactlyOnceWith(AFTER_SAVE);
  });

  it('keeps overlapping requests and explicit clients independent', async () => {
    const { db, createDb, getBookmark, setSession } = await loadClient();
    const { withSession, env } = mockBinding();
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const first = withRuntimeEnv(env, async () => {
      setSession(AFTER_SAVE);
      void db.select();
      await resumed;
      expect(getBookmark()).toBe(AFTER_SAVE);
      expect(() => setSession(BEFORE_SAVE)).toThrow('before the first use of db');
    });
    try {
      await withRuntimeEnv(env, async () => {
        setSession(BEFORE_SAVE);
        const explicit = createDb(env[testCase.bindingName] as unknown as D1Database, {
          session: AFTER_SAVE,
        });
        await Promise.resolve();
        expect(getBookmark(explicit)).toBe(AFTER_SAVE);
        expect(getBookmark()).toBeNull();
        void db.select();
        expect(getBookmark()).toBe(BEFORE_SAVE);
      });
    } finally {
      resume();
      await first;
    }
    withRuntimeEnv(env, () => {
      expect(getBookmark()).toBeNull();
      void db.select();
      expect(getBookmark()).toBeNull();
    });
    expect(withSession.mock.calls.map(([start]) => start)).toEqual([
      AFTER_SAVE,
      AFTER_SAVE,
      BEFORE_SAVE,
      'first-unconstrained',
    ]);
  });

  it('requires a Void request scope for the default-session middleware helpers', async () => {
    const { getBookmark, setSession } = await loadClient();
    expect(() => setSession(AFTER_SAVE)).toThrow('outside a runtime handler');
    expect(() => getBookmark()).toThrow('outside a runtime handler');
  });

  it('reads an explicit client bookmark without a Void request scope', async () => {
    const { createDb, getBookmark } = await loadClient();
    const { withSession, env } = mockBinding();
    const client = createDb(env[testCase.bindingName] as unknown as D1Database, {
      session: AFTER_SAVE,
    });
    expect(getBookmark(client)).toBe(AFTER_SAVE);
    expect(withSession).toHaveBeenCalledExactlyOnceWith(AFTER_SAVE);
  });
});
