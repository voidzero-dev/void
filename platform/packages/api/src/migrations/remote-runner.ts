import { tokenizeSql } from '@void/deploy-core';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

export type RemoteMigration = Readonly<{
  name: string;
  sql: string;
}>;

export type MigrationFailure = Readonly<{
  name: string;
  error: string;
}>;

export type MigrationResult = {
  applied: Array<string>;
  skipped: Array<string>;
  /**
   * If a migration mid-batch fails with a hard D1 / SQL error, the runner
   * records the failure here and stops. The runner does NOT throw for
   * per-migration errors — it returns the partial progress instead so the
   * caller can persist the confirmed-landed subset to pg metadata before
   * surfacing the error. Throwing would discard the committed prefix
   * because the /apply handler runs inside a pg transaction that rolls
   * back on any thrown error, leaving pg missing rows that D1's
   * `_void_migrations` already contains and poisoning subsequent rollback
   * diffs + rename corroboration.
   *
   * Undefined on success. Non-undefined means the batch stopped at this
   * migration and the caller should treat the request as failed (500).
   */
  failed?: MigrationFailure;
};

/**
 * One-time migration: rename legacy `_migrations` table to `_void_migrations`.
 * Copies all rows from the old table to the new one, then drops the old table.
 */
async function upgradeTrackingTable(
  accountId: string,
  apiToken: string,
  databaseId: string,
): Promise<void> {
  const result = await queryD1(accountId, apiToken, databaseId, {
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'",
  });
  if (!result.results || result.results.length === 0) {
    return;
  }
  // INSERT must succeed — propagate failures so the applied set is complete.
  // The one tolerated failure is a concurrent upgrade race: two overlapping
  // ensureTrackingTable() callers both pass the sqlite_master probe above, the
  // winner completes the copy and the DROP, and the loser's INSERT then hits
  // `no such table: _migrations` because the winner already dropped it. That
  // is a benign interleaving — the rows were copied successfully by the
  // winner — so swallow exactly that error text and continue. Any other
  // failure (auth, quota, schema mismatch on `_void_migrations`) still
  // propagates.
  try {
    await queryD1(accountId, apiToken, databaseId, {
      sql: `INSERT OR IGNORE INTO _void_migrations (name, applied_at) SELECT name, applied_at FROM _migrations`,
    });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (!/no such table/i.test(msg)) {
      throw err;
    }
  }
  // DROP can fail if a concurrent caller already dropped the table — safe to ignore.
  try {
    await queryD1(accountId, apiToken, databaseId, {
      sql: `DROP TABLE _migrations`,
    });
  } catch {
    // Concurrent upgrade already dropped the table
  }
}

/**
 * Ensure _void_migrations table exists and upgrade legacy _migrations if present.
 * Returns the set of already-applied migration names.
 */
export async function ensureTrackingTable(
  accountId: string,
  apiToken: string,
  databaseId: string,
): Promise<Set<string>> {
  await queryD1(accountId, apiToken, databaseId, {
    sql: `CREATE TABLE IF NOT EXISTS _void_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  });
  await upgradeTrackingTable(accountId, apiToken, databaseId);
  const appliedResult = await queryD1(accountId, apiToken, databaseId, {
    sql: 'SELECT name FROM _void_migrations',
  });
  return new Set(appliedResult.results.map((row) => row.name as string));
}

export async function runRemoteMigrations(
  accountId: string,
  apiToken: string,
  databaseId: string,
  migrations: ReadonlyArray<RemoteMigration>,
  appliedSet?: Set<string>,
): Promise<MigrationResult> {
  const applied = appliedSet ?? (await ensureTrackingTable(accountId, apiToken, databaseId));
  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      result.skipped.push(migration.name);
      continue;
    }
    if (
      Array.from(tokenizeSql(migration.sql)).some(
        (segment) =>
          segment.kind === 'block-comment' &&
          !migration.sql.slice(segment.start, segment.end).endsWith('*/'),
      )
    ) {
      result.failed = { name: migration.name, error: 'Unterminated SQL block comment' };
      return result;
    }
    // Like Wrangler's migration runner, submit SQL and its tracking INSERT
    // together to D1's transactional query batch. A plain INSERT makes a
    // stale applied-set retry roll back its SQL on the unique-name conflict.
    // The newline also terminates any trailing line comment in user SQL.
    const name = migration.name.replaceAll("'", "''");
    const sql =
      migration.sql +
      "\n;\nINSERT INTO _void_migrations (name, applied_at) VALUES ('" +
      name +
      "', '" +
      new Date().toISOString() +
      "');";
    try {
      await queryD1(accountId, apiToken, databaseId, { sql });
    } catch (error) {
      // A lost response or a concurrent winner is successful only if D1
      // recorded the migration. Never infer success from an existing object.
      try {
        const tracked = await queryD1(accountId, apiToken, databaseId, {
          sql: 'SELECT name FROM _void_migrations WHERE name = ?',
          params: [migration.name],
        });
        if (tracked.results.length > 0) {
          applied.add(migration.name);
          result.skipped.push(migration.name);
          continue;
        }
      } catch {
        // Preserve the original error if reconciliation is unavailable.
      }
      // Return the committed prefix so the caller can persist its metadata
      // before surfacing failure, rather than rolling back its pg transaction.
      result.failed = { name: migration.name, error: String((error as Error)?.message ?? error) };
      return result;
    }
    applied.add(migration.name);
    result.applied.push(migration.name);
  }
  return result;
}

type D1Query = Readonly<{
  sql: string;
  params?: ReadonlyArray<unknown>;
}>;

/**
 * D1 REST query response shape. When present, `meta.changes` reports rows
 * affected by an UPDATE / DELETE / INSERT — the rename endpoint uses this
 * to detect concurrent-rename conflicts where the winner already renamed
 * the row out from under us and our own UPDATE was a no-op.
 */
type D1QueryResponseMeta = Readonly<{
  changes?: number;
  rows_written?: number;
  rows_read?: number;
  [key: string]: unknown;
}>;

type D1QueryResponse = Readonly<{
  results: ReadonlyArray<Record<string, unknown>>;
  meta?: D1QueryResponseMeta;
}>;

export const D1_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Upper bound on a single D1 REST call. Without this, a hung upstream request
 * (outage, partition, TCP black hole) would hold the rename/apply/rollback
 * row lock for the duration of the pending fetch — minutes or until TCP
 * RST — and every other migration request on the same project would pile up
 * on the same lock, burning pg pool connections. Aborting fast with a clear
 * error lets the transaction unwind and releases the lock.
 *
 * The timer MUST remain active until `response.json()` completes.
 * `fetch()` resolves on HEADERS, not full body, so clearing the timeout at
 * header receipt leaves the body parse unguarded. A D1 that sends headers
 * and then stalls the chunked body (or sends a truncated stream) would make
 * `response.json()` hang forever, holding the row lock and pg pool connection
 * for the duration. Keeping the controller active across the parse lets
 * abort propagate into the body stream and reject `json()`.
 */
export async function queryD1(
  accountId: string,
  apiToken: string,
  databaseId: string,
  query: D1Query,
  timeoutMs: number = D1_REQUEST_TIMEOUT_MS,
): Promise<D1QueryResponse> {
  const url = `${CF_API_BASE}/${accountId}/d1/database/${databaseId}/query`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let json: {
    success: boolean;
    errors: ReadonlyArray<{ code: number; message: string }>;
    result: ReadonlyArray<D1QueryResponse & { success?: boolean; error?: string }>;
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(query),
      signal: controller.signal,
    });
    json = (await response.json()) as typeof json;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const preview = query.sql.length > 80 ? `${query.sql.slice(0, 80)}…` : query.sql;
      // oxlint-disable-next-line preserve-caught-error -- Report the timeout without attaching an unsanitized provider or request error.
      throw new Error(`D1 request timed out after ${timeoutMs}ms (${preview})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!json.success) {
    const message = json.errors.map((error) => error.message).join(', ');
    throw new Error(`D1 migration failed: ${message}`);
  }

  const failed = json.result.find((entry) => entry.success === false);
  if (failed) {
    throw new Error('D1 migration failed: ' + (failed.error ?? 'statement failed'));
  }

  // D1 query API returns an array of results (one per statement).
  const first = json.result[0];
  if (!first) {
    return { results: [] };
  }
  return { results: first.results ?? [], meta: first.meta };
}
