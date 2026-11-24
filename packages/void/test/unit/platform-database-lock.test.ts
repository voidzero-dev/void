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
      connect: async () => ({ query, release: () => {} }),
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

it('reads the connection slots left for roles without SUPERUSER', async () => {
  const url = 'postgresql://owner:pw@db.example.com/platform?sslmode=require';
  await claimPlatformDatabase(url, 'test-install', 'test-owner');
  lock = await acquirePlatformDatabaseLifecycleLock(url, 'test-install', 'test-owner');
  const settings = await database.query<{ max: number; superuser: number; reserved: number }>(
    `SELECT current_setting('max_connections')::int AS "max",
            current_setting('superuser_reserved_connections')::int AS "superuser",
            COALESCE(current_setting('reserved_connections', true), '0')::int AS "reserved"`,
  );
  const { max, superuser, reserved } = settings.rows[0];
  expect(max).toBeGreaterThan(superuser + reserved);
  await expect(lock.readConnectionSlots!()).resolves.toBe(max - superuser - reserved);
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
