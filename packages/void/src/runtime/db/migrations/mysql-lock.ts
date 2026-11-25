import { createHash, randomUUID } from 'node:crypto';
import { isRecord } from '@void/deploy-core';

/**
 * Migration runs on one MySQL database exclude each other with two kinds of lock, and each run
 * checks for the other kind after it takes its own:
 *
 * - The CLI runner holds a named lock (GET_LOCK) for its session, so it ends with the connection.
 * - The hosted handler reaches MySQL through Hyperdrive, which pools connections per transaction,
 *   so a session lock could stay on a pooled connection or be reset away. It writes a lease row
 *   with an expiry instead, using one statement at a time. Lease times are UTC: NOW() follows
 *   each session's time zone and its DST changes, and DATETIME stores no zone.
 */

/** Hyperdrive ends a statement after 60 seconds, and the hosted handler renews before each one. */
const LEASE_SECONDS = 120;
/** A deploy waits long enough for the lease of a run that stopped early to expire. */
const DEPLOY_WAIT_MS = (LEASE_SECONDS + 10) * 1000;
const POLL_MS = 1000;
/** How often the lease is renewed while statements that cannot renew it themselves run. */
const KEEP_ALIVE_MS = 30_000;

/** Runs one statement and returns the rows or the result header. */
export type MySqlLeaseQuery = (sql: string, params?: Array<unknown>) => Promise<unknown>;

export type MySqlMigrationLease = {
  /** Extends the lease. Throws when it expired or another run took it. */
  renew(): Promise<void>;
  release(): Promise<void>;
};

/**
 * The CLI runner's named lock. Lock names are server-wide and at most 64 characters, so the name
 * carries a hash of the database name. Vitess reports a connection's target (`app@primary`,
 * `app:-80@replica`) in DATABASE(), and the lock belongs to the keyspace.
 */
export function mySqlMigrationLockName(database: string): string {
  return `void_migrations:${createHash('sha1').update(database.split(/[:@]/)[0]).digest('hex')}`;
}

export function mySqlMigrationLockError(database: string, retry: string): Error {
  return new Error(
    `Another migration run is applying migrations to MySQL database "${database}". Wait for it to finish, then ${retry}.`,
  );
}

/**
 * Seconds left on a deploy's lease, or undefined when no deploy holds one. The CLI runner calls
 * this while it holds the named lock.
 */
export async function readMySqlMigrationLease(query: MySqlLeaseQuery): Promise<number | undefined> {
  try {
    const row = firstRow(
      await query(
        "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(6), `expires_at`) AS remaining FROM `_void_migration_lock` WHERE `name` = 'app' AND `expires_at` > UTC_TIMESTAMP(6)",
      ),
    );
    return row ? readCount(row.remaining, 'remaining lease time') : undefined;
  } catch (error) {
    if (isMissingTable(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Takes the lease for a hosted run. It waits while another deploy holds the lease or a CLI run
 * holds the named lock, and throws when that takes too long.
 */
export async function acquireMySqlMigrationLease(
  query: MySqlLeaseQuery,
): Promise<MySqlMigrationLease> {
  const databaseName = firstRow(await query('SELECT DATABASE() AS db'))?.db;
  if (databaseName !== null && typeof databaseName !== 'string') {
    throw new Error('Invalid database name in MySQL migration lock response');
  }
  const database = databaseName ?? '';
  const lockName = mySqlMigrationLockName(database);
  const owner = randomUUID();
  await query(
    'CREATE TABLE IF NOT EXISTS `_void_migration_lock` (`name` VARCHAR(64) NOT NULL PRIMARY KEY, `owner` VARCHAR(64) NOT NULL, `expires_at` DATETIME(6) NOT NULL)',
  );

  const lease: MySqlMigrationLease = {
    async renew() {
      const result = await query(
        "UPDATE `_void_migration_lock` SET `expires_at` = UTC_TIMESTAMP(6) + INTERVAL ? SECOND WHERE `name` = 'app' AND `owner` = ? AND `expires_at` > UTC_TIMESTAMP(6)",
        [LEASE_SECONDS, owner],
      );
      if (affectedRows(result) !== 1) {
        throw new Error(
          `The migration lock on MySQL database "${database}" expired before this run finished. Deploy again.`,
        );
      }
    },
    // Expires the row instead of deleting it. When a delete meets two waiting inserts of the same
    // key, InnoDB ends one of them with a deadlock.
    async release() {
      await query(
        "UPDATE `_void_migration_lock` SET `expires_at` = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE `name` = 'app' AND `owner` = ?",
        [owner],
      );
    },
  };

  const deadline = Date.now() + DEPLOY_WAIT_MS;
  try {
    for (;;) {
      if (await take(query, owner)) {
        // Taken before this check, so a CLI run that starts later sees the lease and stops.
        if (await isNamedLockFree(query, lockName)) {
          return lease;
        }
        await lease.release();
      }
      if (Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, POLL_MS);
      });
    }
  } catch (error) {
    // A lease write can succeed even when its result cannot be read.
    await lease.release().catch(() => {});
    throw error;
  }
  throw mySqlMigrationLockError(database, 'deploy again');
}

/**
 * Runs `work`, whose statements cannot renew the lease before each one (Better Auth's migrations),
 * and renews the lease in the background meanwhile. Throws after `work` when a renewal failed,
 * because another run may have taken the lease.
 */
export async function holdMySqlMigrationLease<T>(
  lease: MySqlMigrationLease,
  work: () => Promise<T>,
): Promise<T> {
  await lease.renew();
  let failure: { error: unknown } | undefined;
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal
      .then(() => lease.renew())
      .catch((error: unknown) => {
        failure ??= { error };
      });
  }, KEEP_ALIVE_MS);
  let result: T;
  try {
    result = await work();
  } finally {
    clearInterval(timer);
    await renewal;
  }
  if (failure) {
    throw failure.error;
  }
  return result;
}

async function take(query: MySqlLeaseQuery, owner: string): Promise<boolean> {
  try {
    return await tryTake(query, owner);
  } catch (error) {
    // MySQL rolled the statement back as a deadlock victim, so the lease is not taken: poll again.
    if (isRecord(error) && error.errno === 1213) {
      return false;
    }
    throw error;
  }
}

async function tryTake(query: MySqlLeaseQuery, owner: string): Promise<boolean> {
  const inserted = await query(
    "INSERT IGNORE INTO `_void_migration_lock` (`name`, `owner`, `expires_at`) VALUES ('app', ?, UTC_TIMESTAMP(6) + INTERVAL ? SECOND)",
    [owner, LEASE_SECONDS],
  );
  if (affectedRows(inserted) === 1) {
    return true;
  }
  // The lease of a run that stopped early.
  const taken = await query(
    "UPDATE `_void_migration_lock` SET `owner` = ?, `expires_at` = UTC_TIMESTAMP(6) + INTERVAL ? SECOND WHERE `name` = 'app' AND `expires_at` < UTC_TIMESTAMP(6)",
    [owner, LEASE_SECONDS],
  );
  return affectedRows(taken) === 1;
}

async function isNamedLockFree(query: MySqlLeaseQuery, lockName: string): Promise<boolean> {
  const row = firstRow(await query('SELECT IS_USED_LOCK(?)', [lockName]));
  // Vitess names the column after the call and ignores any alias.
  const columns = row ? Object.values(row) : [];
  const holder = columns.length === 1 ? columns[0] : undefined;
  if (holder === null) {
    return true;
  }
  readCount(holder, 'named lock holder');
  return false;
}

function firstRow(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result)) {
    if (result.length === 0) {
      return undefined;
    }
    const row: unknown = result[0];
    if (isRecord(row)) {
      return row;
    }
  }
  throw new Error('Invalid result rows in MySQL migration lock response');
}

function readCount(value: unknown, field: string): number {
  const count =
    typeof value === 'bigint' || (typeof value === 'string' && /^\d+$/.test(value))
      ? Number(value)
      : value;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid ${field} in MySQL migration lock response`);
  }
  return count;
}

function affectedRows(result: unknown): number {
  return readCount(isRecord(result) ? result.affectedRows : undefined, 'affected row count');
}

function isMissingTable(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ER_NO_SUCH_TABLE' || error.errno === 1146);
}
