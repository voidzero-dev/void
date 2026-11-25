import { existsSync, readFileSync } from 'node:fs';
import { minimatch } from 'minimatch';
import { dirname, join, relative } from 'pathslash';

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

export function parsePackageManagerField(pkg: unknown): PackageManager | undefined {
  if (!pkg || typeof pkg !== 'object') {
    return undefined;
  }
  const raw = (pkg as { packageManager?: unknown }).packageManager;
  if (typeof raw !== 'string') {
    return undefined;
  }
  // Corepack spec: "name@version[+sha.<hash>]".
  const name = raw.split('@', 1)[0]?.trim();
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    return name;
  }
  return undefined;
}

/**
 * Nearest ancestor of `start` (excluding `start`) with a `pnpm-workspace.yaml`
 * or a `package.json#workspaces` field.
 */
export function findWorkspaceRoot(start: string): string | undefined {
  let dir = dirname(start);
  while (true) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
        if (pkg && typeof pkg === 'object' && 'workspaces' in pkg) {
          return dir;
        }
      } catch {
        // Keep walking past an unreadable package.json.
      }
    }
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Member globs from `pnpm-workspace.yaml#packages` or `package.json#workspaces`
 * (an array or `{ packages }`). Empty when none can be read.
 */
function readWorkspacePatterns(workspaceRoot: string): Array<string> {
  const pnpmWorkspacePath = join(workspaceRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWorkspacePath)) {
    try {
      const yaml = readFileSync(pnpmWorkspacePath, 'utf8');
      return extractPnpmWorkspacePackages(yaml);
    } catch {
      return [];
    }
  }
  const pkgPath = join(workspaceRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
      const workspaces = (pkg as { workspaces?: unknown }).workspaces;
      if (Array.isArray(workspaces)) {
        return workspaces.filter((x): x is string => typeof x === 'string');
      }
      if (workspaces && typeof workspaces === 'object') {
        const packages = (workspaces as { packages?: unknown }).packages;
        if (Array.isArray(packages)) {
          return packages.filter((x): x is string => typeof x === 'string');
        }
      }
    } catch {
      return [];
    }
  }
  return [];
}

/** Strip a trailing YAML comment, keeping `#` inside quotes (`- "path #hash/*"`). */
export function stripYamlLineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '#' && i > 0 && /\s/.test(line[i - 1])) {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line;
}

/**
 * Read the `packages:` list of a `pnpm-workspace.yaml` in block (`- 'apps/*'`)
 * or flow (`packages: ['apps/*']`) form.
 */
export function extractPnpmWorkspacePackages(yaml: string): Array<string> {
  const lines = yaml.split(/\r?\n/);
  const patterns: Array<string> = [];
  let inPackages = false;
  for (const rawLine of lines) {
    const line = stripYamlLineComment(rawLine);

    const inlineMatch = line.match(/^\s*packages\s*:\s*\[(.*)\]\s*$/);
    if (inlineMatch) {
      const inner = inlineMatch[1];
      const items = inner.match(/(['"])(?:(?!\1).)*\1|[^,\s]+/g) ?? [];
      for (const raw of items) {
        const unquoted = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
        if (unquoted) {
          patterns.push(unquoted);
        }
      }
      inPackages = false;
      continue;
    }

    if (/^\s*packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    // Any other top-level key ends the `packages:` block.
    if (/^[A-Za-z_][\w-]*\s*:\s*(?:\S.*)?$/.test(line) && !/^\s/.test(line)) {
      inPackages = false;
      continue;
    }
    const m = line.match(/^\s*-\s*(['"]?)([^'"\s][^'"]*?)\1\s*$/);
    if (m) {
      patterns.push(m[2]);
    }
  }
  return patterns;
}

/**
 * Whether `root` matches a workspace glob and no `!` glob. A nested app outside
 * the globs is a separate project.
 */
function isWorkspaceSubpackage(workspaceRoot: string, root: string): boolean {
  const relPath = relative(workspaceRoot, root);
  if (relPath === '' || relPath.startsWith('..')) {
    return false;
  }
  const normalized = relPath.split(/[\\/]/).join('/');
  const patterns = readWorkspacePatterns(workspaceRoot);
  if (patterns.length === 0) {
    return false;
  }
  let matched = false;
  for (const raw of patterns) {
    const isNegation = raw.startsWith('!');
    const pattern = (isNegation ? raw.slice(1) : raw).replaceAll(/^\.\/|\/+$/g, '');
    if (minimatch(normalized, pattern, { nonegate: true, nocomment: true, dot: true })) {
      if (isNegation) {
        return false;
      }
      matched = true;
    }
  }
  return matched;
}

export function findWorkspaceMemberRoot(root: string): string | undefined {
  const workspaceRoot = findWorkspaceRoot(root);
  if (workspaceRoot !== undefined && isWorkspaceSubpackage(workspaceRoot, root)) {
    return workspaceRoot;
  }
}
