import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  generateVoidAuthDatabaseModule,
  generateVoidAuthDrizzleSchema,
} from '../../src/auth/drizzle.ts';
import { drizzlePlugin } from '../../src/plugin-drizzle.ts';
import { envContext } from '../../src/runtime/env-raw.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function loadAuthDatabase(d1BindingName: string) {
  const root = mkdtempSync(join(tmpdir(), 'void-auth-d1-'));
  roots.push(root);
  mkdirSync(join(root, 'db'));
  const schemaPath = join(root, 'db', 'schema.mjs');
  writeFileSync(
    schemaPath,
    stripTypeScriptTypes(
      generateVoidAuthDrizzleSchema({ dialect: 'sqlite', providers: ['email'] }).replace(
        '"void/schema-d1"',
        JSON.stringify(import.meta.resolve('drizzle-orm/sqlite-core')),
      ),
    ),
  );
  const envUrl = new URL('../../src/runtime/env.ts', import.meta.url).href;
  const dbPath = join(root, 'db.mjs');
  const plugin = drizzlePlugin(root, false, 'sqlite', { d1BindingName, forceVirtualDb: true });
  const load = getHookHandler(plugin.load) as (id: string) => string;
  writeFileSync(
    dbPath,
    load('\0virtual:void-db').replace(
      JSON.stringify(fileURLToPath(import.meta.resolve('#self/_env'))),
      JSON.stringify(envUrl),
    ),
  );
  const options = {
    dialect: 'sqlite' as const,
    d1BindingName,
    schemaImportPath: schemaPath,
    drizzleAdapterPath: fileURLToPath(import.meta.resolve('better-auth/adapters/drizzle')),
  };
  const authPath = join(root, 'auth-db.mjs');
  writeFileSync(
    authPath,
    stripTypeScriptTypes(
      generateVoidAuthDatabaseModule(options)
        .replace('"void/db"', JSON.stringify(pathToFileURL(dbPath).href))
        .replace('"void/_env"', JSON.stringify(envUrl)),
    ),
  );
  const { __voidAuthDatabase } = (await import(pathToFileURL(authPath).href)) as {
    __voidAuthDatabase: ReturnType<typeof drizzleAdapter>;
  };
  const { db } = (await import(pathToFileURL(dbPath).href)) as { db: DrizzleD1Database };
  const { sessionTable } = (await import(pathToFileURL(schemaPath).href)) as {
    sessionTable: SQLiteTable;
  };
  return { adapter: __voidAuthDatabase({}), db, sessionTable };
}

describe('Better Auth D1 consistency', () => {
  it.each(['DB', 'AUTH_DB'])(
    'rejects a revoked session while the %s replica still has it',
    async (bindingName) => {
      const miniflare = new Miniflare(
        convertV4MiniflareOptions({
          modules: true,
          script: 'export default { fetch() { return new Response("ok") } }',
          d1Databases: ['PRIMARY', 'REPLICA'],
        }),
      );
      try {
        const bindings = await miniflare.getBindings();
        const primary = bindings.PRIMARY as D1Database;
        const replica = bindings.REPLICA as D1Database;
        for (const database of [primary, replica]) {
          await database
            .prepare(`CREATE TABLE session (
            id TEXT PRIMARY KEY, token TEXT NOT NULL, userId TEXT NOT NULL,
            expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
            ipAddress TEXT, userAgent TEXT
          )`)
            .run();
          await database
            .prepare(
              "INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt) VALUES ('s1', 'token', 'u1', ?, 0, 0)",
            )
            .bind(Date.now() + 60_000)
            .run();
        }
        // Keep the replica stale after revocation to model cross-request replication lag.
        const binding = {
          withSession: vi.fn((constraint: D1SessionConstraint) =>
            (constraint === 'first-primary' ? primary : replica).withSession(constraint),
          ),
        };
        const { adapter, db, sessionTable } = await loadAuthDatabase(bindingName);
        const findSession = () =>
          adapter.findOne({
            model: 'session',
            where: [{ field: 'token', value: 'token' }],
          });
        await withRuntimeEnv({ [bindingName]: binding }, async () => {
          expect(await db.select().from(sessionTable)).toHaveLength(1);
          expect(await findSession()).toMatchObject({ id: 's1' });
          expect(await findSession()).toMatchObject({ id: 's1' });
        });
        await primary.prepare('DELETE FROM session').run();
        await withRuntimeEnv({ [bindingName]: binding }, async () => {
          expect(await db.select().from(sessionTable)).toHaveLength(1);
          expect(await findSession()).toBeNull();
        });
        expect(binding.withSession.mock.calls.map(([constraint]) => constraint)).toEqual([
          'first-unconstrained',
          'first-primary',
          'first-unconstrained',
          'first-primary',
        ]);
        // Framework handlers without a Void request scope must also read from primary.
        binding.withSession.mockClear();
        expect(await envContext.run({ [bindingName]: binding }, findSession)).toBeNull();
        expect(binding.withSession).toHaveBeenCalled();
        expect(
          binding.withSession.mock.calls.every(([constraint]) => constraint === 'first-primary'),
        ).toBe(true);
      } finally {
        await miniflare.dispose();
      }
    },
    30_000,
  );
});
