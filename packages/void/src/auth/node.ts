import { mkdirSync } from 'node:fs';
import { dirname } from 'pathslash';
import { readConfig } from '../config.ts';
import { getMiniflareDatabasePath } from '../migrations/runner.ts';
import {
  applyMySqlAuthMigrations,
  applyPgAuthMigrations,
  applySqliteAuthMigrations,
  mysqlMigrationRunner,
  pgMigrationRunner,
} from '../runtime/auth-migrations.ts';
import type { VoidAuthDialect, VoidAuthEnv } from '../runtime/better-auth-shared.ts';
import { loadLocalEnv } from '../shared/env.ts';
import {
  findVoidAuthConfig,
  loadVoidAuthConfig,
  projectAuthConfigImporter,
  type ModuleImporter,
} from './config.ts';
import { resolveVoidAuthMigrationSchema } from './drizzle.ts';

export async function runLocalVoidAuthMigrations(
  root: string,
  dialect: VoidAuthDialect,
  persistRoot: string,
  databaseId: string,
  configPath: string | null = findVoidAuthConfig(root),
  /**
   * The database to change. Without it, DATABASE_URL from the shell, then from `.env`. An empty
   * shell value counts as unset.
   */
  databaseUrl?: string,
  /** The dev server's runner, so a restarted server sees the current config. */
  importModule?: ModuleImporter,
): Promise<void> {
  const authConfig = await loadVoidAuthConfig(
    configPath,
    importModule ?? projectAuthConfigImporter(root),
  );
  const runtime = {
    dialect,
    providers: readConfig(root).auth?.providers ?? null,
    userConfig: authConfig,
  };
  const localEnv = loadLocalEnv(root);
  const connectionString =
    databaseUrl ?? (process.env.DATABASE_URL || localEnv.DATABASE_URL || undefined);
  // The auth config sees the DATABASE_URL that the migration uses.
  const env = {
    ...localEnv,
    ...process.env,
    ...(connectionString !== undefined ? { DATABASE_URL: connectionString } : {}),
  } as unknown as VoidAuthEnv;
  const migrationSchema = resolveVoidAuthMigrationSchema(runtime, env);

  if (dialect === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = getMiniflareDatabasePath(persistRoot, databaseId);
    // The first dev run gets here before Miniflare creates its D1 directory.
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      await applySqliteAuthMigrations(
        {
          async all<T extends Record<string, unknown>>(sql: string) {
            return db.prepare(sql).all() as Array<T>;
          },
          async run(sql: string) {
            db.prepare(sql).run();
          },
        },
        migrationSchema,
      );
    } finally {
      db.close();
    }
    return;
  }

  if (!connectionString) {
    return;
  }

  if (dialect === 'mysql') {
    const { createConnection } = await import('mysql2/promise');
    const connection = await createConnection(connectionString);
    try {
      await applyMySqlAuthMigrations(mysqlMigrationRunner(connection), migrationSchema);
    } finally {
      await connection.end();
    }
    return;
  }

  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await applyPgAuthMigrations(pgMigrationRunner(client), migrationSchema);
  } finally {
    await client.end();
  }
}
