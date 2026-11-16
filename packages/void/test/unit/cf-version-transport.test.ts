import childProcess from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkerConfigPath } from '@cloudflare/build-output-utils';
import { expect, it, vi } from 'vite-plus/test';
import { cloudflareCommandDiagnostic } from '../../../deploy-cloudflare/src/diagnostics.ts';
import { isVoidSecretOnlyDraft } from '../../../deploy-cloudflare/src/secret-draft.ts';
import {
  activateCloudflareVersion,
  encodeCloudflareVersionMessage,
} from '../../../deploy-cloudflare/src/version.ts';
import { operationFixture } from '../../../deploy-cloudflare/test/operation-fixture.ts';
import { voidSecretDraftVersion } from '../../../deploy-cloudflare/test/secret-draft-fixture.ts';
import {
  createActiveSecretPinner,
  createCfCommand,
  createCfResourceVerifier,
  createCfVersionRunner,
} from '../../src/cli/cf-version-runner.ts';
import {
  cfUserAgent,
  listen,
  output,
  pinnedCf,
  REAL_CF_ACTIVATION_TIMEOUT_MS,
  REAL_CF_TIMEOUT_MS,
  roots,
} from '../helpers/cf-version-fixture.ts';

it.each([false, true])(
  'reads immutable version source through the real pinned cf HTTP transport (large=%s)',
  async (large) => {
    const prepared = await output();
    const draft = voidSecretDraftVersion();
    if (large) {
      draft.modules[0]!.content_base64 = Buffer.from(
        `/* ${'x'.repeat(1024 * 1024)} */\nexport default { fetch() { return new Response("ok"); } };`,
      ).toString('base64');
    }
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
      expect(result.status, result.stderr).toBe(0);
      expect(result.data).toMatchObject(draft);
      expect(isVoidSecretOnlyDraft(result.data as Record<string, unknown>)).toBe(!large);
      expect(requests).toEqual([
        `/client/v4/accounts/test-account/workers/workers/void-test/versions/${draft.id}?include=modules`,
      ]);
      expect(commands).toHaveLength(1);
      expect(userAgents).toEqual([cfUserAgent]);
      expect(commands[0]!.bounds).toMatchObject({
        timeoutMs: 30_000,
        maxOutputBytes: 128 * 1024 * 1024,
      });
      expect(JSON.stringify(result)).not.toContain('synthetic-token');
    } finally {
      await prepared.dispose();
    }
  },
  REAL_CF_TIMEOUT_MS,
);

it.each([
  { label: 'missing', version: { id: 'version-id', number: 35 }, readable: true },
  { label: 'null', version: { id: 'version-id', number: 35, bindings: null }, readable: false },
  { label: 'an object', version: { id: 'version-id', number: 35, bindings: {} }, readable: false },
])('reads a version whose bindings are $label', async ({ version, readable }) => {
  const prepared = await output();
  try {
    const runner = createCfVersionRunner({
      output: prepared,
      workerName: 'void-test',
      runCf: () => ({ status: 0, stdout: JSON.stringify(version), stderr: '' }),
      verifyResources: async () => {
        throw new Error('A read must not provision or probe resources');
      },
    });
    const result = await runner(
      { type: 'versions.view', versionId: 'version-id', workerName: 'void-test' },
      { capture: true },
    );
    if (readable) {
      // Cloudflare omits `bindings` for a version that has none.
      expect(result.status).toBe(0);
      expect(result.data).toMatchObject({ bindings: [], resources: { bindings: [] } });
    } else {
      expect(result).toMatchObject({
        status: 1,
        stderr: 'The Cloudflare Worker version was not readable.',
      });
    }
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
      // cf 1.0.0-beta.21 and later print upload messages on stderr.
      expect(result.stdout).toBe('');
      expect(cloudflareCommandDiagnostic(result)).toBe(
        'You are about to upload a Worker that was last updated via the script API.\n' +
          'Aborting the upload operation because of conflicts. To override and upload anyway, remove the `--strict` flag',
      );
      expect(requests).toEqual([
        { method: 'GET', path: '/client/v4/accounts/account-id/workers/services/void-test' },
      ]);
    } finally {
      prepared.dispose();
    }
  },
  REAL_CF_TIMEOUT_MS,
);

it(
  'keeps the dashboard config diff out of the pinned cf upload conflict diagnostic',
  async () => {
    const prepared = await output({ vars: { LOCAL_VALUE: 'local-value-do-not-echo' } });
    const apiBaseUrl = await listen(
      createServer((request, response) => {
        const path = request.url!.split('?')[0]!;
        request.resume();
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: path.endsWith('/services/void-test')
              ? {
                  default_environment: {
                    environment: 'production',
                    script: { id: 'void-test', last_deployed_from: 'dash' },
                  },
                }
              : path.endsWith('/bindings')
                ? [{ type: 'plain_text', name: 'REMOTE_VALUE', text: 'remote-value-do-not-echo' }]
                : path.endsWith('/environments/production')
                  ? { script: { compatibility_date: '2026-01-01' } }
                  : path.endsWith('/schedules')
                    ? { schedules: [] }
                    : [],
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
      // The diff that explains the conflict shows values from both configurations.
      expect(result.stderr).toContain('remote-value-do-not-echo');
      expect(result.stderr).toContain('local-value-do-not-echo');
      expect(cloudflareCommandDiagnostic(result)).toBe(
        'Aborting the upload operation because of conflicts. To override and upload anyway, remove the `--strict` flag',
      );
    } finally {
      prepared.dispose();
    }
  },
  REAL_CF_TIMEOUT_MS,
);

it.each([false, true])(
  'reads the pinned cf upload result without echoing its binding table (rejected=%s)',
  async (rejected) => {
    const next = '22222222-2222-4222-8222-222222222222';
    const prepared = await output({ vars: { LOCAL_VALUE: 'local-value-do-not-echo' } });
    const apiBaseUrl = await listen(
      createServer((request, response) => {
        const path = request.url!.split('?')[0]!;
        const upload = request.method === 'POST' && path.endsWith('/scripts/void-test/versions');
        request.resume();
        response.writeHead(upload && rejected ? 400 : 200, {
          'Content-Type': 'application/json',
        });
        response.end(
          JSON.stringify(
            upload && rejected
              ? {
                  success: false,
                  errors: [{ code: 10021, message: 'Uploaded script has a validation error.' }],
                  messages: [],
                  result: null,
                }
              : {
                  success: true,
                  errors: [],
                  messages: [],
                  result: upload
                    ? { id: next, number: 2, metadata: { has_preview: true }, resources: {} }
                    : path.endsWith('/workers/workers/void-test')
                      ? {
                          subdomain: {
                            enabled: true,
                            previews_enabled: true,
                            preview_url_suffix: '-void-test.example.workers.dev',
                          },
                        }
                      : path.endsWith('/services/void-test')
                        ? {
                            default_environment: {
                              environment: 'production',
                              script: { id: 'void-test' },
                            },
                          }
                        : path.endsWith('/settings')
                          ? {}
                          : [],
                },
          ),
        );
      }),
    );
    try {
      const runner = createCfVersionRunner({
        output: prepared,
        workerName: 'void-test',
        runCf: pinnedCf(apiBaseUrl),
        verifyResources: async () => ({ status: 0, stdout: '', stderr: '' }),
      });
      const result = await runner(
        { type: 'versions.upload', workerName: 'void-test' },
        { capture: true },
      );
      // cf prints the binding table, with values, before it uploads.
      expect(result.stderr).toContain('local-value-do-not-echo');
      if (rejected) {
        expect(result.status).toBe(1);
        expect(cloudflareCommandDiagnostic(result)).toBe(
          '┌ APIError\n│ [10021] Uploaded script has a validation error. [code: 10021]\n│ 400 Bad Request\n└',
        );
      } else {
        expect(result).toMatchObject({
          status: 0,
          data: {
            versionId: next,
            previewUrl: `https://${next.slice(0, 8)}-void-test.example.workers.dev`,
          },
        });
      }
    } finally {
      prepared.dispose();
    }
  },
  REAL_CF_TIMEOUT_MS,
);

// This exercises multiple fresh cf subprocesses. Windows CI has exceeded 30s
// across those startups; bound each child and give the complete protocol a
// separate Windows budget, including assertion and cleanup overhead.
it.each([
  { observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true } } },
  { logpush: false },
  { logpush: true },
])(
  'uploads an API-origin revision and publishes its explicit Worker settings: %j',
  async (settings) => {
    const current = '11111111-1111-4111-8111-111111111111';
    const next = '22222222-2222-4222-8222-222222222222';
    const triggerConfig = {
      workers_dev: true,
      preview_urls: true,
      routes: [],
      crons: [],
      queueConsumers: [],
      workflows: [],
      ...settings,
    };
    const message = encodeCloudflareVersionMessage([], triggerConfig);
    const prepared = await output({
      ...settings,
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
      if (row.method === 'PATCH' && path.endsWith('/script-settings')) {
        expect(traffic).toEqual([{ version_id: next, percentage: 100 }]);
        events.push('settings');
        result = row.body;
      } else if (row.method === 'POST' && path.endsWith('/workers/workers/void-test/versions')) {
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
          getToken: async () => ({ ok: true, token: 'synthetic-token' }),
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
      expect(requests.filter((row) => row.method === 'PATCH')).toEqual([
        {
          method: 'PATCH',
          path: '/client/v4/accounts/account-id/workers/scripts/void-test/script-settings',
          body: settings,
        },
      ]);
      expect(events.indexOf('activate')).toBeLessThan(events.indexOf('settings'));
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
