import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
// oxlint-disable-next-line import/no-namespace -- Drizzle consumes the full schema module with its relations.
import * as schema from '../../src/schema.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));
const TEMPLATE_VERSION = '3';

function walkFiles(dir: string): Array<string> {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const files: Array<string> = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
      continue;
    }
    if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

function getTemplateHash(): string {
  const hash = createHash('sha256');
  hash.update(TEMPLATE_VERSION);

  for (const file of walkFiles(MIGRATIONS_DIR)) {
    hash.update(relative(MIGRATIONS_DIR, file));
    hash.update(readFileSync(file));
  }

  return hash.digest('hex').slice(0, 16);
}

const TEMPLATE_BUNDLE_PATH = join(tmpdir(), `void-api-pglite-${getTemplateHash()}.tar`);

async function buildTemplateBundle(path: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  // Persist a timezone-independent default in the dump, rather than capturing
  // the creating process's local timezone (including its DST offset).
  const db = new PGlite({ postgresqlconf: "timezone = 'UTC'", relaxedDurability: true });

  try {
    await migrate(drizzle(db, { schema }), { migrationsFolder: MIGRATIONS_DIR });
    const dump = await db.dumpDataDir('none');
    await writeFile(tempPath, new Uint8Array(await dump.arrayBuffer()));
    try {
      await rename(tempPath, path);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw error;
      }
    }
  } finally {
    await db.close();
  }
}

export async function ensurePGliteTemplateBundlePath(): Promise<string> {
  try {
    await access(TEMPLATE_BUNDLE_PATH);
    return TEMPLATE_BUNDLE_PATH;
  } catch {
    await buildTemplateBundle(TEMPLATE_BUNDLE_PATH);
    return TEMPLATE_BUNDLE_PATH;
  }
}

export async function loadPGliteTemplateBundle(): Promise<Blob> {
  const path = await ensurePGliteTemplateBundlePath();
  return new Blob([await readFile(path)]);
}
