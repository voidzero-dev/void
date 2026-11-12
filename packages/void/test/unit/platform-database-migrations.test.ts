import { PGlite } from '@electric-sql/pglite';
import {
  getPlatformRuntimeDirectory,
  platformDatabaseSchemaDigest,
  readPlatformRuntimeManifest,
  type PlatformRuntimeDatabaseManifest,
} from '@void/platform/installer';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  inspectPlatformDatabaseStateConnection,
  preparePlatformDatabaseConnection,
} from '../../src/cli/platform-installer-database.ts';

let database: PGlite | undefined;

afterEach(async () => {
  await database?.close();
  database = undefined;
});

describe('platform database migrations', () => {
  it.each(['1.6.0', '1.7.0'])(
    'upgrades a released %s database before applying project AI logging policies',
    async (version) => {
      database = new PGlite();
      await database.waitReady;
      const runtime = readPlatformRuntimeManifest();
      const connection = database as unknown as Parameters<
        typeof preparePlatformDatabaseConnection
      >[0];
      const migrations = runtime.database.migrations.filter((migration) => migration.index < 64);
      const previous = {
        ...runtime.database,
        migrations,
        schemaDigest: platformDatabaseSchemaDigest(runtime.database.lineage, migrations),
      };
      expect(previous.schemaDigest).toBe(
        '41c9f2abec1a793d64d2acd71aa2fd737c3b3a594bc3d1c3c19b9546da05263c',
      );
      await preparePlatformDatabaseConnection(
        connection,
        getPlatformRuntimeDirectory(),
        previous,
        null,
        false,
      );
      await database.exec(
        "INSERT INTO users (id, login) VALUES ('ai-owner', 'ai-owner'); INSERT INTO projects (id, user_id, slug) VALUES ('private-ai', 'ai-owner', 'private-ai')",
      );
      const upgraded = await preparePlatformDatabaseConnection(
        connection,
        getPlatformRuntimeDirectory(),
        runtime.database,
        version,
        true,
      );
      expect(upgraded.appliedMigrations).toBe(
        runtime.database.migrations.length - migrations.length,
      );
      expect((await database.query('SELECT * FROM project_ai_logging')).rows).toEqual([]);
      await database.exec(
        "INSERT INTO project_ai_logging (project_id, mode) VALUES ('private-ai', 'off')",
      );
      await expect(
        database.exec("UPDATE project_ai_logging SET mode='invalid'"),
      ).rejects.toMatchObject({ code: '23514' });
      await database.exec("DELETE FROM projects WHERE id='private-ai'");
      expect((await database.query('SELECT * FROM project_ai_logging')).rows).toEqual([]);
    },
  );

  it('applies and recognizes the complete packaged PostgreSQL schema', async () => {
    database = new PGlite();
    await database.waitReady;
    const runtime = readPlatformRuntimeManifest();
    const connection = database as unknown as Parameters<
      typeof preparePlatformDatabaseConnection
    >[0];

    const migrated = await preparePlatformDatabaseConnection(
      connection,
      getPlatformRuntimeDirectory(),
      runtime.database,
      null,
      false,
    );
    expect(migrated.appliedMigrations).toBe(runtime.database.migrations.length);
    expect(migrated.schemaDigest).toBe(runtime.database.schemaDigest);

    const state = await inspectPlatformDatabaseStateConnection(connection, runtime.database);
    expect(state).toEqual({
      pendingMigrations: [],
      schemaDigest: runtime.database.schemaDigest,
    });
    await expect(
      preparePlatformDatabaseConnection(
        connection,
        getPlatformRuntimeDirectory(),
        runtime.database,
        runtime.platformVersion,
        true,
      ),
    ).resolves.toEqual({
      appliedMigrations: 0,
      previousSchemaDigest: runtime.database.schemaDigest,
      schemaDigest: runtime.database.schemaDigest,
    });
  }, 30_000);

  it('applies an attested forward upgrade from an exact schema prefix', async () => {
    database = new PGlite();
    await database.waitReady;
    const runtime = readPlatformRuntimeManifest();
    const connection = database as unknown as Parameters<
      typeof preparePlatformDatabaseConnection
    >[0];
    const prefixMigrations = runtime.database.migrations.slice(0, 2);
    const prefixDigest = platformDatabaseSchemaDigest(runtime.database.lineage, prefixMigrations);
    const prefix = {
      ...runtime.database,
      migrations: prefixMigrations,
      rollbackSafeFrom: [],
      schemaDigest: prefixDigest,
    } satisfies PlatformRuntimeDatabaseManifest;
    await preparePlatformDatabaseConnection(
      connection,
      getPlatformRuntimeDirectory(),
      prefix,
      null,
      false,
    );
    const target = {
      ...runtime.database,
      rollbackSafeFrom: [{ platformVersion: '0.10.13', schemaDigest: prefixDigest }],
    } satisfies PlatformRuntimeDatabaseManifest;

    const migrated = await preparePlatformDatabaseConnection(
      connection,
      getPlatformRuntimeDirectory(),
      target,
      '0.10.13',
      true,
    );

    expect(migrated.appliedMigrations).toBe(
      runtime.database.migrations.length - prefixMigrations.length,
    );
    expect(migrated.previousSchemaDigest).toBe(prefixDigest);
    expect(migrated.schemaDigest).toBe(runtime.database.schemaDigest);
  }, 30_000);
});
