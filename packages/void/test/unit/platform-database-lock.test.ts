import { PGlite } from '@electric-sql/pglite';
import { getPlatformRuntimeDirectory, readPlatformRuntimeManifest } from '@void/platform/installer';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { claimPlatformDatabase } from '../../src/cli/platform-installer-database.ts';
import { acquirePlatformDatabaseLifecycleLock } from '../../src/cli/platform-installer.ts';
import type { PlatformDatabaseLifecycleLock } from '../../src/cli/platform-installer.ts';

const mocks = vi.hoisted(() => ({ pool: vi.fn() }));
vi.mock('pg', () => ({ Pool: mocks.pool }));
let database: PGlite;
let lock: PlatformDatabaseLifecycleLock | undefined;
let queries: Array<string>;

beforeEach(async () => {
  database = new PGlite();
  await database.waitReady;
  queries = [];
  mocks.pool.mockImplementation(function MockPool() {
    const query = async (sql: string, values?: Array<unknown>) => {
      queries.push(sql);
      // PGlite has one session and no advisory locks. All ownership, migration,
      // checkpoint, and protocol SQL still runs against real PostgreSQL.
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      return database.query(sql, values);
    };
    return {
      connect: async () => ({ query, on: () => {}, release: () => {} }),
      on: () => {},
      query,
      end: async () => {},
    };
  });
}, 30_000);
afterEach(async () => {
  await lock?.();
  lock = undefined;
  await database.close();
});

it('preserves every database lifecycle capability through the pool wrapper on install and resume', async () => {
  const url = 'postgresql://owner:pw@db.example.com/platform?sslmode=require';
  await claimPlatformDatabase(url, 'test-install', 'test-owner');
  lock = await acquirePlatformDatabaseLifecycleLock(url, 'test-install', 'test-owner');
  expect(lock.prepareSandboxDrain).toBeTypeOf('function');
  expect(lock.verifyDatabase).toBeTypeOf('function');
  expect(lock.checkpoint).toBeTypeOf('function');
  expect(lock.requiredSafetyProtocols).toEqual({ sandboxDrain: 0 });
  const runtime = readPlatformRuntimeManifest();
  const directory = getPlatformRuntimeDirectory();
  await lock.prepareDatabase!(directory, runtime.database, null, false);
  const checkpoint = await lock.prepareSandboxDrain!(2);
  expect(checkpoint).toMatchObject({ admissionProtocol: 2, state: 'complete' });
  await expect(lock.verifyDatabase!(directory, runtime.database)).resolves.toBeUndefined();
  await lock();
  lock = undefined;
  expect(queries.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(true);

  lock = await acquirePlatformDatabaseLifecycleLock(url, 'test-install', 'test-owner');
  expect(lock.requiredSafetyProtocols).toEqual({ sandboxDrain: 2 });
  expect(await lock.prepareSandboxDrain!(2)).toEqual(checkpoint);
  await expect(lock.verifyDatabase!(directory, runtime.database)).resolves.toBeUndefined();
}, 30_000);

it('refuses leftover migration history before claiming and still resumes its own claim', async () => {
  const url = 'postgresql://owner:pw@db.example.com/platform?sslmode=require';
  await database.exec(`
    CREATE SCHEMA "drizzle";
    CREATE TABLE "drizzle"."__drizzle_migrations" ("id" serial PRIMARY KEY, "hash" text NOT NULL);
  `);
  await expect(claimPlatformDatabase(url, 'test-install', 'test-owner')).rejects.toThrow(
    'non-empty PostgreSQL database (found drizzle.__drizzle_migrations)',
  );
  const claim = await database.query(
    `SELECT to_regclass('"__void_platform_installation"')::text AS "relation"`,
  );
  expect(claim.rows).toEqual([{ relation: null }]);

  // A resumed installation has already claimed the database and written its
  // own migration history; the matching claim must still be accepted.
  await database.exec(`DROP SCHEMA "drizzle" CASCADE`);
  await claimPlatformDatabase(url, 'test-install', 'test-owner');
  lock = await acquirePlatformDatabaseLifecycleLock(url, 'test-install', 'test-owner');
  const runtime = readPlatformRuntimeManifest();
  await lock.prepareDatabase!(getPlatformRuntimeDirectory(), runtime.database, null, false);
  await lock();
  lock = undefined;
  await expect(claimPlatformDatabase(url, 'test-install', 'test-owner')).resolves.toBeUndefined();
}, 30_000);

it('tells a reinstall on the same database to use a new empty database', async () => {
  const url = 'postgresql://owner:pw@db.example.com/platform?sslmode=require';
  await claimPlatformDatabase(url, 'test-install', 'test-owner');
  // Uninstall leaves the claim and the data, and a reinstall gets a new owner.
  await expect(claimPlatformDatabase(url, 'test-install', 'next-owner')).rejects.toThrow(
    'platform: This PostgreSQL database is already claimed by Void platform installation test-install. Uninstall keeps the database and its data, so use a dedicated empty database for each installation.',
  );
}, 30_000);

it('turns a dropped lifecycle lock connection into a clear failure instead of a crash', async () => {
  const url = 'postgresql://owner:pw@db.example.com/platform?sslmode=require';
  await claimPlatformDatabase(url, 'test-install', 'test-owner');
  const { EventEmitter } = await import('node:events');
  const pool = new EventEmitter();
  const client = new EventEmitter();
  let dropped = false;
  const releases: Array<unknown> = [];
  const query = async (sql: string, values?: Array<unknown>) => {
    queries.push(sql);
    if (dropped) {
      throw new Error('Client has encountered a connection error and is not queryable');
    }
    if (sql.includes('pg_try_advisory_lock')) {
      return { rows: [{ acquired: true }] };
    }
    return database.query(sql, values);
  };
  mocks.pool.mockImplementation(function MockPool() {
    return Object.assign(pool, {
      connect: async () =>
        Object.assign(client, {
          query,
          release: (error?: unknown) => releases.push(error),
        }),
      end: async () => {},
    });
  });
  lock = await acquirePlatformDatabaseLifecycleLock(url, 'test-install', 'test-owner');
  const runtime = readPlatformRuntimeManifest();
  const directory = getPlatformRuntimeDirectory();
  await lock.prepareDatabase!(directory, runtime.database, null, false);

  // pg emits 'error' on a checked-out client when the server resets its socket,
  // for example while the upgrade is deploying Workers and the client is idle.
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  dropped = true;
  expect(() => client.emit('error', reset)).not.toThrow();
  // The pool reports idle client errors on itself.
  expect(() => pool.emit('error', reset)).not.toThrow();

  const lost =
    'platform: The PostgreSQL connection that holds the lifecycle lock was closed (read ECONNRESET). Rerun the command to continue.';
  await expect(lock.verifyDatabase!(directory, runtime.database)).rejects.toThrow(lost);
  await expect(lock.readAdministratorSetup!()).rejects.toThrow(lost);

  // The server ends the session lock with the connection, so release only
  // closes the broken client and the pool.
  queries = [];
  await expect(lock()).resolves.toBeUndefined();
  lock = undefined;
  expect(queries).toEqual([]);
  expect(releases).toEqual([reset]);
}, 30_000);
