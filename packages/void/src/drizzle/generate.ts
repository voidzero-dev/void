import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'pathslash';
import { collectMigrations } from '../migrations/collect.ts';
import { openMigrationValidationDatabase } from '../migrations/sqlite-validation.ts';

function snapshotFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        files.set(path, readFileSync(path));
      }
    }
  }
  return files;
}

function listFiles(dir: string, suffix: string): Set<string> {
  return new Set(existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(suffix)) : []);
}

const bestEffort = (step: () => void): void => {
  try {
    step();
  } catch {
    // The drizzle-kit failure is the error worth reporting.
  }
};

/**
 * Record the Drizzle outputs under `migrationsDir` and return a rollback for a
 * failed `drizzle-kit generate`, so partial files cannot fail the journal check
 * of later `void db` commands.
 */
export function snapshotDrizzleOutputs(migrationsDir: string): () => void {
  const metaDir = join(migrationsDir, 'meta');
  const journalPath = join(metaDir, '_journal.json');
  const metaDirExisted = existsSync(metaDir);
  const journal = existsSync(journalPath) ? readFileSync(journalPath) : null;
  const snapshots = listFiles(metaDir, '_snapshot.json');
  const sqlFiles = listFiles(migrationsDir, '.sql');
  const removeNewFiles = (dir: string, suffix: string, before: Set<string>): void => {
    for (const file of listFiles(dir, suffix)) {
      if (!before.has(file)) {
        bestEffort(() => unlinkSync(join(dir, file)));
      }
    }
  };

  return () => {
    if (metaDirExisted) {
      if (journal !== null) {
        bestEffort(() => writeFileSync(journalPath, journal));
      }
      bestEffort(() => removeNewFiles(metaDir, '_snapshot.json', snapshots));
    } else {
      bestEffort(() => rmSync(metaDir, { recursive: true, force: true }));
    }
    // Keep a new migrations directory so a retry can reuse it.
    bestEffort(() => removeNewFiles(migrationsDir, '.sql', sqlFiles));
  };
}

/** Keep SQL and Drizzle's snapshot/journal together when generation fails validation. */
export async function generateValidatedSqliteMigrations(
  migrationsDir: string,
  generate: () => void,
): Promise<void> {
  // An existing invalid migration needs repair; generating from its target snapshot cannot fix it.
  try {
    (await openMigrationValidationDatabase(collectMigrations(migrationsDir))).close();
  } catch (cause) {
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)}\n` +
        'Repair the unapplied migration before generating again. Drizzle diffs snapshots; rerunning generation does not repair existing SQL.',
      { cause },
    );
  }

  const existed = existsSync(migrationsDir);
  const previous = snapshotFiles(migrationsDir);
  let generated = false;
  try {
    generate();
    generated = true;
    (await openMigrationValidationDatabase(collectMigrations(migrationsDir))).close();
  } catch (cause) {
    if (!existed) {
      rmSync(migrationsDir, { recursive: true, force: true });
    } else {
      for (const path of snapshotFiles(migrationsDir).keys()) {
        if (!previous.has(path)) {
          rmSync(path);
        }
      }
      for (const [path, contents] of previous) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
      }
    }
    const advice = generated
      ? ' Review the schema change before retrying. For additive changes, use an additive migration rather than rebuilding existing tables.'
      : '';
    throw new Error(
      `${cause instanceof Error ? cause.message : String(cause)}\n` +
        `Migration generation failed. The previous SQL, snapshots and journal were restored.${advice}`,
      { cause },
    );
  }
}
