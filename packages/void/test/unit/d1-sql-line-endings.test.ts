import { expect, it } from 'vite-plus/test';
import { normalizeD1SqlLineEndings } from '../../src/cli/d1-sql-line-endings.ts';

it('turns CRLF in a trigger body into LF and keeps it inside a string', () => {
  expect(
    normalizeD1SqlLineEndings(
      "CREATE TRIGGER trg BEFORE DELETE ON probe_z\r\nBEGIN\r\n  SELECT RAISE(ABORT, 'no\r\nchange');\r\nEND;",
    ),
  ).toBe(
    "CREATE TRIGGER trg BEFORE DELETE ON probe_z\nBEGIN\n  SELECT RAISE(ABORT, 'no\r\nchange');\nEND;",
  );
});

it('keeps CRLF inside quoted values and identifiers, and normalizes comments', () => {
  const sql =
    "SELECT 'single''quote\r\nvalue', \"double\r\nquote\", `backtick\r\nquote`, [bracket\r\nquote]; -- don't stop scanning\r\n/* block\r\ncomment */\r\nSELECT 1;";
  expect(normalizeD1SqlLineEndings(sql)).toBe(
    "SELECT 'single''quote\r\nvalue', \"double\r\nquote\", `backtick\r\nquote`, [bracket\r\nquote]; -- don't stop scanning\n/* block\ncomment */\nSELECT 1;",
  );
});

it.each([
  // A bracket identifier ends at the first `]`; `]]` is not an escape in SQLite.
  ['SELECT [a]]\r\nFROM t', 'SELECT [a]]\nFROM t'],
  // A doubled quote stays inside the string.
  ["SELECT 'it''s\r\n'\r\n", "SELECT 'it''s\r\n'\n"],
  // A quote inside a comment does not start a string.
  ["-- it's\r\nSELECT 1\r\n", "-- it's\nSELECT 1\n"],
  ["/* it's */\r\nSELECT 1", "/* it's */\nSELECT 1"],
  // Unterminated text is copied as is.
  ["SELECT 'open\r\n", "SELECT 'open\r\n"],
  ['/* open\r\n', '/* open\n'],
  // A lone CR or LF is left alone.
  ['SELECT 1\rSELECT 2\n', 'SELECT 1\rSELECT 2\n'],
  ['SELECT 1 - -1\r\n', 'SELECT 1 - -1\n'],
])('normalizes %j', (sql, expected) => {
  expect(normalizeD1SqlLineEndings(sql)).toBe(expected);
});
