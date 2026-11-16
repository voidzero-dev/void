import { splitMigrationSql } from './migration-handler.ts';

/**
 * Splits a MySQL migration file into the statements Void runs one query at a time. Hyperdrive
 * does not accept several statements in one query, and a file that runs statement by statement
 * can tell whether a failure left earlier statements committed.
 *
 * The file first splits at drizzle-kit `--> statement-breakpoint` lines. Each part then splits at
 * semicolons outside strings, quoted names and comments, and drops comments after its last
 * statement. A statement that defines a trigger, routine or event keeps the rest of its part with
 * it: the semicolons in its BEGIN ... END body cannot be told apart from the ones between
 * statements without a parser.
 */
export function splitMySqlMigrationSql(sql: string): Array<string> {
  return splitMySqlMigrationStatements(sql).map((statement) => statement.sql);
}

/**
 * A statement from {@link splitMySqlMigrationSql}. `program` marks one that opens a trigger,
 * routine, event or other compound statement, and so also holds the rest of its part.
 */
export type MySqlMigrationStatement = { sql: string; program: boolean };

/** {@link splitMySqlMigrationSql}, with each statement marked. */
export function splitMySqlMigrationStatements(sql: string): Array<MySqlMigrationStatement> {
  return splitMigrationSql(sql).flatMap((part) => {
    const statements = splitMySqlStatements(part);
    return statements.length > 0 ? statements : [{ sql: part, program: false }];
  });
}

/** Words after CREATE or ALTER that name an object without a BEGIN ... END body. */
const PLAIN_OBJECTS =
  'TABLE|INDEX|VIEW|DATABASE|SCHEMA|USER|ROLE|TABLESPACE|SERVER|UNIQUE|FULLTEXT|SPATIAL|TEMPORARY';

/**
 * The start of a statement whose body can hold semicolons: a stored program, after options such
 * as DEFINER, or a compound statement that MariaDB also runs outside one. It is matched against
 * the statement with quoted text and comments blanked out, so a column named `event` or a plain
 * `BEGIN` transaction does not match.
 */
const COMPOUND_START = new RegExp(
  [
    `^\\s*(?:CREATE|ALTER)\\s+(?:(?!(?:${PLAIN_OBJECTS})\\b)\\S+\\s+){0,8}?(?:TRIGGER|PROCEDURE|FUNCTION|EVENT|PACKAGE)\\b`,
    '^\\s*BEGIN\\s+NOT\\s+ATOMIC\\b',
    '^\\s*(?:\\w+\\s*:\\s*)?(?:BEGIN|IF|CASE|LOOP|REPEAT|WHILE)\\b(?!\\s*(?:WORK\\s*)?$)',
  ].join('|'),
  'i',
);

/** The statements in `sql`, without the comments around them. */
function splitMySqlStatements(sql: string): Array<MySqlMigrationStatement> {
  const statements: Array<MySqlMigrationStatement> = [];
  // The current statement with quoted text and comments blanked out.
  let bare = '';
  // Where the current statement starts and ends, or -1 before its first character.
  let start = -1;
  let end = -1;
  // Set once a statement opens a BEGIN ... END body: the rest of the part stays with it.
  let compound = false;
  let index = 0;
  const take = (from: number, to: number) => {
    if (start === -1) {
      start = from;
    }
    end = to;
  };

  while (index < sql.length) {
    const character = sql[index]!;
    const next = sql[index + 1];

    if (character === "'" || character === '"' || character === '`') {
      const close = skipQuoted(sql, index, character);
      take(index, close);
      bare += ' ';
      index = close;
      continue;
    }
    // MySQL reads `--` as a comment only when whitespace or a control character follows it.
    if (
      character === '#' ||
      (character === '-' && next === '-' && !/\S/.test(sql[index + 2] ?? ' '))
    ) {
      const newline = sql.indexOf('\n', index);
      index = newline === -1 ? sql.length : newline;
      bare += ' ';
      continue;
    }
    if (character === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2);
      const commentEnd = close === -1 ? sql.length : close + 2;
      // `/*! ... */` is SQL that MySQL runs, and `/*+ ... */` holds optimizer hints.
      if (sql[index + 2] === '!' || sql[index + 2] === '+') {
        take(index, commentEnd);
      }
      bare += ' ';
      index = commentEnd;
      continue;
    }
    if (character === ';' && !compound) {
      if (start !== -1 && COMPOUND_START.test(bare)) {
        compound = true;
      } else {
        if (start !== -1) {
          statements.push({ sql: sql.slice(start, index + 1), program: false });
        }
        start = -1;
        end = -1;
        bare = '';
        index++;
        continue;
      }
    }

    bare += character;
    if (!/\s/.test(character)) {
      take(index, index + 1);
    }
    index++;
  }

  if (start !== -1) {
    statements.push({ sql: sql.slice(start, end), program: compound });
  }
  return statements;
}

/** The index after the quoted string or name that opens at `open`. */
function skipQuoted(sql: string, open: number, quote: string): number {
  let index = open + 1;
  while (index < sql.length) {
    const character = sql[index];
    // Backslash escapes apply in strings, not in backtick-quoted names.
    if (character === '\\' && quote !== '`') {
      index += 2;
      continue;
    }
    if (character === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index++;
  }
  return sql.length;
}
