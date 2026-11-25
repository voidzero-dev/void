import { types } from 'pg';
import { describe, expect, it } from 'vite-plus/test';
import {
  formatStatementResults,
  mySqlCallStatements,
  mySqlStatementResults,
  pgJsonTypes,
  pgStatementResults,
  splitSqliteStatements,
} from '../../src/cli/db-execute-results.ts';
import { Buffer } from '../../src/cli/node-buffer.ts';

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
    // A trigger missing its END stays open for SQLite to report.
    expect(
      splitSqliteStatements('CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1;'),
    ).toHaveLength(1);
  });

  // The shapes mysql2 resolves `query()` to, as `[rows, fields]`.
  const field = { name: 'a', columnType: 3 };
  const header = { fieldCount: 0, affectedRows: 2, insertId: 5, info: '', serverStatus: 2 };

  it('reads a single MySQL statement', () => {
    expect(mySqlStatementResults([{ a: 1 }], [field], 'SELECT 1')).toEqual([
      { results: [{ a: 1 }], success: true, meta: {} },
    ]);
    expect(mySqlStatementResults([], [field], 'SELECT 1')).toEqual([
      { results: [], success: true, meta: {} },
    ]);
    expect(mySqlStatementResults(header, undefined, 'DELETE FROM a')).toEqual([
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });

  it('reads each MySQL statement of a multi-statement query', () => {
    expect(
      mySqlStatementResults(
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
      mySqlStatementResults([[{ a: 1 }], [{ a: 2 }]], [[field], [field]], 'SELECT 1; SELECT 2'),
    ).toEqual([
      { results: [{ a: 1 }], success: true, meta: {} },
      { results: [{ a: 2 }], success: true, meta: {} },
    ]);
  });

  it("groups a CALL's result sets and header under the CALL", () => {
    expect(mySqlStatementResults([[{ a: 1 }], header], [[field], undefined], 'CALL p()')).toEqual([
      { results: [{ a: 1 }], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
    expect(
      mySqlStatementResults(
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
    expect(
      mySqlStatementResults([[{ a: 1 }], header], [[field], undefined], 'CALL p(); CALL q()'),
    ).toEqual([
      { results: [{ a: 1 }], success: true, meta: {} },
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });

  it('reads MySQL comments and quoted text the way MySQL does', () => {
    expect(mySqlCallStatements('# note\nCALL report()')).toEqual([true]);
    expect(mySqlCallStatements(String.raw`SELECT 'it\'s; ok'; CALL p()`)).toEqual([false, true]);
    expect(mySqlCallStatements(String.raw`SELECT "a\";b"; CALL p()`)).toEqual([false, true]);
    // `--` starts a comment only before whitespace, so `1--1` is arithmetic.
    expect(mySqlCallStatements('SELECT 1--1; -- x;\nCALL p()')).toEqual([false, true]);
    // MySQL runs the SQL in a `/*!` comment, and `[` quotes nothing.
    expect(mySqlCallStatements('/*!40101 SET @a = 1 */; SELECT [1; CALL p()')).toEqual([
      false,
      false,
      true,
    ]);
    expect(
      mySqlStatementResults([[{ a: 1 }], header], [[field], undefined], '# note\nCALL report()'),
    ).toEqual([{ results: [{ a: 1 }], success: true, meta: { affectedRows: 2, insertId: 5 } }]);
  });

  it('finds MySQL statements around stored program bodies', () => {
    expect(
      mySqlCallStatements(
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
});
