import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'pathslash';
import { searchForWorkspaceRoot } from 'vite';

/** Directories never part of the app source, whatever their position. */
const alwaysSkipped = new Set(['node_modules']);

/** Beside the generated types, which the scaffold already ignores. */
const CACHE_FILE = '.void/pages-build-id.json';

/** Workspace files that pin what the installed packages contain. */
const WORKSPACE_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

const HEX_DIGITS = '0123456789abcdef';

/** Twelve lowercase hex digits, the shape `contentIdOf` makes. */
function isBuildId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 12) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    if (!HEX_DIGITS.includes(value.charAt(index))) {
      return false;
    }
  }
  return true;
}

type CacheEntry = {
  fingerprint: string;
  id: string;
};

export type PagesBuildInputs = {
  /** Env values the client inlines. They belong to the build, like a source file. */
  env?: string;
  /** The app's `define` entries, which the client inlines too. */
  define?: string;
};

/**
 * The id each app root got in the current build. Vite resolves the config again
 * for every environment, with new plugin instances, and the values it sees can
 * differ between those passes: a define such as `Date.now()`, or a file another
 * task writes meanwhile. The first pass decides, so both bundles get one id.
 */
const currentBuildIds = new Map<string, string>();

/**
 * A stable id for one build of an app: a hash of what its bundles are made of.
 * Every environment of a Vite build derives the same id from the same tree,
 * which a per-process random value cannot guarantee.
 *
 * The hash covers the app folder, the workspace packages it depends on (found
 * through its installed links, transitively), and the workspace manifest and
 * lockfile, since a dependency upgrade renames chunks without touching the app.
 * Modules imported by a relative path from outside all of these are not seen.
 *
 * The id changes with any change there, including server-only ones, which
 * reloads a stale tab that did not need it. That is the safe direction: missing
 * a change means importing chunks that no longer exist.
 *
 * Hashing contents is cached across processes, keyed by file size and
 * modification time. A write always moves the modification time, so a
 * fingerprint that still matches describes the same content.
 */
export function computePagesBuildId(
  root: string,
  excludeDirs: Array<string>,
  inputs: PagesBuildInputs = {},
): string {
  const current = currentBuildIds.get(root);
  if (current !== undefined) {
    return current;
  }
  const workspace = searchForWorkspaceRoot(root);
  const excluded = new Set(excludeDirs.map((dir) => (isAbsolute(dir) ? dir : join(root, dir))));
  const files = buildSourceFiles(root, workspace, excluded);
  const buildInputs = `${inputs.env ?? ''}\0${inputs.define ?? ''}`;
  const fingerprint = fingerprintOf(workspace, files, buildInputs);
  let id = readCachedId(root, fingerprint);
  if (id === null) {
    id = contentIdOf(workspace, files, buildInputs);
    writeCachedId(root, fingerprint, id);
  }
  currentBuildIds.set(root, id);
  return id;
}

/** Ends the current build of `root`, or of every app, so the next build hashes again. */
export function endPagesBuild(root?: string): void {
  if (root === undefined) {
    currentBuildIds.clear();
  } else {
    currentBuildIds.delete(root);
  }
}

/** Paths, relative to the workspace, of every file the id covers, sorted. */
function buildSourceFiles(root: string, workspace: string, excluded: Set<string>): Array<string> {
  const files = new Set<string>();
  const add = (directory: string) => {
    for (const file of sourceFiles(directory, excluded)) {
      files.add(relative(workspace, file));
    }
  };
  add(root);
  for (const directory of workspaceDependencies(root, workspace)) {
    add(directory);
  }
  if (workspace !== root) {
    for (const name of WORKSPACE_FILES) {
      if (existsSync(join(workspace, name))) {
        files.add(name);
      }
    }
  }
  return [...files].sort();
}

/** Real path, or null when it cannot be resolved. */
function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function dependencyNames(directory: string): Array<string> {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const names: Array<string> = [];
    for (const field of DEPENDENCY_FIELDS) {
      const deps = manifest[field];
      if (deps !== null && typeof deps === 'object') {
        names.push(...Object.keys(deps));
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Folders of the workspace packages `root` depends on, directly or through other
 * workspace packages. Package managers link them into node_modules, and the link
 * leads back into the workspace outside any node_modules.
 */
function workspaceDependencies(root: string, workspace: string): Array<string> {
  const realWorkspace = realPath(workspace);
  const realRoot = realPath(root);
  if (realWorkspace === null || realRoot === null) {
    return [];
  }
  const seen = new Set<string>([realRoot]);
  const found: Array<string> = [];
  const queue = [realRoot];
  for (let directory = queue.shift(); directory !== undefined; directory = queue.shift()) {
    for (const name of dependencyNames(directory)) {
      const target =
        realPath(join(directory, 'node_modules', name)) ??
        realPath(join(realWorkspace, 'node_modules', name));
      if (target === null || seen.has(target)) {
        continue;
      }
      const inWorkspace = relative(realWorkspace, target);
      if (
        inWorkspace.startsWith('..') ||
        isAbsolute(inWorkspace) ||
        inWorkspace.split('/').includes('node_modules')
      ) {
        continue;
      }
      seen.add(target);
      found.push(join(workspace, inWorkspace));
      queue.push(target);
    }
  }
  return found;
}

/**
 * Dot directories hold tool state (.git, .void, .wrangler), and .env files hold
 * local settings, whose client values reach the id through `inputs.env`. Other
 * dot files can configure the build (.postcssrc, .browserslistrc), so they count.
 */
function isSkipped(name: string, isDirectory: boolean): boolean {
  if (alwaysSkipped.has(name)) {
    return true;
  }
  if (!name.startsWith('.')) {
    return false;
  }
  return isDirectory || name.startsWith('.env') || name === '.DS_Store';
}

/** Absolute paths of the files under `directory` that describe it. */
function sourceFiles(directory: string, excluded: Set<string>): Array<string> {
  const files: Array<string> = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // A folder the build cannot read (a database volume, a root-owned cache)
      // cannot feed the bundle either.
      return;
    }
    for (const entry of entries) {
      if (isSkipped(entry.name, entry.isDirectory())) {
        continue;
      }
      const path = join(current, entry.name);
      if (excluded.has(path)) {
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
  walk(directory);
  return files;
}

function fingerprintOf(workspace: string, files: Array<string>, inputs: string): string {
  const hash = createHash('sha256');
  hash.update(inputs);
  hash.update('\0');
  for (const file of files) {
    try {
      const stats = statSync(join(workspace, file));
      hash.update(`${file}\0${stats.size}\0${stats.mtimeMs}\0`);
    } catch {
      // Removed since the walk.
      hash.update(`${file}\0-\0`);
    }
  }
  return hash.digest('hex');
}

function contentIdOf(workspace: string, files: Array<string>, inputs: string): string {
  const hash = createHash('sha256');
  hash.update(inputs);
  hash.update('\0');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    try {
      hash.update(readFileSync(join(workspace, file)));
    } catch {
      // Removed or unreadable since the walk: the bundle cannot read it either.
      hash.update('-');
    }
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/** The last id, when the tree still looks the way it did when the id was made. */
function readCachedId(root: string, fingerprint: string): string | null {
  try {
    const entry = JSON.parse(readFileSync(join(root, CACHE_FILE), 'utf8')) as Partial<CacheEntry>;
    if (entry.fingerprint === fingerprint && isBuildId(entry.id)) {
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
