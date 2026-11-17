import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { isVoidSecretOnlyDraft } from '../../../deploy-cloudflare/src/secret-draft.ts';
import { voidSecretDraftVersion } from '../../../deploy-cloudflare/test/secret-draft-fixture.ts';
import { decodeCloudflareOperationResult } from '../../src/cli/cloudflare-process.ts';
import { Buffer } from '../../src/cli/node-buffer.ts';
import {
  listen,
  runOperation,
  temporaryDirectory,
  tokenEnv,
} from '../helpers/cloudflare-operation-process.ts';

const voidVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  .version as string;
const cfVersion = JSON.parse(readFileSync(new URL(import.meta.resolve('cf/package.json')), 'utf8'))
  .version as string;
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

it.each([
  { observability: { enabled: true } },
  { observability: { enabled: false } },
  { logpush: true },
  { logpush: false },
  { observability: { enabled: false }, logpush: false },
])(
  'publishes explicit Worker settings from the trigger operation: %j',
  async (settings) => {
    const directory = temporaryDirectory('void-cf-observability-');
    const configPath = join(directory, 'wrangler.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'test-worker',
        workers_dev: false,
        preview_urls: false,
        ...settings,
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
              : { subdomain: { enabled: false, previews_enabled: false }, ...settings },
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
        body: settings,
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
  return ${
    uploadType === 'worker.deploy'
      ? // cf 1.0.0-beta.21 and later print the uploaded version on stderr.
        "{ status:0, stdout:'', stderr:'│  Current Version ID: 11111111-1111-4111-8111-111111111111\\n' }"
      : "{ status:0, stdout:JSON.stringify({id:'11111111-1111-4111-8111-111111111111'}), stderr:'' }"
  };
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
        message: '-review',
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
      '--message=-review',
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
