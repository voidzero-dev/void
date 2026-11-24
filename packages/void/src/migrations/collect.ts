import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'pathslash';

/**
 * Collect all .sql migration files from the migrations directory,
 * sorted by filename (lexicographic order).
 */
export function collectMigrations(migrationsDir: string): Array<{ name: string; sql: string }> {
  if (!existsSync(migrationsDir)) {
    return [];
  }

  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && f !== 'seed.sql')
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(migrationsDir, name), 'utf8'),
    }));
}

export type DrizzleJournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

export type DrizzleJournal = {
  version: string;
  dialect: string;
  entries: Array<DrizzleJournalEntry>;
};

/**
 * Read `db/migrations/meta/_journal.json` if it exists. Drizzle maintains
 * this file whenever `drizzle-kit generate` runs; every `.sql` migration
 * under `db/migrations/` should correspond to an entry whose `tag` is the
 * filename without the `.sql` suffix. `sourceRelative` adds the configured
 * `sourceDir` to the path in the parse error.
 */
export function readJournal(
  migrationsDir: string,
  sourceRelative: (path: string) => string = (path) => path,
): DrizzleJournal | undefined {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(journalPath, 'utf8')) as DrizzleJournal;
  } catch (err) {
    throw new Error(
      `db: Failed to parse ${sourceRelative('db/migrations/meta/_journal.json')}: '${(err as Error).message}'.`,
      { cause: err },
    );
  }
}

/**
 * Write `db/migrations/meta/_journal.json` with pretty-printed JSON and a
 * trailing newline, matching the format Drizzle itself emits. Creates the
 * `meta/` directory if it does not yet exist.
 */
export function writeJournal(migrationsDir: string, journal: DrizzleJournal): void {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
}

/**
 * Drop the `.sql` extension from a migration filename, leaving any other
 * suffix untouched. Used to line filenames up with journal `tag` values.
 */
export function stripSqlExt(name: string): string {
  return name.endsWith('.sql') ? name.slice(0, -4) : name;
}
