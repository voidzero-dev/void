import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { migrateBuiltWranglerConfig } from '../../src/cli/cf-config-migrate.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: vi.fn(original.spawn),
    spawnSync: vi.fn(original.spawnSync),
    execFileSync: vi.fn(original.execFileSync),
  };
});
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    writeFileSync: vi.fn(original.writeFileSync),
    mkdtempSync: vi.fn(original.mkdtempSync),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

it('translates in process, without a subprocess or a file, and leaves its input alone', () => {
  const raw = {
    name: 'void-migrate-test',
    compatibility_date: '2026-09-29',
    vars: { MESSAGE: 'hello' },
    kv_namespaces: [{ binding: 'KV', id: 'kv-id' }],
  };
  const before = structuredClone(raw);
  const migrated = migrateBuiltWranglerConfig(raw);

  expect(migrated.worker).toMatchObject({
    name: raw.name,
    env: { MESSAGE: { type: 'text', value: 'hello' }, KV: { type: 'kv', id: 'kv-id' } },
  });
  expect(raw).toEqual(before);
  for (const start of [childProcess.spawn, childProcess.spawnSync, childProcess.execFileSync]) {
    expect(start).not.toHaveBeenCalled();
  }
  expect(fs.writeFileSync).not.toHaveBeenCalled();
  expect(fs.mkdtempSync).not.toHaveBeenCalled();
});

it('returns a configuration that callers can change without affecting the next translation', () => {
  const raw = { name: 'void-migrate-test', compatibility_date: '2026-09-29', vars: { A: '1' } };
  const first = migrateBuiltWranglerConfig(raw);
  first.worker!.env!.ADDED = { type: 'text', value: 'x' };
  expect(migrateBuiltWranglerConfig(raw).worker?.env).toEqual({ A: { type: 'text', value: '1' } });
});

it('rejects unresolved blocking follow-ups instead of silently dropping settings', () => {
  expect(() =>
    migrateBuiltWranglerConfig({
      name: 'void-migrate-test',
      compatibility_date: '2026-09-29',
      routes: [{ pattern: 'example.com', custom_domain: true, zone_id: 'zone-id' }],
    }),
  ).toThrow('cf cannot migrate Cloudflare setting config.routes.0');
});

it.each(
  [undefined, null, 7].flatMap((maxConcurrency) =>
    [false, true].map((named) => ({ maxConcurrency, named })),
  ),
)('preserves Queue concurrency ($maxConcurrency, named=$named)', ({ maxConcurrency, named }) => {
  const queues = { consumers: [{ queue: 'jobs', max_concurrency: maxConcurrency }] };
  const raw = {
    name: 'void-queue-migrate',
    compatibility_date: '2026-11-16',
    ...(named ? { env: { staging: { queues } } } : { queues }),
  };
  const before = structuredClone(raw);
  const migrated = migrateBuiltWranglerConfig(raw, named ? 'staging' : 'production');
  expect(migrated.worker?.triggers).toEqual([
    { type: 'queue', name: 'jobs', ...(maxConcurrency == null ? {} : { maxConcurrency }) },
  ]);
  expect(raw).toEqual(before);
});
