import { existsSync, readdirSync } from 'node:fs';
import { hasStandalonePragma } from '@void/deploy-core';
import { join } from 'pathslash';
import {
  readJournal,
  stripSqlExt,
  type DrizzleJournal,
  type DrizzleJournalEntry,
} from './collect.ts';
import { DESTRUCTIVE_PRAGMA, getExecutableSql } from './plan.ts';

export type MigrationFile = {
  name: string;
  sql: string;
  destructive: boolean;
};

/**
 * Destructive SQL patterns that are rejected unless the migration
 * contains the `-- void:allow-destructive` pragma comment.
 */
const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+VIEW\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bDROP\s+TRIGGER\b/i,
  /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i,
  /\bALTER\s+TABLE\b[\s\S]*\bRENAME\b[\s\S]*\bTO\b/i,
  /\bTRUNCATE\b/i,
  /\bINSERT\s+OR\s+REPLACE\b/i,
];

function splitExecutableStatements(sql: string): Array<string> {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function hasTopLevelKeyword(statement: string, keyword: string): boolean {
  let depth = 0;
  for (let index = 0; index < statement.length; index++) {
    const character = statement[index];
    if (character === '(') {
      depth++;
      continue;
    }
    if (character === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (
      statement.slice(index, index + keyword.length).toUpperCase() === keyword &&
      !/[A-Z0-9_]/i.test(statement[index - 1] ?? '') &&
      !/[A-Z0-9_]/i.test(statement[index + keyword.length] ?? '')
    ) {
      return true;
    }
  }
  return false;
}

function hasUnboundedWrite(statement: string): boolean {
  // Referential actions in table definitions are not UPDATE/DELETE statements.
  // ALTER TABLE ADD ... REFERENCES may declare them outside parentheses, too.
  if (/^(?:CREATE\s+(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?|ALTER\s+)TABLE\b/i.test(statement)) {
    return false;
  }
  if (/\bDELETE\s+FROM\b/i.test(statement)) {
    return !hasTopLevelKeyword(statement, 'WHERE');
  }
  if (/\bUPDATE\b[\s\S]*\bSET\b/i.test(statement)) {
    return !hasTopLevelKeyword(statement, 'WHERE');
  }
  return false;
}

/**
 * Check if a SQL migration contains destructive operations.
 */
export function isDestructive(sql: string): boolean {
  const executable = getExecutableSql(sql.replaceAll(/\r\n?/g, '\n'));
  return splitExecutableStatements(executable).some((statement) => {
    return (
      DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(statement)) ||
      hasUnboundedWrite(statement)
    );
  });
}

/**
 * Validate migration files. Returns the validated list with destructive flags.
 * Throws if any destructive migration lacks the allow-destructive pragma.
 */
export function validateMigrations(
  files: Array<{ name: string; sql: string }>,
): Array<MigrationFile> {
  const results: Array<MigrationFile> = [];
  const errors: Array<string> = [];

  for (const file of files) {
    const destructive = isDestructive(file.sql);
    if (destructive && !hasStandalonePragma(file.sql, DESTRUCTIVE_PRAGMA)) {
      errors.push(file.name);
    }
    results.push({ name: file.name, sql: file.sql, destructive });
  }

  if (errors.length > 0) {
    throw new Error(
      `Destructive migrations detected without pragma:\n` +
        errors.map((f) => `  - ${f}`).join('\n') +
        `\n\nAdd "${DESTRUCTIVE_PRAGMA}" to each file to allow the migration locally and on deploy.`,
    );
  }

  return results;
}

/**
 * Enumerate drizzle-kit metadata artifacts in a migrations directory.
 * Returns repo-relative paths like `db/migrations/meta/0000_snapshot.json`
 * and `db/migrations/migrations.js`, passed through `sourceRelative` so they
 * include the configured `sourceDir`. Empty when none are present.
 *
 * Shared across `assertJournalCoherence`, `void gen migration`, and
 * `void db rename-migrations` so all three agree on what counts as a
 * "partial drizzle-kit state" (journal gone but other metadata lingering).
 */
export function listDrizzleArtifacts(
  migrationsDir: string,
  sourceRelative: (path: string) => string = (path) => path,
): Array<string> {
  const metaDir = join(migrationsDir, 'meta');
  const snapshotFiles = existsSync(metaDir)
    ? readdirSync(metaDir).filter((f) => f.endsWith('_snapshot.json'))
    : [];
  const bundledPath = join(migrationsDir, 'migrations.js');
  const out: Array<string> = [];
  for (const f of snapshotFiles) {
    out.push(sourceRelative(`db/migrations/meta/${f}`));
  }
  if (existsSync(bundledPath)) {
    out.push(sourceRelative('db/migrations/migrations.js'));
  }
  return out;
}

/**
 * Assert that every `.sql` file under `migrationsDir` has a matching entry
 * in `meta/_journal.json`, and vice versa.
 *
 * The runners apply files from disk, but `drizzle-kit generate` only sees the
 * journal, so an orphan file would reach D1 without Drizzle knowing about it.
 *
 * A missing journal (with no other drizzle-kit artifacts) is not drift:
 * hand-written `.sql` projects without `db/schema.ts` are supported and are
 * tracked by filename in `_void_migrations`. They cannot run
 * `void db generate`, so the check is skipped for them.
 *
 * `sourceRelative` (`ProjectPaths.sourceRelative`) adds the configured
 * `sourceDir` to the paths in error messages.
 */
export function assertJournalCoherence(
  migrationsDir: string,
  collected: Array<{ name: string; sql: string }>,
  sourceRelative: (path: string) => string = (path) => path,
): void {
  const dir = sourceRelative('db/migrations');
  const journal = readJournal(migrationsDir, sourceRelative);
  const drizzleArtifacts = listDrizzleArtifacts(migrationsDir, sourceRelative);

  // `undefined` means the file is absent. Parseable scalars such as `null` or
  // `false` are malformed journals, not missing ones, so avoid a falsy check.
  if (journal === undefined) {
    // Leftover snapshots or `migrations.js` mean a half-deleted drizzle-kit
    // state, not a hand-written project.
    if (drizzleArtifacts.length > 0) {
      throw new Error(
        [
          `${dir}/meta/_journal.json is missing, but other drizzle-kit metadata is still present:`,
          ...drizzleArtifacts.map((p) => `  - ${p}`),
          '',
          'This is a partial drizzle-kit state. Restore _journal.json from version control, or delete the orphaned metadata files above if you intended to revert to hand-written migrations.',
        ].join('\n'),
      );
    }
    return;
  }

  // `readJournal` only guarantees valid JSON. `version` and `dialect` are
  // required because `void db rename-migrations` writes them back verbatim.
  if (
    journal === null ||
    typeof journal !== 'object' ||
    Array.isArray(journal) ||
    typeof (journal as DrizzleJournal).version !== 'string' ||
    typeof (journal as DrizzleJournal).dialect !== 'string' ||
    !Array.isArray((journal as DrizzleJournal).entries)
  ) {
    throw new Error(
      `${dir}/meta/_journal.json is malformed: expected an object with string \`version\`, string \`dialect\`, and an \`entries\` array. Restore the file from version control, or delete it if you intended to revert to hand-written migrations.`,
    );
  }

  // `void gen migration` and `void db rename-migrations` read these entry
  // fields back when rewriting the journal (next `idx`, inherited `version`
  // and `breakpoints`, `tag` as the key).
  for (let i = 0; i < journal.entries.length; i++) {
    const entry = journal.entries[i];
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof (entry as DrizzleJournalEntry).idx !== 'number' ||
      typeof (entry as DrizzleJournalEntry).version !== 'string' ||
      typeof (entry as DrizzleJournalEntry).tag !== 'string' ||
      typeof (entry as DrizzleJournalEntry).breakpoints !== 'boolean'
    ) {
      throw new Error(
        `${dir}/meta/_journal.json is malformed: entry at index ${i} is missing required fields (\`idx\`, \`version\`, \`tag\`, \`breakpoints\`). Restore the file from version control, or delete it if you intended to revert to hand-written migrations.`,
      );
    }
  }

  // An empty placeholder journal with no drizzle-kit artifacts is treated like
  // a missing journal (hand-written `.sql` files, as in the kitchen-sink
  // playground). With artifacts left over, it is a half-deleted state.
  if (journal.entries.length === 0) {
    if (drizzleArtifacts.length === 0) {
      return;
    }
    throw new Error(
      [
        `${dir}/meta/_journal.json has no entries, but drizzle-kit metadata is still present:`,
        ...drizzleArtifacts.map((p) => `  - ${p}`),
        '',
        'This is a partial drizzle-kit state. Restore _journal.json from version control (or run `void db generate`), or delete the orphaned metadata files above if you intended to revert to hand-written migrations.',
      ].join('\n'),
    );
  }

  // The Set-based diff below would hide duplicate tags, and
  // `rename-migrations` would rewrite both copies to the same new tag.
  const tagCounts = new Map<string, number>();
  for (const entry of journal.entries) {
    tagCounts.set(entry.tag, (tagCounts.get(entry.tag) ?? 0) + 1);
  }
  const duplicateTags = [...tagCounts.entries()].filter(([, n]) => n > 1).map(([tag]) => tag);
  if (duplicateTags.length > 0) {
    throw new Error(
      [
        `${dir}/meta/_journal.json has duplicate migration entries:`,
        ...duplicateTags.map((t) => `  - ${t} (appears ${tagCounts.get(t)} times)`),
        '',
        'Each migration must have a unique tag. Restore _journal.json from version control, or hand-edit to remove the duplicates.',
      ].join('\n'),
    );
  }

  const journalTags = new Set(journal.entries.map((e) => e.tag));
  const collectedTags = new Set(collected.map((m) => stripSqlExt(m.name)));

  const orphans = collected
    .map((m) => m.name)
    .filter((name) => !journalTags.has(stripSqlExt(name)));
  const missing = journal.entries
    .filter((e) => !collectedTags.has(e.tag))
    .map((e) => `${e.tag}.sql`);

  if (orphans.length === 0 && missing.length === 0) {
    return;
  }

  const lines: Array<string> = [
    `Migration drift detected between ${dir}/ and ${dir}/meta/_journal.json.`,
  ];
  if (orphans.length > 0) {
    lines.push('', 'These files exist on disk but are not tracked in _journal.json:');
    for (const f of orphans) {
      lines.push(`  - ${dir}/${f}`);
    }
    lines.push(
      '',
      `Delete the orphan file(s), or move their contents into \`${sourceRelative('db/schema.ts')}\` and re-run \`void db generate\`.`,
    );
  }
  if (missing.length > 0) {
    lines.push('', 'These entries are in _journal.json but the matching file is missing:');
    for (const f of missing) {
      lines.push(`  - ${dir}/${f}`);
    }
    lines.push('', 'Restore the missing file(s) from version control, or regenerate migrations.');
  }
  throw new Error(lines.join('\n'));
}
