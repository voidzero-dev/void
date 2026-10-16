import childProcess, { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  getWorkerConfigPath,
  readBuildOutput,
  writeContainerConfig,
} from '@cloudflare/build-output-utils';
import { OutputContainerSchema } from '@cloudflare/config';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { isVoidSecretOnlyDraft } from '../../../deploy-cloudflare/src/secret-draft.ts';
import {
  activateCloudflareVersion,
  deployCloudflareVersionTriggers,
  encodeCloudflareVersionMessage,
} from '../../../deploy-cloudflare/src/version.ts';
import { operationFixture } from '../../../deploy-cloudflare/test/operation-fixture.ts';
import { voidSecretDraftVersion } from '../../../deploy-cloudflare/test/secret-draft-fixture.ts';
import { prepareCfBuildOutput } from '../../src/cli/cf-build-output.ts';
import { uploadPinnedCloudflareVersion } from '../../src/cli/cf-version-api.ts';
import {
  createActiveSecretPinner,
  createCfCommand,
  createCfResourceVerifier,
  createCfVersionRunner,
  pinActiveWorkerSecrets,
} from '../../src/cli/cf-version-runner.ts';

const roots: Array<string> = [];
const cleanups: Array<() => unknown> = [];
const pinnedCfVersion = JSON.parse(
  readFileSync(fileURLToPath(import.meta.resolve('cf/package.json')), 'utf8'),
).version as string;
const voidVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .version as string;
const cfUserAgent = `cf-cli/${pinnedCfVersion} void/${voidVersion}`;
// Each real cf subprocess loads cf's bundle before it does any work. That takes about half a
// second when idle and several seconds on a busy machine, which can pass Vitest's 5s default.
const REAL_CF_TIMEOUT_MS = process.platform === 'win32' ? 20_000 : 15_000;
const REAL_CF_ACTIVATION_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 30_000;

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Serve a fake Cloudflare API until the test ends and return its base URL. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
}

/** The real pinned cf, whose child sees only a synthetic token and the fake API. */
function pinnedCf(apiBaseUrl: string, accountId = 'account-id', env: NodeJS.ProcessEnv = {}) {
  return createCfCommand({
    accountId,
    apiBaseUrl,
    verifyUploader: () => true,
    env: () => ({
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
      CI: 'true',
      CLOUDFLARE_API_TOKEN: 'synthetic-token',
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_BASE_URL: apiBaseUrl,
      ...env,
    }),
  });
}

it(
  'reads the exact immutable SDK draft source through the real pinned cf HTTP transport',
  async () => {
    const prepared = await output();
    const draft = voidSecretDraftVersion();
    const requests: Array<string> = [];
    const userAgents: Array<string | undefined> = [];
    const apiBaseUrl = await listen(
      createServer((request, response) => {
        requests.push(request.url ?? '');
        userAgents.push(request.headers['user-agent']);
        request.resume();
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, errors: [], messages: [], result: draft }));
      }),
    );
    try {
      const command = pinnedCf(apiBaseUrl, 'test-account', {
        CLI_VERSION: 'inherited-version void/stale',
      });
      const commands: Array<{ args: Array<string>; bounds: unknown }> = [];
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        runCf: (args, options) => {
          commands.push({ args, bounds: options });
          return command(args, options);
        },
        verifyResources: async () => {
          throw new Error('A read must not provision or probe resources');
        },
      });
      const result = await runner(
        {
          type: 'versions.view',
          versionId: draft.id,
          workerName: 'void-test',
          includeSource: true,
        },
        { capture: true },
      );
      expect(result.status).toBe(0);
      expect(isVoidSecretOnlyDraft(result.data as Record<string, unknown>)).toBe(true);
      expect(requests).toEqual([
        `/client/v4/accounts/test-account/workers/workers/void-test/versions/${draft.id}?include=modules`,
      ]);
      expect(commands).toHaveLength(1);
      expect(userAgents).toEqual([cfUserAgent]);
      expect(commands[0]!.bounds).toMatchObject({ timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
      expect(JSON.stringify(result)).not.toContain('synthetic-token');
    } finally {
      await prepared.dispose();
    }
  },
  REAL_CF_TIMEOUT_MS,
);

it('reads a version that cf returns without bindings as one with no bindings', async () => {
  const prepared = await output();
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      runCf: () => ({
        status: 0,
        stdout: JSON.stringify({ id: 'version-id', number: 35 }),
        stderr: '',
      }),
      verifyResources: async () => {
        throw new Error('A read must not provision or probe resources');
      },
    });
    const result = await runner(
      { type: 'versions.view', versionId: 'version-id', workerName: 'void-test' },
      { capture: true },
    );
    expect(result.status).toBe(0);
    expect(result.data).toMatchObject({ bindings: [], resources: { bindings: [] } });
  } finally {
    await prepared.dispose();
  }
});

it(
  'preserves real cf provider codes so a missing Worker can reach its first upload',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-cf-missing-worker-'));
    roots.push(root);
    const requests: Array<string> = [];
    const apiBaseUrl = await listen(
      createServer((request, response) => {
        requests.push(request.url ?? '');
        request.resume();
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            success: false,
            errors: [{ code: 10007, message: 'The given script does not exist.' }],
            result: null,
          }),
        );
      }),
    );
    const missing = await pinnedCf(apiBaseUrl, 'test-account')(
      ['workers', 'deployments', 'list', '--worker', 'missing-worker'],
      { cwd: root, capture: true },
    );
    expect(missing.status).toBe(1);
    expect(missing.errorCode).toBe(10007);
    expect(requests).toEqual([
      '/client/v4/accounts/test-account/workers/scripts/missing-worker/deployments',
    ]);
    const operations: Array<string> = [];
    const result = await activateCloudflareVersion({
      workerName: 'missing-worker',
      message: 'review',
      verifyUploader: () => true,
      verifyInheritedSecrets: true,
      runWrangler: operationFixture((args) => {
        operations.push(args.slice(0, 2).join(' '));
        return args[1] === 'upload'
          ? { status: 1, stdout: '', stderr: 'Test stopped before uploading.' }
          : missing;
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'upload-failed' });
    expect(operations).toEqual(['deployments status', 'versions list', 'versions upload']);
  },
  REAL_CF_TIMEOUT_MS,
);

it(
  'classifies the pinned prebuilt uploader’s missing-Worker diagnostic',
  async () => {
    const prepared = await output();
    const requests: Array<string> = [];
    const userAgents: Array<string | undefined> = [];
    const apiBaseUrl = await listen(
      createServer((request, response) => {
        requests.push(request.url ?? '');
        userAgents.push(request.headers['user-agent']);
        request.resume();
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            success: false,
            errors: [{ code: 10007, message: 'The given script does not exist.' }],
            result: null,
          }),
        );
      }),
    );
    try {
      const result = await pinnedCf(apiBaseUrl)(['workers', 'versions', 'create', '--prebuilt'], {
        cwd: prepared.directory,
        capture: true,
      });
      expect(result, result.stdout + result.stderr).toMatchObject({
        status: 1,
        failure: 'not-found',
        signal: null,
        error: null,
      });
      // cf deliberately omits the API code from this local error.
      expect(result.errorCode).toBeUndefined();
      expect(requests).toEqual(['/client/v4/accounts/account-id/workers/services/void-test']);
      expect(userAgents).toEqual([cfUserAgent]);
    } finally {
      prepared.dispose();
    }
  },
  REAL_CF_TIMEOUT_MS,
);

it(
  'reproduces the pinned cf uploader refusing an API-origin revision without confirmation',
  async () => {
    const prepared = await output();
    const requests: Array<{ method: string; path: string }> = [];
    const apiBaseUrl = await listen(
      createServer((request, response) => {
        requests.push({ method: request.method!, path: request.url! });
        request.resume();
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: {
              default_environment: {
                environment: 'production',
                script: { id: 'void-test', last_deployed_from: 'api' },
              },
            },
          }),
        );
      }),
    );
    try {
      const result = await pinnedCf(apiBaseUrl)(['workers', 'versions', 'create', '--prebuilt'], {
        cwd: prepared.directory,
        capture: true,
      });
      expect(result).toMatchObject({ status: 1, signal: null, error: null });
      expect(result.stdout.replace(/\s+/g, ' ')).toContain(
        'Aborting the upload operation because of conflicts.',
      );
      expect(result.stdout.replace(/\s+/g, ' ')).toContain('last updated via the script API');
      expect(requests).toEqual([
        { method: 'GET', path: '/client/v4/accounts/account-id/workers/services/void-test' },
      ]);
    } finally {
      prepared.dispose();
    }
  },
  REAL_CF_TIMEOUT_MS,
);

// This exercises multiple fresh cf subprocesses. Windows CI has exceeded 30s
// across those startups; bound each child and give the complete protocol a
// separate Windows budget, including assertion and cleanup overhead.
it(
  'uploads an ordinary API-origin revision with genuine cf reads and UUID-pinned inheritance',
  async () => {
    const current = '11111111-1111-4111-8111-111111111111';
    const next = '22222222-2222-4222-8222-222222222222';
    const triggerConfig = {
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };
    const message = encodeCloudflareVersionMessage([], triggerConfig);
    const prepared = await output({
      secrets: { required: ['AUTH_SECRET'] },
      version_metadata: { binding: 'APP_VERSION' },
      send_email: [
        {
          name: 'SEND_EMAIL',
          allowed_sender_addresses: ['sender@example.test'],
          allowed_destination_addresses: ['receiver@example.test'],
        },
      ],
    });
    const originalConfig = readFileSync(getWorkerConfigPath(prepared.directory), 'utf8');
    let traffic = [{ version_id: current, percentage: 100 }];
    let uploaded = false;
    const events: Array<string> = [];
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Array<Buffer> = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const row = {
        method: request.method!,
        path: request.url!,
        body: text ? JSON.parse(text) : {},
      };
      requests.push(row);
      const path = new URL(row.path, 'http://localhost').pathname;
      let result: unknown;
      if (row.method === 'POST' && path.endsWith('/workers/workers/void-test/versions')) {
        uploaded = true;
        events.push('upload');
        result = { id: next, urls: [`https://${next.slice(0, 8)}-void-test.example.workers.dev`] };
      } else if (row.method === 'GET' && path.endsWith('/deployments')) {
        events.push('owner');
        result = { deployments: [{ versions: traffic }] };
      } else if (row.method === 'GET' && path.endsWith('/versions')) {
        result = [
          { id: current, number: 1, annotations: { 'workers/message': message } },
          ...(uploaded
            ? [{ id: next, number: 2, annotations: { 'workers/message': message } }]
            : []),
        ];
      } else if (row.method === 'GET' && path.endsWith(`/versions/${current}`)) {
        events.push('secret-source');
        result = {
          id: current,
          number: 1,
          bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
          annotations: { 'workers/message': message },
        };
      } else if (row.method === 'GET' && path.endsWith('/services/void-test')) {
        result = {
          default_environment: {
            environment: 'production',
            script: { id: 'void-test', last_deployed_from: 'api' },
          },
        };
      } else {
        response.writeHead(501);
        response.end('Unexpected local test request');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, errors: [], messages: [], result }));
    });
    const apiBaseUrl = await listen(server);
    try {
      const command = pinnedCf(apiBaseUrl);
      const calls: Array<Array<string>> = [];
      const runCf: Parameters<typeof createCfVersionRunner>[0]['runCf'] = async (args, options) => {
        calls.push(args);
        // These mutation acknowledgements retain the activation protocol's state;
        // all discovery reads and the actual version POST use the real transports.
        if (args.slice(0, 3).join(' ') === 'workers deployments create') {
          traffic = JSON.parse(args[args.indexOf('--versions') + 1]!);
          events.push('activate');
          return { status: 0, stdout: '{}', stderr: '' };
        }
        if (args.slice(0, 3).join(' ') === 'workers triggers deploy') {
          events.push('triggers');
          return { status: 0, stdout: '{}', stderr: '' };
        }
        return command(args, { timeoutMs: REAL_CF_TIMEOUT_MS, ...options });
      };
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        runCf,
        pinnedUpload: {
          accountId: 'account-id',
          apiBaseUrl,
          getToken: async () => 'synthetic-token',
          verifyUploader: () => true,
        },
        verifyResources: createCfResourceVerifier({
          configPath: join(roots.at(-1)!, 'dist/ssr/wrangler.json'),
          runCf,
          runWrangler: () => {
            throw new Error('An app without paid bindings must not probe paid services.');
          },
          verifyCompatibilityRunner: () => true,
        }),
      });
      const result = await activateCloudflareVersion({
        runWrangler: runner,
        configPath: join(roots.at(-1)!, 'dist/ssr/wrangler.json'),
        workerName: 'void-test',
        verifyUploader: () => true,
        verifyInheritedSecrets: true,
        expectedPreviousVersionId: current,
        requireVersionMetadata: true,
        pinActiveSecrets: createActiveSecretPinner({
          output: prepared,
          handoffPending: false,
          requiredNames: ['AUTH_SECRET'],
        }),
        readinessAttempts: 1,
        message,
        fetch: async (url) => {
          expect(String(url)).toBe(
            `https://${next.slice(0, 8)}-void-test.example.workers.dev/__void/ready`,
          );
          expect(traffic).toEqual([{ version_id: current, percentage: 100 }]);
          events.push('ready');
          return Response.json({ ready: true, versionId: next });
        },
      });
      expect(result, JSON.stringify({ result, events, requests })).toMatchObject({
        ok: true,
        versionId: next,
        previousVersionId: current,
      });
      expect(prepared.activeSecrets).toEqual({
        versionId: current,
        bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
      });
      const posts = requests.filter((row) => row.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0]!.path).toBe(
        '/client/v4/accounts/account-id/workers/workers/void-test/versions',
      );
      expect(posts[0]!.body.bindings).toContainEqual({
        name: 'AUTH_SECRET',
        type: 'inherit',
        version_id: current,
      });
      expect(posts[0]!.body.bindings).toContainEqual({
        name: 'SEND_EMAIL',
        type: 'send_email',
        allowed_sender_addresses: ['sender@example.test'],
        allowed_destination_addresses: ['receiver@example.test'],
      });
      expect(posts[0]!.body.bindings).toContainEqual({
        name: 'APP_VERSION',
        type: 'version_metadata',
      });
      expect(requests.some((row) => row.path.includes('/services/'))).toBe(false);
      expect(calls.some((args) => args.slice(0, 3).join(' ') === 'workers versions create')).toBe(
        false,
      );
      expect(events.indexOf('upload')).toBeLessThan(events.indexOf('ready'));
      expect(events.indexOf('ready')).toBeLessThan(events.indexOf('activate'));
      expect(events.indexOf('activate')).toBeLessThan(events.indexOf('triggers'));
      expect(
        events.slice(0, events.indexOf('upload')).filter((event) => event === 'owner'),
      ).toHaveLength(2);
      expect(readFileSync(getWorkerConfigPath(prepared.directory), 'utf8')).toBe(originalConfig);
    } finally {
      prepared.dispose();
    }
  },
  REAL_CF_ACTIVATION_TIMEOUT_MS,
);

it(
  'captures a version list larger than Node’s default child-process buffer',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-cf-large-version-list-'));
    roots.push(root);
    const version = {
      id: '00000000-0000-0000-0000-000000000001',
      number: 1,
      modules: [{ name: 'index.js', content_base64: 'a'.repeat(2 * 1024 * 1024) }],
    };
    const apiBaseUrl = await listen(
      createServer((request, response) => {
        request.resume();
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, errors: [], result: [version] }));
      }),
    );
    const result = await pinnedCf(apiBaseUrl, 'test-account')(
      ['workers', 'versions', 'list', '--worker-id', 'large-worker', '--per-page', '10'],
      { cwd: root, capture: true },
    );
    expect(result).toMatchObject({ status: 0, error: null });
    expect(result.stdout.length).toBeGreaterThan(1024 * 1024);
  },
  REAL_CF_TIMEOUT_MS,
);

it.runIf(process.platform !== 'win32')(
  'bounds a Container command by terminating its actual child and descendant before returning',
  async () => {
    const originalSpawn = childProcess.spawn;
    let group: number | undefined;
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation((_file, args, options) => {
      expect(args!.slice(1)).toEqual(['containers', 'push', '--tag', 'fixture:local']);
      expect(options).toMatchObject({ detached: true });
      const child = originalSpawn(
        process.execPath,
        [
          '-e',
          `
      const {spawn}=require('node:child_process');
      const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      console.log(JSON.stringify({pid:process.pid,descendant:descendant.pid}));
      setInterval(()=>{},1000);
    `,
        ],
        options,
      );
      group = child.pid;
      return child;
    });
    syncBuiltinESMExports();
    try {
      const command = createCfCommand({
        accountId: 'account-id',
        apiBaseUrl: 'http://127.0.0.1:1',
        env: () => ({ PATH: process.env.PATH }),
        verifyUploader: () => true,
      });
      const started = Date.now();
      const result = await command(['containers', 'push', '--tag', 'fixture:local'], {
        cwd: tmpdir(),
        capture: true,
        timeoutMs: 500,
        maxOutputBytes: 1024,
      });
      expect(result).toMatchObject({
        status: 1,
        signal: 'SIGKILL',
        error: 'Cloudflare command timed out.',
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      const identity = JSON.parse(result.stdout.trim()) as { pid: number; descendant: number };
      expect(identity.pid).toBe(group);
      for (const pid of [identity.pid, identity.descendant]) {
        const deadline = Date.now() + 2_000;
        for (;;) {
          try {
            process.kill(pid, 0);
          } catch (cause) {
            expect((cause as NodeJS.ErrnoException).code).toBe('ESRCH');
            break;
          }
          if (Date.now() >= deadline) {
            throw new Error('Container command descendant survived termination.');
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    } finally {
      spawn.mockRestore();
      syncBuiltinESMExports();
      if (group) {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {
          /* Already terminated. */
        }
      }
    }
  },
);

it('treats a verified empty deployment list as missing but rejects malformed status', async () => {
  const prepared = await output();
  try {
    for (const body of [{ deployments: [] }, {}]) {
      const calls: Array<Array<string>> = [];
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
        runCf: (args) => {
          calls.push(args);
          return args[1] === 'deployments'
            ? { status: 0, stdout: JSON.stringify(body), stderr: '' }
            : { status: 1, stdout: '', stderr: 'Test stopped before uploading.' };
        },
      });
      const result = await activateCloudflareVersion({
        workerName: 'void-test',
        message: 'review',
        verifyUploader: () => true,
        runWrangler: runner,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: 'deployments' in body ? 'upload-failed' : 'status-failed',
      });
      expect(calls).toHaveLength('deployments' in body ? 2 : 1);
    }
  } finally {
    prepared.dispose();
  }
});

async function output(config: Record<string, unknown> = {}, additionalAsset = false) {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-runner-test-'));
  roots.push(root);
  const worker = join(root, 'dist', 'ssr');
  mkdirSync(worker, { recursive: true });
  writeFileSync(join(worker, 'index.js'), 'export default { fetch: () => new Response("ok") };');
  const assets = config.assets as { directory?: string } | undefined;
  if (assets?.directory) {
    const directory = join(worker, assets.directory);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'index.html'), '<h1>Public</h1>');
    if (additionalAsset) {
      writeFileSync(join(directory, 'module.js'), 'export const ready = true;');
      writeFileSync(join(directory, 'style.css'), 'body { color: red; }');
      writeFileSync(join(directory, 'image.png'), Buffer.from([137, 80, 78, 71]));
      writeFileSync(join(directory, 'opaque.unknown'), 'opaque');
    }
    writeFileSync(join(directory, 'private.txt'), 'Never upload this');
    writeFileSync(join(directory, '.assetsignore'), 'private.txt\n');
  }
  writeFileSync(
    join(worker, 'wrangler.json'),
    JSON.stringify({
      name: 'void-test',
      compatibility_date: '2026-09-29',
      main: 'index.js',
      workers_dev: true,
      ...config,
    }),
  );
  const prepared = await prepareCfBuildOutput(worker, 'account-id');
  expect(prepared).not.toBeNull();
  return prepared!;
}

async function verifyPinnedUpload(atomic: boolean): Promise<void> {
  const prepared = await output(
    {
      secrets: { required: ['AUTH_SECRET'] },
      version_metadata: { binding: 'APP_VERSION' },
      keep_secrets: true,
      keep_vars: true,
      assets: { directory: '../client', binding: 'ASSETS', not_found_handling: 'none' },
      queues: { producers: [{ binding: 'JOBS', queue: 'jobs', delivery_delay: 7 }] },
      ai: { binding: 'AI' },
      hyperdrive: [{ binding: 'POSTGRES', id: 'a'.repeat(32) }],
      services: [
        {
          binding: 'SERVICE',
          service: 'utility-worker',
          entrypoint: 'Rpc',
          props: { enabled: true },
        },
      ],
      send_email: [
        {
          name: 'MAIL',
          allowed_destination_addresses: ['fixture@example.test'],
          allowed_sender_addresses: ['sender@example.test'],
        },
      ],
      analytics_engine_datasets: [{ binding: 'METRICS', dataset: 'metrics' }],
      vectorize: [{ binding: 'VECTORS', index_name: 'vectors' }],
      browser: { binding: 'BROWSER' },
      images: { binding: 'IMAGES' },
      dispatch_namespaces: [
        {
          binding: 'DISPATCH',
          namespace: 'dispatch',
          outbound: { service: 'outbound-worker', parameters: ['tenant'] },
        },
      ],
      workflows: [
        {
          name: 'local-workflow',
          binding: 'LOCAL_WORKFLOW',
          class_name: 'LocalJob',
          limits: { steps: 7 },
          concurrency: { limit: 2 },
          schedules: ['0 * * * *'],
          default_retention: { success_retention: '1 day', error_retention: '3 days' },
        },
        {
          name: 'external-workflow',
          binding: 'WORKFLOW',
          class_name: 'ExternalJob',
          script_name: 'external-worker',
        },
      ],
    },
    true,
  );
  try {
    const activeVersionId = '11111111-1111-4111-8111-111111111111';
    const pinActiveSecrets = createActiveSecretPinner({
      output: prepared,
      handoffPending: false,
      requiredNames: ['AUTH_SECRET'],
    });
    expect(pinActiveSecrets).toBeDefined();
    expect(
      await pinActiveSecrets!(activeVersionId, [
        { name: 'AUTH_SECRET', type: 'secret_text' },
        { name: 'KEY', type: 'secret_key' },
      ]),
    ).toBe(true);
    const worker = JSON.parse(readFileSync(getWorkerConfigPath(prepared.directory), 'utf8'));
    expect(worker.env.AUTH_SECRET).toEqual({ type: 'secret' });
    worker.exports = {
      ...worker.exports,
      ExportOnlyJob: { type: 'workflow', name: 'export-only-workflow', limits: { steps: 3 } },
      Rpc: { type: 'worker', cache: { enabled: false } },
      Departed: { type: 'durable-object', state: 'transferred', transferredTo: 'target-worker' },
      Arriving: {
        type: 'durable-object',
        state: 'expecting-transfer',
        storage: 'sqlite',
        transferFrom: 'source-worker',
      },
    };
    writeFileSync(getWorkerConfigPath(prepared.directory), JSON.stringify(worker));
    const originalWorkerConfig = readFileSync(getWorkerConfigPath(prepared.directory), 'utf8');
    expect(prepared.activeSecrets).toEqual({
      versionId: activeVersionId,
      bindings: [
        { name: 'AUTH_SECRET', type: 'secret_text' },
        { name: 'KEY', type: 'secret_key' },
      ],
    });
    const requests: Array<{
      url: string;
      body: string;
      authorization: string | undefined;
      userAgent: string | undefined;
    }> = [];
    let uploadedBatches = 0;
    const server = createServer(async (request, response) => {
      const chunks: Array<Buffer> = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      requests.push({
        url: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: request.headers.authorization,
        userAgent: request.headers['user-agent'],
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const path = request.url ?? '';
      const result = path.endsWith('/assets-upload-session')
        ? {
            jwt: 'asset-token',
            buckets: Object.values(JSON.parse(requests.at(-1)!.body).manifest).map((entry) => [
              (entry as { hash: string }).hash,
            ]),
          }
        : path.includes('/assets/upload')
          ? ++uploadedBatches === 5
            ? { jwt: 'completion-token' }
            : {}
          : path.includes('/workflows/')
            ? {
                name: path.endsWith('/local-workflow') ? 'local-workflow' : 'export-only-workflow',
                script_name: 'void-test',
                class_name: path.endsWith('/local-workflow') ? 'LocalJob' : 'ExportOnlyJob',
              }
            : request.method === 'GET'
              ? {
                  id: activeVersionId,
                  bindings: [
                    { name: 'AUTH_SECRET', type: 'secret_text' },
                    { name: 'KEY', type: 'secret_key' },
                    { name: 'DASHBOARD_VAR', type: 'plain_text' },
                  ],
                }
              : { id: '22222222-2222-4222-8222-222222222222', urls: [] };
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          result,
        }),
      );
    });
    const uploaded = await uploadPinnedCloudflareVersion({
      output: prepared,
      accountId: 'account-id',
      apiBaseUrl: await listen(server),
      workerName: 'void-test',
      token: 'synthetic-token',
      atomic,
      verifyUploader: () => true,
    });
    expect(uploaded.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(requests.map(({ userAgent }) => userAgent)).toEqual(
      requests.map(() => `void/${voidVersion}`),
    );
    const upload = requests.find(({ url }) =>
      url.endsWith(atomic ? '/versions?deploy=true' : '/versions'),
    );
    expect(upload).toBeDefined();
    const body = JSON.parse(upload!.body);
    expect(body.bindings).toEqual(
      expect.arrayContaining([
        { name: 'AUTH_SECRET', type: 'inherit', version_id: activeVersionId },
        { name: 'KEY', type: 'inherit', version_id: activeVersionId },
        { name: 'DASHBOARD_VAR', type: 'inherit', version_id: activeVersionId },
        { name: 'APP_VERSION', type: 'version_metadata' },
        { name: 'JOBS', type: 'queue', queue_name: 'jobs', delivery_delay: 7 },
        { name: 'AI', type: 'ai' },
        { name: 'POSTGRES', type: 'hyperdrive', id: 'a'.repeat(32) },
        {
          name: 'SERVICE',
          type: 'service',
          service: 'utility-worker',
          entrypoint: 'Rpc',
          props: { enabled: true },
        },
        {
          name: 'MAIL',
          type: 'send_email',
          allowed_destination_addresses: ['fixture@example.test'],
          allowed_sender_addresses: ['sender@example.test'],
        },
        { name: 'METRICS', type: 'analytics_engine', dataset: 'metrics' },
        { name: 'VECTORS', type: 'vectorize', index_name: 'vectors' },
        { name: 'BROWSER', type: 'browser' },
        { name: 'IMAGES', type: 'images' },
        {
          name: 'DISPATCH',
          type: 'dispatch_namespace',
          namespace: 'dispatch',
          outbound: { worker: { service: 'outbound-worker' }, params: [{ name: 'tenant' }] },
        },
        {
          name: 'WORKFLOW',
          type: 'workflow',
          workflow_name: 'external-workflow',
          script_name: 'external-worker',
        },
        {
          name: 'LOCAL_WORKFLOW',
          type: 'workflow',
          workflow_name: 'local-workflow',
          class_name: 'LocalJob',
        },
      ]),
    );
    expect(body.modules).toEqual([expect.objectContaining({ name: 'index.js' })]);
    expect(body.exports).toEqual({
      LocalJob: { type: 'workflow', name: 'local-workflow' },
      ExportOnlyJob: { type: 'workflow', name: 'export-only-workflow' },
      Rpc: { type: 'worker', cache: { enabled: false } },
      Departed: { type: 'durable-object', state: 'transferred', transferred_to: 'target-worker' },
      Arriving: {
        type: 'durable-object',
        state: 'expecting-transfer',
        storage: 'sqlite',
        transfer_from: 'source-worker',
      },
    });
    expect(readFileSync(getWorkerConfigPath(prepared.directory), 'utf8')).toBe(
      originalWorkerConfig,
    );
    expect(worker.exports.LocalJob).toEqual({
      type: 'workflow',
      name: 'local-workflow',
      limits: { steps: 7 },
      concurrency: { limit: 2 },
      schedules: ['0 * * * *'],
      defaultRetention: { successRetention: '1 day', errorRetention: '3 days' },
    });
    expect(body.assets).toEqual({
      jwt: 'completion-token',
      config: { not_found_handling: 'none' },
    });
    expect(body.bindings).toContainEqual({ name: 'ASSETS', type: 'assets' });
    expect(body.containers).toBeUndefined();
    expect(requests.some(({ url }) => url.includes('/containers/'))).toBe(false);
    const session = requests.find(({ url }) => url.endsWith('/assets-upload-session'));
    const manifest = JSON.parse(session!.body).manifest as Record<string, { hash: string }>;
    expect(Object.keys(manifest)).toEqual(
      expect.arrayContaining([
        '/index.html',
        '/module.js',
        '/style.css',
        '/image.png',
        '/opaque.unknown',
      ]),
    );
    expect(Object.keys(manifest)).toHaveLength(5);
    const assetUploads = requests.filter(({ url }) => url.includes('/assets/upload'));
    for (const [name, contentType, contents] of [
      ['index.html', 'text/html', Buffer.from('<h1>Public</h1>')],
      ['module.js', 'text/javascript', Buffer.from('export const ready = true;')],
      ['style.css', 'text/css', Buffer.from('body { color: red; }')],
      ['image.png', 'image/png', Buffer.from([137, 80, 78, 71])],
      ['opaque.unknown', 'application/null', Buffer.from('opaque')],
    ] as const) {
      const hash = manifest[`/${name}`].hash;
      const upload = assetUploads.find(({ body }) => body.includes(`name="${hash}"`));
      expect(upload?.body).toContain(`filename="${hash}"`);
      expect(upload?.body).toContain(`Content-Type: ${contentType}`);
      expect(upload?.body).toContain(contents.toString('base64'));
    }
    expect(assetUploads.map(({ authorization }) => authorization)).toEqual(
      Array(5).fill('Bearer asset-token'),
    );
  } finally {
    prepared.dispose();
  }
}

it('uploads live secrets and multiple asset batches when the latest upload is inactive', () =>
  verifyPinnedUpload(false));

it('uploads live secrets and multiple asset batches for atomic publication', () =>
  verifyPinnedUpload(true));

it('uploads Worker limits, placement and cache with pinned secrets', async () => {
  const prepared = await output({
    secrets: { required: ['AUTH_SECRET'] },
    limits: { cpu_ms: 30_000 },
    placement: { mode: 'smart' },
    cache: { enabled: true, cross_version_cache: true },
    logpush: true,
    tail_consumers: [{ service: 'tail-worker' }],
  });
  try {
    await pinActiveWorkerSecrets({
      output: prepared,
      activeVersionId: '11111111-1111-4111-8111-111111111111',
      bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
      requiredNames: ['AUTH_SECRET'],
    });
    const uploads: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      const chunks: Array<Buffer> = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      if (request.method === 'POST') {
        uploads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          result:
            request.method === 'GET'
              ? {
                  id: '11111111-1111-4111-8111-111111111111',
                  bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
                }
              : { id: '22222222-2222-4222-8222-222222222222', urls: [] },
        }),
      );
    });
    const uploaded = await uploadPinnedCloudflareVersion({
      output: prepared,
      accountId: 'account-id',
      apiBaseUrl: await listen(server),
      workerName: 'void-test',
      token: 'synthetic-token',
      atomic: false,
      verifyUploader: () => true,
    });
    expect(uploaded.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      limits: { cpu_ms: 30_000 },
      placement: { mode: 'smart' },
      cache_options: { enabled: true, cross_version_cache: true },
      bindings: [
        {
          name: 'AUTH_SECRET',
          type: 'inherit',
          version_id: '11111111-1111-4111-8111-111111111111',
        },
      ],
    });
    expect(uploads[0]).not.toHaveProperty('logpush');
    expect(uploads[0]).not.toHaveProperty('tail_consumers');
  } finally {
    prepared.dispose();
  }
});

it.each([
  { region: 'aws:us-east-1' },
  { host: 'db.example.test:5432' },
  { hostname: 'api.example.test' },
])('rejects targeted placement with pinned secrets before any upload: %j', async (placement) => {
  const prepared = await output({ secrets: { required: ['AUTH_SECRET'] }, placement });
  try {
    await pinActiveWorkerSecrets({
      output: prepared,
      activeVersionId: '11111111-1111-4111-8111-111111111111',
      bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
      requiredNames: ['AUTH_SECRET'],
    });
    const requests: Array<string> = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          result:
            request.method === 'GET'
              ? {
                  id: '11111111-1111-4111-8111-111111111111',
                  bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
                }
              : { id: '22222222-2222-4222-8222-222222222222', urls: [] },
        }),
      );
    });
    await expect(
      uploadPinnedCloudflareVersion({
        output: prepared,
        accountId: 'account-id',
        apiBaseUrl: await listen(server),
        workerName: 'void-test',
        token: 'synthetic-token',
        atomic: true,
        verifyUploader: () => true,
      }),
    ).rejects.toThrow(
      `Cloudflare placement.${Object.keys(placement)[0]} cannot be deployed while the Worker has secrets. Remove cloudflare.placement from void.config.ts, or set it to { mode: 'smart' }.`,
    );
    expect(requests).toEqual([]);
  } finally {
    prepared.dispose();
  }
});

it.each(['missing name', 'duplicate name', 'external collision', 'class collision'] as const)(
  'rejects an invalid local Workflow declaration before any provider request: %s',
  async (mode) => {
    const prepared = await output({ secrets: { required: ['AUTH_SECRET'] } });
    try {
      await pinActiveWorkerSecrets({
        output: prepared,
        activeVersionId: '11111111-1111-4111-8111-111111111111',
        bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
        requiredNames: ['AUTH_SECRET'],
      });
      const path = getWorkerConfigPath(prepared.directory);
      const worker = JSON.parse(readFileSync(path, 'utf8'));
      worker.exports = { Job: { type: 'workflow', name: mode === 'missing name' ? '' : 'jobs' } };
      if (mode === 'duplicate name') {
        worker.exports.OtherJob = { type: 'workflow', name: 'jobs' };
      }
      if (mode === 'external collision' || mode === 'class collision') {
        worker.env.JOB = {
          type: 'workflow',
          name: 'jobs',
          worker: mode === 'external collision' ? 'foreign-worker' : 'void-test',
          exportName: mode === 'external collision' ? 'Job' : 'OtherJob',
        };
      }
      writeFileSync(path, JSON.stringify(worker));
      const fetch = vi.spyOn(globalThis, 'fetch');
      await expect(
        uploadPinnedCloudflareVersion({
          output: prepared,
          accountId: 'account-id',
          apiBaseUrl: 'http://127.0.0.1:1',
          workerName: 'void-test',
          token: 'synthetic-token',
          atomic: true,
          verifyUploader: () => true,
        }),
      ).rejects.toThrow(
        mode === 'missing name'
          ? 'Workflow export Job name'
          : mode === 'duplicate name'
            ? 'multiple local exports'
            : 'conflicts with its local export',
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      prepared.dispose();
    }
  },
);

it.each(['missing', 'owned', 'foreign', 'malformed', 'unrelated 404'] as const)(
  'checks local Workflow ownership before uploading assets or a version: %s',
  async (mode) => {
    const prepared = await output({
      secrets: { required: ['AUTH_SECRET'] },
      assets: { directory: '../client', binding: 'ASSETS' },
      workflows: [{ name: 'jobs', binding: 'JOB', class_name: 'Job' }],
    });
    await pinActiveWorkerSecrets({
      output: prepared,
      activeVersionId: '11111111-1111-4111-8111-111111111111',
      bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
      requiredNames: ['AUTH_SECRET'],
    });
    const requests: Array<{ method: string; path: string }> = [];
    const server = createServer((request, response) => {
      request.resume();
      const path = request.url ?? '';
      requests.push({ method: request.method ?? '', path });
      const missing =
        path.endsWith('/workflows/jobs') && ['missing', 'unrelated 404'].includes(mode);
      response.writeHead(missing ? 404 : 200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          success: !missing,
          errors: missing ? [{ code: mode === 'missing' ? 10200 : 10000 }] : [],
          result: path.endsWith('/workflows/jobs')
            ? {
                name: mode === 'malformed' ? 'another-workflow' : 'jobs',
                script_name: mode === 'foreign' ? 'foreign-worker' : 'void-test',
                class_name: 'PreviousJob',
              }
            : path.endsWith('/assets-upload-session')
              ? { jwt: 'asset-completion', buckets: [] }
              : request.method === 'GET'
                ? {
                    id: '11111111-1111-4111-8111-111111111111',
                    bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
                  }
                : { id: '22222222-2222-4222-8222-222222222222', urls: [] },
        }),
      );
    });
    const apiBaseUrl = await listen(server);
    try {
      const upload = uploadPinnedCloudflareVersion({
        output: prepared,
        accountId: 'account-id',
        apiBaseUrl,
        workerName: 'void-test',
        token: 'synthetic-token',
        atomic: true,
        verifyUploader: () => true,
      });
      if (mode === 'missing' || mode === 'owned') {
        await expect(upload).resolves.toMatchObject({ id: '22222222-2222-4222-8222-222222222222' });
        expect(requests.map(({ method }) => method)).toEqual(['GET', 'GET', 'POST', 'POST']);
      } else {
        await expect(upload).rejects.toThrow(
          mode === 'unrelated 404'
            ? 'Cloudflare version upload failed'
            : 'not owned by this Worker',
        );
        expect(requests.map(({ method }) => method)).toEqual(['GET', 'GET']);
      }
      expect(requests[1]?.path).toBe('/client/v4/accounts/account-id/workflows/jobs');
    } finally {
      prepared.dispose();
    }
  },
);

it.each([
  'unsafe binding',
  'unknown export',
  'scheduler Container',
  'explicit secret collision',
] as const)(
  'refuses unsupported pinned output before provider or image mutations: %s',
  async (mode) => {
    const prepared = await output({ secrets: { required: ['AUTH_SECRET'] } });
    try {
      expect(
        await pinActiveWorkerSecrets({
          output: prepared,
          activeVersionId: '11111111-1111-4111-8111-111111111111',
          bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
          requiredNames: ['AUTH_SECRET'],
        }),
      ).toBe(true);
      const workerPath = getWorkerConfigPath(prepared.directory);
      const worker = JSON.parse(readFileSync(workerPath, 'utf8'));
      if (mode === 'unsafe binding') {
        worker.env.BAD = { type: 'unsafe:unknown_product', value: 'unapproved' };
      }
      if (mode === 'unknown export') {
        worker.exports = { Job: { type: 'unapproved', name: 'jobs' } };
      }
      if (mode === 'explicit secret collision') {
        worker.env.AUTH_SECRET = { type: 'ai' };
      }
      writeFileSync(workerPath, JSON.stringify(worker));
      if (mode === 'scheduler Container') {
        await writeContainerConfig({
          root: prepared.directory,
          directoryName: 'scheduler',
          config: OutputContainerSchema.parse({
            name: 'scheduler',
            image: { reference: 'example.test/image:tag' },
          }),
        });
      }
      const secretsFilePath =
        mode === 'explicit secret collision' ? join(roots.at(-1)!, 'secrets.json') : undefined;
      if (secretsFilePath) {
        writeFileSync(secretsFilePath, JSON.stringify({ AUTH_SECRET: 'private-secret' }));
      }
      const fetch = vi.spyOn(globalThis, 'fetch');
      const runCf = vi.fn();
      await expect(
        uploadPinnedCloudflareVersion({
          output: prepared,
          accountId: 'account-id',
          apiBaseUrl: 'http://127.0.0.1:1',
          workerName: 'void-test',
          token: 'synthetic-token',
          atomic: true,
          verifyUploader: () => true,
          secretsFilePath,
          runCf,
        }),
      ).rejects.toThrow(
        mode === 'unknown export'
          ? 'invalid Worker config'
          : mode === 'scheduler Container'
            ? 'Scheduler-managed'
            : mode === 'explicit secret collision'
              ? 'invalid explicit value or binding'
              : 'binding BAD',
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(runCf).not.toHaveBeenCalled();
    } finally {
      prepared.dispose();
    }
  },
);

it('refuses a new imageless Container before version publication', async () => {
  const prepared = await containerOutput();
  try {
    const built = await readBuildOutput(prepared.directory);
    await writeContainerConfig({
      root: prepared.directory,
      directoryName: 'sandbox',
      config: OutputContainerSchema.parse({ ...built.containers[0].config, images: {} }),
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        success: true,
        result: {
          id: activePinnedVersion,
          bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
        },
      }),
    );
    const runCf = vi.fn();
    await expect(
      uploadPinnedCloudflareVersion({
        output: prepared,
        accountId: 'account-id',
        apiBaseUrl: 'http://127.0.0.1:1',
        workerName: 'void-test',
        token: 'synthetic-token',
        atomic: true,
        verifyUploader: () => true,
        runCf,
      }),
    ).rejects.toThrow('no images and no verified existing namespace application');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
    expect(runCf).not.toHaveBeenCalled();
  } finally {
    prepared.dispose();
  }
});

it('bounds pending Container image preparation before uploading a Worker version', async () => {
  const prepared = await containerOutput();
  try {
    let pending = false;
    vi.spyOn(Date, 'now').mockImplementation(() => (pending ? 900_001 : 0));
    const requests: Array<string> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      requests.push(String(url));
      if (String(url).endsWith('/image-preparations')) {
        pending = true;
        return Response.json({
          success: true,
          result: { image: containerImage, status: 'pending' },
        });
      }
      return Response.json({
        success: true,
        result: {
          id: activePinnedVersion,
          bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
        },
      });
    });
    await expect(
      uploadPinnedCloudflareVersion({
        output: prepared,
        accountId: 'account-id',
        apiBaseUrl: 'http://127.0.0.1:1',
        workerName: 'void-test',
        token: 'synthetic-token',
        atomic: true,
        verifyUploader: () => true,
      }),
    ).rejects.toThrow('image preparation timed out');
    expect(requests).toHaveLength(2);
    expect(requests.at(-1)).toContain('/image-preparations');
  } finally {
    prepared.dispose();
  }
});

const activePinnedVersion = '11111111-1111-4111-8111-111111111111';
const uploadedPinnedVersion = '22222222-2222-4222-8222-222222222222';
const containerNamespace = 'c'.repeat(32);
const containerImage = `registry.cloudflare.com/account-id/sandbox@sha256:${'d'.repeat(64)}`;

async function containerOutput() {
  const prepared = await output({
    secrets: { required: ['AUTH_SECRET'] },
    durable_objects: { bindings: [{ name: 'SANDBOX', class_name: 'Sandbox' }] },
    migrations: [
      { tag: 'history', new_sqlite_classes: ['OldRoom', 'Removed'] },
      {
        tag: 'current',
        new_sqlite_classes: ['Sandbox'],
        renamed_classes: [{ from: 'OldRoom', to: 'Room' }],
        deleted_classes: ['Removed'],
      },
    ],
    containers: [
      {
        name: 'sandbox',
        class_name: 'Sandbox',
        scheduling_policy: 'durable_object',
        images: { default: { image: containerImage } },
      },
    ],
  });
  expect(
    await pinActiveWorkerSecrets({
      output: prepared,
      activeVersionId: activePinnedVersion,
      bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
      requiredNames: ['AUTH_SECRET'],
    }),
  ).toBe(true);
  return prepared;
}

type ContainerMode =
  | 'create'
  | 'existing'
  | 'pending'
  | 'image-error'
  | 'foreign'
  | 'lost-readback'
  | 'local'
  | 'lost-image-metadata'
  | 'foreign-namespace'
  | 'settings-change'
  | 'keys-change'
  | 'omitted-defaults'
  | 'readiness-failure'
  | 'key-order';

/** A pinned Sandbox output and a fake Containers and Workers API that records each request. */
async function containerApi(mode: ContainerMode) {
  const prepared = await containerOutput();
  const built = await readBuildOutput(prepared.directory);
  const existing = [
    'existing',
    'foreign',
    'lost-readback',
    'settings-change',
    'keys-change',
    'omitted-defaults',
    'readiness-failure',
    'key-order',
  ].includes(mode);
  const expectedImages =
    mode === 'key-order'
      ? { first: containerImage, second: containerImage }
      : { default: containerImage };
  await writeContainerConfig({
    root: prepared.directory,
    directoryName: 'sandbox',
    config: OutputContainerSchema.parse({
      ...built.containers[0].config,
      observability: { logs: { enabled: true } },
      ...(mode === 'keys-change'
        ? { authorizedKeys: [{ name: 'new-key', publicKey: 'ssh-ed25519 new' }] }
        : {}),
      ...(mode === 'omitted-defaults'
        ? {
            observability: { logs: { enabled: false } },
            ssh: { enabled: false, port: 22 },
            authorizedKeys: [],
            unsafe: { configuration: { experimental_flags: [] } },
          }
        : {}),
      ...(mode === 'key-order'
        ? {
            ssh: { enabled: true, port: 2222 },
            unsafe: { configuration: { experimental_flags: ['fixture-b', 'fixture-a'] } },
            images: { first: { reference: containerImage }, second: { reference: containerImage } },
          }
        : {}),
      ...(mode === 'local'
        ? { images: { default: { localReference: 'void-sandbox-build:fixture' } } }
        : {}),
    }),
  });
  const requests: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  let application: Record<string, unknown> | undefined = existing
    ? {
        id: containerNamespace,
        name: mode === 'foreign' ? 'foreign-app' : 'sandbox',
        scheduling_policy: 'durable_object',
        durable_objects: { namespace_id: containerNamespace },
        ...(mode === 'omitted-defaults'
          ? {}
          : { observability: { logs: { enabled: mode !== 'settings-change' } } }),
        ...(mode === 'keys-change'
          ? {
              configuration: {
                authorized_keys: [{ name: 'old-key', public_key: 'ssh-ed25519 old' }],
              },
            }
          : {}),
        ...(mode === 'key-order'
          ? {
              configuration: {
                wrangler_ssh: { port: 2222, enabled: true },
                authorized_keys: [],
                experimental_flags: ['fixture-a', 'fixture-b'],
              },
            }
          : {}),
      }
    : undefined;
  const counts = { imageAttempts: 0, versionVisibleAttempts: 0 };
  let applicationReads = 0;
  const originalApplication = structuredClone(application);
  const server = createServer(async (request, response) => {
    const chunks: Array<Buffer> = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const row = { method: request.method!, url: request.url!, body: text ? JSON.parse(text) : {} };
    requests.push(row);
    let status = 200;
    let result: unknown;
    let code = 0;
    const binding = {
      name: 'SANDBOX',
      type: 'durable_object_namespace',
      class_name: 'Sandbox',
      namespace_id: containerNamespace,
    };
    if (row.url.endsWith(`/versions/${activePinnedVersion}`)) {
      result = {
        id: activePinnedVersion,
        bindings: [
          { name: 'AUTH_SECRET', type: 'secret_text' },
          ...(existing ? [{ ...binding, script_name: 'void-test' }] : []),
        ],
      };
    } else if (row.url.endsWith('/image-preparations')) {
      result = {
        image: row.body.image,
        status:
          mode === 'image-error'
            ? 'error'
            : mode === 'pending' && ++counts.imageAttempts === 1
              ? 'pending'
              : 'ready',
      };
    } else if (row.method === 'POST' && row.url.includes('/workers/workers/void-test/versions')) {
      result = {
        id: uploadedPinnedVersion,
        urls: ['https://22222222-void-test.account.workers.dev'],
      };
    } else if (row.url.endsWith(`/scripts/void-test/versions/${uploadedPinnedVersion}`)) {
      if (mode === 'pending' && ++counts.versionVisibleAttempts === 1) {
        status = 404;
        code = 100146;
      } else {
        result = {
          id: uploadedPinnedVersion,
          resources: {
            bindings:
              mode === 'foreign-namespace'
                ? [{ ...binding, script_name: 'foreign-worker' }]
                : [binding],
            script_runtime: {
              containers:
                mode === 'lost-image-metadata'
                  ? [{ class_name: 'Sandbox' }]
                  : [
                      {
                        name: 'sandbox',
                        class_name: 'Sandbox',
                        images:
                          mode === 'key-order'
                            ? { second: containerImage, first: containerImage }
                            : expectedImages,
                      },
                    ],
            },
          },
        };
      }
    } else if (row.url.endsWith(`/applications/${containerNamespace}`)) {
      if (!application) {
        status = 404;
      } else if (row.method === 'PATCH') {
        application = { ...application, ...row.body };
        result = application;
      } else {
        result =
          mode === 'lost-readback' && ++applicationReads > 1
            ? { ...application, durable_objects: { namespace_id: 'f'.repeat(32) } }
            : application;
      }
    } else if (row.url.endsWith('/applications') && row.method === 'POST') {
      application = { ...row.body, id: containerNamespace };
      result = application;
    } else {
      status = 500;
    }
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        success: status === 200,
        result: result ?? null,
        errors: status === 200 ? [] : [{ code, message: 'private-provider-detail' }],
      }),
    );
  });
  return {
    prepared,
    existing,
    expectedImages,
    requests,
    counts,
    originalApplication,
    application: () => application,
    apiBaseUrl: await listen(server),
  };
}

it.each(['settings-change', 'keys-change', 'readiness-failure'] as const)(
  'leaves the live Sandbox application unchanged when activation stops: %s',
  async (mode) => {
    const api = await containerApi(mode);
    try {
      const changedSettings = mode !== 'readiness-failure';
      const commands: Array<Array<string>> = [];
      const runner = createCfVersionRunner({
        output: api.prepared,
        workerName: 'void-test',
        verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
        runCf: (args) => {
          commands.push(args);
          if (args.slice(0, 3).join(' ') === 'workers deployments list') {
            return {
              status: 0,
              stdout: JSON.stringify({
                deployments: [{ versions: [{ version_id: activePinnedVersion, percentage: 100 }] }],
              }),
              stderr: '',
            };
          }
          expect(args.slice(0, 3)).toEqual(['workers', 'versions', 'get']);
          return {
            status: 0,
            stdout: JSON.stringify({ id: activePinnedVersion, bindings: [] }),
            stderr: '',
          };
        },
        pinnedUpload: {
          accountId: 'account-id',
          apiBaseUrl: api.apiBaseUrl,
          getToken: async () => 'synthetic-token',
          verifyUploader: () => true,
        },
      });
      const readiness = vi.fn(async () => Response.json({ ready: false }, { status: 503 }));
      const result = await activateCloudflareVersion({
        runWrangler: runner,
        workerName: 'void-test',
        configPath: join(roots.at(-1)!, 'dist/ssr/wrangler.json'),
        verifyUploader: () => true,
        message: 'Verify Container candidate isolation.',
        readinessAttempts: 1,
        fetch: readiness,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: changedSettings ? 'upload-failed' : 'readiness-failed',
      });
      expect(readiness).toHaveBeenCalledTimes(changedSettings ? 0 : 1);
      expect(api.requests.filter((row) => row.method === 'PATCH')).toEqual([]);
      expect(api.application()).toEqual(api.originalApplication);
      expect(
        commands.some((args) => args.slice(0, 3).join(' ') === 'workers deployments create'),
      ).toBe(false);
      if (changedSettings) {
        expect(result).toHaveProperty(
          'diagnostic',
          expect.stringContaining('settings differ from the live application'),
        );
        expect(api.requests.every((row) => row.method === 'GET')).toBe(true);
      }
    } finally {
      api.prepared.dispose();
    }
  },
);

it.each([
  'create',
  'existing',
  'pending',
  'image-error',
  'foreign',
  'lost-readback',
  'local',
  'lost-image-metadata',
  'foreign-namespace',
  'omitted-defaults',
  'key-order',
] as const)('preserves pinned Sandbox image and application lifecycle: %s', async (mode) => {
  const { prepared, requests, counts, existing, expectedImages, apiBaseUrl } =
    await containerApi(mode);
  const runCf = vi.fn(() => ({
    status: 0,
    stdout: 'Pushed image: registry.cloudflare.com/account-id/sandbox:fixture\n',
    stderr: '',
  }));
  const inspect =
    mode === 'local'
      ? vi
          .spyOn(childProcess, 'execFile')
          .mockImplementation((_file, _args, _options, callback) => {
            (callback as (error: null, stdout: string, stderr: string) => void)(
              null,
              JSON.stringify([containerImage]),
              '',
            );
            return {} as ReturnType<typeof execFile>;
          })
      : undefined;
  syncBuiltinESMExports();
  try {
    const upload = uploadPinnedCloudflareVersion({
      output: prepared,
      accountId: 'account-id',
      apiBaseUrl,
      workerName: 'void-test',
      token: 'synthetic-token',
      atomic: true,
      verifyUploader: () => true,
      runCf,
    });
    if (mode === 'image-error' || mode === 'foreign') {
      await expect(upload).rejects.toThrow(
        mode === 'image-error' ? 'image preparation failed' : 'application identity',
      );
      expect(
        requests.some(
          (row) => row.method === 'POST' && row.url.includes('/workers/workers/void-test/versions'),
        ),
      ).toBe(false);
    } else if (['lost-readback', 'lost-image-metadata', 'foreign-namespace'].includes(mode)) {
      await expect(upload).rejects.toThrow(
        `version ${uploadedPinnedVersion} was uploaded and may already be published`,
      );
      expect(requests.filter((row) => row.method === 'PATCH')).toHaveLength(0);
      if (mode !== 'lost-readback') {
        expect(requests.some((row) => row.url.includes('/applications'))).toBe(false);
      }
    } else {
      expect((await upload).id).toBe(uploadedPinnedVersion);
      const post = requests.find(
        (row) => row.method === 'POST' && row.url.includes('/workers/workers/void-test/versions'),
      )!;
      expect(post.body.bindings).toContainEqual({
        name: 'AUTH_SECRET',
        type: 'inherit',
        version_id: activePinnedVersion,
      });
      expect(post.body.bindings).toContainEqual({
        name: 'SANDBOX',
        type: 'durable_object_namespace',
        class_name: 'Sandbox',
      });
      expect(post.body.containers).toEqual([
        { name: 'sandbox', class_name: 'Sandbox', images: expectedImages },
      ]);
      expect(post.body.exports).toEqual({
        OldRoom: { type: 'durable-object', state: 'renamed', renamed_to: 'Room' },
        Room: { type: 'durable-object', storage: 'sqlite', state: 'created' },
        Removed: { type: 'durable-object', state: 'deleted' },
        Sandbox: {
          type: 'durable-object',
          storage: 'sqlite',
          state: 'created',
          container: 'sandbox',
        },
      });
      expect(requests.findIndex((row) => row.url.endsWith('/image-preparations'))).toBeLessThan(
        requests.indexOf(post),
      );
      const creates = requests.filter(
        (row) => row.method === 'POST' && row.url.endsWith('/applications'),
      );
      expect(creates).toHaveLength(existing ? 0 : 1);
      if (!existing) {
        expect(creates[0].body).toEqual({
          name: 'sandbox',
          scheduling_policy: 'durable_object',
          durable_objects: { namespace_id: containerNamespace },
          observability: { logs: { enabled: true } },
        });
      } else {
        expect(requests.filter((row) => row.method === 'PATCH')).toHaveLength(0);
      }
      expect(requests.at(-1)?.method).toBe('GET');
      if (mode === 'pending') {
        expect(counts.imageAttempts).toBe(2);
        expect(counts.versionVisibleAttempts).toBe(2);
      }
      if (mode === 'local') {
        expect(runCf).toHaveBeenCalledWith(
          ['containers', 'push', '--tag', 'void-sandbox-build:fixture'],
          expect.objectContaining({
            cwd: prepared.directory,
            capture: true,
            timeoutMs: expect.any(Number),
            maxOutputBytes: 16 * 1024 * 1024,
          }),
        );
        expect(inspect).toHaveBeenCalledWith(
          expect.any(String),
          [
            'image',
            'inspect',
            '--format',
            '{{json .RepoDigests}}',
            'registry.cloudflare.com/account-id/sandbox:fixture',
          ],
          expect.objectContaining({ timeout: expect.any(Number) }),
          expect.any(Function),
        );
      } else {
        expect(runCf).not.toHaveBeenCalled();
      }
    }
  } finally {
    inspect?.mockRestore();
    syncBuiltinESMExports();
    prepared.dispose();
  }
});

it.each([false, true])(
  'publishes the intended custom domain before pinned-secret bootstrap readiness (atomic=%s)',
  async (atomic) => {
    const current = '11111111-1111-4111-8111-111111111111';
    const next = '22222222-2222-4222-8222-222222222222';
    const domain = 'app.example.com';
    const triggerConfig = {
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: domain, custom_domain: true }],
      crons: [],
      queueConsumers: [],
      workflows: [],
    };
    const prepared = await output({
      workers_dev: false,
      preview_urls: false,
      routes: triggerConfig.routes,
      secrets: { required: ['AUTH_SECRET'] },
    });
    const events: Array<string> = [];
    let active = current;
    let published = false;
    const server = createServer(async (request, response) => {
      request.resume();
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const upload = request.method === 'POST';
      if (upload && request.url?.endsWith('?deploy=true')) {
        active = next;
        events.push('activate');
      }
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          result: upload
            ? { id: next, urls: [] }
            : { id: current, bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }] },
        }),
      );
    });
    const apiBaseUrl = await listen(server);
    try {
      const pinActiveSecrets = createActiveSecretPinner({
        output: prepared,
        handoffPending: false,
        requiredNames: ['AUTH_SECRET'],
      })!;
      // A secret-only first Worker can already require version-pinned inheritance.
      await pinActiveSecrets(current, [{ name: 'AUTH_SECRET', type: 'secret_text' }]);
      const runCf = async (args: Array<string>, options: { cwd: string }) => {
        if (args.slice(0, 3).join(' ') === 'workers deployments list') {
          return {
            status: 0,
            stderr: '',
            stdout: JSON.stringify({
              deployments: [{ versions: [{ version_id: active, percentage: 100 }] }],
            }),
          };
        }
        if (args.slice(0, 3).join(' ') === 'workers versions get') {
          return {
            status: 0,
            stderr: '',
            stdout: JSON.stringify({
              id: args[3],
              bindings: [{ name: 'AUTH_SECRET', type: 'secret_text' }],
            }),
          };
        }
        expect(args).toEqual(['workers', 'triggers', 'deploy', '--prebuilt']);
        const config = JSON.parse(readFileSync(getWorkerConfigPath(options.cwd), 'utf8'));
        expect(active).toBe(next);
        expect(config.domains).toEqual([domain]);
        expect(config.workersDev).toBe(false);
        expect(config.previewUrls).toBe(false);
        expect(config.env).toEqual({ AUTH_SECRET: { type: 'secret' } });
        published = true;
        events.push('publish-domain');
        return { status: 0, stdout: '', stderr: '' };
      };
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        runCf,
        verifyResources: createCfResourceVerifier({
          configPath: join(roots.at(-1)!, 'dist/ssr/wrangler.json'),
          runCf,
          runWrangler: () => {
            throw new Error('An app without paid bindings must not probe paid services.');
          },
          verifyCompatibilityRunner: () => true,
        }),
        pinnedUpload: {
          accountId: 'account-id',
          apiBaseUrl,
          getToken: async () => 'synthetic-token',
          verifyUploader: () => true,
        },
      });
      const result = await activateCloudflareVersion({
        runWrangler: runner,
        workerName: 'void-test',
        configPath: join(roots.at(-1)!, 'dist/ssr/wrangler.json'),
        verifyUploader: () => true,
        pinActiveSecrets,
        atomic,
        allowFirstDeploymentBootstrap: true,
        readinessAttempts: 1,
        message: encodeCloudflareVersionMessage([], triggerConfig),
        fetch: async (url) => {
          expect(url).toBe(`https://${domain}/__void/ready`);
          events.push('readiness');
          return Response.json({ ready: published });
        },
      });
      expect(result, JSON.stringify({ result, events })).toMatchObject({
        ok: true,
        versionId: next,
        previewUrl: `https://${domain}`,
      });
      expect(events).toEqual(['activate', 'publish-domain', 'readiness']);
    } finally {
      await prepared.dispose();
    }
  },
);

it('does not pin active secrets during an existing-Worker handoff', async () => {
  const prepared = await output();
  try {
    expect(
      createActiveSecretPinner({ output: prepared, handoffPending: true, requiredNames: [] }),
    ).toBeUndefined();
  } finally {
    prepared.dispose();
  }
});

it('refuses to pin when a required secret is absent from the live version', async () => {
  const prepared = await output({ secrets: { required: ['AUTH_SECRET'] } });
  try {
    expect(
      await pinActiveWorkerSecrets({
        output: prepared,
        activeVersionId: '11111111-1111-4111-8111-111111111111',
        bindings: [],
        requiredNames: ['AUTH_SECRET'],
      }),
    ).toBe(false);
  } finally {
    prepared.dispose();
  }
});

it(
  'does not delegate credentialed commands to a project-local cf',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'void-cf-pinned-command-'));
    roots.push(root);
    const local = join(root, 'node_modules', 'cf');
    mkdirSync(local, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(
      join(local, 'package.json'),
      JSON.stringify({ name: 'cf', version: '0.0.0', bin: { cf: 'fake.cjs' } }),
    );
    writeFileSync(join(local, 'fake.cjs'), 'console.log("UNPINNED_PROJECT_CF_EXECUTED");');
    const env = {
      PATH: process.env.PATH,
      CI: 'true',
      CLI_VERSION: 'inherited-version void/stale',
      CLOUDFLARE_API_TOKEN: 'synthetic-token',
    };
    const command = createCfCommand({
      accountId: 'test-account',
      apiBaseUrl: 'https://api.cloudflare.com/client/v4',
      verifyUploader: () => true,
      env: () => env,
    });
    const result = await command(['--version'], { cwd: root, capture: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('UNPINNED_PROJECT_CF_EXECUTED');
    expect(result.stdout.trim()).toBe(`${pinnedCfVersion} void/${voidVersion}`);
    expect(env.CLI_VERSION).toBe('inherited-version void/stale');
  },
  REAL_CF_TIMEOUT_MS,
);

it.each([
  { diagnostic: 'synthetic provider failure [10007]', args: ['--version'] },
  {
    diagnostic: 'You cannot upload a new version of a Worker that does not yet exist.',
    args: ['workers', 'versions', 'create', '--prebuilt'],
  },
])(
  'does not classify buffered diagnostics from a terminated real cf process ($diagnostic)',
  async ({ diagnostic, args }) => {
    const root = mkdtempSync(join(tmpdir(), 'void-cf-interrupted-command-'));
    roots.push(root);
    const preload = join(root, 'interrupt.cjs');
    writeFileSync(
      preload,
      `process.stderr.write(${JSON.stringify(diagnostic + '\n')});\n` +
        `setInterval(() => {}, 1 << 30);\n`,
    );
    const command = createCfCommand({
      accountId: 'test-account',
      apiBaseUrl: 'https://api.cloudflare.com/client/v4',
      verifyUploader: () => true,
      env: () => ({
        PATH: process.env.PATH,
        NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        CI: 'true',
      }),
    });
    const spawn = childProcess.spawn;
    // Windows does not report a signal when a process kills itself. Terminate
    // the real child from its parent after the diagnostic is buffered instead.
    const spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation((...args) => {
      const child = spawn(...args);
      child.stderr?.once('data', () => child.kill('SIGTERM'));
      return child;
    });
    syncBuiltinESMExports();
    let result: Awaited<ReturnType<typeof command>>;
    try {
      result = await command(args, { cwd: root, capture: true });
    } finally {
      spawnSpy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(result.status).toBe(1);
    expect(result.signal).toBe('SIGTERM');
    expect(result.stderr).toContain(diagnostic);
    expect(result.errorCode).toBeUndefined();
    expect(result.errors).toBeUndefined();
    expect(result.failure).toBeUndefined();
  },
  REAL_CF_TIMEOUT_MS,
);

it('preserves interruption provenance before interpreting an empty cf deployment list', async () => {
  const prepared = await output();
  try {
    const run = createCfVersionRunner({
      output: prepared,
      workerName: 'site',
      runCf: async () => ({
        status: 0,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
        data: { deployments: [] },
      }),
      verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
    });
    const result = await run({ type: 'deployments.status', workerName: 'site' }, { capture: true });
    expect(result.signal).toBe('SIGTERM');
    expect(result.errorCode).toBeUndefined();
  } finally {
    prepared.dispose();
  }
});

it('uses the configured HTTP proxy for direct cf activation reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-proxy-read-'));
  roots.push(root);
  const requests: Array<string> = [];
  const respond = (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) => {
    requests.push(new URL(request.url ?? '/', 'http://cf-proxy-test.invalid').href);
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        success: true,
        errors: [],
        result: [{ id: '00000000-0000-0000-0000-000000000001', number: 1 }],
      }),
    );
  };
  const api = createServer(respond);
  const proxy = createServer(respond);
  const tunnels = new Set<Duplex>();
  proxy.on('connect', (_request, socket, head) => {
    const upstream = connect((api.address() as AddressInfo).port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    tunnels.add(socket);
    tunnels.add(upstream);
    socket.on('close', () => tunnels.delete(socket));
    upstream.on('close', () => tunnels.delete(upstream));
    upstream.on('error', () => socket.destroy());
  });
  await listen(api);
  const proxyUrl = new URL(await listen(proxy)).origin;
  // Open tunnels keep the servers from closing.
  cleanups.push(() => {
    for (const tunnel of tunnels) {
      tunnel.destroy();
    }
  });
  const apiBaseUrl = 'http://cf-proxy-test.invalid/client/v4';
  const result = await pinnedCf(apiBaseUrl, 'test-account', { HTTP_PROXY: proxyUrl, NO_PROXY: '' })(
    ['workers', 'versions', 'list', '--worker-id', 'proxy-worker'],
    { cwd: root, capture: true },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('00000000-0000-0000-0000-000000000001');
  expect(requests).toEqual([
    'http://cf-proxy-test.invalid/client/v4/accounts/test-account/workers/workers/proxy-worker/versions',
  ]);
}, 30_000);

it('preserves activation metadata and sorts cf version history for the existing protocol', async () => {
  const prepared = await output();
  try {
    const calls: Array<Array<string>> = [];
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
      runCf: (args) => {
        calls.push(args);
        if (args[1] === 'deployments' && args[2] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify({
              deployments: [{ versions: [{ version_id: 'one', percentage: 100 }] }],
            }),
            stderr: '',
          };
        }
        if (args[1] === 'versions' && args[2] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: 'two', number: 2 },
              { id: 'one', number: 1 },
            ]),
            stderr: '',
          };
        }
        return {
          status: 0,
          stdout: 'Worker Version ID: 00000000-0000-0000-0000-000000000001',
          stderr: '',
        };
      },
    });
    const target = { configPath: 'generated.json', workerName: 'void-test' };
    const deployment = await runner({ type: 'deployments.status', ...target }, { capture: true });
    expect(deployment.data).toEqual({
      versions: [{ version_id: 'one', percentage: 100 }],
    });
    const versions = await runner({ type: 'versions.list', ...target }, { capture: true });
    expect((versions.data as Array<{ id: string }>).map((item: { id: string }) => item.id)).toEqual(
      ['one', 'two'],
    );
    expect(calls.at(-1)).toEqual([
      'workers',
      'versions',
      'list',
      '--worker-id',
      'void-test',
      '--per-page',
      '10',
      '--page',
      '1',
    ]);
    await runner(
      {
        type: 'versions.upload',
        ...target,
        message: 'void:metadata',
        previewAlias: 'void-ready',
      },
      { capture: true },
    );
    expect(calls.at(-1)).toEqual([
      'workers',
      'versions',
      'create',
      '--prebuilt',
      '--message',
      'void:metadata',
      '--preview-alias',
      'void-ready',
    ]);
    await runner(
      {
        type: 'versions.deploy',
        ...target,
        message: 'void:metadata',
        versions: [{ versionId: '00000000-0000-0000-0000-000000000001', percentage: 100 }],
      },
      { capture: false },
    );
    const deployArgs = calls.at(-1)!;
    expect(deployArgs.slice(0, 3)).toEqual(['workers', 'deployments', 'create']);
    expect(JSON.parse(deployArgs[deployArgs.indexOf('--body') + 1]!)).toMatchObject({
      strategy: 'percentage',
      annotations: { 'workers/message': 'void:metadata' },
      versions: [{ version_id: '00000000-0000-0000-0000-000000000001', percentage: 100 }],
    });
  } finally {
    prepared.dispose();
  }
});

it.each(['newest-first', 'oldest-first'] as const)(
  'reads the actual latest ten versions when cf pages %s',
  async (order) => {
    const prepared = await output();
    try {
      const history = Array.from({ length: 25 }, (_, index) => ({
        id: `version-${index + 1}`,
        number: index + 1,
      }));
      const ordered = order === 'newest-first' ? history.reverse() : history;
      const pages: Array<number> = [];
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
        runCf: (args) => {
          const page = Number(args[args.indexOf('--page') + 1]);
          pages.push(page);
          return {
            status: 0,
            stdout: JSON.stringify(ordered.slice((page - 1) * 10, page * 10)),
            stderr: '',
          };
        },
      });
      const result = await runner(
        { type: 'versions.list', workerName: 'void-test' },
        { capture: true },
      );
      expect(
        (result.data as Array<{ number: number }>).map((item: { number: number }) => item.number),
      ).toEqual(Array.from({ length: 10 }, (_, index) => index + 16));
      expect(pages).toEqual(order === 'newest-first' ? [1, 2] : [1, 2, 3]);
    } finally {
      prepared.dispose();
    }
  },
);

it('applies the immutable trigger snapshot through a private cf output copy', async () => {
  const prepared = await output();
  const triggerConfig = join(roots[0]!, 'trigger.json');
  writeFileSync(
    triggerConfig,
    JSON.stringify({
      name: 'void-test',
      workers_dev: false,
      preview_urls: true,
      triggers: { crons: ['0 * * * *'] },
    }),
  );
  let privateDirectory = '';
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
      runCf: (args, run) => {
        expect(args).toEqual(['workers', 'triggers', 'deploy', '--prebuilt']);
        privateDirectory = run.cwd;
        expect(run.cwd).not.toBe(prepared.directory);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const result = await runner(
      { type: 'triggers.deploy', configPath: triggerConfig, workerName: 'void-test' },
      { capture: false },
    );
    expect(result.status).toBe(0);
    expect(existsSync(privateDirectory)).toBe(false);
    expect(existsSync(prepared.directory)).toBe(true);
  } finally {
    prepared.dispose();
  }
});

it.each(['restore', 'remove'] as const)(
  'replays workflow exports and schedules when triggers %s the previous workflow state',
  async (operation) => {
    const workflow = {
      binding: 'JOB',
      name: 'void-job',
      class_name: 'Job',
      schedules: ['0 * * * *'],
    };
    const prepared = await output({
      vars: { FIXED: 'value' },
      durable_objects: { bindings: [{ name: 'STATE', class_name: 'State' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['State'] }],
      workflows: operation === 'restore' ? [workflow] : [],
    });
    const desiredWorkflow = { ...workflow, schedules: ['30 * * * *'], concurrency: { limit: 2 } };
    try {
      const calls: Array<Array<string>> = [];
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
        runCf: (args, { cwd }) => {
          calls.push(args);
          const worker = JSON.parse(readFileSync(getWorkerConfigPath(cwd), 'utf8'));
          expect(worker.exports.Job).toEqual({
            type: 'workflow',
            name: 'void-job',
            ...(operation === 'restore'
              ? { schedules: ['30 * * * *'], concurrency: { limit: 2 } }
              : {}),
          });
          expect(worker.env.JOB).toMatchObject({
            type: 'workflow',
            name: 'void-job',
            worker: 'void-test',
            exportName: 'Job',
          });
          expect(worker.exports.State).toMatchObject({ type: 'durable-object', storage: 'sqlite' });
          expect(worker.env.STATE).toMatchObject({ type: 'durable-object' });
          expect(worker.env.FIXED).toEqual({ type: 'text', value: 'value' });
          return { status: 0, stdout: '', stderr: '' };
        },
      });
      const base = {
        workers_dev: true,
        preview_urls: true,
        routes: [],
        crons: [],
        queueConsumers: [],
      };
      const result = await deployCloudflareVersionTriggers({
        workerName: 'void-test',
        configPath: join(roots.at(-1)!, 'dist', 'ssr', 'wrangler.json'),
        runWrangler: runner,
        triggerConfig: {
          ...base,
          workflows: operation === 'restore' ? [desiredWorkflow] : [],
        },
        previousTriggerConfig: { ...base, workflows: [workflow] },
      });
      expect(result.status).toBe(0);
      expect(calls).toEqual([['workers', 'triggers', 'deploy', '--prebuilt']]);
      const original = JSON.parse(readFileSync(getWorkerConfigPath(prepared.directory), 'utf8'));
      expect(original.exports.Job?.schedules).toEqual(
        operation === 'restore' ? ['0 * * * *'] : undefined,
      );
    } finally {
      prepared.dispose();
    }
  },
);

it(
  'applies all local Workflow settings through the real pinned cf trigger transport',
  async () => {
    const workflow = {
      binding: 'JOB',
      name: 'void-job',
      class_name: 'Job',
      limits: { steps: 7 },
      concurrency: { limit: 2 },
      schedules: ['0 * * * *'],
      default_retention: { success_retention: '1 day', error_retention: '3 days' },
    };
    const prepared = await output({
      workers_dev: false,
      preview_urls: false,
      workflows: [workflow],
    });
    const original = readFileSync(getWorkerConfigPath(prepared.directory), 'utf8');
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Array<Buffer> = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body: body ? JSON.parse(body) : undefined,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          success: true,
          errors: [],
          result: request.url?.endsWith('/workers/subdomain')
            ? { subdomain: 'fixture' }
            : { subdomain: { enabled: false, previews_enabled: false } },
        }),
      );
    });
    const apiBaseUrl = await listen(server);
    try {
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        runCf: pinnedCf(apiBaseUrl),
        verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
      });
      const result = await deployCloudflareVersionTriggers({
        workerName: 'void-test',
        configPath: join(roots.at(-1)!, 'dist', 'ssr', 'wrangler.json'),
        runWrangler: runner,
        triggerConfig: {
          workers_dev: false,
          preview_urls: false,
          routes: [],
          crons: [],
          queueConsumers: [],
          workflows: [workflow],
        },
      });
      expect(result, result.stdout + result.stderr).toMatchObject({ status: 0 });
      expect(requests.filter(({ path }) => path.includes('/workflows/'))).toEqual([
        {
          method: 'PUT',
          path: '/client/v4/accounts/account-id/workflows/void-job',
          body: {
            script_name: 'void-test',
            class_name: 'Job',
            limits: { steps: 7 },
            concurrency: { limit: 2 },
            schedules: [{ cron: '0 * * * *' }],
            default_retention: { success_retention: '1 day', error_retention: '3 days' },
          },
        },
      ]);
      expect(requests.some(({ path }) => path.includes('/versions'))).toBe(false);
      expect(readFileSync(getWorkerConfigPath(prepared.directory), 'utf8')).toBe(original);
    } finally {
      prepared.dispose();
    }
  },
  REAL_CF_TIMEOUT_MS,
);

it.each([
  {
    rows: [{ type: 'worker', script_name: 'void-test', consumer_id: 'owned-id' }],
    status: 0,
    remove: true,
  },
  { rows: [{ script: 'void-test', consumer_id: 'owned-id' }], status: 0, remove: true },
  {
    rows: [
      { type: 'worker', script_name: 'void-test', script: 'foreign', consumer_id: 'owned-id' },
    ],
    status: 1,
    remove: false,
  },
  {
    rows: [{ type: 'worker', script_name: null, script: 'void-test', consumer_id: 'owned-id' }],
    status: 1,
    remove: false,
  },
  {
    rows: [{ type: 'worker', script_name: '', consumer_id: 'owned-id' }],
    status: 1,
    remove: false,
  },
  {
    rows: [{ type: 'worker', script_name: 'void-test', consumer_id: '' }],
    status: 1,
    remove: false,
  },
  {
    rows: [{ type: 'http_pull', script_name: 'void-test', consumer_id: 'owned-id' }],
    status: 1,
    remove: false,
  },
  { rows: [{ type: 'worker', consumer_id: 'owned-id' }], status: 1, remove: false },
  {
    rows: [
      { type: 'worker', script_name: 'void-test', consumer_id: 'one' },
      { type: 'worker', script_name: 'void-test', consumer_id: 'two' },
    ],
    status: 1,
    remove: false,
  },
  {
    rows: [
      { type: 'worker', script_name: 'foreign', consumer_id: 'foreign-id' },
      { type: 'http_pull', consumer_id: 'pull-id' },
    ],
    status: 0,
    remove: false,
  },
])(
  'removes only an unambiguous Queue consumer Worker identity: $rows',
  async ({ rows, status, remove }) => {
    const prepared = await output();
    const calls: Array<Array<string>> = [];
    try {
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
        runCf: (args) => {
          calls.push(args);
          return {
            status: 0,
            stdout: JSON.stringify(
              args[1] === 'list'
                ? [{ queue_name: 'jobs', queue_id: 'queue-id' }]
                : args[2] === 'list'
                  ? rows
                  : {},
            ),
            stderr: '',
          };
        },
      });
      const result = await runner(
        { type: 'queues.consumer.remove', queueName: 'jobs', workerName: 'void-test' },
        { capture: true },
      );
      expect(result.status).toBe(status);
      expect(calls.filter((args) => args[2] === 'delete')).toEqual(
        remove
          ? [['queues', 'consumers', 'delete', 'owned-id', '--queue-id', 'queue-id', '--force']]
          : [],
      );
    } finally {
      prepared.dispose();
    }
  },
);

it('uses cf for Queue triggers, consumer cleanup, and version binding reads', async () => {
  const prepared = await output();
  const triggerConfig = join(roots.at(-1)!, 'legacy-trigger.json');
  writeFileSync(
    triggerConfig,
    JSON.stringify({ name: 'void-test', queues: { consumers: [{ queue: 'jobs' }] } }),
  );
  const calls: Array<Array<string>> = [];
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
      runCf: (args) => {
        calls.push(args);
        if (args[0] === 'queues' && args[1] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify([{ queue_name: 'jobs', queue_id: 'queue-id' }]),
            stderr: '',
          };
        }
        if (args[0] === 'queues' && args[1] === 'consumers' && args[2] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify([
              { type: 'worker', script_name: 'void-test', consumer_id: 'consumer-id' },
            ]),
            stderr: '',
          };
        }
        if (args[0] === 'workers' && args[1] === 'versions' && args[2] === 'get') {
          return {
            status: 0,
            stdout: JSON.stringify({
              id: 'version-id',
              bindings: [{ name: 'SECRET', type: 'secret_text' }],
            }),
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const invalid = await runner(
      {
        type: 'versions.deploy',
        workerName: 'void-test',
        versions: [{ versionId: 'invalid', percentage: 100 }],
      },
      { capture: true },
    );
    expect(invalid.status).toBe(1);
    const trigger = await runner(
      { type: 'triggers.deploy', configPath: triggerConfig, workerName: 'void-test' },
      { capture: false },
    );
    expect(trigger.status).toBe(0);
    const remove = await runner(
      { type: 'queues.consumer.remove', queueName: 'jobs', workerName: 'void-test' },
      { capture: false },
    );
    expect(remove.status).toBe(0);
    const version = await runner(
      { type: 'versions.view', versionId: 'version-id', workerName: 'void-test' },
      { capture: true },
    );
    expect(
      (version.data as { resources: { bindings: Array<unknown> } }).resources.bindings,
    ).toEqual([{ name: 'SECRET', type: 'secret_text' }]);
    expect(calls).toContainEqual(['workers', 'triggers', 'deploy', '--prebuilt']);
    expect(calls).toContainEqual([
      'queues',
      'consumers',
      'delete',
      'consumer-id',
      '--queue-id',
      'queue-id',
      '--force',
    ]);
  } finally {
    prepared.dispose();
  }
});

it('accepts only the staged static assets directory already sealed into prebuilt output', async () => {
  const prepared = await output();
  prepared.assetsDirectory = '/staged/assets';
  const calls: Array<Array<string>> = [];
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
      runCf: (args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    expect(
      (
        await runner(
          { type: 'versions.upload', workerName: 'void-test', assetsDirectory: '/staged/assets' },
          { capture: true },
        )
      ).status,
    ).toBe(0);
    expect(calls.at(-1)?.slice(0, 4)).toEqual(['workers', 'versions', 'create', '--prebuilt']);
    expect(
      (
        await runner(
          { type: 'worker.deploy', workerName: 'void-test', assetsDirectory: '/wrong/assets' },
          { capture: true },
        )
      ).status,
    ).toBe(1);
    expect(calls).toHaveLength(1);
  } finally {
    prepared.dispose();
  }
});

it.each(['r2', 'queue'] as const)(
  'refuses every prebuilt mutation when a %s binding does not exist',
  async (missing) => {
    const prepared = await output({
      ...(missing === 'r2' ? { r2_buckets: [{ binding: 'BUCKET', bucket_name: 'bucket' }] } : {}),
      ...(missing === 'queue'
        ? { queues: { producers: [{ binding: 'QUEUE', queue: 'jobs' }] } }
        : {}),
    });
    const triggerConfig = join(roots.at(-1)!, 'triggers.json');
    writeFileSync(triggerConfig, JSON.stringify({ name: 'void-test', workers_dev: true }));
    const cfCalls: Array<Array<string>> = [];
    const runCf = (args: Array<string>) => {
      cfCalls.push(args);
      return { status: 1, stdout: '', stderr: 'Resource not found.' };
    };
    const verifier = createCfResourceVerifier({
      configPath: join(roots.at(-1)!, 'dist', 'ssr', 'wrangler.json'),
      runCf,
      verifyCompatibilityRunner: () => true,
      runWrangler: operationFixture(async () => ({
        status: 1,
        stdout: '',
        stderr: 'Queue not found.',
      })),
    });
    try {
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        runCf,
        verifyResources: verifier,
      });
      expect(
        (await runner({ type: 'versions.upload', workerName: 'void-test' }, { capture: true }))
          .status,
      ).toBe(1);
      expect(
        (await runner({ type: 'worker.deploy', workerName: 'void-test' }, { capture: true }))
          .status,
      ).toBe(1);
      expect(
        (
          await runner(
            { type: 'triggers.deploy', configPath: triggerConfig, workerName: 'void-test' },
            { capture: true },
          )
        ).status,
      ).toBe(1);
      expect(cfCalls.every((args) => args[0] === 'r2' && args[1] === 'buckets')).toBe(true);
      expect(cfCalls).toHaveLength(missing === 'r2' ? 3 : 0);
    } finally {
      prepared.dispose();
    }
  },
  15_000,
);

it('uploads when existing R2 and Queue bindings are verified by exact identity', async () => {
  const prepared = await output({
    r2_buckets: [{ binding: 'BUCKET', bucket_name: 'bucket', jurisdiction: 'eu' }],
    queues: { producers: [{ binding: 'QUEUE', queue: 'jobs' }] },
  });
  const cfCalls: Array<Array<string>> = [];
  const queueCalls: Array<Array<string>> = [];
  const runCf = (args: Array<string>) => {
    cfCalls.push(args);
    return {
      status: 0,
      stdout: args[0] === 'r2' ? JSON.stringify({ name: 'bucket' }) : '',
      stderr: '',
    };
  };
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      runCf,
      verifyResources: createCfResourceVerifier({
        configPath: join(roots.at(-1)!, 'dist', 'ssr', 'wrangler.json'),
        runCf,
        verifyCompatibilityRunner: () => true,
        runWrangler: operationFixture(async (args) => {
          queueCalls.push(args);
          return { status: 0, stdout: 'Queue Name: jobs\n', stderr: '' };
        }),
      }),
    });
    expect(
      (await runner({ type: 'versions.upload', workerName: 'void-test' }, { capture: true }))
        .status,
    ).toBe(0);
    expect(cfCalls).toEqual([
      ['r2', 'buckets', 'get', 'bucket', '--cf-r2-jurisdiction', 'eu'],
      ['workers', 'versions', 'create', '--prebuilt'],
    ]);
    expect(queueCalls).toEqual([
      [
        'queues',
        'info',
        'jobs',
        '-c',
        join(roots.at(-1)!, 'dist', 'ssr', 'wrangler.json'),
        '--env=',
      ],
    ]);
  } finally {
    prepared.dispose();
  }
});
