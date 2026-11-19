// `vp run test` runs each integration test file as its own cached task. The tasks are generated
// from `test/integration-files.ts`; this check fails when the `parallel-integration` project
// collects a file that has no task, so a new include pattern cannot leave tests out.
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listIntegrationTestFiles } from './integration-files.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const tasks = new Set(listIntegrationTestFiles(root));
const collected = JSON.parse(
  execFileSync(
    'vp',
    ['test', 'list', '--project', 'parallel-integration', '--filesOnly', '--json'],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
  ),
).map((entry) => relative(root, entry.file).replaceAll('\\', '/'));

const missing = collected.filter((file) => !tasks.has(file));
if (collected.length === 0 || missing.length > 0) {
  console.error(
    collected.length === 0
      ? 'The parallel-integration project collected no test files.'
      : `These integration tests have no task in \`vp run test\`:\n${missing.join('\n')}\nAdd their directory to test/integration-files.ts.`,
  );
  process.exit(1);
}
