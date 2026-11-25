import { tokenizeSql } from '@void/deploy-core';
import type { CustomTypesConfig } from 'pg';
import type { SqliteDatabase } from '../migrations/runner.ts';
import { skipMySqlQuoted } from '../runtime/db/migrations/mysql-sql.ts';

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
    // SQLite reads a `/*` that ends the input as a `/` and rejects it, so it stays in a statement.
    // Any other block comment, even one left open, is a comment.
    const bareOpen = segment.kind === 'block-comment' && segment.end - segment.start === 2;
    if (segment.kind === 'line-comment' || (segment.kind === 'block-comment' && !bareOpen)) {
      continue;
    }
    if (segment.kind !== 'sql') {
      advance(1, segment.start);
      continue;
    }
    const text = sql.slice(segment.start, segment.end);
    // SQLite's whitespace is these five characters, and a byte-order mark where a token would
    // start; anything else, such as a nonbreaking space, is part of a statement and fails there.
    // A byte-order mark inside a word is part of the word, as it is for SQLite.
    for (const match of text.matchAll(/;|[ \t\n\f\r\uFEFF]+|[\w$\u0080-￿]+|./gu)) {
      const [token] = match;
      if (token === ';') {
        advance(0, segment.start + match.index);
      } else if (!/^[ \t\n\f\r\uFEFF]/u.test(token)) {
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

/** What `JSON.rawJSON()` returns. `JSON.stringify` writes its text as it is. */
type RawJson = { readonly rawJSON: string };

/** JSON parsed with each number kept as its source text. */
type ExactJson =
  | string
  | boolean
  | null
  | RawJson
  | Array<ExactJson>
  | { [key: string]: ExactJson };

// Node 24 has both; TypeScript's libs do not declare them yet.
declare global {
  interface JSON {
    /** A reviver also receives a primitive's source text. */
    parse(
      text: string,
      reviver: (key: string, value: ExactJson | number, context: { source?: string }) => ExactJson,
    ): ExactJson;
    /** A value that `JSON.stringify` writes as `text`, which must be a JSON primitive. */
    rawJSON(text: string): RawJson;
  }
}

/** Parse JSON keeping each number's digits, which `JSON.stringify` then writes back unchanged. */
function parseExactJson(text: string): ExactJson {
  return JSON.parse(text, (_key, value: ExactJson | number, context: { source?: string }) =>
    typeof value === 'number' ? JSON.rawJSON(context.source ?? String(value)) : value,
  );
}

/** A PostgreSQL text array as node-postgres parses it: elements, `NULL`s and nested arrays. */
type PgTextArray = Array<string | null | PgTextArray>;
type PgJsonArray = Array<ExactJson | PgJsonArray>;

function parseExactJsonElements(values: PgTextArray): PgJsonArray {
  return values.map((value) =>
    Array.isArray(value)
      ? parseExactJsonElements(value)
      : value === null
        ? null
        : parseExactJson(value),
  );
}

// PostgreSQL type OIDs. pg's `TypeId` lists only the base types, not arrays.
const PG_TEXT_ARRAY = 1009;
const PG_NUMERIC_ARRAY = 1231;
const PG_JSON = 114;
const PG_JSONB = 3802;
const PG_JSON_ARRAY = 199;
const PG_JSONB_ARRAY = 3807;

/**
 * Type parsers for `void db execute --json` on PostgreSQL. node-postgres reads `numeric[]`
 * elements as numbers and JSON with `JSON.parse`, which round what a double cannot hold. Here a
 * `numeric[]` element stays a string, like a `numeric`, and a JSON number keeps its digits.
 */
export function pgJsonTypes(types: CustomTypesConfig): CustomTypesConfig {
  const parseTextArray = types.getTypeParser(PG_TEXT_ARRAY as CustomTypeId, 'text') as (
    value: string,
  ) => PgTextArray;
  const parsers = new Map<number, (value: string) => ExactJson | PgJsonArray | PgTextArray>([
    [PG_NUMERIC_ARRAY, parseTextArray],
    [PG_JSON, parseExactJson],
    [PG_JSONB, parseExactJson],
    [PG_JSON_ARRAY, (value) => parseExactJsonElements(parseTextArray(value))],
    [PG_JSONB_ARRAY, (value) => parseExactJsonElements(parseTextArray(value))],
  ]);
  return {
    getTypeParser(oid, format = 'text') {
      const parser = format === 'text' ? parsers.get(oid) : undefined;
      // oxlint-disable-next-line typescript/no-unsafe-return -- Other types keep node-postgres's own parsers.
      return parser ?? types.getTypeParser(oid, format);
    },
  };
}

type CustomTypeId = Parameters<CustomTypesConfig['getTypeParser']>[0];

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
 * How the server reads SQL. `version` is its version as MySQL writes it in a `/*!` comment
 * (80403 for 8.4.3), and `backslashEscapes` is false in `NO_BACKSLASH_ESCAPES` mode.
 */
export type MySqlServerMode = { version: number; backslashEscapes: boolean };

/** Reads what `mySqlServerMode()` needs. It only matters for SQL that `needsMySqlServerMode` finds. */
export const MYSQL_SERVER_MODE_QUERY =
  'SELECT @@SESSION.sql_mode AS sql_mode, VERSION() AS version';

/** Whether the SQL holds a backslash or a version comment, which read differently per server. */
export function needsMySqlServerMode(sql: string): boolean {
  return sql.includes('\\') || sql.includes('/*!');
}

/** Read the row `MYSQL_SERVER_MODE_QUERY` returns. */
export function mySqlServerMode(rows: unknown): MySqlServerMode {
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  const fields = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
  const modes = typeof fields.sql_mode === 'string' ? fields.sql_mode.split(',') : [];
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(String(fields.version ?? ''));
  return {
    // A server whose version does not read as one runs every version comment.
    version: version
      ? Number(version[1]) * 10_000 + Number(version[2]) * 100 + Number(version[3])
      : Number.POSITIVE_INFINITY,
    backslashEscapes: !modes.includes('NO_BACKSLASH_ESCAPES'),
  };
}

/** Whether the character after `--` (`NaN` at the end of the input) makes it a comment. */
function startsMySqlDashComment(code: number): boolean {
  // Whitespace or a control character, as MySQL's lexer checks.
  return Number.isNaN(code) || code <= 0x20 || code === 0x7f;
}

const MYSQL_DEFAULT_MODE: MySqlServerMode = {
  version: Number.POSITIVE_INFINITY,
  backslashEscapes: true,
};

/**
 * The words, semicolons and other characters of MySQL SQL, lowercased, outside comments, with
 * a quoted string or name as one empty word. The SQL in a `/*!` comment counts when the server
 * runs it: always without a version, else when the server is at least that version (six digits
 * when whitespace follows them, otherwise five).
 */
function* mySqlWords(sql: string, mode: MySqlServerMode): Generator<string> {
  const word = /[\w$\u0080-￿]+/uy;
  const versionDigits = /!(?:(\d{6})(?=\s)|(\d{5}))?/y;
  let index = 0;
  // Inside a `/*!` comment whose SQL the server runs, so its `*/` is skipped.
  let inVersionComment = false;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === "'" || character === '"' || character === '`') {
      index = skipMySqlQuoted(sql, index, character, mode.backslashEscapes);
      yield '';
    } else if (
      character === '#' ||
      // MySQL reads `--` as a comment only when whitespace or a control character, or the end of
      // the input, follows it.
      (character === '-' && next === '-' && startsMySqlDashComment(sql.charCodeAt(index + 2)))
    ) {
      const newline = sql.indexOf('\n', index);
      index = newline === -1 ? sql.length : newline;
    } else if (inVersionComment && character === '*' && next === '/') {
      inVersionComment = false;
      index += 2;
    } else if (character === '/' && next === '*') {
      versionDigits.lastIndex = index + 2;
      const version = sql[index + 2] === '!' ? versionDigits.exec(sql) : null;
      const required = version?.[1] ?? version?.[2];
      if (version && (required === undefined || Number(required) <= mode.version)) {
        inVersionComment = true;
        index = versionDigits.lastIndex;
      } else {
        // Any other comment, an optimizer hint (`/*+`) too, holds no statement.
        const close = sql.indexOf('*/', index + 2);
        index = close === -1 ? sql.length : close + 2;
      }
    } else if (/[ \t\n\v\f\r]/u.test(character)) {
      index++;
    } else {
      word.lastIndex = index;
      const match = word.exec(sql);
      const token = match ? match[0] : character;
      index += token.length;
      yield token.toLowerCase();
    }
  }
}

/**
 * Tell which MySQL statements are `CALL`s. Statements end at top-level semicolons; a stored
 * program body (`BEGIN ... END`) and a `CASE ... END` hold semicolons or an `END` of their own,
 * so they nest. `END IF`, `END LOOP`, `END WHILE` and `END REPEAT` close blocks that sit inside
 * a `BEGIN`, so they do not change the depth. A `BEGIN` that opens a top-level statement starts
 * a transaction, not a block.
 */
export function mySqlCallStatements(
  sql: string,
  mode: MySqlServerMode = MYSQL_DEFAULT_MODE,
): Array<boolean> {
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
  for (const word of mySqlWords(sql, mode)) {
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
  mode: MySqlServerMode = MYSQL_DEFAULT_MODE,
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
  for (const isCall of mySqlCallStatements(sql, mode)) {
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
