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

// Hosted keeps `securityAudits` off: the scheduler class ships idle, with no AI binding.
it('binds the idle security scan scheduler without AI, in its own SQLite migration', () => {
  type Worker = { durable_objects?: { bindings?: Array<unknown> }; ai?: unknown };
  for (const worker of [config, config.env.production, config.env.staging] as Array<Worker>) {
    expect(worker.durable_objects?.bindings).toContainEqual({
      name: 'SECURITY_SCAN_SCHEDULER',
      class_name: 'SecurityScanScheduler',
    });
    expect(worker.ai).toBeUndefined();
  }
  const migrations = (config as unknown as { migrations: Array<unknown> }).migrations;
  expect(migrations.at(-1)).toEqual({
    tag: 'security-audits-v1',
    new_sqlite_classes: ['SecurityScanScheduler'],
  });
});
