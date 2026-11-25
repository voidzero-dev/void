import { tokenizeSql } from '@void/deploy-core';
import type { CustomTypesConfig } from 'pg';
import type { SqliteDatabase } from '../migrations/runner.ts';
import { closeMySqlQuoted } from '../runtime/db/migrations/mysql-sql.ts';

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
    .prepare<{ last_row_id: bigint; total: bigint }>(
      'SELECT last_insert_rowid() AS last_row_id, total_changes() AS total',
    )
    .safeIntegers(true);
  // A scalar SELECT always returns one row.
  const readCounters = () => counters.get() ?? { last_row_id: 0n, total: 0n };
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
        // The rows the statement wrote, its triggers' writes among them, as D1 counts them.
        changes: after.total - before,
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
 * `ANSI_QUOTES` mode, `brackets` is true in MariaDB's `MSSQL` mode, which reads `[name]` as a
 * quoted name, and `mariaDb` tells MariaDB, which reads executable comments its own way.
 */
export type MySqlServerMode = {
  version: number;
  backslashEscapes: boolean;
  ansiQuotes: boolean;
  brackets: boolean;
  mariaDb: boolean;
};

/** Reads what `mySqlServerMode()` needs. It only matters for SQL that `needsMySqlServerMode` finds. */
export const MYSQL_SERVER_MODE_QUERY =
  'SELECT @@SESSION.sql_mode AS sql_mode, VERSION() AS version';

/**
 * Whether the SQL holds a backslash, a `[` or an executable comment, which read differently per
 * server. Without a backslash, `ANSI_QUOTES` changes what a double-quoted text is but not
 * where it ends.
 */
export function needsMySqlServerMode(sql: string): boolean {
  return sql.includes('\\') || sql.includes('[') || /\/\*M?!/u.test(sql);
}

/** Read the row `MYSQL_SERVER_MODE_QUERY` returns. */
export function mySqlServerMode(rows: unknown): MySqlServerMode {
  const row: unknown = Array.isArray(rows) ? rows[0] : undefined;
  const fields = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
  const modes = typeof fields.sql_mode === 'string' ? fields.sql_mode.split(',') : [];
  const versionText = String(fields.version ?? '');
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(versionText);
  const mariaDb = /mariadb/iu.test(versionText);
  return {
    // A server whose version does not read as one runs every version comment.
    version: version
      ? Number(version[1]) * 10_000 + Number(version[2]) * 100 + Number(version[3])
      : Number.POSITIVE_INFINITY,
    backslashEscapes: !modes.includes('NO_BACKSLASH_ESCAPES'),
    ansiQuotes: modes.includes('ANSI_QUOTES'),
    brackets: mariaDb && modes.includes('MSSQL'),
    mariaDb,
  };
}

/** Whether the character after `--` (`NaN` at the end of the input) makes it a comment. */
function startsMySqlDashComment(code: number): boolean {
  // Whitespace or a control character, as MySQL's lexer checks.
  return Number.isNaN(code) || code <= 0x20 || code === 0x7f;
}

/**
 * The index after the comment whose text starts at `index`, or `undefined` when it does not
 * close. A skipped version comment may hold one nested comment (`nesting` 1); any other comment
 * ends at its first closing marker.
 */
function skipMySqlComment(sql: string, index: number, nesting: number): number | undefined {
  while (index < sql.length) {
    const character = sql[index++];
    if (nesting > 0 && character === '/' && sql[index] === '*') {
      const end = skipMySqlComment(sql, index + 1, nesting - 1);
      if (end === undefined) {
        return undefined;
      }
      index = end;
    } else if (character === '*' && sql[index] === '/') {
      return index + 1;
    }
  }
  return undefined;
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
  brackets: false,
  mariaDb: false,
};

/**
 * Where `readMySqlWord` reads next, where the word it read last starts, whether that is in an
 * executable comment that runs, and what it has read since `readMySqlStatement` began: text that
 * another sql_mode may read differently (`modal`: a quoted string or name that holds a
 * backslash, or on MariaDB a `[`), text the server rejects (`rejected`: a quoted string or
 * name, or a comment, still open at the end of the SQL, or a `[` that quotes no name), and a
 * comment.
 */
type MySqlLexer = {
  index: number;
  start: number;
  inVersionComment: boolean;
  modal: boolean;
  rejected: boolean;
  comment: boolean;
};

function newMySqlLexer(): MySqlLexer {
  return {
    index: 0,
    start: 0,
    inVersionComment: false,
    modal: false,
    rejected: false,
    comment: false,
  };
}

/** The index after the `[name]` that opens at `open`, where `]]` stands for `]`. */
function closeMySqlBracket(sql: string, open: number): number | undefined {
  let index = open + 1;
  for (;;) {
    const close = sql.indexOf(']', index);
    if (close === -1) {
      return undefined;
    }
    if (sql[close + 1] !== ']') {
      return close + 1;
    }
    index = close + 2;
  }
}

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
    lexer.start = index;
    if (character === "'" || character === '"' || character === '`') {
      // A backslash escapes nothing in a quoted name, `ANSI_QUOTES` double quotes included.
      const name = character === '`' || (character === '"' && mode.ansiQuotes);
      const end = closeMySqlQuoted(sql, index, character, mode.backslashEscapes && !name);
      lexer.rejected ||= end === undefined;
      lexer.index = end ?? sql.length;
      const word = sql.slice(index, lexer.index);
      // Whether a double quote opens a string or a name depends on the mode too.
      lexer.modal ||= character !== '`' && word.includes('\\');
      return word;
    }
    // MariaDB's MSSQL mode quotes a name in square brackets. Elsewhere the server rejects a `[`
    // outside a quoted text.
    if (character === '[') {
      lexer.modal ||= mode.mariaDb;
      if (!mode.brackets) {
        lexer.rejected = true;
      } else {
        const end = closeMySqlBracket(sql, index);
        lexer.rejected ||= end === undefined;
        lexer.index = end ?? sql.length;
        return sql.slice(index, lexer.index);
      }
    }
    if (
      character === '#' ||
      // MySQL reads `--` as a comment only when whitespace or a control character, or the end of
      // the input, follows it.
      (character === '-' && next === '-' && startsMySqlDashComment(sql.charCodeAt(index + 2)))
    ) {
      const newline = sql.indexOf('\n', index);
      lexer.index = newline === -1 ? sql.length : newline;
      lexer.comment = true;
    } else if (lexer.inVersionComment && character === '*' && next === '/') {
      lexer.inVersionComment = false;
      lexer.index += 2;
    } else if (character === '/' && next === '*') {
      const executable = /^M?!/u.test(sql.slice(index + 2, index + 4));
      const runsFrom = executable ? runsMySqlComment(sql, index + 2, mode) : undefined;
      lexer.comment = true;
      if (runsFrom !== undefined) {
        lexer.inVersionComment = true;
        lexer.index = runsFrom;
      } else {
        // Any other comment, an optimizer hint (`/*+`) too, holds no statement. One the server
        // skips for its version may nest a comment.
        const end = skipMySqlComment(sql, index + 2, executable ? 1 : 0);
        lexer.rejected ||= end === undefined;
        lexer.index = end ?? sql.length;
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

/**
 * A block that holds statements of its own, so a `;` in it does not end the statement, or a
 * CASE expression, which ends at END like a CASE statement does. MariaDB's FOR loop is one too.
 */
type MySqlBlock = 'begin' | 'case' | 'caseExpression' | 'if' | 'loop' | 'while' | 'repeat' | 'for';

/**
 * A block open in the statement being read. `depth` counts the parentheses around it, and `past`
 * is set once a WHILE or FOR has come to its DO, or a REPEAT to its UNTIL.
 */
type MySqlOpenBlock = { kind: MySqlBlock; depth: number; past: boolean };

// Compound statements that close with END and their own name, such as END IF.
const MYSQL_CONTROL_BLOCKS = new Set<string>(['if', 'loop', 'while', 'repeat', 'for']);
// The words a stored procedure's characteristics are made of, between its parameters and body.
const MYSQL_PROCEDURE_CHARACTERISTICS = new Set([
  'comment',
  'contains',
  'data',
  'definer',
  'deterministic',
  'invoker',
  'language',
  'modifies',
  'no',
  'not',
  'reads',
  'security',
  'sql',
]);
// The words a stored function's body starts with when it is a compound statement. Its other
// body is a RETURN.
const MYSQL_BODY_BLOCKS = new Set(['begin', 'case', ...MYSQL_CONTROL_BLOCKS]);

// The words after which an expression goes on with an operand, so that a name there, such as an
// `end` column, is not the END of a CASE expression or of a REPEAT's UNTIL condition, nor a `do`
// column the DO of a WHILE. Operators written with other characters than letters do the same.
const MYSQL_OPERAND_BEFORE = new Set([
  'and',
  'between',
  'binary',
  'case',
  'div',
  'else',
  'elseif',
  'if',
  'in',
  'interval',
  'is',
  'like',
  'mod',
  'not',
  'of',
  'or',
  'regexp',
  'return',
  'rlike',
  'then',
  'until',
  'when',
  'while',
  'xor',
]);

/** Whether an operand follows `previous`, the word before it in an expression. */
function expectsMySqlOperand(previous: string | undefined): boolean {
  return (
    previous === undefined ||
    MYSQL_OPERAND_BEFORE.has(previous) ||
    // An operator or an opening parenthesis. A closing one, a `?` placeholder and the `}` of an
    // ODBC literal end an operand.
    (previous.length === 1 && !/[\w$)?}\u0080-￿]/u.test(previous))
  );
}

// What a handler does when its condition comes, in DECLARE ... HANDLER.
const MYSQL_HANDLER_ACTIONS = new Set(['continue', 'exit', 'undo']);

/**
 * Where DECLARE ... HANDLER FOR is in its conditions: before FOR, before a condition, after
 * SQLSTATE, before the last word of a condition (SQLSTATE VALUE's text, NOT's FOUND), or after a
 * condition, where a comma or the handler's statement follows.
 */
type MySqlHandlerPart = 'for' | 'condition' | 'sqlstate' | 'last' | 'after';

/** Where a handler's conditions are after `word`, or `'statement'` when its statement starts. */
function nextMySqlHandlerPart(
  part: MySqlHandlerPart,
  word: string,
): MySqlHandlerPart | 'statement' | undefined {
  switch (part) {
    case 'for':
      return word === 'for' ? 'condition' : undefined;
    case 'condition':
      return word === 'sqlstate' ? 'sqlstate' : word === 'not' ? 'last' : 'after';
    case 'sqlstate':
      return word === 'value' ? 'last' : 'after';
    case 'last':
      return 'after';
    default:
      return word === ',' ? 'condition' : 'statement';
  }
}

/** Where a stored program's statement is, up to the start of its body. */
type MySqlProgramHead =
  | 'name'
  | 'parameters'
  | 'characteristics'
  | 'triggerOrder'
  | 'triggerOrderName'
  | 'body';

/** One top-level statement of MySQL SQL. */
type MySqlStatementRead = {
  /** Its words, without the `;` that ends it, empty when it holds only comments or nothing. */
  words: Array<string>;
  /** Where the next statement starts: after the `;`, or at the end of the SQL. */
  end: number;
  inVersionComment: boolean;
  /** Whether a `;` ends it, so another statement may follow. */
  terminated: boolean;
  modal: boolean;
  rejected: boolean;
  comment: boolean;
};

/**
 * Close the innermost block at an END. `next` is the word after it, which names the block for
 * END IF, END LOOP, END WHILE, END REPEAT, END FOR and END CASE. Returns whether `next` belongs
 * to the END.
 */
function closeMySqlBlock(blocks: Array<MySqlOpenBlock>, next: string | undefined): boolean {
  const top = blocks.at(-1)?.kind;
  if (top === 'caseExpression') {
    // A CASE expression ends at its END, whatever follows it, as in `END FOR UPDATE`.
    blocks.pop();
    return next === 'case';
  }
  if (next !== undefined && MYSQL_CONTROL_BLOCKS.has(next)) {
    // An END IF whose IF opened no block here closes nothing.
    // MariaDB's Oracle mode ends WHILE and FOR loops with END LOOP.
    if (top === next || (next === 'loop' && (top === 'while' || top === 'for'))) {
      blocks.pop();
    }
    return true;
  }
  if (next === 'case') {
    if (top === 'case') {
      blocks.pop();
    }
    return true;
  }
  // A plain END closes a BEGIN block, and any block left open in it.
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index].kind === 'begin' || blocks[index].kind === 'case') {
      blocks.length = index;
      break;
    }
  }
  return false;
}

/**
 * Read one top-level statement of MySQL SQL the way a server in `mode` does, from where `lexer`
 * is to its `;` or the end of the SQL.
 *
 * A statement ends at a semicolon outside any block. A stored program's body (`CREATE
 * PROCEDURE`, `FUNCTION`, `TRIGGER` or `EVENT`, and `ALTER EVENT`) holds statements of its own:
 * a BEGIN block, or an IF, CASE, LOOP, WHILE, REPEAT or MariaDB FOR statement, which may also
 * stand alone as the body. MariaDB also runs these, and BEGIN NOT ATOMIC blocks, outside stored
 * programs. Each opens a block only where a statement starts, a handler's statement among them,
 * so the IF() function and DROP TABLE IF EXISTS do not, and BEGIN elsewhere starts a transaction
 * or is a name. END closes a block where a statement starts too, and ends a CASE expression or
 * a REPEAT's UNTIL condition after an operand; elsewhere it is a name, as `begin` and `end`
 * columns are. A CASE expression nests anywhere. A word after a dot or right after an `@` is a
 * name, such as the column in `t.case` or the variable `@case`, as is the account in
 * `DEFINER = account`.
 */
function readMySqlStatement(
  sql: string,
  lexer: MySqlLexer,
  mode: MySqlServerMode,
): MySqlStatementRead {
  lexer.modal = false;
  lexer.rejected = false;
  lexer.comment = false;
  const words: Array<string> = [];
  const blocks: Array<MySqlOpenBlock> = [];
  // The stored program a CREATE or ALTER makes, once it names one, and how far its head goes.
  let program: string | undefined;
  let otherObject = false;
  let head: MySqlProgramHead = 'name';
  let parentheses = 0;
  // Whether a function's body is a RETURN. In MariaDB's Oracle mode, RETURN gives the function's
  // type, and its body starts after AS or IS.
  let returns = false;
  // The parentheses open at the word being read.
  let depth = 0;
  // Where a DECLARE ... HANDLER FOR is in its conditions.
  let handler: MySqlHandlerPart | undefined;
  // Whether the next word starts a statement, and whether the last one did.
  let startsNext = true;
  let startedLast = false;
  // Set right after an END, when the word after it names the block it closed.
  let namesBlock = false;
  // Where the word before ends, and whether it is a name, which ends an operand.
  let wordEnd = -1;
  let named = false;
  const result = (terminated: boolean): MySqlStatementRead => ({
    words,
    end: lexer.index,
    inVersionComment: lexer.inVersionComment,
    terminated,
    modal: lexer.modal,
    rejected: lexer.rejected,
    comment: lexer.comment,
  });
  // The words after the one just read, without moving on.
  const ahead = (count: number) => {
    const copy = { ...lexer };
    return Array.from({ length: count }, () => readMySqlWord(sql, copy, mode));
  };
  for (
    let word = readMySqlWord(sql, lexer, mode);
    word !== undefined;
    word = readMySqlWord(sql, lexer, mode)
  ) {
    const touches = lexer.start === wordEnd;
    wordEnd = lexer.index;
    if (word === ';') {
      if (blocks.length === 0) {
        return result(true);
      }
      words.push(word);
      startsNext = true;
      startedLast = false;
      namesBlock = false;
      named = false;
      handler = undefined;
      continue;
    }
    const previous = words.at(-1);
    const operandBefore = !named && expectsMySqlOperand(previous);
    named = false;
    words.push(word);
    let starts = startsNext;
    startsNext = false;
    const afterLabel = word === ':' && startedLast;
    startedLast = false;
    const closing = namesBlock;
    namesBlock = false;
    if (word === '(') {
      depth++;
    } else if (word === ')') {
      depth--;
    }
    // A word after a dot names a column or other object, and one right after an `@` a variable,
    // or the host of an account.
    if (previous === '.' || (previous === '@' && touches)) {
      named = true;
      continue;
    }
    if ((words[0] === 'create' || words[0] === 'alter') && program === undefined && !otherObject) {
      // The account in DEFINER = account, such as user@localhost, names no object.
      if (previous === '=' && words.at(-3) === 'definer') {
        continue;
      }
      if (MYSQL_STORED_PROGRAMS.has(word)) {
        program = word;
        continue;
      }
      otherObject = MYSQL_OTHER_OBJECTS.has(word);
    } else if (program !== undefined && head !== 'body') {
      // Find where the body starts: after a procedure's or function's parameters and
      // characteristics (a function's RETURNS type among them), a trigger's FOR EACH ROW and
      // FOLLOWS or PRECEDES, or an event's DO. In MariaDB's Oracle mode, a procedure's or
      // function's body starts after AS or IS, with or without parameters before it.
      const routine = program === 'procedure' || program === 'function';
      if (head === 'name') {
        if (word === '(' && routine) {
          head = 'parameters';
          parentheses = 1;
        } else if (program === 'trigger' && word === 'row' && previous === 'each') {
          head = 'triggerOrder';
        } else if (
          (program === 'event' &&
            word === 'do' &&
            !['event', 'exists', 'to'].includes(previous ?? '')) ||
          (routine && (word === 'as' || word === 'is'))
        ) {
          // The word before a DO may name the event, as in CREATE EVENT do.
          head = 'body';
          startsNext = true;
        }
      } else if (head === 'parameters') {
        if (word === '(') {
          parentheses++;
        } else if (word === ')' && --parentheses === 0) {
          head = 'characteristics';
        }
      } else if (head === 'characteristics') {
        if (word === ':' || word === 'as' || word === 'is') {
          // The word before a `:` labels the body, and may be a characteristic's word.
          head = 'body';
          startsNext = true;
        } else if (program === 'procedure') {
          if (!MYSQL_PROCEDURE_CHARACTERISTICS.has(word) && !/^['"]/u.test(word)) {
            head = 'body';
            starts = true;
          }
        } else if (word === 'return' || MYSQL_BODY_BLOCKS.has(word)) {
          head = 'body';
          starts = true;
          returns = word === 'return';
        }
      } else if (head === 'triggerOrder') {
        if (word === 'follows' || word === 'precedes') {
          head = 'triggerOrderName';
        } else {
          head = 'body';
          starts = true;
        }
      } else {
        head = 'body';
        startsNext = true;
      }
    }
    if (handler !== undefined) {
      const part = nextMySqlHandlerPart(handler, word);
      handler = part === 'statement' ? undefined : part;
      starts ||= part === 'statement';
    } else if (
      word === 'handler' &&
      blocks.length > 0 &&
      MYSQL_HANDLER_ACTIONS.has(previous ?? '') &&
      words.at(-3) === 'declare'
    ) {
      handler = 'for';
    }
    const top = blocks.at(-1);
    if (closing && (MYSQL_CONTROL_BLOCKS.has(word) || word === 'case')) {
      // The name of the block the END before it closed.
    } else if (starts && MYSQL_CONTROL_BLOCKS.has(word)) {
      blocks.push({ kind: word as MySqlBlock, depth, past: false });
      // A LOOP or REPEAT holds its statements right after its name.
      startsNext = word === 'loop' || word === 'repeat';
    } else if (word === 'case') {
      blocks.push({ kind: starts ? 'case' : 'caseExpression', depth, past: false });
    } else if (
      word === 'begin' &&
      starts &&
      // At the top level, BEGIN starts a transaction, unless MariaDB's BEGIN NOT ATOMIC opens a
      // block.
      (program !== undefined || blocks.length > 0 || ahead(2).join(' ') === 'not atomic')
    ) {
      blocks.push({ kind: 'begin', depth, past: false });
      startsNext = true;
    } else if (
      word === 'end' &&
      top !== undefined &&
      (starts ||
        ((top.kind === 'caseExpression' || (top.kind === 'repeat' && top.past)) &&
          top.depth === depth &&
          !operandBefore))
    ) {
      namesBlock = closeMySqlBlock(blocks, ahead(1)[0]);
    } else if (word === 'until' && starts && top?.kind === 'repeat') {
      top.past = true;
    } else if (
      // The DO of a WHILE or a MariaDB FOR, after its condition, not a `do` column in it.
      word === 'do' &&
      (top?.kind === 'while' || top?.kind === 'for') &&
      !top.past &&
      top.depth === depth &&
      !operandBefore
    ) {
      top.past = true;
      startsNext = true;
    } else if (
      ((word === 'then' || word === 'else') && top?.kind !== 'caseExpression') ||
      // In MariaDB's Oracle mode, WHILE and FOR loops hold their statements after LOOP.
      word === 'loop' ||
      afterLabel ||
      (word === 'atomic' && previous === 'not' && words.at(-3) === 'begin') ||
      (returns && blocks.length === 0 && depth === 0 && (word === 'as' || word === 'is'))
    ) {
      startsNext = true;
    }
    startedLast = starts;
  }
  return result(false);
}

/** How a server's quoting rules stand after a statement changes its `sql_mode`. */
type MySqlQuoting = Pick<MySqlServerMode, 'backslashEscapes' | 'ansiQuotes' | 'brackets'>;

/**
 * How a statement changes the session's quoting rules: not at all (`undefined`), to the rules
 * a quoted list of modes sets, or in a way this scan cannot read (`'unclear'`), such as
 * `SET sql_mode = @saved`.
 */
type MySqlModeChange = MySqlQuoting | 'unclear' | undefined;

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

/** Whether a word is a quoted name. */
function isMySqlQuotedName(word: string | undefined, mode: MySqlServerMode): word is string {
  const quote = word?.[0];
  return quote === '`' || (quote === '"' && mode.ansiQuotes) || (quote === '[' && mode.brackets);
}

/** The name a word gives, unquoted and lowercased. */
function mySqlName(word: string | undefined, mode: MySqlServerMode): string | undefined {
  if (isMySqlQuotedName(word, mode)) {
    const close = word[0] === '[' ? ']' : word[0];
    return word.slice(1, -1).replaceAll(`${close}${close}`, close).toLowerCase();
  }
  return word;
}

/** Whether a word is a quoted string, not a name. */
function isMySqlString(word: string | undefined, mode: MySqlServerMode): word is string {
  const quote = word?.[0];
  return (
    word !== undefined &&
    (quote === "'" || (quote === '"' && !mode.ansiQuotes)) &&
    word.length >= 2 &&
    word.endsWith(quote)
  );
}

// What a backslash escape in a string stands for. Any other character stands for itself, and
// `\%` and `\_` keep their backslash.
const MYSQL_ESCAPES = new Map([
  ['0', '\0'],
  ['b', '\b'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['Z', '\u001A'],
  ['%', String.raw`\%`],
  ['_', String.raw`\_`],
]);

/** The text of a quoted string. */
function mySqlStringText(word: string, mode: MySqlServerMode): string {
  const quote = word[0];
  let text = '';
  for (let index = 1; index < word.length - 1; index++) {
    const character = word[index];
    if (character === '\\' && mode.backslashEscapes) {
      const escaped = word[++index];
      text += MYSQL_ESCAPES.get(escaped) ?? escaped;
    } else {
      text += character;
      // A doubled quote stands for one.
      if (character === quote) {
        index++;
      }
    }
  }
  return text;
}

/** The quoting rules a quoted list of modes, such as `'ANSI,NO_BACKSLASH_ESCAPES'`, sets. */
function mySqlModeList(value: Array<string>, mode: MySqlServerMode): MySqlQuoting | 'unclear' {
  const [word] = value;
  if (value.length !== 1 || !isMySqlString(word, mode)) {
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
    brackets: mode.mariaDb && modes.includes('MSSQL'),
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
 * How a SET statement changes the session's quoting rules. `SET GLOBAL` leaves them alone, as
 * does a SET of a user variable.
 */
function mySqlSetChange(words: Array<string>, mode: MySqlServerMode): MySqlModeChange {
  const assignments = splitMySqlWords(words.slice(1));
  let change: MySqlModeChange;
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
 * How a statement's results arrive: one result (`'single'`), or like a CALL's (`'call'`), each
 * result set the statements in it return and then one result header. `'unknown'` is an EXECUTE
 * of a statement this scan cannot see.
 */
type MySqlResultKind = 'single' | 'call' | 'unknown';

/** What a statement prepared by PREPARE returns when EXECUTE runs it, and how it sets sql_mode. */
type MySqlPreparedStatement = { kind: MySqlResultKind; change: MySqlModeChange };

/** The statements prepared so far, by name. */
type MySqlPrepared = Map<string, MySqlPreparedStatement>;

/** What one statement does that matters for reading the statements after it and its results. */
type MySqlEffect = MySqlPreparedStatement & {
  /**
   * A PREPARE of a statement (`statement` undefined when this scan cannot see it), or a
   * DEALLOCATE, by name.
   */
  prepares?: {
    name: string | undefined;
    statement: MySqlPreparedStatement | undefined;
    deallocates?: boolean;
  };
  /** The prepared statement an EXECUTE runs. */
  executes?: string;
  /** Whether the server rejects the statement read this way. */
  rejected?: boolean;
};

const MYSQL_SINGLE: MySqlEffect = { kind: 'single', change: undefined };

/**
 * Whether the server rejects the text a PREPARE or EXECUTE IMMEDIATE is given: a quoted name
 * there, such as a double-quoted text in `ANSI_QUOTES` mode, names no statement.
 */
function rejectsMySqlSource(source: Array<string>, mode: MySqlServerMode): boolean {
  return source.length === 1 && isMySqlQuotedName(source[0], mode);
}

/** The statement in a PREPARE's or EXECUTE IMMEDIATE's text, when it is a quoted string. */
function mySqlPreparedStatement(
  source: Array<string>,
  mode: MySqlServerMode,
): MySqlPreparedStatement | undefined {
  const [word] = source;
  if (source.length !== 1 || !isMySqlString(word, mode)) {
    return undefined;
  }
  // The server prepares one statement and rejects more, so the first one is the statement.
  const { words } = readMySqlStatement(mySqlStringText(word, mode), newMySqlLexer(), mode);
  const { kind, change } = mySqlStatementEffect(words, mode, new Map());
  return { kind, change };
}

/**
 * What a top-level statement does. A CALL, and a compound statement that MariaDB runs outside
 * a stored program (a BEGIN NOT ATOMIC block, IF, CASE, LOOP, WHILE, REPEAT or FOR), return
 * their results like a CALL. So does an EXECUTE, or MariaDB's EXECUTE IMMEDIATE, of a CALL.
 * MariaDB's SET STATEMENT ... FOR returns what the statement after FOR does, and keeps what it
 * changes unless it sets sql_mode itself, which it then restores. A stored program, and a
 * compound statement, run with a sql_mode of their own and restore the session's.
 */
function mySqlStatementEffect(
  words: Array<string>,
  mode: MySqlServerMode,
  prepared: MySqlPrepared,
): MySqlEffect {
  const [first, second] = words;
  if (
    first === 'call' ||
    first === 'case' ||
    MYSQL_CONTROL_BLOCKS.has(first) ||
    (first === 'begin' && second === 'not' && words[2] === 'atomic')
  ) {
    return { kind: 'call', change: undefined };
  }
  if (first === 'execute') {
    // MariaDB's EXECUTE IMMEDIATE runs the text it is given. In MySQL, IMMEDIATE may name a
    // prepared statement, which only a USING may follow.
    if (second === 'immediate' && words.length > 2 && words[2] !== 'using') {
      const [source] = splitMySqlWords(words.slice(2), 'using');
      const statement = mySqlPreparedStatement(source, mode);
      return {
        ...(statement ?? { kind: 'unknown', change: 'unclear' }),
        rejected: rejectsMySqlSource(source, mode),
      };
    }
    const name = mySqlName(second, mode) ?? '';
    return { ...(prepared.get(name) ?? { kind: 'unknown', change: 'unclear' }), executes: name };
  }
  if (first === 'prepare' && words[2] === 'from') {
    const source = words.slice(3);
    return {
      ...MYSQL_SINGLE,
      prepares: { name: mySqlName(second, mode), statement: mySqlPreparedStatement(source, mode) },
      rejected: rejectsMySqlSource(source, mode),
    };
  }
  if ((first === 'deallocate' || first === 'drop') && second === 'prepare') {
    return {
      ...MYSQL_SINGLE,
      prepares: { name: mySqlName(words[2], mode), statement: undefined, deallocates: true },
    };
  }
  if (first === 'set' && second === 'statement') {
    const [settings, statement] = splitMySqlWords(words.slice(2), 'for');
    if (statement === undefined) {
      return MYSQL_SINGLE;
    }
    const effect = mySqlStatementEffect(statement, mode, prepared);
    const restores = settings.some((word) => mySqlName(word, mode) === 'sql_mode');
    return restores ? { ...effect, change: undefined } : effect;
  }
  if (first === 'set') {
    return { kind: 'single', change: mySqlSetChange(words, mode) };
  }
  return MYSQL_SINGLE;
}

/**
 * Each quoting mode a server of `mode`'s version and family may be in. Only MariaDB reads
 * square brackets as quotes, in its MSSQL mode.
 */
function mySqlQuotingModes(mode: MySqlServerMode): Array<MySqlServerMode> {
  return [true, false].flatMap((backslashEscapes) =>
    [false, true].flatMap((ansiQuotes) =>
      (mode.mariaDb ? [false, true] : [false]).map((brackets) => ({
        ...mode,
        backslashEscapes,
        ansiQuotes,
        brackets,
      })),
    ),
  );
}

/** Whether two modes read quoted text the same. */
function sameMySqlQuoting(a: MySqlQuoting, b: MySqlQuoting): boolean {
  return (
    a.backslashEscapes === b.backslashEscapes &&
    a.ansiQuotes === b.ansiQuotes &&
    a.brackets === b.brackets
  );
}

/** The modes a server in `mode` may be in after a statement that makes `change`. */
function nextMySqlModes(mode: MySqlServerMode, change: MySqlModeChange): Array<MySqlServerMode> {
  if (change === 'unclear') {
    return mySqlQuotingModes(mode);
  }
  return [change === undefined ? mode : { ...mode, ...change }];
}

/** Record what a PREPARE or DEALLOCATE does, the same in every mode the server may be in. */
function applyMySqlPrepares(prepared: MySqlPrepared, effects: Array<MySqlEffect>): void {
  if (effects[0].kind === 'call') {
    // A procedure may prepare or deallocate statements of the session, though not the one that
    // runs it, which the server refuses.
    const { executes } = effects[0];
    for (const name of prepared.keys()) {
      if (name !== executes) {
        prepared.delete(name);
      }
    }
    return;
  }
  const [{ prepares }] = effects;
  if (prepares === undefined) {
    return;
  }
  const agree = effects.every(
    (effect) => JSON.stringify(effect.prepares) === JSON.stringify(prepares),
  );
  for (const effect of effects) {
    const name = effect.prepares?.name;
    if (name !== undefined) {
      prepared.delete(name);
    }
  }
  if (agree && prepares.name !== undefined && prepares.statement !== undefined) {
    prepared.set(prepares.name, prepares.statement);
  }
}

const MYSQL_UNKNOWN_EXECUTE =
  "db: `void db execute --json` cannot tell whether an EXECUTE in this MySQL SQL runs a CALL, which returns several results, so it cannot group them. It reads the statement that a PREPARE or EXECUTE IMMEDIATE in the same SQL takes as a quoted string, such as PREPARE s FROM 'CALL p()', but a procedure may prepare a statement again, so it forgets the others after a CALL. Prepare the statement again after the CALL, or run SQL that prepares a statement from a variable or an expression without --json.";

/** The error for SQL whose statements this scan cannot tell apart, which says what it cannot do. */
function unclearMySqlStatements(consequence: string, remedy: string): Error {
  return new Error(
    `db: \`void db execute --json\` cannot tell where the statements of this MySQL SQL end, so it ${consequence}. A statement in it changes sql_mode in a way the command cannot read, such as SET sql_mode = @saved, and the mode decides how quoted text reads, such as what a backslash in a string means. Set sql_mode to a quoted list of modes, such as SET sql_mode = 'ANSI_QUOTES', or ${remedy}.`,
  );
}

const MYSQL_UNCLEAR_CALL = () =>
  unclearMySqlStatements(
    'cannot group the results of a statement after it that returns several, such as a CALL',
    'run that statement in a separate command',
  );

/**
 * The statements of MySQL SQL, in order: `calls` tells which ones return their results like a
 * CALL. When `uncounted` is true, more statements follow them, none of them like a CALL, which
 * this scan cannot count. `sql` is the SQL to run: comments after the last statement are left
 * out, since the server would answer them with a result of their own.
 */
export type MySqlStatements = { calls: Array<boolean>; uncounted: boolean; sql: string };

/**
 * Find MySQL's statements (see `readMySqlStatement`) and tell which return their results like a
 * CALL (see `mySqlStatementEffect`), reading the SQL the way a server in `mode` does.
 *
 * The server reads each statement with the `sql_mode` the statements before it left, so a
 * `SET sql_mode` to a quoted list of modes changes how the SQL after it reads. After a statement
 * that changes it in a way this scan cannot read, the SQL is read in each quoting mode the
 * server may be in, leaving out a reading that leaves a quoted string open, or finds a `[` that
 * quotes no name, which the server rejects. Where they read different statements, the statements are `uncounted` when none of
 * them can return results like a CALL, and otherwise this throws before the SQL runs, since
 * their results could not be grouped. It also throws for an EXECUTE of a statement it cannot
 * see, which may be a CALL.
 */
export function mySqlStatements(
  sql: string,
  initialMode: MySqlServerMode = MYSQL_DEFAULT_MODE,
): MySqlStatements {
  const lexer = newMySqlLexer();
  let modes = [initialMode];
  const prepared: MySqlPrepared = new Map();
  const calls: Array<boolean> = [];
  // Where the SQL may be cut after its last statement, and whether only comments follow it.
  let cut: number | undefined;
  let trailingComment = false;
  let read: MySqlStatementRead;
  do {
    const from = { ...lexer };
    read = readMySqlStatement(sql, lexer, modes[0]);
    // Without a backslash in a quoted string or name, or a `[` on MariaDB, every quoting mode
    // reads it the same.
    let readings = modes.map((mode, index) => ({
      mode,
      read: index === 0 || !read.modal ? read : readMySqlStatement(sql, { ...from }, mode),
    }));
    const accepted = readings.filter((reading) => !reading.read.rejected);
    if (accepted.length > 0) {
      readings = accepted;
    }
    const [{ read: chosen }] = readings;
    read = chosen;
    if (readings.some((reading) => !sameMySqlStatement(reading.read, chosen))) {
      return divergedMySqlStatements(
        sql,
        from,
        readings.map((reading) => reading.mode),
        {
          calls,
          prepared,
        },
      );
    }
    lexer.index = read.end;
    lexer.inVersionComment = read.inVersionComment;
    if (read.words.length === 0) {
      trailingComment ||= read.comment;
      cut = mySqlCut(cut, read);
      continue;
    }
    let effects = readings.map((reading) =>
      mySqlStatementEffect(read.words, reading.mode, prepared),
    );
    // As with a quoted string left open, the server is not in a mode that rejects the statement.
    if (effects.some((effect) => !effect.rejected)) {
      readings = readings.filter((_, index) => !effects[index].rejected);
      effects = effects.filter((effect) => !effect.rejected);
    }
    if (effects.some((effect) => effect.kind === 'unknown')) {
      throw new Error(MYSQL_UNKNOWN_EXECUTE);
    }
    if (effects.some((effect) => effect.kind !== effects[0].kind)) {
      throw MYSQL_UNCLEAR_CALL();
    }
    calls.push(effects[0].kind === 'call');
    applyMySqlPrepares(prepared, effects);
    const next = readings.flatMap((reading, index) =>
      nextMySqlModes(reading.mode, effects[index].change),
    );
    modes = next.filter(
      (mode, index) => next.findIndex((other) => sameMySqlQuoting(other, mode)) === index,
    );
    cut = mySqlCut(undefined, read);
    trailingComment = false;
  } while (read.terminated);
  return {
    calls,
    uncounted: false,
    sql: trailingComment && cut !== undefined ? sql.slice(0, cut) : sql,
  };
}

/**
 * Where the SQL may be cut to leave out what follows a statement, after reading `read`: at the
 * end of a statement, unless an executable comment is still open there, and not where comments
 * that follow leave one open, which the server rejects.
 */
function mySqlCut(cut: number | undefined, read: MySqlStatementRead): number | undefined {
  if (read.words.length > 0) {
    return read.inVersionComment ? undefined : read.end;
  }
  return read.rejected ? undefined : cut;
}

/** Whether two readings of a statement find the same words and end in the same place. */
function sameMySqlStatement(a: MySqlStatementRead, b: MySqlStatementRead): boolean {
  return (
    a === b ||
    (a.end === b.end &&
      a.inVersionComment === b.inVersionComment &&
      a.words.length === b.words.length &&
      a.words.every((word, index) => word === b.words[index]))
  );
}

/**
 * Record a PREPARE that one way of reading diverged SQL finds, in the statements all the ways
 * share. Returns 1 when that forgets a statement some way may have read an EXECUTE with.
 *
 * A name keeps a statement while every way that prepares it prepares the same one as before,
 * or the first time. A way that does not prepare it then reads the statement prepared before,
 * which is the same, or none, and the server rejects its EXECUTE. Otherwise the name is
 * forgotten for every way. A DEALLOCATE changes nothing here: its own way then fails on the
 * server at any EXECUTE of the name, and the others still read the statement.
 */
function prepareDivergedMySql(
  effect: MySqlEffect,
  before: MySqlPrepared,
  prepared: MySqlPrepared,
  conflicts: Set<string>,
): number {
  const { name, statement, deallocates } = effect.prepares ?? {};
  if (name === undefined || deallocates || conflicts.has(name)) {
    return 0;
  }
  const same = (other: MySqlPreparedStatement | undefined) =>
    other === undefined || JSON.stringify(other) === JSON.stringify(statement);
  if (statement !== undefined && same(prepared.get(name)) && same(before.get(name))) {
    prepared.set(name, statement);
    return 0;
  }
  conflicts.add(name);
  return prepared.delete(name) ? 1 : 0;
}

/** One way the server may read the SQL from a statement on. */
type MySqlReading = {
  lexer: MySqlLexer;
  mode: MySqlServerMode;
  cut: number | undefined;
};

/**
 * The statements of SQL whose quoting modes read the statement at `from` differently. Every way
 * the server may read the rest is followed to the end. They are counted only where they hold
 * no statement that returns results like a CALL, and comments after the last statement are left
 * out only where every way agrees on where they start.
 *
 * The ways share their prepared statements (see `prepareDivergedMySql`), which tells less than
 * each way knows, never more, and keeps the walk short.
 */
function divergedMySqlStatements(
  sql: string,
  from: MySqlLexer,
  modes: Array<MySqlServerMode>,
  before: { calls: Array<boolean>; prepared: MySqlPrepared },
): MySqlStatements {
  const prepared = new Map(before.prepared);
  // Names that ways of reading prepare differently.
  const conflicts = new Set<string>();
  let forgotten = 0;
  const ends = new Set<number>();
  // Each place is read once in each mode, and again once a prepared statement is forgotten.
  // A statement prepared the first time changes no EXECUTE read before, since that one failed.
  const seen = new Set<string>();
  const readings: Array<MySqlReading> = modes.map((mode) => ({
    lexer: { ...from },
    mode,
    cut: undefined,
  }));
  for (let reading = readings.pop(); reading !== undefined; reading = readings.pop()) {
    const { lexer } = reading;
    const key = JSON.stringify([
      lexer.index,
      lexer.inVersionComment,
      reading.mode.backslashEscapes,
      reading.mode.ansiQuotes,
      reading.mode.brackets,
      reading.cut,
      forgotten,
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    let trailingComment = false;
    let finished = true;
    let read: MySqlStatementRead;
    do {
      read = readMySqlStatement(sql, lexer, reading.mode);
      if (read.rejected) {
        // The server rejects the SQL if it reads it this way.
        finished = false;
        break;
      }
      if (read.words.length === 0) {
        trailingComment ||= read.comment;
        continue;
      }
      const effect = mySqlStatementEffect(read.words, reading.mode, prepared);
      if (effect.rejected) {
        finished = false;
        break;
      }
      if (effect.kind === 'unknown') {
        throw new Error(MYSQL_UNKNOWN_EXECUTE);
      }
      if (effect.kind === 'call') {
        throw MYSQL_UNCLEAR_CALL();
      }
      forgotten += prepareDivergedMySql(effect, before.prepared, prepared, conflicts);
      reading.cut = mySqlCut(undefined, read);
      trailingComment = false;
      if (effect.change === 'unclear') {
        for (const next of mySqlQuotingModes(reading.mode)) {
          readings.push({ lexer: { ...lexer }, mode: next, cut: reading.cut });
        }
        finished = false;
        break;
      }
      [reading.mode] = nextMySqlModes(reading.mode, effect.change);
    } while (read.terminated);
    if (finished) {
      ends.add(trailingComment && reading.cut !== undefined ? reading.cut : sql.length);
    }
  }
  if (ends.size > 1) {
    throw unclearMySqlStatements(
      'cannot tell whether the comments after its last statement return a result of their own',
      'remove those comments',
    );
  }
  const [end = sql.length] = ends;
  return { calls: before.calls, uncounted: true, sql: sql.slice(0, end) };
}

/**
 * mysql2 returns `[rows, fields]`. With several result sets, `rows` holds one entry per result
 * (rows, or a result header for a write) and `fields` holds each one's column list, or
 * `undefined` for a header. A `CALL` returns each result set of the procedure and then its own
 * header, so those entries are grouped under the `CALL`, its rows in order. `statements` is what
 * `mySqlStatements` found in the SQL. SQL without a statement returns no entry, though the
 * server answers comments alone with a result header.
 */
export function mySqlStatementResults(
  rows: unknown,
  fields: unknown,
  statements: MySqlStatements,
): Array<StatementResult> {
  if (statements.calls.length === 0 && !statements.uncounted) {
    return [];
  }
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
