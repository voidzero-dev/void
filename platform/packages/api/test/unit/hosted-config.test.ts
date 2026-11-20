import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { parseJsoncObject } from '../../../../../packages/void/src/cli/generated-wrangler-config.ts';

type KvBinding = { binding: string; id: string };
type WorkerConfig = { kv_namespaces?: Array<KvBinding> };
type HostedConfig = WorkerConfig & {
  vars: Record<string, string>;
  env: Record<'production' | 'staging', WorkerConfig & { vars: Record<string, string> }>;
};

function readConfig(path: string): HostedConfig {
  return parseJsoncObject(readFileSync(resolve(import.meta.dirname, path), 'utf8')) as HostedConfig;
}

const config = readConfig('../../wrangler.jsonc');
const proxyConfig = readConfig('../../../proxy/wrangler.jsonc');

it.each([
  ['default', config.vars, 'https://api.void.cloud', 'void-cron-fires'],
  ['production', config.env.production.vars, 'https://api.void.cloud', 'void-cron-fires'],
  ['staging', config.env.staging.vars, 'https://api.staging.void.cloud', 'void-cron-fires-staging'],
])('configures OAuth and cron queues for %s', (_name, vars, origin, queue) => {
  expect(vars).toMatchObject({
    AUTH_REDIRECT_URI: `${origin}/auth/callback`,
    CRON_FIRES_QUEUE_NAME: queue,
  });
});

function routingId(worker: WorkerConfig): string | undefined {
  return worker.kv_namespaces?.find((namespace) => namespace.binding === 'ROUTING')?.id;
}

// The API publishes `ai-logging:<projectId>` and the proxy reads it, so both must
// bind the same ROUTING namespace in every environment.
it.each([
  ['default', config, proxyConfig],
  ['production', config.env.production, proxyConfig.env.production],
  ['staging', config.env.staging, proxyConfig.env.staging],
])('binds the proxy and the API to the same ROUTING namespace in %s', (_name, api, proxy) => {
  expect(routingId(api)).toBeTruthy();
  expect(routingId(proxy)).toBe(routingId(api));
});

type DurableObjectConfig = {
  durable_objects?: { bindings?: Array<{ name: string; class_name: string }> };
  ai?: unknown;
};
type Migration = { tag: string; new_classes?: Array<string>; new_sqlite_classes?: Array<string> };
const migrations = (config as unknown as { migrations: Array<Migration> }).migrations;

// Hosted keeps `securityAudits` off: the scheduler class ships idle and no AI binding is added.
it.each([
  ['default', config as DurableObjectConfig],
  ['production', config.env.production as DurableObjectConfig],
  ['staging', config.env.staging as DurableObjectConfig],
])('binds the idle security scan scheduler without AI in %s', (_name, worker) => {
  expect(worker.durable_objects?.bindings).toContainEqual({
    name: 'SECURITY_SCAN_SCHEDULER',
    class_name: 'SecurityScanScheduler',
  });
  expect(worker.ai).toBeUndefined();
});

it('adds the security scan scheduler in its own SQLite migration after v6', () => {
  expect(migrations.map((migration) => migration.tag)).toEqual([
    'v1',
    'v2',
    'v3',
    'v4',
    'v5',
    'v6',
    'security-audits-v1',
  ]);
  expect(migrations.at(-1)).toEqual({
    tag: 'security-audits-v1',
    new_sqlite_classes: ['SecurityScanScheduler'],
  });
});

// Workerd refuses a bound Durable Object class that the entry module does not export.
it('exports every bound Durable Object class from the Worker entry module', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../src/worker/index.ts'), 'utf8');
  const start = source.indexOf('export {');
  const end = source.indexOf('}', start);
  const exported = new Set(
    source
      .slice(start + 'export {'.length, end)
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );
  const bound = new Set<string>();
  for (const worker of [
    config,
    config.env.production,
    config.env.staging,
  ] as Array<DurableObjectConfig>) {
    for (const binding of worker.durable_objects?.bindings ?? []) {
      bound.add(binding.class_name);
    }
  }
  for (const className of bound) {
    expect(exported, className).toContain(className);
    expect(
      migrations.some(
        (migration) =>
          migration.new_classes?.includes(className) ||
          migration.new_sqlite_classes?.includes(className),
      ),
      className,
    ).toBe(true);
  }
});
