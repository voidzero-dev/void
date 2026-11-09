import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import type { TestSpecification, Vitest } from 'vite-plus/test/node';
import { SuiteSequencer } from '../../../../test/sequencer.ts';

const root = join(import.meta.dirname, '../../../..');
function specification(project: string, file: string, groupOrder = 2): TestSpecification {
  return {
    moduleId: join(root, file),
    project: { name: project, config: { sequence: { groupOrder }, isolate: true } },
  } as TestSpecification;
}
function context(
  results: Map<TestSpecification, { duration: number; failed?: boolean }>,
  config = {},
): Vitest {
  return {
    config: { root, sequence: {}, ...config },
    cache: { getTestSpecificationResult: (test: TestSpecification) => results.get(test) },
  } as Vitest;
}

it('starts costly files across projects without crossing phase barriers or delaying failures', async () => {
  const integration = specification('parallel-integration', 'integration.ts');
  const unit = specification('unit', 'unit.ts');
  const database = specification('unit-pglite', 'database.ts');
  const earlier = specification('platform-unit', 'earlier.ts', 0);
  const failed = specification('unit', 'failed.ts');
  const results = new Map([
    [integration, { duration: 100 }],
    [unit, { duration: 30_000 }],
    [database, { duration: 10_000 }],
    [earlier, { duration: 1 }],
    [failed, { duration: 1, failed: true }],
  ]);
  const tests = [integration, unit, database, earlier, failed];
  expect(await new SuiteSequencer(context(results)).sort(tests)).toEqual([
    earlier,
    failed,
    unit,
    database,
    integration,
  ]);
  expect(tests).toEqual([integration, unit, database, earlier, failed]);
});

it('uses measured fixture estimates when no local result exists', async () => {
  const angular = specification(
    'parallel-integration',
    'packages/void/test/integration/analog.test.ts',
  );
  const unknown = specification('unit', 'new-test.ts');
  const short = specification(
    'parallel-integration',
    'packages/void/test/integration/trigger-auth.test.ts',
  );
  expect(await new SuiteSequencer(context(new Map())).sort([short, unknown, angular])).toEqual([
    angular,
    unknown,
    short,
  ]);
});

it('keeps shard membership complete and seeded shuffling reproducible', async () => {
  const tests = ['analog', 'astro', 'nuxt', 'sveltekit', 'new-test'].map((name) =>
    specification('parallel-integration', `packages/void/test/integration/${name}.test.ts`),
  );
  const shards = await Promise.all(
    [1, 2, 3].map((index) =>
      new SuiteSequencer(context(new Map(), { shard: { index, count: 3 } })).shard(tests),
    ),
  );
  expect(shards.flat()).toHaveLength(tests.length);
  expect(new Set(shards.flat())).toEqual(new Set(tests));
  const sequencer = new SuiteSequencer(
    context(new Map(), { sequence: { shuffle: true, seed: 42 } }),
  );
  expect(await sequencer.sort(tests)).toEqual(await sequencer.sort([...tests].reverse()));
  expect(new Set(await sequencer.sort(tests))).toEqual(new Set(tests));
});
