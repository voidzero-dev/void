import { tokenizeSql } from '@void/deploy-core';
import type { SqliteDatabase } from '../migrations/runner.ts';

/**
 * One statement's outcome for `void db execute --json`. The shape follows D1's result
 * objects, which `wrangler d1 execute --json` also prints, so a script can read either tool.
 */
export type StatementResult = {
  results: Array<Record<string, unknown>>;
  success: boolean;
  meta: Record<string, unknown>;
};

/** Serialize results for stdout. Binary values print as byte arrays, the way D1 returns BLOBs. */
export function formatStatementResults(results: Array<StatementResult>): string {
  return JSON.stringify(
    results.map((result) => ({
      ...result,
      results: result.results.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([column, value]) => [
            column,
            value instanceof Uint8Array ? Array.from(value) : value,
          ]),
        ),
      ),
    })),
    null,
    2,
  );
}

/**
 * Cut SQL after each `;` outside literals and comments. A trigger's `BEGIN ... END` body holds
 * semicolons of its own, so a piece can end inside a statement; the caller joins pieces until
 * SQLite accepts them.
 */
function* sqlPieces(sql: string): Generator<string> {
  let start = 0;
  for (const segment of tokenizeSql(sql)) {
    if (segment.kind !== 'sql') {
      continue;
    }
    for (let index = segment.start; index < segment.end; index++) {
      if (sql[index] === ';') {
        yield sql.slice(start, index + 1);
        start = index + 1;
      }
    }
  }
  yield sql.slice(start);
}

function isIncompleteInput(error: unknown): boolean {
  return error instanceof Error && error.message === 'incomplete input';
}

/**
 * Run SQL statement by statement and keep each one's rows. Like `exec()`, every statement
 * commits on its own unless the SQL opens a transaction, and a failing statement stops the run
 * after the ones before it took effect.
 *
 * SQLite decides where a statement ends: a piece it reports as incomplete input continues
 * into the next one. better-sqlite3 refuses SQL without a statement (whitespace or comments
 * only) with a `RangeError`, and that piece is skipped.
 */
export function runSqliteStatements(db: SqliteDatabase, sql: string): Array<StatementResult> {
  const counters = db.prepare<{ changes: number; last_row_id: number; total: number }>(
    'SELECT changes() AS changes, last_insert_rowid() AS last_row_id, total_changes() AS total',
  );
  // A scalar SELECT always returns one row.
  const readCounters = () => counters.get() ?? { changes: 0, last_row_id: 0, total: 0 };
  const results: Array<StatementResult> = [];
  let pending = '';
  for (const piece of sqlPieces(sql)) {
    pending += piece;
    let statement;
    try {
      statement = db.prepare<Record<string, unknown>>(pending);
    } catch (error) {
      if (isIncompleteInput(error)) {
        continue;
      }
      if (error instanceof RangeError) {
        pending = '';
        continue;
      }
      throw error;
    }
    pending = '';
    const before = readCounters().total;
    const started = performance.now();
    let rows: Array<Record<string, unknown>> = [];
    if (statement.reader) {
      rows = statement.all();
    } else {
      statement.run();
    }
    const duration = performance.now() - started;
    const after = readCounters();
    results.push({
      results: rows,
      success: true,
      meta: {
        // `changes()` keeps the last write's count, so a statement that wrote nothing reports 0.
        changes: after.total === before ? 0 : after.changes,
        last_row_id: after.last_row_id,
        duration,
      },
    });
  }
  if (pending.trim()) {
    // SQL that ends inside a statement: let SQLite report the incomplete input.
    db.prepare(pending);
  }
  return results;
}

type PgResult = {
  command?: string | null;
  rowCount?: number | null;
  rows?: Array<Record<string, unknown>>;
};

/** node-postgres returns one result for one statement and an array for several. */
export function pgStatementResults(result: PgResult | Array<PgResult>): Array<StatementResult> {
  return (Array.isArray(result) ? result : [result]).map((item) => ({
    results: item.rows ?? [],
    success: true,
    meta: { command: item.command ?? null, rowCount: item.rowCount ?? null },
  }));
}

function mySqlStatementResult(value: unknown): StatementResult {
  if (Array.isArray(value)) {
    return { results: value as Array<Record<string, unknown>>, success: true, meta: {} };
  }
  const header = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    results: [],
    success: true,
    meta: { affectedRows: header.affectedRows ?? 0, insertId: header.insertId ?? 0 },
  };
}

/**
 * mysql2 returns `[rows, fields]`. With several statements, `rows` holds one entry per
 * statement (rows, or a result header for a write), and `fields` holds each statement's
 * column list, or `undefined` for a write. One statement's `fields` lists column objects.
 */
export function mySqlStatementResults(rows: unknown, fields: unknown): Array<StatementResult> {
  const severalStatements =
    Array.isArray(rows) &&
    Array.isArray(fields) &&
    fields.some((entry) => entry === undefined || Array.isArray(entry));
  return severalStatements
    ? (rows as Array<unknown>).map(mySqlStatementResult)
    : [mySqlStatementResult(rows)];
}
