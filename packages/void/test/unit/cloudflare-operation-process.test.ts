import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { expect, it } from 'vite-plus/test';
import { decodeCloudflareOperationResult } from '../../src/cli/cloudflare-process.ts';
import { Buffer } from '../../src/cli/node-buffer.ts';
import {
  cleanups,
  listen,
  runOperation,
  systemEnv,
  temporaryDirectory,
  tokenEnv,
} from '../helpers/cloudflare-operation-process.ts';

it.each(['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'] as const)(
  'keeps OAuth storage and terminal UI unloaded when %s supplies the bearer',
  async (name) => {
    const root = temporaryDirectory('void-token-only-startup-');
    const preload = join(root, 'reject-auth-imports.mjs');
    writeFileSync(
      preload,
      `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.includes('/cf-session') || specifier.includes('/cloudflare-login-output') ||
      specifier.startsWith('@cloudflare/workers-auth') || specifier === '@voidzero-dev/vite-plus-prompts') {
    throw new Error('Token-only operations must not load OAuth storage or terminal UI');
  }
  return nextResolve(specifier, context);
} });`,
    );
    const result = await runOperation(
      root,
      { type: 'auth.token' },
      tokenEnv(undefined, name),
      preload,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual({ type: 'api_token', token: 'synthetic-token' });
  },
);

it('loads the live terminal presentation when the login operation needs it', async () => {
  const root = temporaryDirectory('void-login-presentation-');
  const preload = join(root, 'login-child.mjs');
  writeFileSync(
    preload,
    `import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
childProcess.spawn = (_command, args) => {
  if (!args.includes('login') || !args.includes('--force')) throw new Error('Expected forced login');
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => {
    child.stderr.write('Visit this link to authenticate: https://example.test/device\\nand enter the code: TEST-1234\\n');
    child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
  });
  return child;
};
syncBuiltinESMExports();`,
  );
  const result = await runOperation(
    root,
    { type: 'auth.login' },
    { ...systemEnv, CLOUDFLARE_AUTH_USE_KEYRING: 'false' },
    preload,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('TEST-1234');
  expect(result.stdout).toContain('https://example.test/device');
});

it.each([
  ['clear-crons', 'true'],
  ['clear-domains', 'false'],
])(
  'uses browser credentials for %s with keyring %s',
  async (operation, keyringSetting) => {
    const directory = temporaryDirectory('void-cf-clear-crons-oauth-');
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      authorization: string | undefined;
      body: unknown;
    }> = [];
    const api = await listen(
      createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
        }
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          body: JSON.parse(body),
        });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ success: true, result: { schedules: [] } }));
      }),
    );
    const configPath = join(directory, 'wrangler.json');
    const preload = join(directory, 'mock-cf.mjs');
    writeFileSync(configPath, JSON.stringify({ name: 'test-worker', account_id: 'test-account' }));
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
os.homedir = () => process.env.VOID_TEST_HOME;
syncBuiltinESMExports();
import { setKeyProviderFactoryForTesting } from ${JSON.stringify(import.meta.resolve('@cloudflare/workers-auth'))};
import { createCfAuth } from ${JSON.stringify(import.meta.resolve('@cloudflare/workers-auth/cf'))};
let key;
setKeyProviderFactoryForTesting(() => ({ getKey: () => key, setKey: (value) => { key = value; }, deleteKey: () => { key = undefined; }, describe: () => 'synthetic provider' }));
const logger = { debug() {}, info() {}, log() {}, warn() {}, error() {} };
const auth = createCfAuth({ logger, userAgent: 'void-test', prompt: async () => '', select: async () => '', isNoDefaultValueProvidedError: () => false });
auth.writeAuthCredentials({ oauth_token: 'synthetic-oauth-token', refresh_token: 'synthetic-refresh', expiration_time: new Date(Date.now() + 3600000).toISOString(), scopes: [] });
const credentialPath = auth.getCredentialStore().path();
child.spawnSync = (_binary, args, options) => {
  if (args[1] !== 'auth' || args[2] !== 'whoami' || options.env.CLOUDFLARE_AUTH_USE_KEYRING !== ${JSON.stringify(keyringSetting)}) {
    return { status: 1, stdout: '', stderr: 'Wrong authentication source.' };
  }
  return { status: 0, stdout: JSON.stringify({ authenticated: true, tokenValid: true, authSource: 'OAuth token from ' + credentialPath }), stderr: '' };
};
syncBuiltinESMExports();
`,
    );
    const output = await runOperation(
      directory,
      {
        type: `triggers.${operation}` as 'triggers.clear-crons' | 'triggers.clear-domains',
        configPath,
        workerName: 'test-worker',
      },
      {
        ...systemEnv,
        CI: 'true',
        CLOUDFLARE_AUTH_USE_KEYRING: keyringSetting,
        CLOUDFLARE_ACCOUNT_ID: 'test-account',
        CLOUDFLARE_API_BASE_URL: `${api}/client/v4`,
        HOME: directory,
        USERPROFILE: directory,
        XDG_CONFIG_HOME: join(directory, '.config'),
        APPDATA: join(directory, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(directory, 'AppData', 'Local'),
        VOID_TEST_HOME: directory,
      },
      preload,
    );
    expect(output.status, output.stderr).toBe(0);
    expect(requests).toMatchObject([
      {
        method: 'PUT',
        url: `/client/v4/accounts/test-account/workers/scripts/test-worker/${operation === 'clear-crons' ? 'schedules' : 'domains/records'}`,
        authorization: 'Bearer synthetic-oauth-token',
      },
    ]);
  },
  30_000,
);

it('reports an absent cf session as authentication failure', async () => {
  const directory = temporaryDirectory('void-cf-no-auth-');
  const output = await runOperation(
    directory,
    { type: 'auth.whoami' },
    {
      ...systemEnv,
      HOME: directory,
      USERPROFILE: directory,
      XDG_CONFIG_HOME: directory,
      APPDATA: directory,
      // Test absent credentials independently of host keyring support.
      CLOUDFLARE_AUTH_USE_KEYRING: 'false',
      CI: 'true',
    },
  );
  expect(output.status, output.stdout + output.stderr).toBe(1);
  expect(JSON.parse(output.stdout).data, output.stderr).toEqual({ loggedIn: false });
  expect(output.stderr).toContain('authentication is required');
}, 30_000);

it.each([false, true])(
  'forwards the cf auth whoami failure from auth.token (Global API Key=%s)',
  async (apiKey) => {
    const directory = temporaryDirectory('void-cf-token-whoami-');
    const preload = join(directory, 'mock-cf.mjs');
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
child.spawnSync = () => ({ status: 1, stdout: '', stderr: 'Not logged in. [code: 10000]\\n' });
syncBuiltinESMExports();
`,
    );
    const output = await runOperation(
      directory,
      { type: 'auth.token' },
      {
        ...systemEnv,
        CI: 'true',
        HOME: directory,
        USERPROFILE: directory,
        ...(apiKey
          ? { CLOUDFLARE_API_KEY: 'synthetic-key', CLOUDFLARE_EMAIL: 'a@example.test' }
          : {}),
      },
      preload,
    );
    expect(output.status, output.stderr).toBe(1);
    const decoded = decodeCloudflareOperationResult(output);
    expect(decoded.stderr).toContain(
      'cf auth whoami exited with code 1.\nNot logged in. [code: 10000]',
    );
    expect(decoded.data).toEqual(apiKey ? { type: 'api_key' } : undefined);
  },
  30_000,
);

it('uses pinned cf despite a project-local CLI and preserves D1 results and the CF token alias', async () => {
  const directory = temporaryDirectory('void-cf-d1-contract-');
  const requests: Array<{ method: string; path: string; authorization: string | undefined }> = [];
  const api = await listen(
    createServer((request, response) => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
      });
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: [{ results: [{ name: '0001_setup.sql' }], success: true, meta: {} }],
        }),
      );
    }),
  );
  const local = join(directory, 'node_modules', 'cf');
  mkdirSync(local, { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{}');
  writeFileSync(
    join(local, 'package.json'),
    JSON.stringify({ name: 'cf', version: '0.0.0', bin: { cf: 'fake.cjs' } }),
  );
  writeFileSync(join(local, 'fake.cjs'), 'console.log("UNPINNED_PROJECT_CF_EXECUTED");');
  const configPath = join(directory, 'wrangler.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      account_id: 'test-account',
      d1_databases: [{ binding: 'DB', database_id: 'test-database' }],
    }),
  );
  const output = await runOperation(
    directory,
    { type: 'd1.execute', database: 'DB', sql: 'SELECT name FROM d1_migrations', configPath },
    tokenEnv(api, 'CF_API_TOKEN'),
  );
  expect(output.status, output.stderr).toBe(0);
  expect(JSON.parse(output.stdout).data).toEqual([
    { results: [{ name: '0001_setup.sql' }], success: true, meta: {} },
  ]);
  expect(requests).toEqual([
    {
      method: 'POST',
      path: '/client/v4/accounts/test-account/d1/database/test-database/query',
      authorization: 'Bearer synthetic-token',
    },
  ]);
}, 30_000);

it('sends D1 SQL that starts with a comment as one --sql value through the pinned cf', async () => {
  const directory = temporaryDirectory('void-cf-d1-comment-sql-');
  const bodies: Array<unknown> = [];
  const api = await listen(
    createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
      }
      bodies.push(JSON.parse(body));
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: [{ results: [], success: true, meta: {} }],
        }),
      );
    }),
  );
  const configPath = join(directory, 'wrangler.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      account_id: 'test-account',
      d1_databases: [{ binding: 'DB', database_id: 'test-database' }],
    }),
  );
  const sql = '-- leading comment\nSELECT 1;';
  const output = await runOperation(
    directory,
    { type: 'd1.execute', database: 'DB', sql, configPath },
    tokenEnv(api, 'CF_API_TOKEN'),
  );
  expect(output.status, output.stderr).toBe(0);
  expect(bodies).toEqual([{ sql }]);
}, 30_000);

it('uses the configured HTTP proxy for cf resource requests', async () => {
  const directory = temporaryDirectory('void-cf-resource-proxy-');
  let proxied = 0;
  let queried = 0;
  const api = await listen(
    createServer((request, response) => {
      queried++;
      expect(request.url).toBe('/client/v4/accounts/test-account/d1/database/test-database/query');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true, result: [{ results: [], success: true }] }));
    }),
  );
  const proxy = createServer((request, response) => {
    proxied++;
    const upstream = httpRequest(
      request.url!,
      { method: request.method, headers: request.headers },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    request.pipe(upstream);
    upstream.on('error', () => response.destroy());
  });
  proxy.on('connect', (request, socket, head) => {
    proxied++;
    const [host, port] = request.url!.split(':');
    const upstream = connect(Number(port), host!, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
  });
  const proxyUrl = await listen(proxy);
  const configPath = join(directory, 'wrangler.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      account_id: 'test-account',
      d1_databases: [{ binding: 'DB', database_id: 'test-database' }],
    }),
  );
  const output = await runOperation(
    directory,
    { type: 'd1.execute', database: 'DB', sql: 'SELECT 1', configPath },
    {
      ...process.env,
      CF_API_TOKEN: 'synthetic-token',
      CLOUDFLARE_ACCOUNT_ID: 'test-account',
      CLOUDFLARE_API_BASE_URL: `${api}/client/v4`,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: '',
      NO_PROXY: '',
    },
  );
  expect(output.status, output.stderr).toBe(0);
  expect(queried).toBe(1);
  expect(proxied).toBe(1);
}, 30_000);

it.each([
  { label: 'malformed JSON', request: '{', extra: [] },
  { label: 'null request', request: 'null', extra: [] },
  { label: 'array request', request: '[]', extra: [] },
  { label: 'missing operation type', request: '{}', extra: [] },
  { label: 'unknown operation', request: JSON.stringify({ type: 'unknown.operation' }), extra: [] },
  { label: 'legacy command words', request: 'd1', extra: ['list'] },
  {
    label: 'trailing command arguments',
    request: JSON.stringify({ type: 'd1.list' }),
    extra: ['--json'],
  },
])('rejects $label before invoking the provider', async ({ request, extra }) => {
  const directory = temporaryDirectory('void-operation-protocol-');
  const capture = join(directory, 'provider-ran');
  const preload = join(directory, 'mock-provider.mjs');
  writeFileSync(
    preload,
    `import child from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
child.spawnSync = () => {
  writeFileSync(${JSON.stringify(capture)}, 'invoked');
  return {status:0,stdout:'[]',stderr:''};
};
syncBuiltinESMExports();`,
  );
  const output = await runOperation(directory, [request, ...extra], tokenEnv(), preload);
  expect(output.status, output.stderr).toBe(1);
  expect(existsSync(capture)).toBe(false);
  expect(JSON.parse(output.stdout)).toMatchObject({
    operationResult: 1,
    errors: expect.any(Array),
  });
  expect(output.stdout + output.stderr).not.toContain('synthetic-token');
});

it.each([
  { label: 'signal', code: 10006, signal: 'SIGTERM', spawnError: false },
  { label: 'spawn error', code: 10007, signal: null, spawnError: true },
  { label: 'missing exit status', code: 10006, signal: null, spawnError: false },
])('preserves an inner provider $label without authorizing resource absence', async (example) => {
  const directory = temporaryDirectory('void-operation-provider-failure-');
  const preload = join(directory, 'failed-provider.mjs');
  writeFileSync(
    preload,
    `import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
child.spawnSync = () => ({
  status: null,
  signal: ${JSON.stringify(example.signal)},
  error: ${example.spawnError ? "new Error('Synthetic provider spawn failure.')" : 'undefined'},
  stdout: '[]',
  stderr: '[${example.code}] Resource does not exist.'
});
syncBuiltinESMExports();`,
  );
  const operation =
    example.code === 10007
      ? { type: 'secret.list' as const, workerName: 'test-worker' }
      : { type: 'r2.bucket.info' as const, name: 'test-bucket' };
  const output = await runOperation(directory, operation, tokenEnv(), preload);
  expect(output.status).toBe(1);
  expect(output.stderr).toContain(`[code: ${example.code}]`);
  const envelope = JSON.parse(output.stdout);
  expect(envelope.operationResult).toBe(1);
  expect(envelope.errorCode).toBeUndefined();
  expect(envelope.failure).toBeUndefined();
  expect(envelope.errors[0].code).toBeUndefined();
  const decoded = decodeCloudflareOperationResult({ ...output, signal: null, error: null });
  expect(decoded.status).toBe(1);
  expect(decoded.data).toBeUndefined();
  expect(decoded.errorCode).toBeUndefined();
  expect(decoded.failure).toBeUndefined();
  if (example.signal) {
    expect(decoded.signal).toBe(example.signal);
  } else {
    expect(decoded.error).toContain(
      example.spawnError
        ? 'Synthetic provider spawn failure.'
        : 'Cloudflare CLI did not report an exit status.',
    );
  }
  expect(output.stdout + output.stderr).not.toContain('synthetic-token');
});

it('rejects a changed tail target before any provider request', async () => {
  const directory = temporaryDirectory('void-tail-target-');
  const configPath = join(directory, 'wrangler.jsonc');
  writeFileSync(configPath, JSON.stringify({ name: 'changed-worker', account_id: 'test-account' }));
  const output = await runOperation(
    directory,
    { type: 'tail', workerName: 'original-worker', configPath },
    { ...tokenEnv('http://127.0.0.1:1'), CI: undefined },
  );
  expect(output.status).toBe(1);
  expect(output.stderr).toContain('tail target is not pinned');
  expect(output.stdout).toBe('');
});

it('renders binary and text frames from a real Node WebSocket in order and removes the captured tail', async () => {
  const directory = temporaryDirectory('void-tail-binary-');
  const sockets = new Set<Duplex>();
  const requests: Array<{ method: string | undefined; url: string | undefined; body: string }> = [];
  let initialization: string | undefined;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        success: true,
        ...(request.method === 'POST'
          ? {
              result: {
                id: 'owned-tail',
                url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/stream`,
              },
            }
          : {}),
      }),
    );
  });
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const key = request.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: trace-v1\r\n\r\n`,
    );
    let input = Buffer.alloc(0);
    const started = (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (input.length < 6) {
        return;
      }
      const length = input[1]! & 127;
      if (length >= 126 || input.length < 6 + length) {
        return;
      }
      initialization = Buffer.from(
        input.subarray(6, 6 + length).map((value, index) => value ^ input[2 + (index % 4)]!),
      ).toString();
      socket.off('data', started);
      const frame = (value: unknown, opcode: number) => {
        const data = Buffer.from(JSON.stringify(value));
        const header =
          data.length < 126 ? Buffer.from([0x80 | opcode, data.length]) : Buffer.alloc(4);
        if (data.length >= 126) {
          header[0] = 0x80 | opcode;
          header[1] = 126;
          header.writeUInt16BE(data.length, 2);
        }
        return Buffer.concat([header, data]);
      };
      socket.write(
        Buffer.concat([
          frame(
            {
              event: { request: { method: 'POST', url: 'https://isolated.invalid/runtime' } },
              eventTimestamp: 1790000000000,
              outcome: 'ok',
              logs: [
                { level: 'log', message: ['binary marker \u001b]52;c;ZXZpbA==\u0007'] },
                { level: 'error', message: ['error marker'] },
              ],
            },
            2,
          ),
          frame(
            {
              event: { queue: 'owned-queue' },
              eventTimestamp: 1790000000001,
              outcome: 'ok',
              logs: [{ level: 'log', message: ['text marker'] }],
            },
            1,
          ),
          Buffer.from([0x88, 0]),
        ]),
      );
      socket.once('data', () => socket.end());
    };
    socket.on('data', started);
  });
  const api = await listen(server);
  // Upgraded sockets keep the server open until they are destroyed.
  cleanups.push(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
  });
  const configPath = join(directory, 'wrangler.json');
  writeFileSync(configPath, JSON.stringify({ name: 'test-worker', account_id: 'test-account' }));
  const output = await runOperation(
    directory,
    {
      type: 'tail',
      workerName: 'test-worker',
      configPath,
      search: 'marker',
      versionId: '11111111-2222-3333-4444-555555555555',
    },
    { ...tokenEnv(api), CI: undefined },
  );
  expect(output.status, output.stderr).toBe(0);
  expect(initialization).toBe('{"debug":false}');
  expect(output.stderr).not.toContain('malformed tail');
  expect(output.stdout).toContain('POST https://isolated.invalid/runtime - ok');
  expect(output.stdout).toContain('  (log) binary marker');
  expect(output.stdout).not.toContain('\x1b]');
  expect(output.stdout).not.toContain('\x07');
  expect(output.stdout).toContain('  (error) error marker');
  expect(output.stdout).toContain('Queue owned-queue - ok');
  expect(output.stdout.indexOf('binary marker')).toBeLessThan(output.stdout.indexOf('text marker'));
  expect(requests).toHaveLength(2);
  expect(JSON.parse(requests[0]!.body)).toEqual({
    filters: [{ query: 'marker' }, { scriptVersion: '11111111-2222-3333-4444-555555555555' }],
  });
  expect(requests[1]).toEqual({
    method: 'DELETE',
    url: '/client/v4/accounts/test-account/workers/scripts/test-worker/tails/owned-tail',
    body: '',
  });
}, 30_000);

it.each(['canonical', 'alias', 'bearer'] as const)(
  'reads the account workers.dev subdomain with %s credentials',
  async (credentials) => {
    const directory = temporaryDirectory('void-cf-subdomain-');
    const requests: Array<{
      path: string | undefined;
      key: string | undefined;
      email: string | undefined;
      authorization: string | undefined;
    }> = [];
    const api = await listen(
      createServer((request, response) => {
        requests.push({
          path: request.url,
          key: request.headers['x-auth-key'] as string | undefined,
          email: request.headers['x-auth-email'] as string | undefined,
          authorization: request.headers.authorization,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, result: { subdomain: 'my-team' } }));
      }),
    );
    const env = {
      ...systemEnv,
      CI: 'true',
      CLOUDFLARE_ACCOUNT_ID: 'test-account',
      CLOUDFLARE_API_BASE_URL: api + '/client/v4',
      ...(credentials === 'bearer'
        ? { CLOUDFLARE_API_TOKEN: 'synthetic-token' }
        : credentials === 'canonical'
          ? { CLOUDFLARE_API_KEY: 'synthetic-key', CLOUDFLARE_EMAIL: 'dev@example.test' }
          : { CF_API_KEY: 'synthetic-key', CF_EMAIL: 'dev@example.test' }),
    };
    const output = await runOperation(directory, { type: 'workers.subdomain.get' }, env);
    expect(output.status, output.stderr).toBe(0);
    expect(decodeCloudflareOperationResult(output).data).toEqual({ subdomain: 'my-team' });
    expect(requests).toEqual([
      {
        path: '/client/v4/accounts/test-account/workers/subdomain',
        key: credentials === 'bearer' ? undefined : 'synthetic-key',
        email: credentials === 'bearer' ? undefined : 'dev@example.test',
        authorization: credentials === 'bearer' ? 'Bearer synthetic-token' : undefined,
      },
    ]);
    expect(output.stdout + output.stderr).not.toContain('synthetic-');
  },
);

it.each([
  { name: 'HTTP failure', status: 403, body: { success: false, errors: [] } },
  { name: 'API failure', status: 200, body: { success: false, result: { subdomain: 'team' } } },
  { name: 'missing subdomain', status: 200, body: { success: true, result: {} } },
  { name: 'empty subdomain', status: 200, body: { success: true, result: { subdomain: ' ' } } },
  { name: 'invalid type', status: 200, body: { success: true, result: { subdomain: 42 } } },
  { name: 'redirect', status: 302, body: {} },
])('rejects a subdomain lookup with $name', async ({ status, body }) => {
  const directory = temporaryDirectory('void-cf-subdomain-error-');
  let redirected = false;
  const api = await listen(
    createServer((request, response) => {
      if (request.url === '/redirected') {
        redirected = true;
      }
      response.writeHead(status, { 'Content-Type': 'application/json', Location: '/redirected' });
      response.end(JSON.stringify(body));
    }),
  );
  const output = await runOperation(directory, { type: 'workers.subdomain.get' }, tokenEnv(api));
  expect(output.status).toBe(1);
  expect(decodeCloudflareOperationResult(output).data).toBeUndefined();
  expect(redirected).toBe(false);
  expect(output.stdout + output.stderr).not.toContain('synthetic-token');
});
