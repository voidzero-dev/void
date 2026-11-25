// `vp run test` runs the unit, platform and integration groups as many cached tasks, generated in the root
// `vite.config.ts`. This check runs after the tasks of a group and fails when one of the group's
// Vitest projects collects a file that no task ran, so a new include pattern cannot leave tests out.
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {Record<string, { projects: string[], prefix: string } | undefined>} */
const groups = {
  unit: { projects: ['unit', 'unit-pglite', 'cli-unit'], prefix: 'test:unit:' },
  platform: {
    projects: [
      'platform-unit',
      'platform-unit-pglite',
      'platform-api-integration',
      'platform-api-integration-threads',
    ],
    prefix: 'test:platform:',
  },
  integration: { projects: ['parallel-integration'], prefix: 'test:integration:' },
};
const group = groups[process.argv[2]];
if (!group) {
  throw new Error(`Usage: node test/check-test-tasks.mjs <${Object.keys(groups).join('|')}>`);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (args) =>
  execFileSync('vp', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    shell: process.platform === 'win32',
  });

/** @type {{ tasks: Record<string, { package: string, name: string, command: string }> }} */
const plan = JSON.parse(run(['run', '--json']));
// A task's command ends with the test files it runs.
const commands = Object.values(plan.tasks)
  .filter((task) => task.package === '.' && task.name.startsWith(group.prefix))
  .map((task) => task.command);
const covered = new Set(
  commands.flatMap((command) => command.split(' ').filter((word) => word.endsWith('.test.ts'))),
);
/** @type {Array<{ file: string }>} */
const testFiles = JSON.parse(
  run([
    'test',
    'list',
    ...group.projects.flatMap((project) => ['--project', project]),
    '--filesOnly',
    '--json',
  ]),
);
const collected = testFiles.map((entry) => relative(root, entry.file).replaceAll('\\', '/'));

const missing = collected.filter((file) => !covered.has(file));
if (collected.length === 0 || missing.length > 0) {
  console.error(
    collected.length === 0
      ? `The ${process.argv[2]} projects collected no test files.`
      : `These ${process.argv[2]} tests have no task in \`vp run test\`:\n${missing.join('\n')}\nGenerate their tasks in vite.config.ts.`,
  );
  process.exit(1);
}
