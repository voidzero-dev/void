import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { migrateBuiltWranglerConfig } from '../../src/cli/cf-config-migrate.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawnSync: vi.fn(original.spawnSync) };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(spawnSync).mockClear();
});

it('migrates and validates in one uncredentialed process and removes its scratch directory', () => {
  for (const key of [
    'CLOUDFLARE_API_TOKEN',
    'CF_API_TOKEN',
    'WRANGLER_API_TOKEN',
    'VOID_PLATFORM_TOKEN',
    'DATABASE_URL',
    'VOID_ACCESS_TOKEN',
  ]) {
    vi.stubEnv(key, 'synthetic-credential');
  }
  const raw = {
    name: 'void-migrate-test',
    compatibility_date: '2026-09-29',
    vars: { MESSAGE: 'hello' },
  };
  const before = structuredClone(raw);
  const migrated = migrateBuiltWranglerConfig(raw);

  expect(migrated.worker).toMatchObject({
    name: raw.name,
    env: { MESSAGE: { type: 'text', value: 'hello' } },
  });
  expect(raw).toEqual(before);
  expect(spawnSync).toHaveBeenCalledTimes(1);
  const [binary, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
  expect(binary).toBe(process.execPath);
  expect(args).toContain(import.meta.resolve('@cloudflare/codemods'));
  expect(options).toMatchObject({ env: { CF_DELEGATION: '1' }, timeout: 30_000 });
  for (const key of Object.keys(process.env)) {
    if (/^(?:CLOUDFLARE|CF_|WRANGLER|VOID_PLATFORM_|DATABASE_URL|VOID_ACCESS_)/i.test(key)) {
      if (key !== 'CF_DELEGATION') {
        expect(options!.env).not.toHaveProperty(key);
      }
    }
  }
  expect(existsSync(String(options!.cwd))).toBe(false);
});

it('rejects unresolved blocking follow-ups instead of silently dropping settings', () => {
  expect(() =>
    migrateBuiltWranglerConfig({
      name: 'void-migrate-test',
      compatibility_date: '2026-09-29',
      routes: [{ pattern: 'example.com', custom_domain: true, zone_id: 'zone-id' }],
    }),
  ).toThrow('cf cannot migrate Cloudflare setting config.routes.0');
  expect(existsSync(String(vi.mocked(spawnSync).mock.calls[0]![2]!.cwd))).toBe(false);
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
