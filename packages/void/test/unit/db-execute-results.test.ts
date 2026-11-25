import { types } from 'pg';
import { describe, expect, it } from 'vite-plus/test';
import {
  formatStatementResults,
  mySqlServerMode,
  mySqlStatementResults,
  mySqlStatements,
  pgJsonTypes,
  needsMySqlServerMode,
  pgStatementResults,
  splitSqliteStatements,
} from '../../src/cli/db-execute-results.ts';
import type { MySqlServerMode } from '../../src/cli/db-execute-results.ts';
import { Buffer } from '../../src/cli/node-buffer.ts';

/** Which statements of MySQL SQL are CALLs. */
const calls = (sql: string, mode?: MySqlServerMode) => mySqlStatements(sql, mode).calls;

/** Group mysql2's results by the statements of `sql`. */
const groupResults = (rows: unknown, fields: unknown, sql: string, mode?: MySqlServerMode) =>
  mySqlStatementResults(rows, fields, mySqlStatements(sql, mode));

describe('db execute --json results', () => {
  it('prints binary values as byte arrays', () => {
    const output = formatStatementResults([
      {
        results: [{ data: Buffer.from([0, 255]), bytes: new Uint8Array([7]), text: 'x' }],
        success: true,
        meta: {},
      },
    ]);
    expect(JSON.parse(output)).toEqual([
      { results: [{ data: [0, 255], bytes: [7], text: 'x' }], success: true, meta: {} },
    ]);
  });

  it('prints bytes inside arrays as byte arrays', () => {
    const output = formatStatementResults([
      { results: [{ files: [Buffer.from([1, 2]), null] }], success: true, meta: {} },
    ]);
    expect(JSON.parse(output)).toEqual([
      { results: [{ files: [[1, 2], null] }], success: true, meta: {} },
    ]);
  });

  it('keeps every digit of integers past 2^53', () => {
    const output = formatStatementResults([
      {
        results: [{ big: 9_007_199_254_740_993n, low: -9_007_199_254_740_993n, small: 42n }],
        success: true,
        meta: { last_row_id: 9_007_199_254_740_993n, changes: 1n },
      },
    ]);
    expect(JSON.parse(output)).toEqual([
      {
        results: [{ big: '9007199254740993', low: '-9007199254740993', small: 42 }],
        success: true,
        meta: { last_row_id: '9007199254740993', changes: 1 },
      },
    ]);
  });

  it('tells infinite and NaN values apart from NULL', () => {
    const output = formatStatementResults([
      {
        results: [{ up: Infinity, down: -Infinity, nan: Number.NaN, missing: null }],
        success: true,
        meta: {},
      },
    ]);
    expect(JSON.parse(output)).toEqual([
      {
        results: [{ up: 'Infinity', down: '-Infinity', nan: 'NaN', missing: null }],
        success: true,
        meta: {},
      },
    ]);
  });

  it('reads one or several node-postgres results', () => {
    expect(pgStatementResults({ command: 'SELECT', rowCount: 1, rows: [{ a: 1 }] })).toEqual([
      { results: [{ a: 1 }], success: true, meta: { command: 'SELECT', rowCount: 1 } },
    ]);
    expect(
      pgStatementResults([
        { command: 'CREATE', rowCount: null, rows: [] },
        { command: 'SELECT', rowCount: 0, rows: [] },
      ]),
    ).toEqual([
      { results: [], success: true, meta: { command: 'CREATE', rowCount: null } },
      { results: [], success: true, meta: { command: 'SELECT', rowCount: 0 } },
    ]);
  });

  it('keeps the digits of PostgreSQL numeric arrays and JSON numbers', () => {
    const parsers = pgJsonTypes(types);
    const parse = (oid: number, text: string) =>
      (parsers.getTypeParser(oid, 'text') as (value: string) => object | string | number | null)(
        text,
      );
    // The value as `--json` prints it, without whitespace.
    const value = (oid: number, text: string) =>
      formatStatementResults([{ results: [{ v: parse(oid, text) }], success: true, meta: {} }])
        .replaceAll(/\s/g, '')
        .slice('[{"results":[{"v":'.length, -'}],"success":true,"meta":{}}]'.length);
    // numeric[] elements stay strings, like a numeric.
    expect(value(1231, '{1234567890123456789.987,NULL}')).toBe('["1234567890123456789.987",null]');
    // json and jsonb numbers print with the digits the database sent.
    expect(value(3802, '{"a": 9007199254740993, "b": [1.50, "x", null, true]}')).toBe(
      '{"a":9007199254740993,"b":[1.50,"x",null,true]}',
    );
    expect(value(114, '0.1000000000000000000001')).toBe('0.1000000000000000000001');
    expect(value(3807, String.raw`{"{\"a\": 9007199254740993}",NULL}`)).toBe(
      '[{"a":9007199254740993},null]',
    );
    expect(value(199, '{{"1e400"}}')).toBe('[[1e400]]');
    // Other types keep node-postgres's parsers.
    expect(parse(23, '5')).toBe(5);
    expect(parse(20, '9007199254740993')).toBe('9007199254740993');
  });

  it('leaves out the empty-query result of SQL without a statement', () => {
    expect(pgStatementResults({ command: null, rowCount: null, rows: [] })).toEqual([]);
  });

  it('splits SQLite SQL where SQLite ends each statement', () => {
    expect(splitSqliteStatements("SELECT ';'; -- a;\nSELECT 2 /* ; */;;  SELECT 3")).toEqual([
      "SELECT ';';",
      ' -- a;\nSELECT 2 /* ; */;',
      '  SELECT 3',
    ]);
    expect(splitSqliteStatements('-- only a comment;\n')).toEqual([]);
    const trigger =
      'CREATE TEMP TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = CASE WHEN 1 THEN 2 END; DELETE FROM b; END;';
    expect(splitSqliteStatements(`${trigger} SELECT 1;`)).toEqual([trigger, ' SELECT 1;']);
    expect(
      splitSqliteStatements('EXPLAIN CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;'),
    ).toHaveLength(1);
    // A transaction's BEGIN and END are statements of their own.
    expect(splitSqliteStatements('BEGIN; INSERT INTO a VALUES (1); END;')).toHaveLength(3);
    // SQLite rejects a bare `/*` at the end and characters it does not count as whitespace, so
    // they stay as statements that fail. A block comment left open is still a comment.
    expect(splitSqliteStatements('SELECT 1;/*')).toEqual(['SELECT 1;', '/*']);
    expect(splitSqliteStatements('SELECT 1;\u00a0')).toEqual(['SELECT 1;', '\u00a0']);
    expect(splitSqliteStatements('SELECT 1;\v')).toEqual(['SELECT 1;', '\v']);
    expect(splitSqliteStatements('SELECT 1; /* open')).toEqual(['SELECT 1;']);
    expect(splitSqliteStatements('SELECT 1;\t\n\f\r ')).toEqual(['SELECT 1;']);
    // A byte-order mark where a token starts is whitespace to SQLite, so it hides no keyword.
    const bomTrigger = '\uFEFFCREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;';
    expect(splitSqliteStatements(`${bomTrigger} SELECT 2;`)).toEqual([bomTrigger, ' SELECT 2;']);
    expect(splitSqliteStatements('SELECT 1;\uFEFF')).toEqual(['SELECT 1;']);
    // A trigger missing its END stays open for SQLite to report.
    expect(
      splitSqliteStatements('CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1;'),
    ).toHaveLength(1);
  });

  // The shapes mysql2 resolves `query()` to, as `[rows, fields]`.
  const field = { name: 'a', columnType: 3 };
  const header = { fieldCount: 0, affectedRows: 2, insertId: 5, info: '', serverStatus: 2 };

  it('reads a single MySQL statement', () => {
    expect(groupResults([{ a: 1 }], [field], 'SELECT 1')).toEqual([
      { results: [{ a: 1 }], success: true, meta: {} },
    ]);
    expect(groupResults([], [field], 'SELECT 1')).toEqual([
      { results: [], success: true, meta: {} },
    ]);
    expect(groupResults(header, undefined, 'DELETE FROM a')).toEqual([
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });

  it('reads each MySQL statement of a multi-statement query', () => {
    expect(
      groupResults(
        [header, [{ a: 1 }], []],
        [undefined, [field], [field]],
        'DELETE FROM a; SELECT 1; SELECT 2',
      ),
    ).toEqual([
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [{ a: 1 }], success: true, meta: {} },
      { results: [], success: true, meta: {} },
    ]);
    expect(
      groupResults([[{ a: 1 }], [{ a: 2 }]], [[field], [field]], 'SELECT 1; SELECT 2'),
    ).toEqual([
      { results: [{ a: 1 }], success: true, meta: {} },
      { results: [{ a: 2 }], success: true, meta: {} },
    ]);
  });

  it("groups a CALL's result sets and header under the CALL", () => {
    expect(groupResults([[{ a: 1 }], header], [[field], undefined], 'CALL p()')).toEqual([
      { results: [{ a: 1 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
    expect(
      groupResults(
        [[{ a: 1 }], [{ b: 2 }], [{ c: 3 }], header, header],
        [[field], [field], [field], undefined, undefined],
        'SELECT 1; CALL p(); DELETE FROM a',
      ),
    ).toEqual([
      { results: [{ a: 1 }], success: true, meta: {} },
      { results: [{ b: 2 }, { c: 3 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });

  it('prints one entry per MySQL result when the statements do not line up', () => {
    expect(groupResults([[{ a: 1 }], header], [[field], undefined], 'CALL p(); CALL q()')).toEqual([
      { results: [{ a: 1 }], success: true, meta: {} },
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });

  it('reads MySQL comments and quoted text the way MySQL does', () => {
    expect(calls('# note\nCALL report()')).toEqual([true]);
    expect(calls(String.raw`SELECT 'it\'s; ok'; CALL p()`)).toEqual([false, true]);
    expect(calls(String.raw`SELECT "a\";b"; CALL p()`)).toEqual([false, true]);
    // `--` starts a comment only before whitespace, so `1--1` is arithmetic.
    expect(calls('SELECT 1--1; -- x;\nCALL p()')).toEqual([false, true]);
    // MySQL runs the SQL in a `/*!` comment, and `[` quotes nothing.
    expect(calls('/*!40101 SET @a = 1 */; SELECT [1; CALL p()')).toEqual([false, false, true]);
    // A control character after `--` starts a comment too.
    expect(calls('SELECT 1; --\u0001 x;\nCALL p()')).toEqual([false, true]);
    expect(calls('SELECT 1; --')).toEqual([false]);
    // An optimizer hint outside a statement is an ordinary comment.
    expect(calls('/*+ BKA(t) */ CALL p()')).toEqual([true]);
    expect(
      groupResults([[{ a: 1 }], header], [[field], undefined], '# note\nCALL report()'),
    ).toEqual([{ results: [{ a: 1 }], success: true, meta: { affectedRows: 2, insertId: 5 } }]);
  });

  it('reads MySQL SQL the way the server it runs on does', () => {
    const mysql84 = mySqlServerMode([{ sql_mode: 'STRICT_TRANS_TABLES', version: '8.4.3' }]);
    expect(mysql84).toEqual({
      version: 80_403,
      backslashEscapes: true,
      ansiQuotes: false,
      brackets: false,
      mariaDb: false,
    });
    const noEscapes = mySqlServerMode([
      { sql_mode: 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES', version: '8.4.3' },
    ]);
    expect(noEscapes).toEqual({
      version: 80_403,
      backslashEscapes: false,
      ansiQuotes: false,
      brackets: false,
      mariaDb: false,
    });
    // With NO_BACKSLASH_ESCAPES, a backslash before a quote is an ordinary character.
    const backslash = String.raw`SELECT '\'; CALL p()`;
    expect(calls(backslash, noEscapes)).toEqual([false, true]);
    expect(calls(backslash, mysql84)).toEqual([false]);
    expect(
      groupResults(
        [[{ a: 1 }], [{ b: 2 }], header],
        [[field], [field], undefined],
        backslash,
        noEscapes,
      ),
    ).toEqual([
      { results: [{ a: 1 }], success: true, meta: {} },
      { results: [{ b: 2 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
    // The server skips a version comment for a later version and runs one for its own.
    expect(calls('/*!99999 SET @n = 1 */ CALL p()', mysql84)).toEqual([true]);
    expect(calls('/*!80403 SET @n = 1 */ CALL p()', mysql84)).toEqual([false]);
    expect(calls('/*! CALL p() */', mysql84)).toEqual([true]);
    expect(calls('/*!40101 CALL p() */; SELECT 1', mysql84)).toEqual([true, false]);
    // Six digits are a version when whitespace follows them; otherwise five are.
    expect(calls('/*!100000 SET @n = 1 */ CALL p()', mysql84)).toEqual([true]);
    expect(calls('/*!800001 CALL p() */ SELECT 1', mysql84)).toEqual([false]);
    expect(calls('/*!800001; CALL p() */', mysql84)).toEqual([false, true]);
    expect(calls('/*!80000CALL p() */', mysql84)).toEqual([true]);
    // A skipped version comment may hold one nested comment.
    expect(calls('/*!99999 /* note */ SELECT 1 */ CALL p()', mysql84)).toEqual([true]);
    expect(calls('/* /* note */ CALL p()', mysql84)).toEqual([true]);
    // MySQL reads MariaDB's `/*M!` as an ordinary comment.
    expect(calls('/*M! SELECT 0; */ CALL p()', mysql84)).toEqual([true]);
    expect(needsMySqlServerMode('SELECT 1; CALL p()')).toBe(false);
    expect(needsMySqlServerMode(backslash)).toBe(true);
    expect(needsMySqlServerMode('/*!80000 SET @n = 1 */')).toBe(true);
    expect(needsMySqlServerMode('/*M!100100 SELECT 0 */')).toBe(true);
  });

  it('reads MariaDB executable comments the way MariaDB does', () => {
    const mariaDb = mySqlServerMode([
      { sql_mode: 'STRICT_TRANS_TABLES', version: '10.11.6-MariaDB-1:10.11.6+maria~ubu2204' },
    ]);
    expect(mariaDb).toEqual({
      version: 101_106,
      backslashEscapes: true,
      ansiQuotes: false,
      brackets: false,
      mariaDb: true,
    });
    expect(calls('/*M!100100 SELECT 0 */; CALL p()', mariaDb)).toEqual([false, true]);
    expect(calls('/*M! SELECT 0 */; CALL p()', mariaDb)).toEqual([false, true]);
    expect(calls('/*M!110000 SELECT 0; */ CALL p()', mariaDb)).toEqual([true]);
    // MariaDB skips `/*!` comments for MySQL 5.7 and later, but not its own versions.
    expect(calls('/*!80000 SELECT 0; */ CALL p()', mariaDb)).toEqual([true]);
    expect(calls('/*!50699 SELECT 0 */; CALL p()', mariaDb)).toEqual([false, true]);
    expect(calls('/*!100100 SELECT 0 */; CALL p()', mariaDb)).toEqual([false, true]);
    // A sixth digit belongs to the version without whitespace after it.
    expect(calls('/*!100100SELECT 0 */; CALL p()', mariaDb)).toEqual([false, true]);
    expect(
      groupResults(
        [[{ 0: 0 }], [{ a: 1 }], header],
        [[field], [field], undefined],
        '/*M!100100 SELECT 0 */; CALL p()',
        mariaDb,
      ),
    ).toEqual([
      { results: [{ 0: 0 }], success: true, meta: {} },
      { results: [{ a: 1 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });

  it('reads double quotes as a name in ANSI_QUOTES mode', () => {
    const ansi = mySqlServerMode([
      {
        sql_mode: 'REAL_AS_FLOAT,PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ONLY_FULL_GROUP_BY,ANSI',
        version: '8.4.3',
      },
    ]);
    expect(ansi.ansiQuotes).toBe(true);
    // A backslash escapes nothing in a quoted name.
    expect(calls(String.raw`SELECT 1 AS "a\"; CALL p()`, ansi)).toEqual([false, true]);
    // A single-quoted string still reads its backslash escapes.
    expect(calls(String.raw`SELECT 'a\'; CALL p()'`, ansi)).toEqual([false]);
  });

  it('finds MySQL statements around stored program bodies', () => {
    expect(
      calls(
        [
          'BEGIN',
          `CREATE PROCEDURE p() lbl: BEGIN
             DECLARE x INT DEFAULT 0;
             IF x > 0 THEN SELECT 1; END IF;
             CASE x WHEN 0 THEN SELECT 2; END CASE;
             SELECT CASE WHEN x THEN 'a;' ELSE 'b' END;
             WHILE x < 2 DO SET x = x + 1; END WHILE;
           END lbl`,
          'call p()',
          'COMMIT',
          '-- trailing comment',
        ].join(';\n'),
      ),
    ).toEqual([false, false, true, false]);
  });

  it('opens a BEGIN block only in a stored program', () => {
    // BEGIN may name a column, and XA BEGIN starts a transaction.
    expect(calls('SELECT begin FROM appointments; CALL report()')).toEqual([false, true]);
    expect(calls("XA BEGIN 'x'; CALL p()")).toEqual([false, true]);
    expect(calls('CREATE TABLE event (begin INT, `end` INT); CREATE VIEW v AS SELECT 1')).toEqual([
      false,
      false,
    ]);
    expect(
      calls(
        [
          `CREATE DEFINER = CURRENT_USER TRIGGER t BEFORE INSERT ON a FOR EACH ROW BEGIN
             SET NEW.begin = 1; SELECT x.begin INTO @b FROM x;
           END`,
          `CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM a; END`,
          'CALL p()',
        ].join(';\n'),
      ),
    ).toEqual([false, false, true]);
    // MariaDB runs BEGIN NOT ATOMIC blocks outside a stored program, and returns their results
    // like a CALL's.
    expect(calls('BEGIN NOT ATOMIC SELECT 1; SELECT 2; END; CALL p()')).toEqual([true, true]);
    expect(
      groupResults(
        [[{ begin: 1 }], [{ a: 1 }], header],
        [[field], [field], undefined],
        'SELECT begin FROM appointments; CALL report()',
      ),
    ).toEqual([
      { results: [{ begin: 1 }], success: true, meta: {} },
      { results: [{ a: 1 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });

  it('reads a reserved word after a dot as a name', () => {
    expect(calls('SELECT t.case, t.end FROM t; CALL report()')).toEqual([false, true]);
    expect(calls('SELECT CASE WHEN t.end > 0 THEN t.case END FROM t; CALL p()')).toEqual([
      false,
      true,
    ]);
    expect(
      calls(`CREATE PROCEDURE p() BEGIN SELECT t.case, t.end, t.begin FROM t; END; CALL p()`),
    ).toEqual([false, true]);
  });

  it('keeps an ALTER EVENT body in one MySQL statement', () => {
    expect(
      calls(
        [
          'ALTER EVENT e DO BEGIN DELETE FROM a; SELECT 1; END',
          `ALTER DEFINER = 'admin'@'%' EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM a; END`,
          'CALL p()',
        ].join(';\n'),
      ),
    ).toEqual([false, false, true]);
    // ALTER of other objects opens no block.
    expect(calls('ALTER TABLE event ADD begin INT; BEGIN; CALL p()')).toEqual([false, false, true]);
  });

  it('reads MySQL SQL after a SET of sql_mode the way the new mode does', () => {
    const noEscapes = mySqlServerMode([{ sql_mode: 'NO_BACKSLASH_ESCAPES', version: '8.4.3' }]);
    const backslash = String.raw`SELECT '\'; CALL p()`;
    expect(calls(`SET sql_mode = 'NO_BACKSLASH_ESCAPES'; ${backslash}`)).toEqual([
      false,
      false,
      true,
    ]);
    expect(calls(`SET sql_mode = ''; ${backslash}'`, noEscapes)).toEqual([false, false]);
    for (const set of [
      `SET SESSION sql_mode = 'no_backslash_escapes'`,
      `SET LOCAL sql_mode := 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES'`,
      `SET @@sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `SET @@SESSION.sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `SET @@local.sql_mode = "NO_BACKSLASH_ESCAPES"`,
      "SET `sql_mode` = 'NO_BACKSLASH_ESCAPES'",
      `SET GLOBAL max_connections = 10, SESSION sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `SET GLOBAL max_connections = 10, @@sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `SET @old_sql_mode = @@sql_mode, sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `/*!40101 SET SQL_MODE = 'NO_BACKSLASH_ESCAPES' */`,
      `SET STATEMENT max_statement_time = 10 FOR SET sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `SET NAMES utf8mb4, sql_mode = 'ANSI_QUOTES,,NO_BACKSLASH_ESCAPES'`,
      "EXECUTE IMMEDIATE 'SET sql_mode = ''NO_BACKSLASH_ESCAPES'''",
    ]) {
      expect(calls(`${set}; ${backslash}`), set).toEqual([false, false, true]);
    }
    // The SET reads its own text the way the mode before it does.
    expect(calls(String.raw`SET sql_mode = 'NO_BACKSLASH_ESCAPES', @a = '\'; CALL p()'`)).toEqual([
      false,
    ]);
    // ANSI_QUOTES, and the combination modes that include it, make a double quote a name.
    expect(calls(String.raw`SET sql_mode = 'ANSI'; SELECT 1 AS "a\"; CALL p()`)).toEqual([
      false,
      false,
      true,
    ]);
    const ansi = mySqlServerMode([{ sql_mode: 'ANSI_QUOTES', version: '8.4.3' }]);
    expect(calls(String.raw`SET sql_mode = ''; SELECT "a\"; CALL p()"`, ansi)).toEqual([
      false,
      false,
    ]);
    expect(
      groupResults(
        [header, [{ a: '\\' }], [{ b: 2 }], header],
        [undefined, [field], [field], undefined],
        `SET sql_mode = 'NO_BACKSLASH_ESCAPES'; ${backslash}`,
      ),
    ).toEqual([
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [{ a: '\\' }], success: true, meta: {} },
      { results: [{ b: 2 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });

  it("leaves the session's sql_mode alone for SQL that does not change it", () => {
    const mysql84 = mySqlServerMode([{ sql_mode: '', version: '8.4.3' }]);
    // The backslash escapes the quote, so the string holds the rest.
    const backslash = String.raw`SELECT 'a\'; CALL p()'`;
    for (const statement of [
      `SET GLOBAL sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `SET PERSIST sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `SET @@GLOBAL.sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `SET @@persist.sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `SET GLOBAL max_connections = 10, sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `SET @sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `SET STATEMENT sql_mode = 'NO_BACKSLASH_ESCAPES' FOR SELECT 1`,
      `SET STATEMENT sql_mode = 'ANSI' FOR SET sql_mode = 'NO_BACKSLASH_ESCAPES'`,
      `BEGIN NOT ATOMIC SET sql_mode = 'NO_BACKSLASH_ESCAPES'; END`,
      `BEGIN NOT ATOMIC EXECUTE IMMEDIATE 'SET sql_mode = ''NO_BACKSLASH_ESCAPES'''; END`,
      `SELECT 'SET sql_mode = ''NO_BACKSLASH_ESCAPES'''`,
      `CREATE PROCEDURE q() BEGIN SET sql_mode = 'NO_BACKSLASH_ESCAPES'; END`,
      `/*!99999 SET sql_mode = 'NO_BACKSLASH_ESCAPES' */ SELECT 1`,
    ]) {
      expect(calls(`${statement}; ${backslash}`, mysql84).slice(1), statement).toEqual([false]);
    }
  });

  it('reads MySQL SQL after an unclear change of sql_mode in each quoting mode', () => {
    const unclear = [
      'SET sql_mode = @saved',
      "SET sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')",
      'SET sql_mode = DEFAULT',
      "SET sql_mode = 'ANSI QUOTES'",
      'SET STATEMENT max_statement_time = 10 FOR SET sql_mode = @saved',
      "EXECUTE IMMEDIATE 'SET sql_mode = @saved'",
      "PREPARE m FROM 'SET sql_mode = @saved'; EXECUTE m",
    ];
    for (const statement of unclear) {
      const before = calls(statement);
      // Without a backslash after it, every mode reads the SQL the same.
      expect(mySqlStatements(`${statement}; CALL p()`), statement).toEqual({
        calls: [...before, true],
        uncounted: false,
        sql: `${statement}; CALL p()`,
      });
      // Every mode ends this string, and the comment after it, in the same place.
      expect(
        calls(String.raw`${statement}; SELECT 'C:\\tmp' AS path /* CALL syntax note */; CALL p()`),
        statement,
      ).toEqual([...before, false, true]);
      // A mode that would leave the string open is not the server's, since it would reject it.
      expect(calls(String.raw`${statement}; SELECT 'a\'; CALL p()`), statement).toEqual([
        ...before,
        false,
        true,
      ]);
      // The modes read different statements, none of them a CALL, so they are not counted.
      expect(mySqlStatements(String.raw`${statement}; SELECT 'a\';\''; SELECT 2`)).toEqual({
        calls: before,
        uncounted: true,
        sql: String.raw`${statement}; SELECT 'a\';\''; SELECT 2`,
      });
      // A CALL among them cannot be grouped, so the SQL is refused before it runs.
      expect(() => mySqlStatements(String.raw`${statement}; SELECT 'a\';\''; CALL p()`)).toThrow(
        'cannot tell where the statements of this MySQL SQL end',
      );
    }
    // A backslash in a comment changes nothing.
    expect(calls('SET sql_mode = @saved; -- C:\\path\nCALL p()')).toEqual([false, true]);
    // A version comment may run a CALL right after its digits.
    expect(() =>
      mySqlStatements(String.raw`SET sql_mode = @saved; SELECT 'a\';\''; /*!80000CALL p() */`),
    ).toThrow('cannot tell where the statements of this MySQL SQL end');
    // So may a compound statement, which MariaDB runs outside a stored program.
    expect(() =>
      mySqlStatements(
        String.raw`SET sql_mode = @saved; SELECT 'a\';\''; IF 1 THEN SELECT 1; END IF`,
      ),
    ).toThrow('cannot tell where the statements of this MySQL SQL end');
    // A SET of a quoted list of modes makes the mode clear again.
    expect(
      mySqlStatements(
        String.raw`SET sql_mode = @saved; CALL p(); SET sql_mode = ''; SELECT 'a\'; CALL q()'`,
      ),
    ).toEqual({
      calls: [false, true, false, false],
      uncounted: false,
      sql: String.raw`SET sql_mode = @saved; CALL p(); SET sql_mode = ''; SELECT 'a\'; CALL q()'`,
    });
    // Comments after the last statement are left out where every mode ends it in the same place.
    expect(
      mySqlStatements(String.raw`SET sql_mode = @saved; SELECT 'a\';\''; SELECT 2; -- end`).sql,
    ).toBe(String.raw`SET sql_mode = @saved; SELECT 'a\';\''; SELECT 2;`);
    // Ways of reading the SQL that prepare different statements are followed without reading the
    // rest again for each combination of them.
    const forks = Array.from(
      { length: 40 },
      (_, index) => `SET sql_mode = @m; PREPARE s${index} FROM "SELECT 1";`,
    ).join(' ');
    const started = performance.now();
    expect(
      mySqlStatements(String.raw`SET sql_mode = @m; SELECT 'a\';' ; ${forks} SELECT 1`).uncounted,
    ).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
    // Where the modes read different statements, a statement prepared before them, or among
    // them the same way in every mode, is still known.
    for (const sql of [
      String.raw`PREPARE s FROM 'SELECT 1'; SET sql_mode = @m; SELECT 'a\';\''; EXECUTE s`,
      String.raw`SET sql_mode = @m; SELECT 'a\';\''; SELECT 2; PREPARE g FROM 'SELECT 1'; EXECUTE g`,
      String.raw`PREPARE g FROM 'SELECT 1'; SET sql_mode = @m; SELECT 'a\';\''; PREPARE g FROM 'SELECT 2'; EXECUTE g`,
      // A double-quoted text names no statement in ANSI_QUOTES mode, which the server rejects.
      String.raw`SET sql_mode = @m; SELECT 'a\';\''; PREPARE g FROM "SELECT 1"; EXECUTE g`,
    ]) {
      expect(mySqlStatements(sql).uncounted, sql).toBe(true);
    }
    // One prepared differently from before is forgotten.
    expect(() =>
      mySqlStatements(
        String.raw`PREPARE g FROM 'SELECT 1'; SET sql_mode = @m; SELECT 'a\';\''; PREPARE g FROM 'SET sql_mode = ''ANSI'''; EXECUTE g`,
      ),
    ).toThrow('cannot tell whether an EXECUTE in this MySQL SQL runs a CALL');
    // A mode in which the server rejects a statement is not the server's.
    expect(calls('SET sql_mode = DEFAULT; PREPARE s FROM "CALL p()"; EXECUTE s; SELECT 3')).toEqual(
      [false, false, true, false],
    );
    // Here one mode reads a comment after the last statement and the other reads a string.
    expect(() =>
      mySqlStatements(String.raw`SET sql_mode = @saved; SELECT '\'; -- '; SELECT 1`),
    ).toThrow(
      'cannot tell whether the comments after its last statement return a result of their own',
    );
    // At least one statement follows, so results that end before it do not line up.
    expect(
      groupResults(
        [[{ a: 1 }], header, header],
        [[field], undefined, undefined],
        String.raw`CALL p(); SET sql_mode = @saved; SELECT 'a\';\''`,
      ),
    ).toEqual([
      { results: [{ a: 1 }], success: true, meta: {} },
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
    // Statements that are not CALLs each return one result.
    expect(
      groupResults(
        [[{ a: 1 }], header, header, [{ b: 1 }], [{ c: 2 }]],
        [[field], undefined, undefined, [field], [field]],
        String.raw`CALL p(); SET sql_mode = @saved; SELECT 'a\';\''; SELECT 2`,
      ),
    ).toEqual([
      { results: [{ a: 1 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [{ b: 1 }], success: true, meta: {} },
      { results: [{ c: 2 }], success: true, meta: {} },
    ]);
  });

  it('leaves out MySQL comments after the last statement, which return a result of their own', () => {
    const mysql84 = mySqlServerMode([{ sql_mode: '', version: '8.4.3' }]);
    expect(mySqlStatements('CALL p(); -- end of script')).toEqual({
      calls: [true],
      uncounted: false,
      sql: 'CALL p();',
    });
    for (const [sql, sent] of [
      ['SELECT 1; /* a */ # b\n', 'SELECT 1;'],
      ['SELECT 1; -- note\n;', 'SELECT 1;'],
      ['SELECT 1;/*+ hint */', 'SELECT 1;'],
      ['SELECT 1; /*!99999 SELECT 2 */', 'SELECT 1;'],
      ['SELECT 1; /*! */', 'SELECT 1;'],
      ['SELECT 1; --', 'SELECT 1;'],
      // Whitespace and semicolons alone return nothing, and a comment before the end of a
      // statement is part of it.
      ['SELECT 1;\n\n', 'SELECT 1;\n\n'],
      ['SELECT 1;;', 'SELECT 1;;'],
      ['SELECT 1 -- note', 'SELECT 1 -- note'],
      ['SELECT 1; /*!80000 SELECT 2 */', 'SELECT 1; /*!80000 SELECT 2 */'],
      // The server rejects a comment left open, and a cut in a running executable comment would
      // leave that open.
      ['SELECT 1; /* open', 'SELECT 1; /* open'],
      ['SELECT 1 /*!40101 ; */ -- note', 'SELECT 1 /*!40101 ; */ -- note'],
    ]) {
      expect(mySqlStatements(sql, mysql84).sql, sql).toBe(sent);
    }
    expect(calls('SELECT 1; /*!80000 SELECT 2 */', mysql84)).toEqual([false, false]);
    expect(
      groupResults(
        [[{ a: 1 }], [{ b: 2 }], header],
        [[field], [field], undefined],
        'CALL p(); -- end of script',
      ),
    ).toEqual([
      { results: [{ a: 1 }, { b: 2 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
    // SQL that holds only comments has no statement, though the server answers it.
    expect(mySqlStatements('-- nothing here')).toEqual({
      calls: [],
      uncounted: false,
      sql: '-- nothing here',
    });
    expect(groupResults(header, undefined, '-- nothing here')).toEqual([]);
  });

  it('groups the results of a prepared MySQL CALL under its EXECUTE', () => {
    const mysql84 = mySqlServerMode([{ sql_mode: '', version: '8.4.3' }]);
    const mariaDb = mySqlServerMode([{ sql_mode: '', version: '11.4.4-MariaDB' }]);
    expect(
      calls("PREPARE s FROM 'CALL p()'; EXECUTE s; EXECUTE s USING @a; SELECT 1; EXECUTE s"),
    ).toEqual([false, true, true, false, true]);
    expect(calls("PREPARE s FROM 'SELECT 1'; EXECUTE s")).toEqual([false, false]);
    // Names are not case-sensitive, and a double-quoted string is a string.
    expect(calls('PREPARE `S` FROM "CALL p()"; EXECUTE s')).toEqual([false, true]);
    expect(calls(String.raw`PREPARE s FROM 'CALL p(''a'', \'b\')'; EXECUTE s`)).toEqual([
      false,
      true,
    ]);
    expect(calls("PREPARE s FROM '-- note\nCALL p()'; EXECUTE s")).toEqual([false, true]);
    // The statement reads the way the server does, executable comments too.
    expect(calls("PREPARE s FROM '/*!80000 CALL p() */'; EXECUTE s", mysql84)).toEqual([
      false,
      true,
    ]);
    expect(calls("PREPARE s FROM '/*!80000 CALL p() */'; EXECUTE s", mariaDb)).toEqual([
      false,
      false,
    ]);
    // A later PREPARE of the name replaces the statement.
    expect(calls("PREPARE s FROM 'CALL p()'; PREPARE s FROM 'SELECT 1'; EXECUTE s")).toEqual([
      false,
      false,
      false,
    ]);
    // MariaDB's EXECUTE IMMEDIATE runs the text it is given, and SET STATEMENT the statement
    // after FOR.
    expect(
      calls(
        "EXECUTE IMMEDIATE 'CALL p()'; EXECUTE IMMEDIATE 'CALL p(?)' USING 1; EXECUTE IMMEDIATE 'SELECT 1'",
      ),
    ).toEqual([true, true, false]);
    expect(
      calls(
        "SET STATEMENT max_statement_time = 10 FOR CALL p(); PREPARE s FROM 'CALL p()'; SET STATEMENT max_statement_time = 10 FOR EXECUTE s",
      ),
    ).toEqual([true, false, true]);
    // A prepared SET of sql_mode changes it when EXECUTE runs it.
    expect(
      calls(
        String.raw`PREPARE m FROM 'SET sql_mode = ''NO_BACKSLASH_ESCAPES'''; EXECUTE m; SELECT '\'; CALL p()`,
      ),
    ).toEqual([false, false, false, true]);
    expect(
      groupResults(
        [header, [{ a: 1 }], [{ b: 2 }], header, [{ c: 3 }]],
        [undefined, [field], [field], undefined, [field]],
        "PREPARE s FROM 'CALL p()'; EXECUTE s; SELECT 3",
      ),
    ).toEqual([
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [{ a: 1 }, { b: 2 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [{ c: 3 }], success: true, meta: {} },
    ]);
  });

  it('refuses MySQL SQL that executes a statement it cannot see', () => {
    for (const sql of [
      'EXECUTE s',
      "SET @q = 'CALL p()'; PREPARE s FROM @q; EXECUTE s",
      "PREPARE s FROM CONCAT('CALL ', 'p()'); EXECUTE s",
      "PREPARE s FROM 'CALL p()' 'x'; EXECUTE s",
      "PREPARE s FROM 'SELECT 1'; DEALLOCATE PREPARE s; EXECUTE s",
      "PREPARE s FROM 'SELECT 1'; DROP PREPARE s; EXECUTE s",
      // A procedure may prepare a statement under the same name, though not the one that runs it.
      "PREPARE s FROM 'SELECT 1'; CALL p(); EXECUTE s",
      "PREPARE s FROM 'SELECT 1'; PREPARE c FROM 'CALL p()'; EXECUTE c; EXECUTE s",
      "PREPARE s FROM 'SELECT 1'; EXECUTE IMMEDIATE 'CALL p()'; EXECUTE s",
      "PREPARE s FROM 'SELECT 1'; IF 1 THEN CALL p(); END IF; EXECUTE s",
      'SET STATEMENT max_statement_time = 10 FOR EXECUTE s',
      "EXECUTE IMMEDIATE CONCAT('CALL ', 'p()')",
      'EXECUTE IMMEDIATE @q',
      // In MySQL, IMMEDIATE can name a prepared statement.
      'EXECUTE immediate USING @a',
    ]) {
      expect(() => mySqlStatements(sql), sql).toThrow(
        'cannot tell whether an EXECUTE in this MySQL SQL runs a CALL',
      );
    }
    // Statements that prepare or deallocate return one result each.
    expect(calls('PREPARE s FROM @q; DEALLOCATE PREPARE s; SELECT 1')).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('keeps a stored program body that is a single compound statement together', () => {
    for (const program of [
      'CREATE PROCEDURE p() IF 1 THEN SELECT 1; SELECT 2; END IF',
      "CREATE PROCEDURE p() COMMENT 'x;' DETERMINISTIC IF (1) THEN SELECT 1; ELSE SELECT 2; END IF",
      'CREATE PROCEDURE IF NOT EXISTS p() IF NOT EXISTS (SELECT 1) THEN SELECT 1; SELECT 2; END IF',
      'CREATE DEFINER = CURRENT_USER PROCEDURE db.p(IN a INT) READS SQL DATA SQL SECURITY INVOKER CASE a WHEN 1 THEN SELECT 1; SELECT 2; ELSE BEGIN END; END CASE',
      'CREATE PROCEDURE p() lbl: LOOP SELECT 1; LEAVE lbl; END LOOP lbl',
      'CREATE PROCEDURE p() comment: LOOP SELECT 1; LEAVE comment; END LOOP',
      'CREATE PROCEDURE p() REPEAT SELECT 1; UNTIL 1 END REPEAT',
      'CREATE PROCEDURE p() WHILE (0) DO SELECT 1; END WHILE',
      'CREATE PROCEDURE p() FOR i IN 1..3 DO SELECT i; END FOR',
      'CREATE PROCEDURE p() IF a THEN IF (b) THEN SELECT 1; END IF; SELECT 2; ELSE BEGIN SELECT 3; END; END IF',
      'CREATE PROCEDURE p() IF a THEN SELECT CASE WHEN b THEN 1 END; ELSEIF c THEN CASE WHEN d THEN SELECT 2; END CASE; END IF',
      'CREATE FUNCTION f(a INT) RETURNS INT DETERMINISTIC IF a > 0 THEN RETURN 1; ELSE RETURN 0; END IF',
      "CREATE FUNCTION f(a INT) RETURNS VARCHAR(10) CHARACTER SET utf8mb4 DETERMINISTIC IF a > 0 THEN RETURN 'y'; END IF",
      'CREATE FUNCTION f() RETURNS INT lbl: BEGIN RETURN 1; END lbl',
      'CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW IF NEW.a < 0 THEN SET NEW.a = 0; END IF',
      'CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW FOLLOWS t0 IF NEW.a < 0 THEN SET NEW.a = 0; END IF',
      'CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO IF 1 THEN DELETE FROM a; DELETE FROM b; END IF',
      'ALTER EVENT e DO WHILE 0 DO DELETE FROM a; END WHILE',
      // IF() and REPEAT() are functions, and IF EXISTS is part of a statement.
      'CREATE PROCEDURE p() SELECT IF(a, 1, 2), REPEAT(b, 2) FROM t FOR UPDATE',
      'CREATE FUNCTION f(a INT) RETURNS INT DETERMINISTIC RETURN IF(a > 0, 1, 0)',
      'CREATE PROCEDURE p() BEGIN DROP TABLE IF EXISTS t; CREATE TABLE IF NOT EXISTS t (a INT); SELECT IF(1, 2, 3); END',
      // A CASE expression ends at its END, whatever follows it.
      'CREATE PROCEDURE p() BEGIN SELECT CASE WHEN a THEN 1 END FOR UPDATE; SELECT 2; END',
      // A handler's statement may be a compound statement of its own.
      'CREATE PROCEDURE p() BEGIN DECLARE CONTINUE HANDLER FOR NOT FOUND IF 1 THEN SET @a = 1; END IF; SELECT 1; END',
      // MariaDB's Oracle mode ends a WHILE loop with END LOOP.
      'CREATE PROCEDURE p AS BEGIN WHILE a LOOP SELECT 1; END LOOP; END',
    ]) {
      expect(calls(`${program}; CALL p()`), program).toEqual([false, true]);
    }
  });

  it('groups the results of a compound statement MariaDB runs outside a stored program', () => {
    for (const statement of [
      'BEGIN NOT ATOMIC SELECT 1; SELECT 2; END',
      'BEGIN NOT ATOMIC BEGIN SELECT 1; END; IF 1 THEN SELECT 2; END IF; END',
      'BEGIN NOT ATOMIC DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END; START TRANSACTION; SELECT 1; COMMIT; END',
      'IF 1 THEN SELECT 1; SELECT 2; END IF',
      'CASE WHEN 1 THEN SELECT 1; END CASE',
      'FOR i IN 1..2 DO SELECT i; END FOR',
      'WHILE 0 DO SELECT 1; END WHILE',
      'REPEAT SELECT 1; UNTIL 1 END REPEAT',
    ]) {
      expect(calls(`${statement}; SELECT 3`), statement).toEqual([true, false]);
    }
    expect(
      groupResults(
        [[{ a: 1 }], [{ b: 2 }], header, [{ c: 3 }]],
        [[field], [field], undefined, [field]],
        'IF 1 THEN SELECT 1; SELECT 2; END IF; SELECT 3',
      ),
    ).toEqual([
      { results: [{ a: 1 }, { b: 2 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [{ c: 3 }], success: true, meta: {} },
    ]);
  });

  it('reads a word right after an @ as a name', () => {
    // `@case` is a user variable, and the words after `@@` and in `@x.case` are names too.
    expect(calls('SELECT @case AS n; CALL p()')).toEqual([false, true]);
    expect(
      calls('SELECT @begin, @end, @if, @loop, @while, @repeat, @for, @do, @x.case; CALL p()'),
    ).toEqual([false, true]);
    expect(calls('SET @@session.sql_mode = @@sql_mode; SELECT @@begin; CALL p()')).toEqual([
      false,
      false,
      true,
    ]);
    expect(calls('CREATE PROCEDURE q() BEGIN SET @end = 1; SELECT @begin; END; CALL p()')).toEqual([
      false,
      true,
    ]);
    expect(
      groupResults(
        [[{ n: null }], [{ a: 1 }], [{ b: 2 }], header],
        [[field], [field], [field], undefined],
        'SELECT @case AS n; CALL p()',
      ),
    ).toEqual([
      { results: [{ n: null }], success: true, meta: {} },
      { results: [{ a: 1 }, { b: 2 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });

  it('reads begin, end and do as names where a stored program body uses them so', () => {
    for (const program of [
      'CREATE PROCEDURE q() BEGIN SELECT begin, end, do FROM t; END',
      'CREATE PROCEDURE q() BEGIN SELECT 1 AS begin; SELECT 2 AS end; SELECT 3 do; END',
      'CREATE PROCEDURE q() SELECT 1 AS begin',
      'CREATE PROCEDURE q() BEGIN SELECT end AS end FROM t; UPDATE t SET end = 2 WHERE begin = 1; END',
      'CREATE PROCEDURE q() BEGIN SELECT 1 FROM t WHERE end IS NOT NULL; END',
      // A CASE expression ends at an END after an operand, and holds `end` columns elsewhere.
      'CREATE PROCEDURE q() BEGIN SELECT CASE WHEN 1 THEN end END FROM t; END',
      'CREATE PROCEDURE q() BEGIN SELECT CASE end WHEN 2 THEN begin ELSE - end END FROM t; END',
      'CREATE PROCEDURE q() BEGIN SELECT CASE WHEN end = 2 THEN (SELECT end FROM t) END end FROM t; END',
      'CREATE PROCEDURE q() BEGIN SELECT CASE WHEN EXISTS (SELECT end FROM t) THEN 1 END; END',
      'CREATE PROCEDURE q() BEGIN SELECT CASE WHEN t.end > 0 THEN t.case END FROM t; END',
      // So does a REPEAT's UNTIL condition.
      'CREATE PROCEDURE q() BEGIN DECLARE end INT DEFAULT 0; REPEAT SET end = end + 1; UNTIL end END REPEAT; END',
      'CREATE PROCEDURE q() BEGIN REPEAT SELECT end FROM t; UNTIL end > 1 END REPEAT; END',
      // A WHILE's DO comes after its condition.
      'CREATE PROCEDURE q() BEGIN DECLARE do INT DEFAULT 0; WHILE do DO SET do = 0; END WHILE; END',
      'CREATE PROCEDURE q() BEGIN WHILE (SELECT do FROM t) = 0 DO SELECT 1; END WHILE; SELECT do FROM t; END',
      // Names of routines, parameters and variables.
      'CREATE PROCEDURE begin() BEGIN SELECT 1; END',
      'CREATE PROCEDURE do() BEGIN SELECT 1; END',
      'CREATE PROCEDURE q(begin INT, end INT) BEGIN SELECT begin + end; END',
      'CREATE PROCEDURE q() BEGIN DECLARE begin INT DEFAULT 1; DECLARE end INT DEFAULT 2; SET begin = end; END',
      'CREATE EVENT do ON SCHEDULE EVERY 1 DAY DO BEGIN SELECT 1; SELECT 2; END',
      'CREATE TRIGGER begin BEFORE INSERT ON begin FOR EACH ROW BEGIN SET NEW.end = 1; END',
      // A handler's statement starts after its conditions.
      "CREATE PROCEDURE q() BEGIN DECLARE c CONDITION FOR SQLSTATE '45000'; DECLARE CONTINUE HANDLER FOR c BEGIN END; DECLARE EXIT HANDLER FOR SQLSTATE VALUE '23000', 1062, NOT FOUND, SQLWARNING BEGIN SELECT 9; END; SELECT 1; END",
      'CREATE PROCEDURE q() BEGIN DECLARE CONTINUE HANDLER FOR SQLEXCEPTION IF 1 THEN SELECT 1; END IF; SELECT 2; END',
    ]) {
      expect(calls(`${program}; CALL p()`), program).toEqual([false, true]);
    }
    expect(
      groupResults(
        [header, [{ a: 1 }], [{ b: 2 }], header],
        [undefined, [field], [field], undefined],
        'CREATE PROCEDURE q() BEGIN SELECT begin, end FROM t; END; CALL p()',
      ),
    ).toEqual([
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [{ a: 1 }, { b: 2 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });

  it('reads the account in DEFINER = account as a name', () => {
    for (const program of [
      'CREATE DEFINER = user@localhost PROCEDURE q() BEGIN SELECT 1; SELECT 2; END',
      'CREATE DEFINER=event@localhost PROCEDURE q() BEGIN SELECT 1; END',
      'CREATE DEFINER = user PROCEDURE q() BEGIN SELECT 1; END',
      'CREATE DEFINER = user@local.host FUNCTION f() RETURNS INT BEGIN RETURN 1; END',
      'CREATE DEFINER = `table`@`localhost` TRIGGER t BEFORE INSERT ON a FOR EACH ROW BEGIN SET NEW.a = 1; END',
      'CREATE OR REPLACE DEFINER = role EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM a; END',
      'ALTER DEFINER = user@localhost EVENT e DO BEGIN DELETE FROM a; END',
    ]) {
      expect(calls(`${program}; CALL p()`), program).toEqual([false, true]);
    }
    // A view is not a stored program, so a BEGIN after it starts a transaction.
    expect(
      calls(
        'CREATE ALGORITHM = MERGE DEFINER = user@localhost SQL SECURITY INVOKER VIEW v AS SELECT 1; BEGIN; CALL p()',
      ),
    ).toEqual([false, false, true]);
  });

  it("reads square-bracket names in MariaDB's MSSQL mode", () => {
    const mssql = mySqlServerMode([
      { sql_mode: 'PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,MSSQL', version: '11.4.4-MariaDB' },
    ]);
    expect(mssql).toMatchObject({ ansiQuotes: true, brackets: true, mariaDb: true });
    const mariaDb = mySqlServerMode([{ sql_mode: '', version: '11.4.4-MariaDB' }]);
    // MySQL 5.7's MSSQL mode quotes nothing in brackets.
    expect(mySqlServerMode([{ sql_mode: 'MSSQL', version: '5.7.44' }]).brackets).toBe(false);
    expect(needsMySqlServerMode('SELECT [a] FROM t')).toBe(true);
    for (const sql of [
      'SELECT [case] FROM t; CALL p()',
      'SELECT [a;b] FROM t; CALL p()',
      // `]]` stands for `]`, and a backslash escapes nothing.
      'SELECT [a]]b;] FROM t; CALL p()',
      String.raw`SELECT [x\], 'it''s' FROM t; CALL p()`,
      'SELECT [x\'y], [x"y], [x`y], [x/*y], [x-- y] FROM t; CALL p()',
    ]) {
      expect(calls(sql, mssql), sql).toEqual([false, true]);
    }
    expect(calls("PREPARE [S] FROM 'CALL p()'; EXECUTE s", mssql)).toEqual([false, true]);
    // A name in brackets is no statement to prepare, so the server rejects the PREPARE.
    expect(calls('SET sql_mode = @m; PREPARE s FROM [CALL p()]; SELECT 1', mariaDb)).toEqual([
      false,
      false,
      false,
    ]);
    // A SET of sql_mode turns the brackets on and off.
    expect(
      calls("SET sql_mode = 'MSSQL'; SELECT [a;b]; SET sql_mode = ''; CALL p()", mariaDb),
    ).toEqual([false, false, false, true]);
    // After an unclear change, only the mode that reads the brackets as a name is the server's,
    // since the server rejects a `[` that quotes nothing.
    expect(calls('SET sql_mode = @m; SELECT [case] FROM t; CALL p()', mariaDb)).toEqual([
      false,
      false,
      true,
    ]);
    expect(
      groupResults(
        [[{ case: 4 }], [{ a: 1 }], [{ b: 2 }], header],
        [[field], [field], [field], undefined],
        'SELECT [case] FROM t; CALL p()',
        mssql,
      ),
    ).toEqual([
      { results: [{ case: 4 }], success: true, meta: {} },
      { results: [{ a: 1 }, { b: 2 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });
});
