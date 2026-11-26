import type { Connection } from 'mysql2/promise';
import {
  mySqlMigrationLockError,
  mySqlMigrationLockName,
  readMySqlMigrationLease,
} from '../runtime/db/migrations/mysql-lock.ts';
import { splitMySqlMigrationSql } from '../runtime/db/migrations/mysql-sql.ts';
import { collectMigrations } from './collect.ts';

export type MySqlClient = {
  query<T extends Array<Record<string, unknown>> = Array<Record<string, unknown>>>(
    sql: string,
    params?: Array<unknown>,
  ): Promise<T>;
};

export async function readMySqlAppliedMigrations(client: MySqlClient): Promise<Array<string>> {
  try {
    const rows = await client.query<Array<{ name: string }>>(
      'SELECT `name` FROM `_void_migrations`',
    );
    return rows.map((row) => String(row.name));
  } catch (error) {
    const value =
      typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined;
    if (value?.code === 'ER_NO_SUCH_TABLE' || value?.errno === 1146) {
      return [];
    }
    throw error;
  }
}

export function toMySqlClient(connection: Connection): MySqlClient {
  return {
    async query<T extends Array<Record<string, unknown>> = Array<Record<string, unknown>>>(
      sql: string,
      params?: Array<unknown>,
    ): Promise<T> {
      const [rows] = await connection.query(sql, params);
      return (Array.isArray(rows) ? rows : []) as T;
    },
  };
}

export async function getMySqlAppliedMigrations(url: string): Promise<Array<string>> {
  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection(url);
  try {
    return await readMySqlAppliedMigrations(toMySqlClient(connection));
  } finally {
    await connection.end();
  }
}

const MIGRATION_LOCK_TIMEOUT_SECONDS = 10;

/**
 * Take a named lock so two runs on one database cannot both apply a pending file. The lock
 * survives the commits MySQL makes for DDL and ends with the session. A deploy cannot hold a
 * session lock and writes a lease row instead, so this also waits for that lease.
 */
async function acquireMySqlMigrationLock(client: MySqlClient): Promise<string> {
  const [row] = await client.query<Array<{ db: string | null }>>('SELECT DATABASE() AS db');
  const database = row?.db ?? '';
  const name = mySqlMigrationLockName(database);
  const [lock] = await client.query<Array<Record<string, unknown>>>(
    'SELECT GET_LOCK(?, ?) AS acquired',
    [name, MIGRATION_LOCK_TIMEOUT_SECONDS],
  );
  // Vitess names the column after the call and ignores the alias.
  if (Number(Object.values(lock ?? {})[0]) !== 1) {
    throw mySqlMigrationLockError(database, 'run the command again');
  }

  const readLease = () => readMySqlMigrationLease((sql, params) => client.query(sql, params));
  const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_SECONDS * 1000;
  try {
    let remaining = await readLease();
    while (remaining !== undefined && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 1000);
      });
      remaining = await readLease();
    }
    if (remaining !== undefined) {
      throw new Error(
        `A deploy is applying migrations to MySQL database "${database}". Wait for it to finish, then run the command again. If that deploy stopped, its lock expires in ${remaining} seconds.`,
      );
    }
  } catch (error) {
    await client.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => {});
    throw error;
  }
  return name;
}

/**
 * A DDL statement makes MySQL commit and close the open transaction. A savepoint can only be
 * rolled back to inside a transaction, so this tells whether the file's changes can still be undone.
 */
async function isTransactionOpen(client: MySqlClient): Promise<boolean> {
  try {
    await client.query('SAVEPOINT `void_migration`');
    await client.query('ROLLBACK TO SAVEPOINT `void_migration`');
    return true;
  } catch {
    return false;
  }
}

// ER_LOCK_DEADLOCK and ER_TRANSACTION_ROLLBACK_DURING_COMMIT: MySQL has rolled back the whole
// transaction itself, which also closes it, so the savepoint probe cannot tell it from a DDL commit.
const ROLLED_BACK_BY_SERVER_ERRNOS = new Set([1213, 3101]);

function isRolledBackByServer(error: unknown): boolean {
  const errno =
    typeof error === 'object' && error !== null ? (error as { errno?: unknown }).errno : undefined;
  return typeof errno === 'number' && ROLLED_BACK_BY_SERVER_ERRNOS.has(errno);
}

function mySqlMigrationError(name: string, error: unknown, committed: boolean): Error {
  const lines = [
    `migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
  ];
  if (committed) {
    lines.push(
      `MySQL commits schema changes immediately, so earlier statements in ${name} may already be applied. Undo them, fix the file, then run the command again.`,
      'See https://void.cloud/guide/database/mysql#failed-migrations',
    );
  }
  return new Error(lines.join('\n'), { cause: error });
}

/**
 * Runs `work` while this session holds the database's migration lock, so no other migration run,
 * deploy or reset changes the schema meanwhile.
 */
export async function withMySqlMigrationLock<T>(
  client: MySqlClient,
  work: () => Promise<T>,
): Promise<T> {
  const lock = await acquireMySqlMigrationLock(client);
  try {
    return await work();
  } finally {
    await client.query('SELECT RELEASE_LOCK(?)', [lock]).catch(() => {});
  }
}

export async function applyMySqlMigrations(
  client: MySqlClient,
  migrations: Array<{ name: string; sql: string }>,
): Promise<Array<string>> {
  if (migrations.length === 0) {
    return [];
  }
  return withMySqlMigrationLock(client, () => applyPendingMySqlMigrations(client, migrations));
}

/** Applies the files not yet recorded. The caller holds the migration lock. */
export async function applyPendingMySqlMigrations(
  client: MySqlClient,
  migrations: Array<{ name: string; sql: string }>,
): Promise<Array<string>> {
  if (migrations.length === 0) {
    return [];
  }

  await client.query(
    'CREATE TABLE IF NOT EXISTS `_void_migrations` (`name` VARCHAR(255) PRIMARY KEY, `applied_at` VARCHAR(64) NOT NULL)',
  );
  const existing = await client.query<Array<{ name: string }>>(
    'SELECT `name` FROM `_void_migrations`',
  );
  const appliedSet = new Set(existing.map((row) => String(row.name)));
  const pending = migrations.filter((migration) => !appliedSet.has(migration.name));

  for (const migration of pending) {
    let ran = 0;
    // Data changes commit with the tracking row. MySQL commits DDL, and anything before it, on its own.
    await client.query('BEGIN');
    try {
      // One statement per query, so `ran` tells whether earlier statements of the file ran.
      for (const statement of splitMySqlMigrationSql(migration.sql)) {
        await client.query(statement);
        ran++;
      }
      await client.query('INSERT INTO `_void_migrations` (`name`, `applied_at`) VALUES (?, ?)', [
        migration.name,
        new Date().toISOString(),
      ]);
      await client.query('COMMIT');
    } catch (error) {
      const committed =
        ran > 0 && !isRolledBackByServer(error) && !(await isTransactionOpen(client));
      // A failed ROLLBACK means the session is gone, and MySQL rolls back with it.
      await client.query('ROLLBACK').catch(() => {});
      throw mySqlMigrationError(migration.name, error, committed);
    }
  }

  return pending.map((migration) => migration.name);
}

/** Connects to `url` and runs `work` while holding that database's migration lock. */
export async function withMySqlMigrationLockAt<T>(
  url: string,
  work: (client: MySqlClient) => Promise<T>,
): Promise<T> {
  const { createConnection } = await import('mysql2/promise');
  const connection = await createConnection({ uri: url, multipleStatements: true });
  try {
    const client = toMySqlClient(connection);
    return await withMySqlMigrationLock(client, () => work(client));
  } finally {
    await connection.end();
  }
}

/**
 * Applies the pending files in `migrationsDir`. `afterApply` gets the applied names and runs before
 * the lock is released, so the schema changes it makes (Better Auth's tables) do not overlap
 * another run either.
 */
export async function runMySqlMigrations(
  migrationsDir: string,
  url: string,
  afterApply?: (applied: Array<string>) => Promise<void>,
): Promise<Array<string>> {
  const migrations = collectMigrations(migrationsDir);
  if (migrations.length === 0 && !afterApply) {
    return [];
  }

  return withMySqlMigrationLockAt(url, async (client) => {
    const applied = await applyPendingMySqlMigrations(client, migrations);
    await afterApply?.(applied);
    return applied;
  });
}
