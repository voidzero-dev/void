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
 * How the server reads SQL. `version` is its version as a `/*!` comment writes it (80403 for
 * 8.4.3), `backslashEscapes` is false in `NO_BACKSLASH_ESCAPES` mode, `ansiQuotes` is true in
 * `ANSI_QUOTES` mode, and `mariaDb` tells MariaDB, which reads executable comments its own way.
 */
export type MySqlServerMode = {
  version: number;
  backslashEscapes: boolean;
  ansiQuotes: boolean;
  mariaDb: boolean;
};

/** Reads what `mySqlServerMode()` needs. It only matters for SQL that `needsMySqlServerMode` finds. */
export const MYSQL_SERVER_MODE_QUERY =
  'SELECT @@SESSION.sql_mode AS sql_mode, VERSION() AS version';

/**
 * Whether the SQL holds a backslash or an executable comment, which read differently per
 * server. Without a backslash, `ANSI_QUOTES` changes what a double-quoted text is but not
 * where it ends.
 */
export function needsMySqlServerMode(sql: string): boolean {
  return sql.includes('\\') || /\/\*M?!/u.test(sql);
}

/** Read the row `MYSQL_SERVER_MODE_QUERY` returns. */
export function mySqlServerMode(rows: unknown): MySqlServerMode {
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  const fields = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
  const modes = typeof fields.sql_mode === 'string' ? fields.sql_mode.split(',') : [];
  const versionText = String(fields.version ?? '');
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(versionText);
  return {
    // A server whose version does not read as one runs every version comment.
    version: version
      ? Number(version[1]) * 10_000 + Number(version[2]) * 100 + Number(version[3])
      : Number.POSITIVE_INFINITY,
    backslashEscapes: !modes.includes('NO_BACKSLASH_ESCAPES'),
    ansiQuotes: modes.includes('ANSI_QUOTES'),
    mariaDb: /mariadb/iu.test(versionText),
  };
}

/** Whether the character after `--` (`NaN` at the end of the input) makes it a comment. */
function startsMySqlDashComment(code: number): boolean {
  // Whitespace or a control character, as MySQL's lexer checks.
  return Number.isNaN(code) || code <= 0x20 || code === 0x7f;
}

/**
 * The index after the comment whose text starts at `index`. A skipped version comment may hold
 * one nested comment (`nesting` 1); any other comment ends at its first closing marker.
 */
function skipMySqlComment(sql: string, index: number, nesting: number): number {
  while (index < sql.length) {
    const character = sql[index++];
    if (nesting > 0 && character === '/' && sql[index] === '*') {
      index = skipMySqlComment(sql, index + 1, nesting - 1);
    } else if (character === '*' && sql[index] === '/') {
      return index + 1;
    }
  }
  return sql.length;
}

// After `/*`: MySQL reads six digits as a version when whitespace follows them, otherwise five.
// MariaDB reads six when a sixth digit follows, and its own `/*M!` comments too.
const MYSQL_VERSION_COMMENT = /!(?:(\d{6})(?=\s)|(\d{5}))?/y;
const MARIADB_VERSION_COMMENT = /(M?)!(?:(\d{6})|(\d{5}))?/y;

/** The index after the marker of an executable comment the server runs at `index`, if any. */
function runsMySqlComment(sql: string, index: number, mode: MySqlServerMode): number | undefined {
  const marker = mode.mariaDb ? MARIADB_VERSION_COMMENT : MYSQL_VERSION_COMMENT;
  marker.lastIndex = index;
  const match = marker.exec(sql);
  if (!match) {
    return undefined;
  }
  const digits = mode.mariaDb ? (match[2] ?? match[3]) : (match[1] ?? match[2]);
  if (digits === undefined) {
    return marker.lastIndex;
  }
  const required = Number(digits);
  // MariaDB skips `/*!` comments for MySQL 5.7 and later (50700 to 99999), not its own `/*M!`.
  const mySqlOnly = mode.mariaDb && match[1] !== 'M' && required >= 50_700 && required <= 99_999;
  return required <= mode.version && !mySqlOnly ? marker.lastIndex : undefined;
}

const MYSQL_DEFAULT_MODE: MySqlServerMode = {
  version: Number.POSITIVE_INFINITY,
  backslashEscapes: true,
  ansiQuotes: false,
  mariaDb: false,
};

/** Where `readMySqlWord` reads next, and whether that is in an executable comment that runs. */
type MySqlLexer = { index: number; inVersionComment: boolean };

const MYSQL_WORD = /[\w$\u0080-￿]+/uy;

/**
 * The next word, semicolon or other character of MySQL SQL after any whitespace and comments,
 * lowercased, or `undefined` at the end. A quoted string or name is one word, as written with
 * its quotes. The SQL in an executable comment (`/*!`, and `/*M!` on MariaDB) counts when the
 * server runs it.
 */
function readMySqlWord(sql: string, lexer: MySqlLexer, mode: MySqlServerMode): string | undefined {
  while (lexer.index < sql.length) {
    const index = lexer.index;
    const character = sql[index];
    const next = sql[index + 1];
    if (character === "'" || character === '"' || character === '`') {
      // A backslash escapes nothing in a quoted name, `ANSI_QUOTES` double quotes included.
      const name = character === '`' || (character === '"' && mode.ansiQuotes);
      lexer.index = skipMySqlQuoted(sql, index, character, mode.backslashEscapes && !name);
      return sql.slice(index, lexer.index);
    }
    if (
      character === '#' ||
      // MySQL reads `--` as a comment only when whitespace or a control character, or the end of
      // the input, follows it.
      (character === '-' && next === '-' && startsMySqlDashComment(sql.charCodeAt(index + 2)))
    ) {
      const newline = sql.indexOf('\n', index);
      lexer.index = newline === -1 ? sql.length : newline;
    } else if (lexer.inVersionComment && character === '*' && next === '/') {
      lexer.inVersionComment = false;
      lexer.index += 2;
    } else if (character === '/' && next === '*') {
      const executable = /^M?!/u.test(sql.slice(index + 2, index + 4));
      const runsFrom = executable ? runsMySqlComment(sql, index + 2, mode) : undefined;
      if (runsFrom !== undefined) {
        lexer.inVersionComment = true;
        lexer.index = runsFrom;
      } else {
        // Any other comment, an optimizer hint (`/*+`) too, holds no statement. One the server
        // skips for its version may nest a comment.
        lexer.index = skipMySqlComment(sql, index + 2, executable ? 1 : 0);
      }
    } else if (/[ \t\n\v\f\r]/u.test(character)) {
      lexer.index++;
    } else {
      MYSQL_WORD.lastIndex = index;
      const token = MYSQL_WORD.exec(sql)?.[0] ?? character;
      lexer.index += token.length;
      return token.toLowerCase();
    }
  }
  return undefined;
}

// The object a CREATE or ALTER statement names, which tells a stored program from other DDL.
const MYSQL_STORED_PROGRAMS = new Set(['procedure', 'function', 'trigger', 'event']);
const MYSQL_OTHER_OBJECTS = new Set([
  'database',
  'fulltext',
  'index',
  'instance',
  'logfile',
  'resource',
  'role',
  'schema',
  'sequence',
  'server',
  'spatial',
  'table',
  'tablespace',
  'temporary',
  'undo',
  'unique',
  'user',
  'view',
]);

/** How a server's quoting rules stand after a statement changes its `sql_mode`. */
type MySqlQuoting = Pick<MySqlServerMode, 'backslashEscapes' | 'ansiQuotes'>;

// The modes that turn on ANSI_QUOTES: itself, and the combination modes that include it.
const MYSQL_ANSI_QUOTES_MODES = new Set([
  'ANSI',
  'ANSI_QUOTES',
  'DB2',
  'MAXDB',
  'MSSQL',
  'ORACLE',
  'POSTGRESQL',
]);
const MYSQL_GLOBAL_SCOPES = new Set(['global', 'persist', 'persist_only']);
const MYSQL_SESSION_SCOPES = new Set(['session', 'local']);

/** The name a word in a SET statement gives, unquoted and lowercased. */
function mySqlName(word: string | undefined, mode: MySqlServerMode): string | undefined {
  const quote = word?.[0];
  if (word !== undefined && (quote === '`' || (quote === '"' && mode.ansiQuotes))) {
    return word.slice(1, -1).replaceAll(`${quote}${quote}`, quote).toLowerCase();
  }
  return word;
}

/** The quoting rules a quoted list of modes, such as `'ANSI,NO_BACKSLASH_ESCAPES'`, sets. */
function mySqlModeList(value: Array<string>, mode: MySqlServerMode): MySqlQuoting | 'unclear' {
  const [word] = value;
  const quote = word?.[0];
  const string = quote === "'" || (quote === '"' && !mode.ansiQuotes);
  if (value.length !== 1 || !string || word.length < 2 || !word.endsWith(quote)) {
    return 'unclear';
  }
  const text = word.slice(1, -1);
  // Mode names hold only letters and underscores. Anything else (an escape, a quote, a space)
  // is read here as unclear rather than guessed.
  if (!/^[A-Za-z_,]*$/u.test(text)) {
    return 'unclear';
  }
  const modes = text.toUpperCase().split(',');
  return {
    backslashEscapes: !modes.includes('NO_BACKSLASH_ESCAPES'),
    ansiQuotes: modes.some((name) => MYSQL_ANSI_QUOTES_MODES.has(name)),
  };
}

/** Split words at top-level commas, or at the first top-level word `at` when one is given. */
function splitMySqlWords(words: Array<string>, at = ','): Array<Array<string>> {
  let current: Array<string> = [];
  const parts = [current];
  let parentheses = 0;
  for (const word of words) {
    if (word === at && parentheses === 0 && (at === ',' || parts.length === 1)) {
      current = [];
      parts.push(current);
      continue;
    }
    if (word === '(') {
      parentheses++;
    } else if (word === ')') {
      parentheses--;
    }
    current.push(word);
  }
  return parts;
}

/**
 * How a top-level statement changes the session's quoting rules: not at all (`undefined`), to
 * the rules a quoted list of modes sets, or in a way this scan cannot read (`'unclear'`), such
 * as `SET sql_mode = @saved` or a prepared statement's `EXECUTE`. A stored program, and a
 * MariaDB `BEGIN NOT ATOMIC` block, run with a `sql_mode` of their own and restore the
 * session's, and `SET GLOBAL` leaves it alone.
 */
function mySqlModeChange(
  words: Array<string>,
  mode: MySqlServerMode,
): MySqlQuoting | 'unclear' | undefined {
  const [first] = words;
  // A prepared statement, or MariaDB's EXECUTE IMMEDIATE, may set sql_mode.
  if (first === 'execute') {
    return 'unclear';
  }
  if (first !== 'set') {
    return undefined;
  }
  if (words[1] === 'statement') {
    // MariaDB's SET STATEMENT ... FOR keeps what the statement after FOR changes, unless it
    // sets sql_mode itself, which it then restores.
    const [settings, statement] = splitMySqlWords(words.slice(2), 'for');
    const restores = settings.some((word) => mySqlName(word, mode) === 'sql_mode');
    return statement === undefined || restores ? undefined : mySqlModeChange(statement, mode);
  }
  const assignments = splitMySqlWords(words.slice(1));
  let change: MySqlQuoting | 'unclear' | undefined;
  // A GLOBAL or SESSION before an assignment holds for the ones after it.
  let global = false;
  for (const assignment of assignments) {
    let index = 0;
    if (MYSQL_GLOBAL_SCOPES.has(assignment[index])) {
      global = true;
      index++;
    } else if (MYSQL_SESSION_SCOPES.has(assignment[index])) {
      global = false;
      index++;
    }
    let targetsGlobal = global;
    if (assignment[index] === '@') {
      // `@name` is a user variable.
      if (assignment[index + 1] !== '@') {
        continue;
      }
      index += 2;
      // `@@name` is the session's variable, and `@@scope.name` the scope's.
      targetsGlobal = false;
      if (assignment[index + 1] === '.') {
        targetsGlobal = MYSQL_GLOBAL_SCOPES.has(assignment[index]);
        index += 2;
      }
    }
    if (targetsGlobal || mySqlName(assignment[index], mode) !== 'sql_mode') {
      continue;
    }
    index++;
    if (assignment[index] === ':') {
      index++;
    }
    change =
      assignment[index] === '='
        ? mySqlModeList(assignment.slice(index + 1), mode)
        : // Not an assignment MySQL accepts, so the statement fails.
          'unclear';
  }
  return change;
}

/**
 * The statements of MySQL SQL, in order: `calls` tells which ones are `CALL`s. When `uncounted`
 * is true, more statements follow them, none of them a `CALL`, which this scan cannot count.
 */
export type MySqlStatements = { calls: Array<boolean>; uncounted: boolean };

/**
 * Find MySQL's statements and tell which are `CALL`s, reading the SQL the way a server in
 * `mode` does. Statements end at top-level semicolons. In a stored program (`CREATE PROCEDURE`,
 * `FUNCTION`, `TRIGGER` or `EVENT`, and `ALTER EVENT`), a `BEGIN ... END` body holds semicolons
 * of its own, so it nests, as does MariaDB's `BEGIN NOT ATOMIC` block. Elsewhere `BEGIN` starts a
 * transaction or is a name. A `CASE ... END` nests anywhere. `END IF`, `END LOOP`, `END WHILE`
 * and `END REPEAT` close blocks that sit inside a `BEGIN`, so they do not change the depth. After
 * a dot, each of these words is a name, such as the column in `t.case`.
 *
 * The server reads each statement with the `sql_mode` the statements before it left, so a
 * `SET sql_mode` to a quoted list of modes changes how the SQL after it reads. After a statement
 * that changes it in a way this scan cannot read, the SQL reads the same until a quoted string
 * or name holds a backslash. From there on, the statements are `uncounted` when none of them can be a `CALL`,
 * and otherwise this throws before the SQL runs, since their results could not be grouped.
 */
export function mySqlStatements(
  sql: string,
  initialMode: MySqlServerMode = MYSQL_DEFAULT_MODE,
): MySqlStatements {
  let mode = initialMode;
  const lexer: MySqlLexer = { index: 0, inVersionComment: false };
  const calls: Array<boolean> = [];
  let depth = 0;
  // The current statement's words, and where it starts.
  let words: Array<string> = [];
  let start = 0;
  // Whether this statement creates a stored program, once its CREATE or ALTER names the object.
  let storedProgram: boolean | undefined;
  // Set right after an END that closed a block, so a following IF, LOOP, WHILE, REPEAT or CASE
  // reads as part of that END.
  let afterEnd = false;
  // Whether a statement changed sql_mode in a way this scan cannot read. Until a quoted string
  // or name holds a backslash, every mode reads the SQL after it the same way.
  let unclear = false;
  const finish = () => {
    if (words.length > 0) {
      calls.push(words[0] === 'call');
      const change = mySqlModeChange(words, mode);
      if (change === 'unclear') {
        unclear = true;
      } else if (change !== undefined) {
        mode = { ...mode, ...change };
        unclear = false;
      }
    }
    words = [];
    start = lexer.index;
    storedProgram = undefined;
    afterEnd = false;
  };
  // Whether the BEGIN just read opens MariaDB's BEGIN NOT ATOMIC block, read without moving on.
  const opensBlock = () => {
    const ahead = { ...lexer };
    return (
      readMySqlWord(sql, ahead, mode) === 'not' && readMySqlWord(sql, ahead, mode) === 'atomic'
    );
  };
  for (
    let word = readMySqlWord(sql, lexer, mode);
    word !== undefined;
    word = readMySqlWord(sql, lexer, mode)
  ) {
    if (unclear && word.includes('\\')) {
      // `CALL` is a word of its own, so SQL without it holds none. A digit may come before it,
      // as in `/*!80000CALL`.
      if (/(?<![A-Za-z_$\u0080-\uFFFF])call(?![\w$\u0080-\uFFFF])/iu.test(sql.slice(start))) {
        throw new Error(
          "db: `void db execute --json` cannot tell where this MySQL SQL's statements end, so it cannot group a CALL's results. A statement in it may change sql_mode, which changes what a backslash in a quoted string means after it: a SET of sql_mode to something other than a quoted list of modes, such as SET sql_mode = @saved, or an EXECUTE. Set sql_mode to a quoted list, such as SET sql_mode = 'ANSI_QUOTES', or run the CALL in a separate command.",
        );
      }
      return { calls, uncounted: true };
    }
    const previous = words.at(-1);
    if (word === ';') {
      afterEnd = false;
      if (depth === 0) {
        finish();
      } else {
        words.push(word);
      }
      continue;
    }
    words.push(word);
    const first = words[0];
    if ((first === 'create' || first === 'alter') && storedProgram === undefined) {
      if (MYSQL_STORED_PROGRAMS.has(word)) {
        storedProgram = true;
      } else if (MYSQL_OTHER_OBJECTS.has(word)) {
        storedProgram = false;
      }
    }
    const closedBlock = afterEnd;
    afterEnd = false;
    // A word after a dot names a column or other object.
    if (previous === '.') {
      continue;
    }
    if (closedBlock && /^(?:if|loop|while|repeat)$/.test(word)) {
      // That END closed an IF or loop, which never opened a level, so restore it.
      depth++;
    } else if (closedBlock && word === 'case') {
      // END CASE closes the CASE that opened a level.
    } else if (word === 'case' || (word === 'begin' && (storedProgram === true || opensBlock()))) {
      depth++;
    } else if (word === 'end' && depth > 0) {
      depth--;
      afterEnd = true;
    }
  }
  finish();
  return { calls, uncounted: false };
}

/**
 * mysql2 returns `[rows, fields]`. With several result sets, `rows` holds one entry per result
 * (rows, or a result header for a write) and `fields` holds each one's column list, or
 * `undefined` for a header. A `CALL` returns each result set of the procedure and then its own
 * header, so those entries are grouped under the `CALL`, its rows in order. `statements` is what
 * `mySqlStatements` found in the SQL.
 */
export function mySqlStatementResults(
  rows: unknown,
  fields: unknown,
  statements: MySqlStatements,
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
  for (const isCall of statements.calls) {
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
  if (statements.uncounted) {
    // At least one statement follows, and statements that are not CALLs each return one result.
    matched &&= index < entries.length;
    grouped.push(...entries.slice(index).map(mySqlStatementResult));
    index = entries.length;
  }
  // When the statements and results do not line up (SQL this scan reads differently from
  // MySQL), print one entry per result rather than guess.
  return matched && index === entries.length ? grouped : entries.map(mySqlStatementResult);
}
