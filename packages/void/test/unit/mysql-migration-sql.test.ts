import { describe, expect, it } from 'vite-plus/test';
import { splitMySqlMigrationSql } from '../../src/runtime/db/migrations/mysql-sql.ts';

describe('splitMySqlMigrationSql', () => {
  it('splits a file without breakpoints at its semicolons', () => {
    expect(
      splitMySqlMigrationSql(
        '-- comments\nCREATE TABLE comments (id int primary key);\nALTER TABLE c ADD COLUMN n int;\n',
      ),
    ).toEqual(['CREATE TABLE comments (id int primary key);', 'ALTER TABLE c ADD COLUMN n int;']);
  });

  it('splits each breakpoint part, and keeps a statement without a semicolon', () => {
    expect(
      splitMySqlMigrationSql(
        'CREATE TABLE `a` (`id` int);--> statement-breakpoint\nINSERT INTO a VALUES (1); INSERT INTO a VALUES (2)\n--> statement-breakpoint\nCREATE INDEX `a_id` ON `a` (`id`)',
      ),
    ).toEqual([
      'CREATE TABLE `a` (`id` int);',
      'INSERT INTO a VALUES (1);',
      'INSERT INTO a VALUES (2)',
      'CREATE INDEX `a_id` ON `a` (`id`)',
    ]);
  });

  it('keeps semicolons inside strings, quoted names and comments', () => {
    const statements = [
      "INSERT INTO t (s) VALUES ('a;b', 'it''s;', 'it\\'s; \\\\', \"x;y\");",
      // A backslash does not escape in a quoted name.
      'CREATE TABLE `dir\\` (id int);',
      'CREATE TABLE `odd;name` (`a``;b` int); # trailing; comment',
      'UPDATE t SET n = 5--3; -- 5 minus -3; then a comment',
      'SELECT 1 /* a; b */ + 1;',
    ];
    expect(splitMySqlMigrationSql(statements.join('\n'))).toEqual([
      "INSERT INTO t (s) VALUES ('a;b', 'it''s;', 'it\\'s; \\\\', \"x;y\");",
      'CREATE TABLE `dir\\` (id int);',
      'CREATE TABLE `odd;name` (`a``;b` int);',
      'UPDATE t SET n = 5--3;',
      'SELECT 1 /* a; b */ + 1;',
    ]);
  });

  // MySQL runs `/*! ... */`, so it is a statement, not a comment to drop.
  it('keeps an executable comment as a statement', () => {
    expect(splitMySqlMigrationSql('SELECT 1;\n/*!40101 SET @x = 1 */;\n-- end')).toEqual([
      'SELECT 1;',
      '/*!40101 SET @x = 1 */;',
    ]);
  });

  it('keeps a trigger, routine or event together with the rest of its part', () => {
    const trigger =
      'CREATE TRIGGER c_bump BEFORE INSERT ON c FOR EACH ROW BEGIN SET NEW.v = NEW.v + 1; END;';
    expect(splitMySqlMigrationSql(`CREATE TABLE c (v int);\n${trigger}`)).toEqual([
      'CREATE TABLE c (v int);',
      trigger,
    ]);
    // Without a parser, the end of the body is unknown, so what follows in the part stays with it.
    expect(
      splitMySqlMigrationSql(
        `${trigger}\nINSERT INTO c VALUES (1);\n--> statement-breakpoint\nSELECT 1;`,
      ),
    ).toEqual([`${trigger}\nINSERT INTO c VALUES (1);`, 'SELECT 1;']);
    const procedure =
      "create definer = `root`@'%' /* x; */ procedure p() begin select 1; select 2; end";
    expect(splitMySqlMigrationSql(`-- p\n${procedure} -- done`)).toEqual([procedure]);
    const event =
      'ALTER EVENT e DO BEGIN DELETE FROM a; DELETE FROM b; END;\nCREATE FUNCTION f() RETURNS int RETURN 1;';
    expect(splitMySqlMigrationSql(event)).toEqual([event]);
  });

  // MariaDB also runs compound statements outside a stored program.
  it('keeps a compound statement outside a stored program together with the rest of its part', () => {
    for (const statement of [
      'BEGIN NOT ATOMIC INSERT INTO a VALUES (1); INSERT INTO a VALUES (2); END;',
      'fill: LOOP INSERT INTO a VALUES (1); LEAVE fill; END LOOP fill;',
      'IF (SELECT COUNT(*) FROM a) = 0 THEN INSERT INTO a VALUES (1); END IF;',
    ]) {
      const part = `${statement}\nSELECT 1;`;
      expect(splitMySqlMigrationSql(part)).toEqual([part]);
    }
  });

  // A whole part with several statements cannot run where one query takes one statement.
  it('splits statements that only use those keywords as names or transactions', () => {
    expect(
      splitMySqlMigrationSql(
        "CREATE TABLE logs (id int, event varchar(20), begin int);\nINSERT INTO `begin` VALUES ('BEGIN');\nCREATE INDEX trigger ON event (id);",
      ),
    ).toEqual([
      'CREATE TABLE logs (id int, event varchar(20), begin int);',
      "INSERT INTO `begin` VALUES ('BEGIN');",
      'CREATE INDEX trigger ON event (id);',
    ]);
    expect(
      splitMySqlMigrationSql(
        'BEGIN;\nINSERT INTO a VALUES (1);\nCOMMIT;\nDROP PROCEDURE IF EXISTS p;',
      ),
    ).toEqual(['BEGIN;', 'INSERT INTO a VALUES (1);', 'COMMIT;', 'DROP PROCEDURE IF EXISTS p;']);
    expect(splitMySqlMigrationSql('BEGIN WORK;\nINSERT INTO a VALUES (1);\nCOMMIT WORK;')).toEqual([
      'BEGIN WORK;',
      'INSERT INTO a VALUES (1);',
      'COMMIT WORK;',
    ]);
  });

  it('sends a part with only comments as it is', () => {
    expect(splitMySqlMigrationSql('-- Custom SQL migration file, put your code below! --')).toEqual(
      ['-- Custom SQL migration file, put your code below! --'],
    );
  });
});
