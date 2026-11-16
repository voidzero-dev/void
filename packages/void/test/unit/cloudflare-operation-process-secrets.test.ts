import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import {
  VOID_SECRET_DRAFT_MESSAGE,
  VOID_SECRET_DRAFT_SOURCE,
  type CloudflareOperation,
} from '@void/deploy-cloudflare';
import { expect, it } from 'vite-plus/test';
import { decodeCloudflareOperationResult } from '../../src/cli/cloudflare-process.ts';
import {
  listen,
  runOperation,
  temporaryDirectory,
  tokenEnv,
} from '../helpers/cloudflare-operation-process.ts';

type CfReply = { status: number; stdout?: string; stderr?: string };
type ApiReply = { status: number; body: unknown };
type CfCall = { label: string; file?: string };

// Replaces cf with replies scripted by command prefix, served in call order. Each call is logged
// with the contents of its `--file` argument, which cf would read before the scratch file goes.
const SCRIPTED_CF = `import child from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawnSync = child.spawnSync.bind(child);
child.spawnSync = (binary, args, options) => {
  if (!Array.isArray(args) || typeof args[0] !== 'string' || !/(?:\\/|^)cf$/.test(args[0])) {
    return originalSpawnSync(binary, args, options);
  }
  const label = args.slice(1).join(' ');
  const fileIndex = args.indexOf('--file');
  const log = process.env.VOID_TEST_CALL_LOG;
  const calls = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : [];
  calls.push({ label, ...(fileIndex >= 0 ? { file: readFileSync(args[fileIndex + 1], 'utf8') } : {}) });
  writeFileSync(log, JSON.stringify(calls));
  const script = JSON.parse(readFileSync(process.env.VOID_TEST_CF_SCRIPT, 'utf8'));
  const prefix = Object.keys(script).find((key) => label.startsWith(key));
  if (!prefix) {
    return { status: 1, stdout: '', stderr: 'Unscripted cf call: ' + label };
  }
  const seen = calls.filter((call) => call.label.startsWith(prefix)).length;
  const replies = script[prefix];
  return { stdout: '', stderr: '', ...replies[Math.min(seen, replies.length) - 1] };
};
syncBuiltinESMExports();
`;

/** Run a secret operation with scripted cf replies and the Cloudflare API on a local server. */
async function runSecretScenario(options: {
  operation: CloudflareOperation;
  input: string;
  cf: Record<string, Array<CfReply>>;
  api?: (method: string, path: string) => ApiReply;
  env?: NodeJS.ProcessEnv;
}) {
  const directory = temporaryDirectory('void-cf-secret-test-');
  const apiCalls: Array<{ method: string; path: string; body: unknown }> = [];
  const apiHeaders: Array<IncomingHttpHeaders> = [];
  const api = await listen(
    createServer(async (request, response) => {
      let text = '';
      for await (const chunk of request) {
        text += chunk;
      }
      const method = request.method ?? '';
      const path = (request.url ?? '').replace('/client/v4/accounts/test-account', '');
      apiCalls.push({ method, path, body: text ? JSON.parse(text) : undefined });
      apiHeaders.push(request.headers);
      const reply = options.api?.(method, path) ?? { status: 500, body: { success: false } };
      response.writeHead(reply.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    }),
  );
  const config = join(directory, 'wrangler.json');
  const preload = join(directory, 'scripted-cf.mjs');
  const callLog = join(directory, 'cf-calls.json');
  const script = join(directory, 'cf-script.json');
  writeFileSync(config, JSON.stringify({ name: 'my-worker', account_id: 'test-account' }));
  writeFileSync(script, JSON.stringify(options.cf));
  writeFileSync(preload, SCRIPTED_CF);
  const child = await runOperation(
    directory,
    { ...options.operation, configPath: config },
    {
      ...tokenEnv(api),
      VOID_TEST_CALL_LOG: callLog,
      VOID_TEST_CF_SCRIPT: script,
      ...options.env,
    },
    preload,
    options.input,
  );
  const cfCalls: Array<CfCall> = existsSync(callLog)
    ? (JSON.parse(readFileSync(callLog, 'utf8')) as Array<CfCall>)
    : [];
  return { result: decodeCloudflareOperationResult(child), cfCalls, apiCalls, apiHeaders };
}

const putOperation: CloudflareOperation = {
  type: 'secret.put',
  name: 'S1',
  configPath: '',
  workerName: 'my-worker',
};
const bulkOperation: CloudflareOperation = {
  type: 'secret.bulk',
  configPath: '',
  workerName: 'my-worker',
};

const ok: CfReply = { status: 0, stdout: '{}' };
const missing: CfReply = { status: 1, stderr: '[code: 10007] This Worker does not exist.' };
const undeployed: CfReply = { status: 1, stderr: '[code: 10013] An unknown error occurred.' };
const success: ApiReply = { status: 200, body: { success: true, result: { id: 'v1' } } };
const exists: ApiReply = {
  status: 409,
  body: { success: false, errors: [{ code: 10040, message: 'This Worker name is in use.' }] },
};

/** Workers API replies keyed by request: create and version upload. */
function workersApi(replies: { create: ApiReply; upload?: ApiReply }) {
  return (method: string, path: string): ApiReply => {
    if (method === 'POST' && path === '/workers/workers') {
      return replies.create;
    }
    if (method === 'POST' && path === '/workers/workers/my-worker/versions?deploy=true') {
      return replies.upload ?? { status: 500, body: {} };
    }
    return { status: 500, body: {} };
  };
}

it('wraps Workers secrets bulk payload in a secrets object', async () => {
  const { result, cfCalls } = await runSecretScenario({
    operation: bulkOperation,
    input: JSON.stringify({ ONE: 'first', TWO: 'second' }),
    cf: { 'workers secrets bulk': [ok] },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(cfCalls).toHaveLength(1);
  expect(cfCalls[0]!.label).toMatch(
    /^workers secrets bulk --worker my-worker --file \S+body\.json$/,
  );
  expect(JSON.parse(cfCalls[0]!.file!)).toEqual({
    secrets: {
      ONE: { type: 'secret_text', text: 'first' },
      TWO: { type: 'secret_text', text: 'second' },
    },
  });
});

const isUpload = (call: { method: string; path: string }) =>
  call.method === 'POST' && call.path.endsWith('/versions?deploy=true');

it('creates a missing Worker and deploys the placeholder with its secret in one request', async () => {
  const { result, cfCalls, apiCalls } = await runSecretScenario({
    operation: putOperation,
    input: 'one',
    cf: { 'workers secrets update': [missing] },
    api: workersApi({ create: success, upload: success }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(cfCalls).toHaveLength(1);
  expect(apiCalls[0]).toEqual({
    method: 'POST',
    path: '/workers/workers',
    body: { name: 'my-worker', subdomain: { enabled: false, previews_enabled: false } },
  });
  expect(apiCalls[1]).toEqual({
    method: 'POST',
    path: '/workers/workers/my-worker/versions?deploy=true',
    body: {
      main_module: 'index.js',
      modules: [
        {
          name: 'index.js',
          content_type: 'application/javascript+module',
          content_base64: Buffer.from(VOID_SECRET_DRAFT_SOURCE).toString('base64'),
        },
      ],
      compatibility_date: '2025-01-01',
      bindings: [{ type: 'secret_text', name: 'S1', text: 'one' }],
      annotations: { 'workers/message': VOID_SECRET_DRAFT_MESSAGE },
    },
  });
  expect(apiCalls).toHaveLength(2);
});

it('sets the secret on a Worker deployed after the 10007 without deploying the placeholder', async () => {
  const { result, cfCalls, apiCalls } = await runSecretScenario({
    operation: putOperation,
    input: 'one',
    cf: { 'workers secrets update': [missing, ok] },
    api: workersApi({ create: exists }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(cfCalls.filter((call) => call.label.startsWith('workers secrets update'))).toHaveLength(2);
  expect(apiCalls.some(isUpload)).toBe(false);
});

it.each([
  ['has no versions (10007)', missing],
  ['has versions but no deployment (10013)', undeployed],
])('fails with the recovery steps when the existing Worker %s', async (_label, retried) => {
  const { result, apiCalls } = await runSecretScenario({
    operation: putOperation,
    input: 'one',
    cf: { 'workers secrets update': [missing, retried] },
    api: workersApi({ create: exists, upload: success }),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('exists but has no deployment');
  expect(result.stderr).toContain('run `void deploy` first');
  expect(result.stderr).toContain('delete the Worker "my-worker" in the Cloudflare dashboard');
  expect(apiCalls.some(isUpload)).toBe(false);
});

it('fails with the recovery steps for bulk secrets on a Worker without a deployment', async () => {
  const { result, apiCalls } = await runSecretScenario({
    operation: bulkOperation,
    input: JSON.stringify({ ONE: 'first' }),
    cf: { 'workers secrets bulk': [missing, missing] },
    api: workersApi({ create: exists, upload: success }),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('exists but has no deployment');
  expect(apiCalls.some(isUpload)).toBe(false);
});

it('sends the API token when a Global API Key is also set, as cf does', async () => {
  const { result, apiHeaders } = await runSecretScenario({
    operation: putOperation,
    input: 'one',
    cf: { 'workers secrets update': [missing] },
    api: workersApi({ create: success, upload: success }),
    env: { CLOUDFLARE_API_KEY: 'synthetic-key', CLOUDFLARE_EMAIL: 'a@example.test' },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(apiHeaders).toHaveLength(2);
  for (const headers of apiHeaders) {
    expect(headers.authorization).toBe('Bearer synthetic-token');
    expect(headers).not.toHaveProperty('x-auth-key');
  }
});

it.each([
  ['the Worker create returns an error status', { create: { status: 500, body: {} } }],
  [
    'the Worker create is refused',
    {
      create: {
        status: 403,
        body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
      },
    },
  ],
  [
    'the Worker create returns an unsuccessful body',
    { create: { status: 200, body: { success: false } } },
  ],
  [
    'the Worker create returns a body that is not JSON',
    { create: { status: 200, body: 'created' } },
  ],
])('fails without deploying when %s', async (_label, replies) => {
  const { result, apiCalls } = await runSecretScenario({
    operation: putOperation,
    input: 'one',
    cf: { 'workers secrets update': [missing, missing] },
    api: workersApi(replies),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Cloudflare did not create the Worker');
  expect(apiCalls.some(isUpload)).toBe(false);
});

it('returns a non-zero status when the placeholder deploy fails after Worker 10007', async () => {
  const { result, apiCalls } = await runSecretScenario({
    operation: bulkOperation,
    input: JSON.stringify({ ONE: 'first' }),
    cf: { 'workers secrets bulk': [missing] },
    api: workersApi({
      create: success,
      upload: {
        status: 400,
        body: {
          success: false,
          errors: [{ code: 10021, message: 'Invalid compatibility_date "2025-13-01".' }],
        },
      },
    }),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Cloudflare did not deploy the secret placeholder (HTTP 400).');
  expect(result.stderr).toContain('code 10021: Invalid compatibility_date "2025-13-01".');
  expect(apiCalls.filter(isUpload)).toHaveLength(1);
});

it('deploys every bulk secret with the placeholder', async () => {
  const { result, apiCalls } = await runSecretScenario({
    operation: bulkOperation,
    input: JSON.stringify({ ONE: 'first', TWO: 'second' }),
    cf: { 'workers secrets bulk': [missing] },
    api: workersApi({ create: success, upload: success }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(apiCalls.find(isUpload)?.body).toHaveProperty('bindings', [
    { type: 'secret_text', name: 'ONE', text: 'first' },
    { type: 'secret_text', name: 'TWO', text: 'second' },
  ]);
});

it('sets bulk secrets on a Worker deployed after the 10007 without deploying the placeholder', async () => {
  const { result, cfCalls, apiCalls } = await runSecretScenario({
    operation: bulkOperation,
    input: JSON.stringify({ ONE: 'first' }),
    cf: { 'workers secrets bulk': [missing, ok] },
    api: workersApi({ create: exists }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(cfCalls.filter((call) => call.label.startsWith('workers secrets bulk'))).toHaveLength(2);
  expect(apiCalls.some(isUpload)).toBe(false);
});

it('rejects bulk secret values that are not strings', async () => {
  const { result, apiCalls, cfCalls } = await runSecretScenario({
    operation: bulkOperation,
    input: JSON.stringify({ ONE: 1 }),
    cf: {},
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Secret values must be strings.');
  expect(cfCalls).toHaveLength(0);
  expect(apiCalls).toHaveLength(0);
});
