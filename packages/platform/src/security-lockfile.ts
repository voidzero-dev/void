/**
 * Third-party code by package identity (design doc 0095 M10), shared by the CLI at deploy
 * and the API that drops registry packages from a scan input. A package seen as both
 * local and registry is local: code that may be the owner's is never dropped.
 */

import { isRecord } from './validate.ts';

export type SecurityPackageSource = 'registry' | 'local';

/** Package name → where the lockfile says it comes from. */
export type SecurityLockfileIndex = ReadonlyMap<string, SecurityPackageSource>;

/** Lockfiles the readers understand, in the order a directory is searched. */
export const SECURITY_LOCKFILE_NAMES: ReadonlyArray<string> = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
];

/** Package names one deploy may claim, at most (the deploy body stays small). */
export const SECURITY_PACKAGE_CLAIMS_MAX = 5000;
/** npm's own limit on a package name. */
const MAX_PACKAGE_NAME = 214;

/**
 * What a deploy sends (`securityPackages`): the packages its Worker bundle's source maps
 * name, as the project's lockfile resolves them. Names it cannot place are left out.
 */
export type SecurityPackageClaims = Readonly<{
  registry: ReadonlyArray<string>;
  local: ReadonlyArray<string>;
}>;

/** The package a path sits in: the part after its last `node_modules/`. */
export function packageNameOfPath(path: string): string | null {
  const segments = path.split('/');
  const last = segments.lastIndexOf('node_modules');
  if (last === -1) {
    return null;
  }
  const first = segments[last + 1];
  if (!first || first.startsWith('.')) {
    return null;
  }
  if (first.startsWith('@')) {
    const second = segments[last + 2];
    return second ? `${first}/${second}` : null;
  }
  return first;
}

function sourceOfSpecifier(version: string): SecurityPackageSource {
  const local =
    ['link:', 'file:', 'workspace:', 'git'].some((prefix) => version.startsWith(prefix)) ||
    version.includes('://');
  return local ? 'local' : 'registry';
}

function record(
  index: Map<string, SecurityPackageSource>,
  name: string,
  source: SecurityPackageSource,
) {
  if (index.get(name) !== 'local') {
    index.set(name, source);
  }
}

/** `package-lock.json` v2/v3: `packages["node_modules/x"]` with `resolved` or `link`. */
export function parsePackageLock(text: string): SecurityLockfileIndex | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.packages)) {
    return null;
  }
  const index = new Map<string, SecurityPackageSource>();
  for (const [key, entry] of Object.entries(value.packages)) {
    const name = packageNameOfPath(key);
    if (name === null || !isRecord(entry)) {
      continue;
    }
    const { link, resolved } = entry;
    // A registry tarball is an `https://` URL; a link, a `file:` path or a git URL is local.
    const local =
      link === true ||
      typeof resolved !== 'string' ||
      resolved.startsWith('file:') ||
      resolved.startsWith('git');
    record(index, name, local ? 'local' : 'registry');
  }
  return index;
}

function unquote(text: string): string {
  if (text.length >= 2 && (text[0] === "'" || text[0] === '"') && text.at(-1) === text[0]) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * The name in a `packages:` key: `hono@4.0.0` (v9), `/hono@4.0.0` (v6–v8),
 * `'@acme/x@1.0.0(react@18.3.1)'`. `null` when there is no version part.
 */
function nameOfPnpmPackageKey(key: string): string | null {
  let text = unquote(key);
  if (text.startsWith('/')) {
    text = text.slice(1);
  }
  const at = text.indexOf('@', 1);
  if (at <= 0) {
    return null;
  }
  return text.slice(0, at);
}

/** A `resolution` that is not a registry tarball: a local folder, a `file:` tarball or git. */
function localResolution(text: string): boolean {
  return (
    text.includes('directory:') ||
    text.includes('tarball: file:') ||
    text.includes('type: git') ||
    text.includes('repo:')
  );
}

/**
 * `pnpm-lock.yaml` (v6–v9), read line by line from its indentation: `importers` give each
 * direct dependency's `version:`, `packages` each resolved package's `resolution`.
 * Workspace packages are importers, never `packages` entries, so they stay local.
 */
export function parsePnpmLock(text: string): SecurityLockfileIndex | null {
  const index = new Map<string, SecurityPackageSource>();
  let top: 'importers' | 'packages' | null = null;
  let section = false;
  let current: string | null = null;
  // `packages`: the entry being read and its resolution text (one line or nested lines).
  let entry: string | null = null;
  let resolution: string | null = null;
  let nested = false;
  const closeEntry = () => {
    if (entry !== null && resolution !== null) {
      record(index, entry, localResolution(resolution) ? 'local' : 'registry');
    }
    entry = null;
    resolution = null;
    nested = false;
  };
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    if (indent === 0) {
      closeEntry();
      top = content === 'importers:' ? 'importers' : content === 'packages:' ? 'packages' : null;
      section = false;
      current = null;
      continue;
    }
    if (top === 'packages') {
      if (indent === 2) {
        closeEntry();
        if (content.endsWith(':')) {
          entry = nameOfPnpmPackageKey(content.slice(0, -1));
        }
        continue;
      }
      if (entry === null) {
        continue;
      }
      if (indent === 4) {
        nested = false;
        if (content.startsWith('resolution:')) {
          resolution = content.slice('resolution:'.length).trim();
          // `resolution:` alone: its fields follow on deeper lines.
          nested = resolution === '';
        }
        continue;
      }
      if (nested && resolution !== null) {
        resolution += ` ${content}`;
      }
      continue;
    }
    if (top !== 'importers') {
      continue;
    }
    if (indent === 4) {
      section =
        content === 'dependencies:' ||
        content === 'devDependencies:' ||
        content === 'optionalDependencies:';
      current = null;
      continue;
    }
    if (!section) {
      continue;
    }
    if (indent === 6 && content.endsWith(':')) {
      current = unquote(content.slice(0, -1));
      continue;
    }
    if (indent === 8 && current !== null && content.startsWith('version:')) {
      record(index, current, sourceOfSpecifier(unquote(content.slice('version:'.length).trim())));
    }
  }
  closeEntry();
  return index.size > 0 ? index : null;
}

/** Reads a lockfile by its file name; `null` for a name or text it does not understand. */
export function parseSecurityLockfile(
  fileName: string,
  text: string,
): SecurityLockfileIndex | null {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  if (base === 'pnpm-lock.yaml') {
    return parsePnpmLock(text);
  }
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') {
    return parsePackageLock(text);
  }
  return null;
}

/** The claims a deploy sends for `names` (the packages its source maps name). */
export function securityPackageClaims(
  index: SecurityLockfileIndex,
  names: Iterable<string>,
): SecurityPackageClaims {
  const registry: Array<string> = [];
  const local: Array<string> = [];
  for (const name of new Set(names)) {
    const source = index.get(name);
    if (source === 'registry') {
      registry.push(name);
    } else if (source === 'local') {
      local.push(name);
    }
  }
  return { registry: registry.sort(), local: local.sort() };
}

function validName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PACKAGE_NAME &&
    packageNameOfPath(`node_modules/${value}/x`) === value
  );
}

/**
 * The server reads a deploy's `securityPackages` back into an index; `null` for anything
 * malformed or too long (the scan then keeps third-party code, ranked last).
 */
export function parseSecurityPackageClaims(value: unknown): SecurityLockfileIndex | null {
  if (!isRecord(value)) {
    return null;
  }
  const { registry, local } = value;
  if (
    !Array.isArray(registry) ||
    !Array.isArray(local) ||
    registry.length + local.length > SECURITY_PACKAGE_CLAIMS_MAX ||
    !registry.every(validName) ||
    !local.every(validName)
  ) {
    return null;
  }
  const index = new Map<string, SecurityPackageSource>();
  for (const name of registry) {
    record(index, name, 'registry');
  }
  for (const name of local) {
    record(index, name, 'local');
  }
  return index;
}
