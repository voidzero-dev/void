import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Returns the path for a temporary fixture of the tests in `testDir`, such as
 * `packages/void/test/unit`. The fixture lives in `test/.tmp-fixtures` beside the test
 * directories, where it still resolves the package's dependencies. Vitest lists the test
 * directories to collect files, and an entry that appears and disappears there would
 * invalidate every cached test task that was collecting at the time.
 *
 * The parent directory is created; the fixture itself is left to the caller.
 */
export function packageFixturePath(testDir: string, name: string): string {
  const parent = join(testDir, '..', '.tmp-fixtures');
  mkdirSync(parent, { recursive: true });
  return join(parent, name);
}

/** Creates a uniquely named fixture directory for a package, given the package root. */
export function createPackageFixtureDir(packageDir: string, prefix: string): string {
  return mkdtempSync(packageFixturePath(join(packageDir, 'test', 'unit'), prefix));
}
