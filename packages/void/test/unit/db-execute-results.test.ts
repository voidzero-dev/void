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
      mariaDb: false,
    });
    const noEscapes = mySqlServerMode([
      { sql_mode: 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES', version: '8.4.3' },
    ]);
    expect(noEscapes).toEqual({
      version: 80_403,
      backslashEscapes: false,
      ansiQuotes: false,
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
    // MariaDB runs BEGIN NOT ATOMIC blocks outside a stored program.
    expect(calls('BEGIN NOT ATOMIC SELECT 1; SELECT 2; END; CALL p()')).toEqual([false, true]);
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
      expect(calls(`${statement}; ${backslash}`, mysql84), statement).toEqual([false, false]);
    }
  });

  it('stops reading MySQL SQL where an unclear change of sql_mode matters', () => {
    const unclear = [
      'SET sql_mode = @saved',
      "SET sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')",
      'SET sql_mode = DEFAULT',
      "SET sql_mode = 'ANSI QUOTES'",
      'EXECUTE set_mode',
      "EXECUTE IMMEDIATE 'SET sql_mode = ''NO_BACKSLASH_ESCAPES'''",
      'SET STATEMENT max_statement_time = 10 FOR EXECUTE set_mode',
    ];
    for (const statement of unclear) {
      // Without a backslash after it, every mode reads the SQL the same.
      expect(mySqlStatements(`${statement}; CALL p()`), statement).toEqual({
        calls: [false, true],
        uncounted: false,
      });
      // After a backslash, the statements cannot be counted, but none of them is a CALL.
      expect(mySqlStatements(String.raw`${statement}; SELECT 1; SELECT 'a\'; SELECT 2`)).toEqual({
        calls: [false, false],
        uncounted: true,
      });
      // A CALL that may follow it cannot be grouped, so the SQL is refused before it runs.
      expect(() => mySqlStatements(String.raw`${statement}; SELECT 'a\'; CALL p()`)).toThrow(
        'cannot tell where this MySQL SQL',
      );
    }
    // A backslash in a comment, or a word that only holds the letters of CALL, changes nothing.
    expect(mySqlStatements('SET sql_mode = @saved; -- C:\\path\nCALL p()')).toEqual({
      calls: [false, true],
      uncounted: false,
    });
    expect(
      mySqlStatements(
        String.raw`SET sql_mode = @saved; SELECT 'a\b' AS recall; SELECT called_at FROM t`,
      ),
    ).toEqual({ calls: [false], uncounted: true });
    // A version comment may run a CALL right after its digits.
    expect(() =>
      mySqlStatements(String.raw`SET sql_mode = @saved; SELECT 'a\b'; /*!80000CALL p() */`),
    ).toThrow('cannot tell where this MySQL SQL');
    // A SET of a quoted list of modes makes the mode clear again.
    expect(
      mySqlStatements(
        String.raw`SET sql_mode = @saved; CALL p(); SET sql_mode = ''; SELECT 'a\'; CALL q()'`,
      ),
    ).toEqual({ calls: [false, true, false, false], uncounted: false });
    // At least one statement follows, so results that end before it do not line up.
    expect(
      groupResults(
        [[{ a: 1 }], header, header],
        [[field], undefined, undefined],
        String.raw`CALL p(); SET sql_mode = @saved; SELECT 'a\b'`,
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
        String.raw`CALL p(); SET sql_mode = @saved; SELECT 'a\'b'; SELECT 2`,
      ),
    ).toEqual([
      { results: [{ a: 1 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [{ b: 1 }], success: true, meta: {} },
      { results: [{ c: 2 }], success: true, meta: {} },
    ]);
  });
});
