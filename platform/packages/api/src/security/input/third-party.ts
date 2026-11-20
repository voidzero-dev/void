/**
 * Third-party code by package identity, not path text (spec §7.4).
 *
 * A source map path can say `node_modules/…` for the project's own code (pnpm
 * workspace packages show up as `node_modules/@scope/pkg/src/…`), so a source is
 * dropped only when its package resolves to a registry package in the lockfile.
 * Workspace, `link:`, `file:` and git packages stay. Without a lockfile the file
 * stays, ranks last and counts as `third-party-unverified`.
 *
 * Where the lockfile comes from: T1 reads it from the repo tarball; a CLI deploy sends
 * the claims for its bundle's packages (`securityPackages`, read from the project's
 * lockfile). The readers are shared with the CLI (`@void/platform/security-lockfile`).
 */
import { packageNameOfPath, type SecurityLockfileIndex } from '@void/platform/security-lockfile';

export {
  packageNameOfPath,
  parsePackageLock,
  parsePnpmLock,
  parseSecurityLockfile,
  parseSecurityPackageClaims,
  SECURITY_LOCKFILE_NAMES,
  type SecurityLockfileIndex,
  type SecurityPackageSource,
} from '@void/platform/security-lockfile';

export type SecurityThirdParty = 'first_party' | 'registry' | 'unverified';

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
