import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { delimiter, dirname, join } from 'node:path';
import { text } from 'node:stream/consumers';
import { afterEach, expect, it } from 'vite-plus/test';
import {
  collectServerOutput,
  createPackageFixtureDir,
  killChild,
} from '../../../../test/integration-helpers.ts';
import { readGeneratedDeployConfig } from '../../src/cli/deploy-artifact-validation.ts';
import { LATEST_KNOWN_COMPAT_DATE } from '../../src/cli/wrangler.ts';
import { readConfig } from '../../src/config.ts';

const packageRoot = join(import.meta.dirname, '../..');
const cli = join(packageRoot, 'dist/cli/cli.mjs');
const account = '11111111111111111111111111111111';
const kvId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const namespacesPath = `/client/v4/accounts/${account}/storage/kv/namespaces`;
const migrations = [
  { tag: 'void-durable-counter-v1', new_sqlite_classes: ['CounterDurableObject'] },
  { tag: 'void-ws-v1', new_sqlite_classes: ['ChatWs'] },
];
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function project(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(join(root, 'routes'), { recursive: true });
  mkdirSync(join(root, 'durable-objects'));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(
    packageRoot,
    join(root, 'node_modules/void'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  writeFileSync(
    join(root, 'package.json'),
    '{"private":true,"type":"module","devDependencies":{"void":"*","vite-plus":"*"}}',
  );
  writeFileSync(
    join(root, 'vite.config.ts'),
    "import { voidPlugin } from 'void'; export default { plugins: [voidPlugin()] };",
  );
  writeFileSync(join(root, 'routes/index.ts'), "export const GET = () => new Response('ok');");
  writeFileSync(
    join(root, 'routes/chat.ws.ts'),
    "import { defineWebSocket } from 'void/ws'; export default defineWebSocket({});",
  );
  writeFileSync(
    join(root, 'durable-objects/counter.ts'),
    "import { defineDurableState } from 'void/durable'; export default defineDurableState({ initialState: { count: 0 }, methods: { increment(ctx) { return ++ctx.state.count; } } });",
  );
  return root;
}

async function withProvider(
  run: (api: string, requests: Array<string>, titles: Array<string>) => Promise<void>,
): Promise<void> {
  const requests: Array<string> = [];
  const titles: Array<string> = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(`${req.method} ${path}`);
    res.setHeader('content-type', 'application/json');
    if (path === namespacesPath && req.method === 'GET') {
      res.end(
        JSON.stringify({ success: true, result: titles.map((title) => ({ title, id: kvId })) }),
      );
      return;
    }
    if (path === namespacesPath && req.method === 'POST') {
      // The namespace exists even though the create response reports failure.
      const { title } = JSON.parse(await text(req)) as { title: string };
      titles.push(title);
    }
    res.statusCode = 503;
    res.end(
      JSON.stringify({
        success: false,
        errors: [{ code: 10_000, message: 'Mock Cloudflare stop' }],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}/client/v4`, requests, titles);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

async function deploy(
  root: string,
  api: string,
  { args = ['deploy', '--platform', 'cloudflare'], accountId = account } = {},
): Promise<string> {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: [join(packageRoot, 'node_modules/.bin'), process.env.PATH].join(delimiter),
      SystemRoot: process.env.SystemRoot,
      HOME: root,
      USERPROFILE: root,
      CI: 'true',
      NO_COLOR: '1',
      VOID_API_URL: new URL(api).origin,
      CF_SEND_TELEMETRY: 'false',
      CLOUDFLARE_CF_FETCH_ENABLED: 'false',
      CLOUDFLARE_API_TOKEN: 'synthetic-loopback-token',
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_BASE_URL: api,
    },
  });
  const output = collectServerOutput(child);
  try {
    const [status] = await once(child, 'close', { signal: AbortSignal.timeout(40_000) });
    expect(status, output()).toBe(1);
    return output();
  } finally {
    await killChild(child);
  }
}

function readJson(root: string, path: string) {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
}

it('reuses a committed KV create after the first deploy loses its reply and the project moves', async () => {
  const parent = createPackageFixtureDir(packageRoot, 'cloudflare-seed-');
  roots.push(parent);
  const original = project(parent, 'first-worker');
  const copy = project(parent, 'relocated');
  const route =
    "import { kv } from 'void/kv'; export const GET = async () => new Response(await kv.get('key'));";
  for (const root of [original, copy]) {
    writeFileSync(join(root, 'routes/index.ts'), route);
  }

  await withProvider(async (api, requests, titles) => {
    const output = await deploy(original, api);
    expect(output.replaceAll(/\s+/g, ' ')).toContain(
      'Created void.config.ts. Commit it, the .gitignore change, and void.lock.json when present.',
    );
    expect(output).toContain('provisioning failed');
    expect(readConfig(original)).toEqual({
      cloudflare: { name: 'first-worker' },
      worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE },
    });
    expect(readFileSync(join(original, '.gitignore'), 'utf8').split(/\r?\n/)).toContain(
      '.void-wrangler.jsonc',
    );
    expect(readJson(original, 'void.lock.json').resolved).toMatchObject({
      account_id: account,
      migrations,
    });
    expect(readJson(original, 'void.lock.json').resolved).not.toHaveProperty('kv_namespaces');
    expect(existsSync(join(original, 'wrangler.jsonc'))).toBe(false);

    for (const name of ['void.config.ts', 'void.lock.json', '.gitignore']) {
      cpSync(join(original, name), join(copy, name));
    }
    expect(await deploy(copy, api)).toContain(
      'Could not verify existing Cloudflare Worker "first-worker"',
    );
    expect(titles).toEqual(['first-worker-kv']);
    expect(requests).toContain(
      `GET /client/v4/accounts/${account}/workers/scripts/first-worker/deployments`,
    );
    const expected = {
      name: 'first-worker',
      account_id: account,
      kv_namespaces: [{ binding: 'KV', id: kvId }],
      migrations,
    };
    expect(readJson(copy, 'void.lock.json').resolved).toMatchObject(expected);
    expect(readGeneratedDeployConfig(copy).config).toMatchObject(expected);
  });
});

it('migrates an authored Wrangler config before deploying its Worker', async () => {
  const parent = createPackageFixtureDir(packageRoot, 'cloudflare-migrate-');
  roots.push(parent);
  const root = project(parent, 'authored');
  const cloudflare = {
    name: 'legacy-worker',
    account_id: account,
    compatibility_date: LATEST_KNOWN_COMPAT_DATE,
    vars: { LEGACY: 'preserved' },
    durable_objects: {
      bindings: [
        { name: 'COUNTER', class_name: 'CounterDurableObject' },
        { name: 'ChatWs', class_name: 'ChatWs' },
      ],
    },
    migrations,
  };
  const original = `// Authored configuration\n${JSON.stringify(cloudflare, null, 2)}\n`;
  writeFileSync(join(root, 'wrangler.jsonc'), original);

  await withProvider(async (api, requests) => {
    const output = await deploy(root, api);
    expect(output).toContain('Migrated project configuration to void.config.ts');
    expect(output).toContain('Could not verify existing Cloudflare Worker "legacy-worker"');
    expect(requests).toEqual([
      `GET /client/v4/accounts/${account}/workers/scripts/legacy-worker/deployments`,
    ]);
    expect(readFileSync(join(root, '.void/config-migration/wrangler.jsonc'), 'utf8')).toBe(
      original,
    );
    expect(existsSync(join(root, 'wrangler.jsonc'))).toBe(false);
    expect(readConfig(root).cloudflare).toEqual(cloudflare);
    expect(readJson(root, 'void.lock.json').resolved).toMatchObject(cloudflare);
    expect(readGeneratedDeployConfig(root).config).toMatchObject(cloudflare);
  });
});

it.each([
  ['void.lock.json', '{"preserve":"me"}\n'],
  ['.void-wrangler.jsonc', '{"preserve":"me"}\n'],
  [
    '.void/cloudflare-candidate.json',
    JSON.stringify({
      accountId: account,
      workerName: 'previous-worker',
      parentVersionId: 'previous-version',
      versionIds: ['candidate-version'],
    }),
  ],
])('stops before provisioning when only %s exists', async (file, contents) => {
  const parent = createPackageFixtureDir(packageRoot, 'cloudflare-orphan-');
  roots.push(parent);
  const root = project(parent, 'orphan');
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);

  await withProvider(async (api, requests) => {
    expect(await deploy(root, api)).toContain(
      'Restore void.config.ts from version control or a backup.',
    );
    expect(requests).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(contents);
    expect(existsSync(join(root, 'void.config.ts'))).toBe(false);
  });
});

it('uses the managed fallback only while the seed from a failed deploy is unchanged', async () => {
  const parent = createPackageFixtureDir(packageRoot, 'cloudflare-account-failure-');
  roots.push(parent);
  const root = project(parent, 'account-failure');
  rmSync(join(root, 'routes/chat.ws.ts'));
  rmSync(join(root, 'durable-objects'), { recursive: true });

  await withProvider(async (api, requests) => {
    expect(await deploy(root, api, { accountId: '' })).toContain(
      'Cloudflare authentication is required',
    );
    expect(readConfig(root).cloudflare?.name).toBe('account-failure');
    expect(existsSync(join(root, 'void.lock.json'))).toBe(false);
    const calls = requests.length;
    const configPath = join(root, 'void.config.ts');
    const source = readFileSync(configPath, 'utf8').replaceAll('\n', '\r\n');
    writeFileSync(configPath, source);
    expect(await deploy(root, api, { args: ['deploy'] })).toContain('platform: No connection to');

    writeFileSync(configPath, source.replace('"account-failure"', '"existing-worker"'));
    expect(await deploy(root, api, { args: ['deploy'] })).toContain(
      'without a deployment destination',
    );
    expect(requests).toHaveLength(calls);
  });
});
