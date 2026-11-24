/**
 * The package claims a deploy sends for security scans (`securityPackages`, design doc
 * 0095 M10): which packages named by the Worker bundle's source maps come from the
 * registry, read from the project's lockfile. The platform drops registry code from the
 * scan input by package identity; with no claims it keeps that code, ranked last.
 *
 *   worker *.map ─► `sources` ─► package names (after the last `node_modules/`)
 *   nearest lockfile (project folder, then up to the repository root)
 *     ─► registry | local per name ─► { registry, local }
 *
 * Best effort: any problem sends no claims and never fails the deploy.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  packageNameOfPath,
  parseSecurityLockfile,
  SECURITY_LOCKFILE_NAMES,
  SECURITY_PACKAGE_CLAIMS_MAX,
  securityPackageClaims,
} from '@void/platform/security-lockfile';
import type { SecurityPackageClaims } from '@void/platform/security-lockfile';
import { basename, dirname, join } from 'pathslash';

/** A lockfile bigger than this is not read. */
const MAX_LOCKFILE_BYTES = 32 * 1024 * 1024;

/** The lockfile nearest `root`, walking up and stopping at the repository root. */
export function findProjectLockfile(root: string): string | null {
  let dir = root;
  for (;;) {
    for (const name of SECURITY_LOCKFILE_NAMES) {
      const path = join(dir, name);
      if (existsSync(path)) {
        return path;
      }
    }
    const parent = dirname(dir);
    if (parent === dir || existsSync(join(dir, '.git'))) {
      return null;
    }
    dir = parent;
  }
}

/** The packages the bundle's source maps name. */
export function bundlePackageNames(workerFiles: ReadonlyMap<string, Buffer>): Set<string> {
  const names = new Set<string>();
  for (const [name, bytes] of workerFiles) {
    if (!name.endsWith('.map')) {
      continue;
    }
    let sources: unknown;
    try {
      sources = (JSON.parse(bytes.toString('utf8')) as { sources?: unknown }).sources;
    } catch {
      continue;
    }
    if (!Array.isArray(sources)) {
      continue;
    }
    for (const source of sources) {
      if (typeof source !== 'string') {
        continue;
      }
      const packageName = packageNameOfPath(source.split('\\').join('/'));
      if (packageName !== null) {
        names.add(packageName);
      }
    }
  }
  return names;
}

/** The claims for this deploy, or `null` when there is nothing to claim or no lockfile. */
export function readSecurityPackageClaims(
  root: string,
  workerFiles: ReadonlyMap<string, Buffer>,
): SecurityPackageClaims | null {
  try {
    const names = bundlePackageNames(workerFiles);
    if (names.size === 0) {
      return null;
    }
    const lockfile = findProjectLockfile(root);
    if (lockfile === null || statSync(lockfile).size > MAX_LOCKFILE_BYTES) {
      return null;
    }
    const index = parseSecurityLockfile(basename(lockfile), readFileSync(lockfile, 'utf8'));
    if (index === null) {
      return null;
    }
    const claims = securityPackageClaims(index, names);
    const total = claims.registry.length + claims.local.length;
    return total === 0 || total > SECURITY_PACKAGE_CLAIMS_MAX ? null : claims;
  } catch {
    return null;
  }
}
