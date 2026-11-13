import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { parseJsoncObject } from '../../../../../packages/void/src/cli/generated-wrangler-config.ts';

type HostedConfig = {
  vars: Record<string, string>;
  env: Record<'production' | 'staging', { vars: Record<string, string> }>;
};

const config = parseJsoncObject(
  readFileSync(resolve(import.meta.dirname, '../../wrangler.jsonc'), 'utf8'),
) as HostedConfig;

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
