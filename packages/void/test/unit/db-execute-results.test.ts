import { describe, expect, it } from 'vite-plus/test';
import {
  formatStatementResults,
  mySqlStatementResults,
  pgStatementResults,
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

  // The shapes mysql2 resolves `query()` to, as `[rows, fields]`.
  const field = { name: 'a', columnType: 3 };
  const header = { fieldCount: 0, affectedRows: 2, insertId: 5, info: '', serverStatus: 2 };

  it('reads a single MySQL statement', () => {
    expect(mySqlStatementResults([{ a: 1 }], [field])).toEqual([
      { results: [{ a: 1 }], success: true, meta: {} },
    ]);
    expect(mySqlStatementResults([], [field])).toEqual([{ results: [], success: true, meta: {} }]);
    expect(mySqlStatementResults(header, undefined)).toEqual([
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
    ]);
  });

  it('reads each MySQL statement of a multi-statement query', () => {
    expect(mySqlStatementResults([header, [{ a: 1 }], []], [undefined, [field], [field]])).toEqual([
      { results: [], success: true, meta: { affectedRows: 2, insertId: 5 } },
      { results: [{ a: 1 }], success: true, meta: {} },
      { results: [], success: true, meta: {} },
    ]);
    expect(mySqlStatementResults([[{ a: 1 }], [{ a: 2 }]], [[field], [field]])).toEqual([
      { results: [{ a: 1 }], success: true, meta: {} },
      { results: [{ a: 2 }], success: true, meta: {} },
    ]);
  });
});
