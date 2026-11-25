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

/** A value as JSON.stringify hands it to a replacer, after any `toJSON()`. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<JsonValue>
  | { [key: string]: JsonValue };

const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Write values JSON cannot hold as-is without changing them. `this[key]` is the value before
 * `toJSON()`, so a Buffer is still a Buffer here, at any depth (a `bytea[]` element too).
 */
function jsonValue(this: unknown, key: string, value: JsonValue): JsonValue {
  const raw = (this as Record<string, unknown>)[key];
  // Bytes print as byte arrays, the way D1 returns BLOBs.
  if (raw instanceof Uint8Array) {
    return Array.from(raw);
  }
  // An integer past 2^53 would round as a JSON number, so it prints as a string of its digits,
  // like mysql2's `supportBigNumbers`.
  if (typeof raw === 'bigint') {
    return raw >= MIN_SAFE && raw <= MAX_SAFE ? Number(raw) : raw.toString();
  }
  // JSON has no Infinity or NaN, and JSON.stringify would print them as null, which reads as
  // SQL NULL. PostgreSQL's own JSON functions write them as these strings.
  if (typeof raw === 'number' && !Number.isFinite(raw)) {
    return String(raw);
  }
  return value;
}

/** Serialize results for stdout. */
export function formatStatementResults(results: Array<StatementResult>): string {
  return JSON.stringify(results, jsonValue, 2);
}

type StatementRange = { start: number; end: number };

/**
 * Find each statement in SQLite SQL the way `sqlite3_complete()` does: a statement ends at a
 * top-level `;`, except that `CREATE [TEMP] TRIGGER` runs until `; END ;`, since its body holds
 * semicolons of its own. Ranges hold no statement when they are only whitespace and comments,
 * and those are left out. The last range may lack its `;`; SQLite decides whether it is complete.
 */
export function sqliteStatementRanges(sql: string): Array<StatementRange> {
  // States and transitions from SQLite's complete.c (whitespace and comments change nothing):
  // 0 nothing yet, 1 between statements, 2 a statement, 3 after EXPLAIN, 4 after CREATE [TEMP],
  // 5 a trigger, 6 a trigger after `;`, 7 a trigger after `; END`.
  // Token order: semicolon, other, EXPLAIN, CREATE, TEMP, TRIGGER, END.
  const START = 1;
  const transitions: Array<Array<number>> = [
    [1, 2, 3, 4, 2, 2, 2],
    [1, 2, 3, 4, 2, 2, 2],
    [1, 2, 2, 2, 2, 2, 2],
    [1, 3, 2, 4, 2, 2, 2],
    [1, 2, 2, 2, 4, 5, 2],
    [6, 5, 5, 5, 5, 5, 5],
    [6, 5, 5, 5, 5, 5, 7],
    [1, 5, 5, 5, 5, 5, 5],
  ];
  const keywords = new Map([
    ['explain', 2],
    ['create', 3],
    ['temp', 4],
    ['temporary', 4],
    ['trigger', 5],
    ['end', 6],
  ]);
  const ranges: Array<StatementRange> = [];
  let state = 0;
  let start = 0;
  let hasStatement = false;
  const advance = (token: number, index: number) => {
    const next = transitions[state][token];
    if (token === 0 && next === START) {
      if (hasStatement) {
        ranges.push({ start, end: index + 1 });
      }
      start = index + 1;
      hasStatement = false;
    } else if (token !== 0) {
      hasStatement = true;
    }
    state = next;
  };
  for (const segment of tokenizeSql(sql)) {
    if (segment.kind === 'line-comment' || segment.kind === 'block-comment') {
      continue;
    }
    if (segment.kind !== 'sql') {
      advance(1, segment.start);
      continue;
    }
    const text = sql.slice(segment.start, segment.end);
    for (const match of text.matchAll(/;|\s+|[\w$\u0080-￿]+|./gu)) {
      const [token] = match;
      if (token === ';') {
        advance(0, segment.start + match.index);
      } else if (!/^\s/u.test(token)) {
        advance(keywords.get(token.toLowerCase()) ?? 1, segment.start + match.index);
      }
    }
  }
  if (hasStatement) {
    ranges.push({ start, end: sql.length });
  }
  return ranges;
}

/** Split SQLite SQL into its statements. See `sqliteStatementRanges`. */
export function splitSqliteStatements(sql: string): Array<string> {
  return sqliteStatementRanges(sql).map(({ start, end }) => sql.slice(start, end));
}

/**
 * Run SQL statement by statement and keep each one's rows. Like `exec()`, every statement
 * commits on its own unless the SQL opens a transaction, and a failing statement stops the run
 * after the ones before it took effect. Integers are read exactly, as BigInt.
 */
export function runSqliteStatements(db: SqliteDatabase, sql: string): Array<StatementResult> {
  const counters = db
    .prepare<{ changes: bigint; last_row_id: bigint; total: bigint }>(
      'SELECT changes() AS changes, last_insert_rowid() AS last_row_id, total_changes() AS total',
    )
    .safeIntegers(true);
  // A scalar SELECT always returns one row.
  const readCounters = () => counters.get() ?? { changes: 0n, last_row_id: 0n, total: 0n };
  const results: Array<StatementResult> = [];
  for (const statementSql of splitSqliteStatements(sql)) {
    const statement = db.prepare<Record<string, unknown>>(statementSql).safeIntegers(true);
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
  return results;
}

type PgResult = {
  command?: string | null;
  rowCount?: number | null;
  rows?: Array<Record<string, unknown>>;
};

/**
 * node-postgres returns one result for one statement and an array for several. SQL without a
 * statement returns an empty-query result with no command, which is left out.
 */
export function pgStatementResults(result: PgResult | Array<PgResult>): Array<StatementResult> {
  return (Array.isArray(result) ? result : [result])
    .filter((item) => item.command !== null && item.command !== undefined)
    .map((item) => ({
      results: item.rows ?? [],
      success: true,
      meta: { command: item.command, rowCount: item.rowCount ?? null },
    }));
}

/** A write's result header. `insertId` is a string past 2^53 with `supportBigNumbers`. */
type MySqlHeaderMeta = { affectedRows: number | string; insertId: number | string };

function mySqlCount(field: unknown): number | string {
  return typeof field === 'number' || typeof field === 'string' ? field : 0;
}

function mySqlHeaderMeta(value: unknown): MySqlHeaderMeta {
  const header = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return { affectedRows: mySqlCount(header.affectedRows), insertId: mySqlCount(header.insertId) };
}

function mySqlStatementResult(value: unknown): StatementResult {
  return Array.isArray(value)
    ? { results: value as Array<Record<string, unknown>>, success: true, meta: {} }
    : { results: [], success: true, meta: mySqlHeaderMeta(value) };
}

/**
 * Tell which MySQL statements are `CALL`s. Statements end at top-level semicolons; a stored
 * program body (`BEGIN ... END`) and a `CASE ... END` hold semicolons or an `END` of their own,
 * so they nest. `END IF`, `END LOOP`, `END WHILE` and `END REPEAT` close blocks that sit inside
 * a `BEGIN`, so they do not change the depth. A `BEGIN` that opens a top-level statement starts
 * a transaction, not a block.
 */
export function mySqlCallStatements(sql: string): Array<boolean> {
  const calls: Array<boolean> = [];
  let depth = 0;
  let firstWord: string | undefined;
  // Set right after an END that closed a block, so a following IF, LOOP, WHILE, REPEAT or CASE
  // reads as part of that END.
  let afterEnd = false;
  const finish = () => {
    if (firstWord !== undefined) {
      calls.push(firstWord === 'call');
    }
    firstWord = undefined;
    afterEnd = false;
  };
  for (const segment of tokenizeSql(sql)) {
    if (segment.kind === 'line-comment' || segment.kind === 'block-comment') {
      continue;
    }
    if (segment.kind !== 'sql') {
      firstWord ??= '';
      afterEnd = false;
      continue;
    }
    const text = sql.slice(segment.start, segment.end);
    for (const [token] of text.matchAll(/;|\s+|[\w$\u0080-￿]+|./gu)) {
      if (/^\s/u.test(token)) {
        continue;
      }
      const word = token.toLowerCase();
      if (word === ';') {
        afterEnd = false;
        if (depth === 0) {
          finish();
        }
        continue;
      }
      const closedBlock = afterEnd;
      afterEnd = false;
      if (closedBlock && /^(?:if|loop|while|repeat)$/.test(word)) {
        // That END closed an IF or loop, which never opened a level, so restore it.
        depth++;
      } else if (closedBlock && word === 'case') {
        // END CASE closes the CASE that opened a level.
      } else if (word === 'case' || (word === 'begin' && (depth > 0 || firstWord !== undefined))) {
        depth++;
      } else if (word === 'end' && depth > 0) {
        depth--;
        afterEnd = true;
      }
      firstWord ??= word;
    }
  }
  finish();
  return calls;
}

/**
 * mysql2 returns `[rows, fields]`. With several result sets, `rows` holds one entry per result
 * (rows, or a result header for a write) and `fields` holds each one's column list, or
 * `undefined` for a header. A `CALL` returns each result set of the procedure and then its own
 * header, so those entries are grouped under the `CALL`, its rows in order.
 */
export function mySqlStatementResults(
  rows: unknown,
  fields: unknown,
  sql: string,
): Array<StatementResult> {
  const severalResults =
    Array.isArray(rows) &&
    Array.isArray(fields) &&
    fields.some((entry) => entry === undefined || Array.isArray(entry));
  if (!severalResults) {
    return [mySqlStatementResult(rows)];
  }
  const entries = rows as Array<unknown>;
  const grouped: Array<StatementResult> = [];
  let index = 0;
  let matched = true;
  for (const isCall of mySqlCallStatements(sql)) {
    if (!isCall) {
      matched &&= index < entries.length;
      grouped.push(mySqlStatementResult(entries[index++]));
      continue;
    }
    const sets: Array<Array<Record<string, unknown>>> = [];
    while (index < entries.length && Array.isArray(entries[index])) {
      sets.push(entries[index++] as Array<Record<string, unknown>>);
    }
    matched &&= index < entries.length;
    grouped.push({ results: sets.flat(), success: true, meta: mySqlHeaderMeta(entries[index++]) });
  }
  // When the statements and results do not line up (SQL this scan reads differently from
  // MySQL), print one entry per result rather than guess.
  return matched && index === entries.length ? grouped : entries.map(mySqlStatementResult);
}
