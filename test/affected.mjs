import { globSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deletedFiles, planAffectedTests } from './affected-tests.ts';
import { createAffectedVcsProvider } from './affected-vcs.ts';
import { preparePublicPackages } from './build-setup.ts';

async function runAffected(root, values) {
  root = realpathSync(root);
  if (values.help) {
    console.log('vp run test [--base <ref>] [--list] [--unit] [--report <file>]');
    console.log(
      'Defaults to staged, unstaged, and untracked changes. --base includes branch changes.',
    );
    console.log(
      '--list previews without executing tests or builds. --unit skips integration coverage.',
    );
    return;
  }
  const vcsProvider = createAffectedVcsProvider();
  const changed = values.base ?? true;
  const changes = (await vcsProvider.findChangedFiles({ root, changedSince: changed })).map(
    (file) => relative(root, file).replaceAll('\\', '/'),
  );
  if (!changes.length) {
    console.log(
      'No changed files. Use --base <ref> for committed work, or vp test run for all tests.',
    );
    return;
  }
  if (values.unit) {
    console.log('Unit-only iteration: integration coverage is intentionally omitted.');
  }
  const initial = planAffectedTests(changes, [], deletedFiles(root, changes));
  if (!initial.full && !initial.related.length) {
    console.log('Documentation-only changes: no runtime tests selected. Verify docs separately.');
    return;
  }
  let publicBuildMilliseconds;
  if (initial.build && !values.list) {
    console.log('Refreshing public package builds before testing their installed exports.');
    publicBuildMilliseconds = await preparePublicPackages(root);
  }
  console.log('Initializing Vitest and discovering test files...');
  const { createVitest } = await import('vite-plus/test/node');
  const vitest = await createVitest({
    root,
    watch: false,
    changed: initial.full ? false : changed,
    experimental: { vcsProvider },
    ...(values.report
      ? {
          reporters: [
            'default',
            fileURLToPath(new URL('./performance-reporter.ts', import.meta.url)),
          ],
          outputFile: values.report,
        }
      : {}),
    ...(values.unit
      ? { project: ['unit', 'unit-pglite', 'cli-unit', 'platform-unit', 'platform-unit-pglite'] }
      : {}),
  });
  if (publicBuildMilliseconds !== undefined) {
    vitest.provide('publicBuildMilliseconds', publicBuildMilliseconds);
  }
  try {
    const all = await vitest.globTestSpecifications();
    if (!all.length) {
      throw new Error('No tests discovered. Check the Vitest project configuration.');
    }
    const needsSources = changes.some((file) => file.startsWith('playground/'));
    const files = initial.full
      ? []
      : all.map((spec) => ({
          path: relative(root, spec.moduleId).replaceAll('\\', '/'),
          project: spec.project.name,
          source: needsSources ? readFileSync(spec.moduleId, 'utf8') : '',
        }));
    const plan = initial.full
      ? initial
      : planAffectedTests(changes, files, deletedFiles(root, changes));
    plan.reasons.forEach((reason) => console.log(reason));
    let selected = all;
    if (!plan.full) {
      const forced = all.filter((spec, index) => plan.forced.has(files[index].path));
      const remaining = all.filter((spec, index) => !plan.forced.has(files[index].path));
      if (plan.build) {
        vcsProvider.addRelatedFiles(
          [...globSync('packages/*/dist/**/*', { cwd: root })].map((file) => join(root, file)),
        );
      }
      let affected = [];
      if (remaining.length) {
        console.log('Finding tests affected by changed imports...');
        affected = await vitest.getRelevantTestSpecifications(
          remaining.map((spec) => spec.moduleId),
        );
      }
      selected = [...forced, ...affected];
    }
    console.log(
      `Selected ${selected.length}/${all.length} test files for ${changes.length} changed files.`,
    );
    if (values.list) {
      if (plan.build) {
        console.log(
          'Execution will also refresh public package builds; built-export selection may expand.',
        );
      }
      for (const spec of selected.sort((first, second) =>
        first.moduleId.localeCompare(second.moduleId),
      )) {
        console.log(
          `[${spec.project.name}] ${relative(root, spec.moduleId).replaceAll('\\', '/')}`,
        );
      }
    } else if (selected.length) {
      if (plan.full) {
        await vitest.start();
      } else {
        await vitest.standalone();
        await vitest.runTestSpecifications(selected);
      }
    } else {
      console.log(
        'No tests import these changes. Add focused regression coverage when changing behavior.',
      );
    }
  } finally {
    await vitest.close();
  }
}

try {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      list: { type: 'boolean' },
      unit: { type: 'boolean' },
      report: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  await runAffected(fileURLToPath(new URL('../', import.meta.url)), values);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
