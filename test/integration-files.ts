import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { integrationTimings } from './integration-timings.ts';

/** The directories whose test files form the `parallel-integration` project. */
export const integrationTestDirs: ReadonlyArray<string> = [
  'packages/void/test/integration',
  // Gated live-account e2e. Collected so it is skipped cleanly without credentials rather than
  // silently undiscovered; it runs only when its env vars are set.
  'packages/void/test/e2e',
  'packages/md/test/integration',
  'packages/image-renderer-takumi/test/integration',
  'packages/react/test/integration',
  'packages/vue/test/integration',
  'packages/svelte/test/integration',
  'packages/solid/test/integration',
];

/** Every integration test file, relative to the workspace root, longest first. */
export function listIntegrationTestFiles(workspaceRoot: string): Array<string> {
  const duration = (file: string) => integrationTimings[file] ?? 5000;
  return integrationTestDirs
    .flatMap((dir) =>
      readdirSync(join(workspaceRoot, dir), { recursive: true, encoding: 'utf8' })
        .map((entry) => `${dir}/${entry.replaceAll('\\', '/')}`)
        .filter((file) => file.endsWith('.test.ts')),
    )
    .sort((a, b) => duration(b) - duration(a) || a.localeCompare(b));
}
