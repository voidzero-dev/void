import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { CloudflareOperation } from '@void/deploy-cloudflare';
import { afterEach, expect, it } from 'vite-plus/test';
import { isVoidSecretOnlyDraft } from '../../../deploy-cloudflare/src/secret-draft.ts';
import { voidSecretDraftVersion } from '../../../deploy-cloudflare/test/secret-draft-fixture.ts';
import {
  decodeCloudflareOperationResult,
  encodeCloudflareOperation,
} from '../../src/cli/cloudflare-process.ts';
import { Buffer } from '../../src/cli/node-buffer.ts';
import { resolveCloudflareOperationArgv } from '../../src/cli/preset.ts';

const voidVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .version as string;
const cfVersion = JSON.parse(readFileSync(new URL(import.meta.resolve('cf/package.json')), 'utf8'))
  .version as string;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Serve on a random local port until the test ends and return the origin. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// Children get only what Node needs, so host credentials cannot leak into a test.
const systemEnv = {
  PATH: process.env.PATH,
  SYSTEMROOT: process.env.SYSTEMROOT,
  WINDIR: process.env.WINDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
};

function tokenEnv(
  api?: string,
  token: 'CLOUDFLARE_API_TOKEN' | 'CF_API_TOKEN' = 'CLOUDFLARE_API_TOKEN',
): NodeJS.ProcessEnv {
  return {
    ...systemEnv,
    CI: 'true',
    [token]: 'synthetic-token',
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    ...(api ? { CLOUDFLARE_API_BASE_URL: `${api}/client/v4` } : {}),
  };
}

function unproxiedEnv(api: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CF_API_TOKEN: 'synthetic-token',
    CLOUDFLARE_ACCOUNT_ID: 'test-account',
    CLOUDFLARE_API_BASE_URL: `${api}/client/v4`,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    http_proxy: '',
    https_proxy: '',
  };
}

/** Run the operation process the CLI spawns; `preload` is imported first to stub cf. */
function runOperation(
  cwd: string,
  request: CloudflareOperation | Array<string>,
  env: NodeJS.ProcessEnv,
  preload?: string,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const [command, ...prefix] = resolveCloudflareOperationArgv();
  const args = Array.isArray(request) ? request : encodeCloudflareOperation(request);
  return new Promise((resolve) => {
    execFile(
      command!,
      [...(preload ? ['--import', pathToFileURL(preload).href] : []), ...prefix, ...args],
      { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024 * 1024, env },
      (error, stdout, stderr) =>
        resolve({ status: error ? Number(error.code) || 1 : 0, stdout, stderr }),
    );
  });
}

it.each([true, false])(
  'publishes observability from the trigger operation (enabled=%s)',
  async (enabled) => {
    const directory = temporaryDirectory('void-cf-observability-');
    const configPath = join(directory, 'wrangler.json');
    const observability = { enabled, logs: { enabled }, traces: { enabled } };
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'test-worker',
        workers_dev: false,
        preview_urls: false,
        observability,
      }),
    );
    const patches: Array<{ path: string; body: unknown; authorization?: string }> = [];
    const api = await listen(
      createServer(async (request, response) => {
        const chunks: Array<Buffer> = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        if (request.method === 'PATCH') {
          patches.push({
            path: request.url ?? '',
            body: JSON.parse(Buffer.concat(chunks).toString()),
            authorization: request.headers.authorization,
          });
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            success: true,
            result: request.url?.endsWith('/workers/subdomain')
              ? { subdomain: 'fixture' }
              : { subdomain: { enabled: false, previews_enabled: false }, observability },
          }),
        );
      }),
    );
    const output = await runOperation(
      directory,
      {
        type: 'triggers.deploy',
        workerName: 'test-worker',
        configPath,
      },
      tokenEnv(api),
    );
    expect(output.status, output.stderr).toBe(0);
    expect(patches).toEqual([
      {
        path: '/client/v4/accounts/test-account/workers/scripts/test-worker/script-settings',
        body: { observability },
        authorization: 'Bearer synthetic-token',
      },
    ]);
  },
  15_000,
);

it.each([false, true])(
  'requests immutable version source without provisioning (large=%s)',
  async (large) => {
    const directory = temporaryDirectory('void-cf-secret-source-');
    const draft = voidSecretDraftVersion();
    if (large) {
      draft.modules[0]!.content_base64 = Buffer.from(
        `/* ${'x'.repeat(1024 * 1024)} */\nexport default { fetch() { return new Response("ok"); } };`,
      ).toString('base64');
    }
    const requests: Array<string> = [];
    const userAgents: Array<string | undefined> = [];
    const api = await listen(
      createServer((request, response) => {
        requests.push(request.url ?? '');
        userAgents.push(request.headers['user-agent']);
        request.resume();
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, errors: [], messages: [], result: draft }));
      }),
    );
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(configPath, JSON.stringify({ name: 'test-worker', account_id: 'test-account' }));
    const output = await runOperation(
      directory,
      {
        type: 'versions.view',
        versionId: draft.id,
        includeSource: true,
        configPath,
        workerName: 'test-worker',
      },
      { ...tokenEnv(api), CLI_VERSION: 'inherited-version void/stale' },
    );
    expect(output.status, output.stderr).toBe(0);
    const result = decodeCloudflareOperationResult({
      status: 0,
      stdout: output.stdout,
      stderr: '',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.data).toEqual(draft);
    expect(isVoidSecretOnlyDraft(result.data as Record<string, unknown>)).toBe(!large);
    expect(requests).toEqual([
      `/client/v4/accounts/test-account/workers/workers/test-worker/versions/${draft.id}?include=modules`,
    ]);
    expect(output.stdout).not.toContain('synthetic-token');
    expect(userAgents).toEqual([`cf-cli/${cfVersion} void/${voidVersion}`]);
  },
);

it.each([undefined, false, true])(
  'sends bypassDeploymentChecks=%s through cf alongside the deployment body',
  async (bypassDeploymentChecks) => {
    const directory = temporaryDirectory('void-cf-deployment-checks-');
    const requests: Array<{ url: string | undefined; body: unknown }> = [];
    const api = await listen(
      createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
        }
        requests.push({ url: request.url, body: JSON.parse(body) });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ success: true, result: { id: 'deployment-id' } }));
      }),
    );
    const preload = join(directory, 'capture-cf.mjs');
    const callsPath = join(directory, 'calls.json');
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
const spawnSync = child.spawnSync;
child.spawnSync = (binary, args, options) => {
  writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args.slice(1)));
  return spawnSync(binary, args, options);
};
syncBuiltinESMExports();
`,
    );
    const versionId = '11111111-1111-4111-8111-111111111111';
    const message = 'Void automatic rollback after readiness failed.';
    const output = await runOperation(
      directory,
      {
        type: 'versions.deploy',
        workerName: 'test-worker',
        versions: [{ versionId, percentage: 100 }],
        message,
        bypassDeploymentChecks,
      },
      tokenEnv(api),
      preload,
    );
    expect(output.status, output.stderr).toBe(0);
    expect(decodeCloudflareOperationResult({ ...output, status: 0 }).status).toBe(0);
    const args = JSON.parse(readFileSync(callsPath, 'utf8')) as Array<string>;
    expect(args.includes('--bypass-deployment-checks')).toBe(bypassDeploymentChecks === true);
    expect(args).toContain('--body');
    expect(requests).toEqual([
      {
        url: `/client/v4/accounts/test-account/workers/scripts/test-worker/deployments${bypassDeploymentChecks === true ? '?force=true' : ''}`,
        body: {
          strategy: 'percentage',
          versions: [{ version_id: versionId, percentage: 100 }],
          annotations: { 'workers/message': message },
        },
      },
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

it.each([401, 403, 404, 503])(
  'stops a prebuilt platform upload before cf can provision an unavailable R2 bucket (HTTP %s)',
  async (status) => {
    const directory = temporaryDirectory('void-cf-platform-r2-preflight-');
    const requests: Array<string> = [];
    const api = await listen(
      createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ success: false, errors: [{ code: 10006 }] }));
      }),
    );
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(
      join(directory, 'index.js'),
      'export default { fetch() { return new Response("ok") } };',
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'test-worker',
        account_id: 'test-account',
        compatibility_date: '2026-09-29',
        main: 'index.js',
        no_bundle: true,
        r2_buckets: [{ binding: 'ASSETS', bucket_name: 'missing-bucket' }],
      }),
    );
    const output = await runOperation(
      directory,
      { type: 'versions.upload', configPath },
      unproxiedEnv(api),
    );
    expect(output.status).toBe(1);
    expect(output.stderr).toContain('refusing automatic provisioning');
    expect(output.stderr).toContain(`HTTP ${status}`);
    expect(requests).toEqual(['GET /client/v4/accounts/test-account/r2/buckets/missing-bucket']);
  },
  30_000,
);

it.each(['ordinary', 'versions.upload', 'worker.deploy'] as const)(
  'allows a prebuilt %s upload and scopes installation attribution to the cf child',
  async (uploadType) => {
    const directory = temporaryDirectory('void-cf-platform-resource-preflight-');
    const requests: Array<string> = [];
    const jurisdictions: Array<string | undefined> = [];
    const api = await listen(
      createServer((request, response) => {
        const path = request.url ?? '';
        requests.push(`${request.method} ${path}`);
        if (path.includes('/r2/buckets/')) {
          jurisdictions.push(request.headers['cf-r2-jurisdiction'] as string | undefined);
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            success: true,
            result:
              path.endsWith('/queues') || path.includes('/queues?page=')
                ? [{ queue_id: 'queue-id', queue_name: 'existing-queue' }]
                : {},
            ...(path.includes('/queues?page=') ? { result_info: { page: 1, total_pages: 1 } } : {}),
          }),
        );
      }),
    );
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(
      join(directory, 'index.js'),
      'export default { fetch() { return new Response("ok") } };',
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'test-worker',
        account_id: 'test-account',
        compatibility_date: '2026-09-29',
        main: 'index.js',
        no_bundle: true,
        r2_buckets: [{ binding: 'ASSETS', bucket_name: 'existing-bucket', jurisdiction: 'eu' }],
        queues: { producers: [{ binding: 'JOBS', queue: 'existing-queue' }] },
        dispatch_namespaces: [{ binding: 'DISPATCH', namespace: 'existing-namespace' }],
        ...(uploadType === 'ordinary'
          ? {}
          : {
              vars: {
                PLATFORM_VERSION: '0.27.0',
                PLATFORM_OWNERSHIP_MARKER: JSON.stringify({
                  schemaVersion: 1,
                  accountId: 'test-account',
                  installationId: 'installation-one',
                  ownershipNonce: 'private-ownership-proof',
                  resourceId: 'test-worker',
                  resourceName: 'test-worker',
                  resourceKey: 'api-worker',
                  resourceKind: 'worker',
                }),
              },
            }),
      }),
    );
    const preload = join(directory, 'mock-version-upload.mjs');
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const actualSpawnSync=child.spawnSync;
child.spawnSync = (binary, args, options) => {
  if(args.slice(1,4).join(' ') !== 'workers versions create' && args[1] !== 'deploy') return actualSpawnSync(binary,args,options);
  writeFileSync(${JSON.stringify(join(directory, 'upload-environment.json'))}, JSON.stringify({version:options.env.CLI_VERSION,telemetry:options.env.CF_SEND_TELEMETRY}));
  return { status:0, stdout:JSON.stringify({id:'11111111-1111-4111-8111-111111111111'}), stderr:'' };
};
syncBuiltinESMExports();`,
    );
    const output = await runOperation(
      directory,
      { type: uploadType === 'ordinary' ? 'versions.upload' : uploadType, configPath },
      unproxiedEnv(api),
      preload,
    );
    expect(output.status, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout).data).toEqual({
      versionId: '11111111-1111-4111-8111-111111111111',
    });
    expect(requests).toEqual([
      'GET /client/v4/accounts/test-account/r2/buckets/existing-bucket',
      'GET /client/v4/accounts/test-account/workers/dispatch/namespaces/existing-namespace',
      'GET /client/v4/accounts/test-account/queues?page=1',
    ]);
    expect(jurisdictions).toEqual(['eu']);
    const uploadEnvironment = JSON.parse(
      readFileSync(join(directory, 'upload-environment.json'), 'utf8'),
    );
    expect(uploadEnvironment).toEqual({
      version:
        cfVersion +
        ' void/' +
        voidVersion +
        (uploadType === 'ordinary'
          ? ''
          : ' void-platform-install/0.27.0 void-role/api-worker void-installation/installation-one'),
      telemetry: 'false',
    });
    expect(JSON.stringify(uploadEnvironment)).not.toContain('private-ownership-proof');
  },
  30_000,
);

it.each([
  { label: 'uppercase proxy variables', lowercase: false, bypass: false, authenticated: false },
  { label: 'lowercase proxy variables', lowercase: true, bypass: false, authenticated: false },
  { label: 'NO_PROXY bypass', lowercase: false, bypass: true, authenticated: false },
  { label: 'no_proxy bypass', lowercase: true, bypass: true, authenticated: false },
  { label: 'authenticated proxy', lowercase: false, bypass: false, authenticated: true },
])(
  'inspects existing Worker versions with $label',
  async ({ lowercase, bypass, authenticated }) => {
    const directory = temporaryDirectory('void-cf-proxy-contract-');
    const versionId = '11111111-1111-4111-8111-111111111111';
    let proxied = 0;
    let inspected = 0;
    const proxyAuthorizations: Array<string | undefined> = [];
    // Node passes only one case variant of each environment key on Windows.
    // Clear inherited variants so the lowercase case does not lose to an empty uppercase value.
    const proxyEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'].includes(
            key.toUpperCase(),
          ),
      ),
    );
    const api = await listen(
      createServer((request, response) => {
        inspected++;
        expect(request.headers.authorization).toBe('Bearer synthetic-token');
        expect(request.headers['proxy-authorization']).toBeUndefined();
        expect(request.url).toBe(
          `/client/v4/accounts/test-account/workers/scripts/test-worker/versions/${versionId}`,
        );
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            success: true,
            result: {
              resources: { bindings: [], script: { handlers: ['fetch'] }, script_runtime: {} },
            },
          }),
        );
      }),
    );
    const proxy = createServer((request, response) => {
      proxied++;
      proxyAuthorizations.push(request.headers['proxy-authorization']);
      const { 'proxy-authorization': _proxyAuthorization, ...headers } = request.headers;
      const upstream = httpRequest(
        new URL(request.url!),
        { method: request.method, headers },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on('error', () => response.destroy());
      request.pipe(upstream);
    });
    proxy.on('connect', (request, socket, head) => {
      proxied++;
      proxyAuthorizations.push(request.headers['proxy-authorization']);
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
    const proxyOrigin = await listen(proxy);
    const proxyUrl = authenticated
      ? proxyOrigin.replace('http://', 'http://proxy-user:proxy-pass@')
      : proxyOrigin;
    const configPath = join(directory, 'wrangler.json');
    const preload = join(directory, 'mock-cf.mjs');
    writeFileSync(configPath, JSON.stringify({ name: 'test-worker', account_id: 'test-account' }));
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
child.spawnSync = () => ({ status: 0, stdout: JSON.stringify({ id: '${versionId}', bindings: [] }), stderr: '' });
syncBuiltinESMExports();
`,
    );
    const output = await runOperation(
      directory,
      { type: 'versions.view', versionId, configPath },
      {
        ...proxyEnvironment,
        CLOUDFLARE_ACCOUNT_ID: 'test-account',
        CLOUDFLARE_API_TOKEN: 'synthetic-token',
        CLOUDFLARE_API_BASE_URL: `${api}/client/v4`,
        [lowercase ? 'http_proxy' : 'HTTP_PROXY']: proxyUrl,
        [lowercase ? 'no_proxy' : 'NO_PROXY']: bypass ? '127.0.0.1' : '',
        NODE_USE_ENV_PROXY: '',
      },
      preload,
    );
    expect(output.status, output.stderr).toBe(0);
    expect(JSON.parse(output.stdout).data.resources.bindings).toEqual([]);
    expect(proxied).toBe(bypass ? 0 : 1);
    expect(proxyAuthorizations).toEqual(
      bypass
        ? []
        : [
            authenticated
              ? `Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`
              : undefined,
          ],
    );
    expect(inspected).toBe(1);
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

it.each([false, true])(
  'attaches cf to the terminal only for an interactive platform upload (interactive: %s)',
  async (interactive) => {
    const directory = temporaryDirectory('void-cf-interactive-upload-');
    const requests: Array<string> = [];
    const api = await listen(
      createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.statusCode = 500;
        response.end();
      }),
    );
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(
      join(directory, 'index.js'),
      'export default { fetch() { return new Response("ok") } };',
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'test-worker',
        account_id: 'test-account',
        compatibility_date: '2026-09-29',
        main: 'index.js',
        no_bundle: true,
      }),
    );
    const record = join(directory, 'cf-stdio.json');
    const preload = join(directory, 'mock-interactive-upload.mjs');
    writeFileSync(
      preload,
      `import child from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const actualSpawnSync=child.spawnSync;
child.spawnSync = (binary, args, options) => {
  if(args.slice(1,4).join(' ') !== 'workers versions create') return actualSpawnSync(binary,args,options);
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({stdio:options.stdio,args:args.slice(1)}));
  return options.stdio === 'inherit'
    ? { status:0, stdout:null, stderr:null }
    : { status:0, stdout:JSON.stringify({id:'11111111-1111-4111-8111-111111111111'}), stderr:'' };
};
syncBuiltinESMExports();`,
    );
    const output = await runOperation(
      directory,
      {
        type: 'versions.upload',
        configPath,
        message: 'review',
        ...(interactive ? { interactive } : {}),
      },
      unproxiedEnv(api),
      preload,
    );
    expect(output.status, output.stderr).toBe(0);
    const called = JSON.parse(readFileSync(record, 'utf8'));
    expect(called.args).toEqual([
      'workers',
      'versions',
      'create',
      '--prebuilt',
      '--message',
      'review',
    ]);
    if (interactive) {
      expect(called.stdio).toBe('inherit');
      // The terminal shows cf's own output; no result envelope follows it.
      expect(output.stdout).toBe('');
    } else {
      expect(called.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      expect(JSON.parse(output.stdout).data).toEqual({
        versionId: '11111111-1111-4111-8111-111111111111',
      });
    }
    expect(requests).toEqual([]);
  },
  30_000,
);
