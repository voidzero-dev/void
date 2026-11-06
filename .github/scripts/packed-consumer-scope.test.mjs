import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePackedSuite, selectPackedSuite } from './packed-consumer-scope.mjs';

test('skips documentation-only changes and keeps ordinary runtime changes small', () => {
  assert.equal(
    selectPackedSuite([
      'README.md',
      'AGENTS.md',
      'docs/guide/queues.md',
      'platform/meta/operations.md',
    ]),
    'skip',
  );
  assert.equal(
    selectPackedSuite(['docs/guide/env-vars.md', 'packages/void/src/runtime/env-public.ts']),
    'smoke',
  );
  assert.equal(selectPackedSuite(['platform/packages/api/src/routes/projects.ts']), 'smoke');
});

test('runs the full matrix for dependencies, adapters, scaffolding, and packaging', () => {
  for (const path of [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.node-version',
    'package.json',
    'packages/void/package.json',
    'packages/void/vite.config.ts',
    'packages/solid/src/plugin.ts',
    'packages/hono/src/plugin.ts',
    'packages/vue/src/runtime/index.ts',
    'packages/create-void/src/pm.ts',
    'packages/void/src/cli/init.ts',
    '.github/scripts/packed-init.mjs',
    '.github/workflows/packed-consumers.yml',
    '.github/workflows/prepublish-test.yml',
    '.github/workflows/publish.yml',
  ]) {
    assert.equal(selectPackedSuite([path]), 'full', path);
  }
});

const repository = { full_name: 'voidzero-dev/void' };
test('reads every PR file page and considers the old path of renamed files', async () => {
  const calls = [];
  const result = await resolvePackedSuite({
    eventName: 'pull_request',
    event: { number: 123, repository },
    request: async (path) => {
      calls.push(path);
      return calls.length === 1
        ? Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` }))
        : [{ filename: 'docs/retired.md', previous_filename: 'packages/react/src/plugin.ts' }];
    },
  });
  assert.equal(result, 'full');
  assert.equal(calls.length, 2);
  assert(calls[1].endsWith('page=2'));
});

test('compares the full pushed range rather than just the last commit', async () => {
  const before = '1'.repeat(40),
    after = '2'.repeat(40);
  const result = await resolvePackedSuite({
    eventName: 'push',
    event: { repository, before, after },
    request: async (path) => {
      assert(path.includes(`${before}...${after}`));
      return { files: [{ filename: 'packages/void/src/runtime/kv.ts' }] };
    },
  });
  assert.equal(result, 'smoke');
});

test('retains full coverage for unavailable or truncated changed-file lists', async () => {
  const event = { repository, before: '1'.repeat(40), after: '2'.repeat(40) };
  for (const request of [
    async () => {
      throw new Error('API unavailable');
    },
    async () => ({ files: Array.from({ length: 300 }, () => ({ filename: 'docs/a.md' })) }),
    async () => ({ files: [{}] }),
  ]) {
    assert.equal(await resolvePackedSuite({ eventName: 'push', event, request }), 'full');
  }
  assert.equal(
    await resolvePackedSuite({ eventName: 'push', event: { ...event, before: '0'.repeat(40) } }),
    'full',
  );
  assert.equal(
    await resolvePackedSuite({ eventName: 'push', event: { ...event, forced: true } }),
    'full',
  );
});

test('release and manual full runs do not depend on changed paths', async () => {
  const request = async () => {
    throw new Error('Should not inspect paths');
  };
  assert.equal(
    await resolvePackedSuite({ eventName: 'push', event: { ref: 'refs/tags/v1.0.0' }, request }),
    'full',
  );
  assert.equal(
    await resolvePackedSuite({ eventName: 'push', event: {}, requested: 'full', request }),
    'full',
  );
  assert.equal(
    await resolvePackedSuite({ eventName: 'workflow_dispatch', event: {}, request }),
    'full',
  );
  assert.equal(
    await resolvePackedSuite({
      eventName: 'workflow_dispatch',
      event: {},
      requested: 'smoke',
      request,
    }),
    'smoke',
  );
});
