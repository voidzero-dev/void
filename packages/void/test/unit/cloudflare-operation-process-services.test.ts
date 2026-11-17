import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { Buffer } from '../../src/cli/node-buffer.ts';
import {
  listen,
  runOperation,
  systemEnv,
  temporaryDirectory,
  tokenEnv,
} from '../helpers/cloudflare-operation-process.ts';

const voidVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .version as string;

it.each(['apac', undefined] as const)(
  'creates R2 buckets with location hint %s through installed cf',
  async (locationHint) => {
    const directory = temporaryDirectory('void-cf-r2-location-');
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify({ name: 'test-worker', account_id: 'test-account' }));
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const api = await listen(
      createServer(async (request, response) => {
        const chunks: Array<Buffer> = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        requests.push({
          path: request.url ?? '',
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ success: true, errors: [], result: { name: 'test-storage' } }),
        );
      }),
    );
    const result = await runOperation(
      directory,
      {
        type: 'r2.bucket.create',
        name: 'test-storage',
        binding: 'STORAGE',
        configPath,
        locationHint,
      },
      tokenEnv(api),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(requests).toEqual([
      {
        path: '/client/v4/accounts/test-account/r2/buckets',
        body: expect.objectContaining({
          name: 'test-storage',
          ...(locationHint ? { locationHint } : {}),
        }),
      },
    ]);
    if (!locationHint) {
      expect(requests[0]!.body).not.toHaveProperty('locationHint');
    }
    expect(JSON.parse(readFileSync(configPath, 'utf8')).r2_buckets).toEqual([
      { binding: 'STORAGE', bucket_name: 'test-storage' },
    ]);
  },
);

it.each([200, 503])(
  'reports HTTP %i without loading the build toolchain when domain cleanup returns non-JSON',
  async (status) => {
    const directory = temporaryDirectory('void-cf-domain-error-');
    const api = await listen(
      createServer((request, response) => {
        request.resume();
        response.statusCode = status;
        response.end('temporary upstream response');
      }),
    );
    const configPath = join(directory, 'wrangler.json');
    const preload = join(directory, 'reject-build-imports.mjs');
    writeFileSync(
      preload,
      `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (['vite', '@cloudflare/build-output-utils'].includes(specifier) || specifier.endsWith('/cf-build-output.ts')) {
      throw new Error('Ancillary operations must not load the build toolchain');
    }
    return nextResolve(specifier, context);
  },
});
`,
    );
    writeFileSync(configPath, JSON.stringify({ name: 'test-worker', account_id: 'test-account' }));
    const output = await runOperation(
      directory,
      { type: 'triggers.clear-domains', configPath, workerName: 'test-worker' },
      tokenEnv(api),
      preload,
    );
    expect(output.status).toBe(1);
    expect(output.stderr).toContain(`HTTP ${status}`);
    expect(output.stderr).not.toContain('synthetic-token');
  },
  30_000,
);

it.each(['clear-crons', 'clear-domains'])(
  'clears %s through the pinned account API',
  async (operation) => {
    const directory = temporaryDirectory('void-cf-clear-crons-');
    let requested = false;
    const api = await listen(
      createServer(async (request, response) => {
        requested = true;
        expect(request.method).toBe('PUT');
        expect(request.url).toBe(
          `/client/v4/accounts/test-account/workers/scripts/test-worker/${operation === 'clear-crons' ? 'schedules' : 'domains/records'}`,
        );
        expect(request.headers.authorization).toBe('Bearer synthetic-token');
        expect(request.headers['user-agent']).toBe(`void/${voidVersion}`);
        let body = '';
        for await (const chunk of request) {
          body += chunk;
        }
        expect(JSON.parse(body)).toEqual(
          operation === 'clear-crons'
            ? []
            : {
                override_scope: true,
                override_existing_origin: false,
                override_existing_dns_record: false,
                origins: [],
              },
        );
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ success: true, result: { schedules: [] } }));
      }),
    );
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify({ name: 'test-worker', account_id: 'test-account' }));
    const output = await runOperation(
      directory,
      {
        type: `triggers.${operation}` as 'triggers.clear-crons' | 'triggers.clear-domains',
        configPath,
        workerName: 'test-worker',
      },
      tokenEnv(api),
    );
    expect(output.status, output.stderr).toBe(0);
    expect(requested).toBe(true);
  },
  30_000,
);

it('discovers KV namespaces beyond the first cf API page', async () => {
  const directory = temporaryDirectory('void-cf-kv-pages-');
  const requestedPages: Array<number> = [];
  const namespaces = Array.from({ length: 100 }, (_, index) => ({
    id: (index + 1).toString(16).padStart(32, '0'),
    title: `other-${index}`,
  }));
  const target = { id: 'f'.repeat(32), title: 'existing-void-kv' };
  const api = await listen(
    createServer((request, response) => {
      const url = new URL(request.url ?? '', 'http://127.0.0.1');
      expect(url.pathname).toBe('/client/v4/accounts/test-account/storage/kv/namespaces');
      expect(url.searchParams.get('per_page')).toBe('100');
      expect(url.searchParams.get('order')).toBe('id');
      expect(url.searchParams.get('direction')).toBe('asc');
      const page = Number(url.searchParams.get('page'));
      requestedPages.push(page);
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: page === 1 ? namespaces : page === 2 ? [target] : [],
        }),
      );
    }),
  );
  const configPath = join(directory, 'wrangler.json');
  writeFileSync(configPath, JSON.stringify({ account_id: 'test-account' }));
  const output = await runOperation(
    directory,
    { type: 'kv.namespace.list', configPath },
    tokenEnv(api, 'CF_API_TOKEN'),
  );
  expect(output.status, output.stderr).toBe(0);
  expect(JSON.parse(output.stdout).data).toEqual([...namespaces, target]);
  expect(requestedPages).toEqual([1, 2]);
}, 30_000);

it('finds existing Queues beyond the first cf API page', async () => {
  const directory = temporaryDirectory('void-cf-queue-pages-');
  const requestedPages: Array<number> = [];
  const api = await listen(
    createServer((request, response) => {
      const url = new URL(request.url ?? '', 'http://127.0.0.1');
      expect(url.pathname).toBe('/client/v4/accounts/test-account/queues');
      const page = Number(url.searchParams.get('page'));
      requestedPages.push(page);
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          success: true,
          result: [
            page === 1
              ? { queue_id: 'first-queue', queue_name: 'another-queue' }
              : { queue_id: 'target-queue', queue_name: 'existing-void-queue' },
          ],
          result_info: { page, per_page: 1, total_pages: 2, total_count: 2 },
        }),
      );
    }),
  );
  const configPath = join(directory, 'wrangler.json');
  writeFileSync(configPath, JSON.stringify({ account_id: 'test-account' }));
  const output = await runOperation(
    directory,
    { type: 'queues.info', name: 'existing-void-queue', configPath },
    tokenEnv(api, 'CF_API_TOKEN'),
  );
  expect(output.status, output.stderr).toBe(0);
  expect(JSON.parse(output.stdout).data).toMatchObject({ name: 'existing-void-queue' });
  expect(requestedPages).toEqual([1, 2]);
}, 30_000);

it.each([
  {
    label: 'Worker and HTTP pull consumers',
    queue: {
      consumers: [
        { type: 'worker', script_name: 'app-production', consumer_id: 'one' },
        { type: 'http_pull', consumer_id: 'two' },
      ],
      consumers_total_count: 2,
    },
    consumers: ['app-production', null],
  },
  { label: 'no consumer', queue: { consumers: [], consumers_total_count: 0 }, consumers: [] },
  {
    label: 'an incomplete consumer list',
    queue: { consumers: [], consumers_total_count: 1 },
    consumers: undefined,
  },
  { label: 'no consumer list', queue: {}, consumers: undefined },
  {
    label: 'a legacy script field',
    queue: { consumers: [{ type: 'worker', script: 'app' }], consumers_total_count: 1 },
    consumers: ['app'],
  },
  {
    label: 'a Worker consumer without a name',
    queue: { consumers: [{ type: 'worker', script_name: '' }], consumers_total_count: 1 },
    consumers: undefined,
  },
  {
    label: 'two different Worker names on one consumer',
    queue: {
      consumers: [{ type: 'worker', script_name: 'app', script: 'other' }],
      consumers_total_count: 1,
    },
    consumers: undefined,
  },
  {
    label: 'a consumer of an unknown type',
    queue: { consumers: [{ type: 'other' }], consumers_total_count: 1 },
    consumers: undefined,
  },
])(
  'reports a queue with $label',
  async ({ queue, consumers }) => {
    const directory = temporaryDirectory('void-cf-queue-consumers-');
    const api = await listen(
      createServer((_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            success: true,
            result: [{ queue_id: 'queue-id', queue_name: 'jobs', ...queue }],
            result_info: { page: 1, per_page: 1, total_pages: 1, total_count: 1 },
          }),
        );
      }),
    );
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify({ account_id: 'test-account' }));
    const output = await runOperation(
      directory,
      { type: 'queues.info', name: 'jobs', configPath },
      tokenEnv(api, 'CF_API_TOKEN'),
    );
    expect(output.status, output.stderr).toBe(0);
    // Without a complete list the field is left out; only queue naming needs it.
    expect(JSON.parse(output.stdout).data).toEqual({
      id: 'queue-id',
      name: 'jobs',
      ...(consumers ? { consumers } : {}),
    });
  },
  30_000,
);

it.each([
  {
    label: 'Cloudflare script_name',
    consumers: [{ script_name: 'test-worker', consumer_id: 'owned-consumer', type: 'worker' }],
    deleted: ['owned-consumer'],
    status: 0,
  },
  {
    label: 'matching legacy alias',
    consumers: [
      { script_name: 'test-worker', script: 'test-worker', consumer_id: 'owned-consumer' },
    ],
    deleted: ['owned-consumer'],
    status: 0,
  },
  {
    label: 'foreign Worker and HTTP pull consumers',
    consumers: [
      { script_name: 'other-worker', consumer_id: 'foreign-consumer', type: 'worker' },
      { consumer_id: 'pull-consumer', type: 'http_pull' },
    ],
    deleted: [],
    status: 0,
  },
  {
    label: 'conflicting aliases',
    consumers: [
      { script_name: 'other-worker', script: 'test-worker', consumer_id: 'foreign-consumer' },
    ],
    deleted: [],
    status: 1,
  },
  {
    label: 'missing Worker identity',
    consumers: [{ consumer_id: 'unknown-consumer', type: 'worker' }],
    deleted: [],
    status: 1,
  },
  {
    label: 'null Worker identity',
    consumers: [{ script_name: null, consumer_id: 'unknown-consumer' }],
    deleted: [],
    status: 1,
  },
  {
    label: 'missing consumer ID',
    consumers: [{ script_name: 'test-worker', type: 'worker' }],
    deleted: [],
    status: 1,
  },
  {
    label: 'duplicate owned consumers',
    consumers: [
      { script_name: 'test-worker', consumer_id: 'first-consumer', type: 'worker' },
      { script_name: 'test-worker', consumer_id: 'second-consumer', type: 'worker' },
    ],
    deleted: [],
    status: 1,
  },
  {
    label: 'option-shaped consumer ID',
    consumers: [{ script_name: 'test-worker', consumer_id: '--help', type: 'worker' }],
    deleted: [],
    status: 1,
  },
])(
  'cleans up Queue consumers using verified identities: $label',
  async ({ consumers, deleted, status }) => {
    const directory = temporaryDirectory('void-cf-queue-cleanup-');
    const deletes: Array<string> = [];
    const api = await listen(
      createServer((request, response) => {
        const url = new URL(request.url ?? '', 'http://127.0.0.1');
        request.resume();
        response.setHeader('Content-Type', 'application/json');
        const queuePath = '/client/v4/accounts/test-account/queues';
        if (request.method === 'GET' && url.pathname === queuePath) {
          response.end(
            JSON.stringify({
              success: true,
              result: [{ queue_id: 'queue-id', queue_name: 'existing-queue' }],
              result_info: { page: 1, total_pages: 1 },
            }),
          );
        } else if (request.method === 'GET' && url.pathname === `${queuePath}/queue-id/consumers`) {
          response.end(JSON.stringify({ success: true, result: consumers }));
        } else if (
          request.method === 'DELETE' &&
          url.pathname.startsWith(`${queuePath}/queue-id/consumers/`)
        ) {
          deletes.push(url.pathname.split('/').at(-1)!);
          response.end(JSON.stringify({ success: true, result: {} }));
        } else {
          response.statusCode = 400;
          response.end(
            JSON.stringify({ success: false, errors: [{ message: 'Unexpected request' }] }),
          );
        }
      }),
    );
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify({ account_id: 'test-account', name: 'test-worker' }));
    const output = await runOperation(
      directory,
      {
        type: 'queues.consumer.remove',
        queueName: 'existing-queue',
        workerName: 'test-worker',
        configPath,
      },
      tokenEnv(api, 'CF_API_TOKEN'),
    );
    expect(output.status, output.stderr).toBe(status);
    expect(deletes).toEqual(deleted);
    expect(output.stderr).not.toContain('synthetic-token');
  },
  30_000,
);

it.each([
  {
    operation: { type: 'email.routing.settings' as const, domain: 'acme.com' },
    commands: [
      {
        command: ['email-routing', 'settings', 'get', '--zone', 'acme.com'],
        data: {
          name: 'acme.com',
          enabled: true,
          status: 'ready',
          tag: '11111111111111111111111111111111',
        },
      },
    ],
    expected: {
      name: 'acme.com',
      enabled: true,
      status: 'ready',
      tag: '11111111111111111111111111111111',
    },
  },
  {
    operation: { type: 'email.sending.settings' as const, domain: 'mail.acme.com' },
    commands: [
      {
        command: ['email-routing', 'settings', 'get', '--zone', 'mail.acme.com'],
        status: 1,
        stderr: 'Zone not found: mail.acme.com',
      },
      {
        command: ['email-routing', 'settings', 'get', '--zone', 'acme.com'],
        data: {
          name: 'acme.com',
          enabled: true,
          status: 'ready',
          tag: '11111111111111111111111111111111',
        },
      },
      {
        command: ['email-sending', 'subdomains', 'list', '--zone', 'acme.com'],
        data: [{ name: 'mail.acme.com', enabled: true, id: '22222222222222222222222222222222' }],
      },
    ],
    expected: { name: 'mail.acme.com', enabled: true, id: '22222222222222222222222222222222' },
  },
  {
    operation: { type: 'email.routing.rules.list' as const, domain: 'acme.com' },
    commands: [
      {
        command: [
          'email-routing',
          'rules',
          'list-account',
          '--page',
          '1',
          '--per-page',
          '100',
          '--zone',
          'acme.com',
        ],
        data: Array.from({ length: 100 }, (_, index) => ({
          id: `rule-${index}`,
          name: 'support',
          enabled: index % 2 === 0,
          matchers: [{ type: 'literal', field: 'to', value: `support-${index}@acme.com` }],
          actions: [{ type: 'worker', value: ['my-worker'] }],
        })),
      },
      {
        command: [
          'email-routing',
          'rules',
          'list-account',
          '--page',
          '2',
          '--per-page',
          '100',
          '--zone',
          'acme.com',
        ],
        data: [{ enabled: false, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] }],
      },
    ],
  },
])('returns structured email data for $operation', async ({ operation, commands, ...example }) => {
  const directory = temporaryDirectory('void-cf-email-json-');
  const preload = join(directory, 'mock-cf.mjs');
  const callsPath = join(directory, 'calls.json');
  writeFileSync(
    preload,
    `import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const commands = ${JSON.stringify(commands)};
const calls = [];
child.spawnSync = (_executable, args) => {
  const command = args.slice(1);
  calls.push(command);
  writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
  const response = commands[calls.length - 1];
  if (JSON.stringify(command) !== JSON.stringify(response?.command)) {
    return { status: 1, stdout: '', stderr: 'Unexpected email transport command' };
  }
  return { status: response.status ?? 0, stdout: response.data === undefined ? '' : JSON.stringify(response.data), stderr: response.stderr ?? '' };
};
syncBuiltinESMExports();
`,
  );
  const output = await runOperation(
    directory,
    operation,
    { ...systemEnv, CI: 'true', CLOUDFLARE_AUTH_USE_KEYRING: 'false' },
    preload,
  );
  expect(output.status, output.stderr).toBe(0);
  expect(JSON.parse(output.stdout).data).toEqual(
    'expected' in example
      ? example.expected
      : commands.flatMap<unknown>((command) => command.data ?? []),
  );
  expect(JSON.parse(readFileSync(callsPath, 'utf8'))).toEqual(
    commands.map((command) => command.command),
  );
});
