import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'pathslash';

/** Directories never part of the app source, whatever their position. */
const alwaysSkipped = new Set(['node_modules']);

/** Beside the generated types, which the scaffold already ignores. */
const CACHE_FILE = '.void/pages-build-id.json';

const ID_PATTERN = /^[0-9a-f]{12}$/;

type CacheEntry = {
  fingerprint: string;
  id: string;
};

/**
 * A stable id for one build of an app: a hash of its source files. Every
 * environment of a Vite build derives the same id from the same tree, which a
 * per-process random value cannot guarantee, since Vite may resolve the config
 * once per environment.
 *
 * The id changes with any source change, including server-only ones, which
 * reloads a stale tab that did not need it. That is the safe direction: missing
 * the id means importing chunks that no longer exist.
 *
 * Resolving the config per environment means hashing the tree twice. The cache
 * turns the second pass into one stat walk, keyed by file size and modification
 * time. A write always moves the modification time, so a fingerprint that still
 * matches describes the same content.
 */
export function computePagesBuildId(root: string, excludeDirs: Array<string>): string {
  const excluded = new Set(excludeDirs.map((dir) => (isAbsolute(dir) ? dir : join(root, dir))));
  const files = sourceFiles(root, excluded);
  const fingerprint = fingerprintOf(root, files);
  const cached = readCachedId(root, fingerprint);
  if (cached) {
    return cached;
  }
  const id = contentIdOf(root, files);
  writeCachedId(root, fingerprint, id);
  return id;
}

/** Relative paths of the files under `root` that describe the app, sorted. */
function sourceFiles(root: string, excluded: Set<string>): Array<string> {
  const files: Array<string> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      // Dot directories hold tool state (.git, .void, .wrangler), and dot files
      // hold local settings such as .env that a deploy must not depend on.
      if (entry.name.startsWith('.') || alwaysSkipped.has(entry.name)) {
        continue;
      }
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (excluded.has(join(root, path))) {
        continue;
      }
      // Symlinked directories are not followed: they can leave the tree.
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  walk('');
  return files.sort();
}

function fingerprintOf(root: string, files: Array<string>): string {
  const hash = createHash('sha256');
  for (const file of files) {
    const stats = statSync(join(root, file));
    hash.update(`${file}\0${stats.size}\0${stats.mtimeMs}\0`);
  }
  return hash.digest('hex');
}

function contentIdOf(root: string, files: Array<string>): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/** The last id, when the tree still looks the way it did when the id was made. */
function readCachedId(root: string, fingerprint: string): string | null {
  try {
    const entry = JSON.parse(readFileSync(join(root, CACHE_FILE), 'utf8')) as Partial<CacheEntry>;
    if (
      entry.fingerprint === fingerprint &&
      typeof entry.id === 'string' &&
      ID_PATTERN.test(entry.id)
    ) {
      return entry.id;
    }
  } catch {
    // No cache, unreadable cache, or a cache from another tool: hash the tree.
  }
  return null;
}

function writeCachedId(root: string, fingerprint: string, id: string): void {
  try {
    const path = join(root, CACHE_FILE);
    mkdirSync(join(root, '.void'), { recursive: true });
    writeFileSync(path, JSON.stringify({ fingerprint, id } satisfies CacheEntry));
  } catch {
    // A read-only tree still builds; it just pays for the second pass.
  }
}
