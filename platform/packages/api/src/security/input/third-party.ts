/**
 * Third-party code by package identity, not path text (spec §7.4).
 *
 * A source map path can say `node_modules/…` for the project's own code (pnpm
 * workspace packages show up as `node_modules/@scope/pkg/src/…`), so a source is
 * dropped only when its package resolves to a registry package in the lockfile.
 * Workspace, `link:`, `file:` and git packages stay. Without a lockfile the file
 * stays, ranks last and counts as `third-party-unverified`.
 */

export type SecurityPackageSource = 'registry' | 'local';

/** Package name → where the lockfile says it comes from. */
export type SecurityLockfileIndex = ReadonlyMap<string, SecurityPackageSource>;

export type SecurityThirdParty = 'first_party' | 'registry' | 'unverified';

/** The package a path sits in: the part after its last `node_modules/`. */
export function packageNameOfPath(path: string): string | null {
  const segments = path.split('/');
  let last = -1;
  for (let index = 0; index < segments.length; index++) {
    if (segments[index] === 'node_modules') {
      last = index;
    }
  }
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

export function classifyThirdParty(
  path: string,
  lockfile: SecurityLockfileIndex | null,
): SecurityThirdParty {
  const name = packageNameOfPath(path);
  if (name === null) {
    return 'first_party';
  }
  const source = lockfile?.get(name);
  if (source === 'registry') {
    return 'registry';
  }
  if (source === 'local') {
    return 'first_party';
  }
  return 'unverified';
}

function sourceOfSpecifier(version: string): SecurityPackageSource {
  if (
    version.startsWith('link:') ||
    version.startsWith('file:') ||
    version.startsWith('workspace:') ||
    version.startsWith('git') ||
    version.startsWith('github:') ||
    version.includes('://')
  ) {
    return 'local';
  }
  return 'registry';
}

/** A package seen as both local and registry is local: never drop code that may be ours. */
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
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const packages = (value as { packages?: unknown }).packages;
  if (typeof packages !== 'object' || packages === null) {
    return null;
  }
  const index = new Map<string, SecurityPackageSource>();
  for (const [key, entry] of Object.entries(packages as Record<string, unknown>)) {
    const name = packageNameOfPath(key);
    if (name === null || typeof entry !== 'object' || entry === null) {
      continue;
    }
    const { link, resolved } = entry as { link?: unknown; resolved?: unknown };
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

/**
 * `pnpm-lock.yaml` (v6–v9): every `importers` dependency, read line by line from
 * its indentation. A `version:` starting with `link:`/`file:` (or a git URL) is
 * local; anything else came from the registry.
 */
export function parsePnpmLock(text: string): SecurityLockfileIndex | null {
  const index = new Map<string, SecurityPackageSource>();
  let inImporters = false;
  let section = false;
  let current: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    if (indent === 0) {
      inImporters = content === 'importers:';
      section = false;
      current = null;
      continue;
    }
    if (!inImporters) {
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
  return index.size > 0 ? index : null;
}

function unquote(text: string): string {
  if (
    text.length >= 2 &&
    (text[0] === "'" || text[0] === '"') &&
    text[text.length - 1] === text[0]
  ) {
    return text.slice(1, -1);
  }
  return text;
}
