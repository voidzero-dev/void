import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { getMiniflareDatabasePath, openSqliteDatabase } from '../../src/migrations/runner.ts';
import {
  buildPrerenderBindings,
  collectPrerenderPaths,
  collectPrerenderPathsNode,
  collectPrerenderWorkerModules,
  writeDefaultNotFoundPage,
} from '../../src/prerender.ts';
import { INTERNAL_ENV_KEYS, stripInternalEnvKeys } from '../../src/shared/env.ts';

const tempDirs: Array<string> = [];

function createTempWorkerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'void-prerender-'));
  tempDirs.push(dir);
  return dir;
}

describe('static 404 page', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a self-contained default page', () => {
    const clientDir = join(createTempWorkerDir(), 'client');
    writeDefaultNotFoundPage(clientDir);
    const html = readFileSync(join(clientDir, '404.html'), 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('404');
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"|<script[^>]+src=/);
  });

  it('preserves a custom page', () => {
    const clientDir = createTempWorkerDir();
    const html = '<h1>Custom not found page</h1>';
    writeFileSync(join(clientDir, '404.html'), html);
    writeDefaultNotFoundPage(clientDir);
    expect(readFileSync(join(clientDir, '404.html'), 'utf8')).toBe(html);
  });
});

describe('stripInternalEnvKeys', () => {
  it.each([undefined, {}])('returns empty sanitized + empty stripped for %j', (input) => {
    const result = stripInternalEnvKeys(input);
    expect(result.sanitized).toEqual({});
    expect(result.stripped).toEqual([]);
  });

  it('passes through non-internal keys unchanged', () => {
    const result = stripInternalEnvKeys({ API_URL: 'https://api', FOO: 'bar' });
    expect(result.sanitized).toEqual({ API_URL: 'https://api', FOO: 'bar' });
    expect(result.stripped).toEqual([]);
  });

  it('strips every internal key listed in INTERNAL_ENV_KEYS', () => {
    const polluted: Record<string, string> = { SAFE: 'keep' };
    for (const key of INTERNAL_ENV_KEYS) {
      polluted[key] = 'polluted';
    }
    const result = stripInternalEnvKeys(polluted);
    expect(result.sanitized).toEqual({ SAFE: 'keep' });
    expect(result.stripped.sort()).toEqual([...INTERNAL_ENV_KEYS].sort());
  });

  it('preserves non-internal keys when mixed with internal keys', () => {
    const result = stripInternalEnvKeys({
      __VOID_TOKEN: 'polluted',
      API_URL: 'https://api',
      __VOID_REMOTE: '1',
      FOO: 'bar',
    });
    expect(result.sanitized).toEqual({ API_URL: 'https://api', FOO: 'bar' });
    expect(result.stripped.sort()).toEqual(['__VOID_REMOTE', '__VOID_TOKEN']);
  });
});

describe('collectPrerenderWorkerModules', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('collects supported modules and keeps the entry first', () => {
    const workerDir = createTempWorkerDir();

    mkdirSync(join(workerDir, '.vite'), { recursive: true });
    mkdirSync(join(workerDir, 'assets'), { recursive: true });

    writeFileSync(join(workerDir, 'wrangler.json'), '{}');
    writeFileSync(join(workerDir, '.vite', 'manifest.json'), '{}');
    writeFileSync(join(workerDir, 'index.js'), 'export default {};');
    writeFileSync(join(workerDir, 'pages-client.js'), 'export const client = true;');
    writeFileSync(join(workerDir, 'assets', 'chunk.js'), 'export const chunk = true;');
    writeFileSync(join(workerDir, 'assets', 'legacy.cjs'), 'module.exports = {};');
    writeFileSync(join(workerDir, 'assets', 'module.wasm'), 'wasm');
    writeFileSync(join(workerDir, 'assets', 'message.txt'), 'hello');
    writeFileSync(join(workerDir, 'assets', 'blob.bin'), 'data');

    const modules = collectPrerenderWorkerModules(workerDir, 'index.js');

    expect(
      modules.map(({ path, type }) => ({
        path: toSlash(relative(workerDir, path)),
        type,
      })),
    ).toEqual([
      { path: 'index.js', type: 'ESModule' },
      { path: 'assets/blob.bin', type: 'Data' },
      { path: 'assets/chunk.js', type: 'ESModule' },
      { path: 'assets/legacy.cjs', type: 'CommonJS' },
      { path: 'assets/message.txt', type: 'Text' },
      { path: 'assets/module.wasm', type: 'CompiledWasm' },
      { path: 'pages-client.js', type: 'ESModule' },
    ]);
  });

  it('throws when the configured worker entry is missing', () => {
    const workerDir = createTempWorkerDir();
    writeFileSync(join(workerDir, 'pages-client.js'), 'export const client = true;');

    expect(() => collectPrerenderWorkerModules(workerDir, 'index.js')).toThrow(
      "Worker entry 'index.js' not found",
    );
  });
});

describe('collectPrerenderPathsNode', () => {
  it('scrubs orchestrator credentials and ignores production dotenv before importing the built app', async () => {
    const root = createTempWorkerDir();
    const ssrDir = join(root, 'dist', 'ssr');
    mkdirSync(ssrDir, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, '.env.production'), 'PUBLIC_VALUE=visible\n');
    writeFileSync(
      join(ssrDir, 'app.js'),
      `
const sensitive = [
  'VOID_TOKEN',
  'DATABASE_URL',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCESS_CLIENT_SECRET',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
];
export default {
  fetch(request, env) {
    if (env?.__VOID_PRERENDER !== '1') return new Response('Not Found', { status: 404 });
    const paths = process.env.PUBLIC_VALUE === 'visible' ? ['/safe'] : ['/safe-missing'];
    if (sensitive.some((name) => process.env[name])) paths.push('/credential-leaked');
    return Response.json({ paths });
  },
};
`,
    );
    const previous = new Map<string, string | undefined>();
    for (const name of [
      'VOID_TOKEN',
      'DATABASE_URL',
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCESS_CLIENT_SECRET',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    ]) {
      previous.set(name, process.env[name]);
      process.env[name] = `secret-${name}`;
    }
    try {
      await expect(collectPrerenderPathsNode({ root, ssrDir })).resolves.toEqual(['/safe-missing']);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('collectPrerenderPaths (Cloudflare target)', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  // The dev server (`@cloudflare/vite-plugin`, `persistState: { path: '.void' }`
  // -> `<root>/.void/v3`), the local migration runner, the drizzle plugin and the
  // auth bootstrap all address the local D1 file through
  // `getMiniflareDatabasePath(join(root, '.void'), id)`. Prerender boots the built
  // worker in its own Miniflare and MUST open that same file, otherwise a page that
  // reads a migrated table renders against an empty database. This test seeds a
  // table exactly where the runner writes it and asks the real bundled Miniflare
  // (resolved through wrangler like prerender.ts does) to read it back.
  it('opens the D1 database the local migration runner wrote', async () => {
    const root = createTempWorkerDir();
    const persistDir = join(root, '.void');
    const workerDir = join(root, 'dist', 'ssr');
    mkdirSync(workerDir, { recursive: true });

    const dbPath = getMiniflareDatabasePath(persistDir, 'local');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = await openSqliteDatabase(dbPath);
    try {
      db.exec('CREATE TABLE pages (path TEXT NOT NULL)');
      db.prepare('INSERT INTO pages (path) VALUES (?)').run('/from-migrated-db');
    } finally {
      db.close();
    }

    writeFileSync(
      join(workerDir, 'wrangler.json'),
      JSON.stringify({
        main: 'index.js',
        compatibility_date: '2026-02-12',
        d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
      }),
    );
    writeFileSync(
      join(workerDir, 'index.js'),
      `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/__void/prerender-paths' || env.__VOID_PRERENDER !== '1') {
      return new Response('Not Found', { status: 404 });
    }
    const { results } = await env.DB.prepare('SELECT path FROM pages ORDER BY path').all();
    return Response.json({ paths: results.map((row) => row.path) });
  },
};
`,
    );

    await expect(collectPrerenderPaths({ root, workerDir, persistDir })).resolves.toEqual([
      '/from-migrated-db',
    ]);
  }, 60_000);
});

describe('buildPrerenderBindings', () => {
  it('passes only the selected proxy Access credentials to the local Worker', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      voidToken: 'human',
      voidProjectId: 'project',
      voidProxyUrl: 'https://proxy.example.com',
      remoteMode: true,
      accessEnv: {
        VOID_ACCESS_CREDENTIALS: JSON.stringify({
          'https://proxy.example.com': { CF_ACCESS_TOKEN: 'proxy-proof' },
          'https://api.example.com': { CF_ACCESS_TOKEN: 'api-proof' },
        }),
      },
    });
    expect(JSON.parse(result.__VOID_ACCESS_CREDENTIALS as string)).toEqual({
      'https://proxy.example.com': { CF_ACCESS_TOKEN: 'proxy-proof' },
    });
    expect(JSON.stringify(result)).not.toContain('api-proof');
  });

  it.each([
    { voidToken: null, voidProjectId: 'proj', remoteMode: false },
    { voidToken: 'tkn', voidProjectId: undefined, remoteMode: false },
    { voidToken: null, voidProjectId: undefined, remoteMode: false },
    { voidToken: null, voidProjectId: undefined, remoteMode: true },
  ])('omits __VOID_* bindings without both token and projectId (%j)', (credentials) => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      voidProxyUrl: 'https://proxy.example.test',
      ...credentials,
    });

    expect(result).toStrictEqual({});
  });

  it('sets credentials and the selected proxy URL when token+projectId are present', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      voidToken: 'tkn',
      voidProjectId: 'proj',
      voidProxyUrl: 'https://proxy.example.test',
      remoteMode: false,
    });

    expect(result.__VOID_TOKEN).toBe('tkn');
    expect(result.__VOID_PROJECT_ID).toBe('proj');
    expect(result.__VOID_PROXY_URL).toBe('https://proxy.example.test');
    expect(result).not.toHaveProperty('__VOID_STAGING');
    expect(result).not.toHaveProperty('__VOID_REMOTE');
  });

  it('requires a selected proxy before binding credentials', () => {
    expect(() =>
      buildPrerenderBindings({
        wranglerVars: {},
        voidToken: 'token',
        voidProjectId: 'project',
        remoteMode: true,
      }),
    ).toThrow('No connected platform proxy');
  });

  it('sets __VOID_REMOTE when remote mode is enabled', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {},
      voidToken: 'tkn',
      voidProjectId: 'proj',
      voidProxyUrl: 'https://proxy.example.test',
      remoteMode: true,
    });

    expect(result.__VOID_REMOTE).toBe('1');
  });

  it('keeps user wranglerVars and strips internal keys when credentials are absent', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {
        __VOID_TOKEN: 'polluted-token',
        __VOID_PROJECT_ID: 'polluted-project',
        API_URL: 'https://api.example.com',
      },
      voidToken: null,
      voidProjectId: undefined,
      remoteMode: false,
    });

    expect(result).toStrictEqual({ API_URL: 'https://api.example.com' });
  });

  it('still strips polluted __VOID_* even when real credentials are present', () => {
    const result = buildPrerenderBindings({
      wranglerVars: {
        __VOID_TOKEN: 'wv-poll',
        __VOID_PROXY_TOKEN: 'poll',
        __VOID_PROXY_URL: 'https://evil.example.com',
      },
      voidToken: 'real',
      voidProjectId: 'proj',
      voidProxyUrl: 'https://proxy.example.test',
      remoteMode: false,
    });

    expect(result.__VOID_TOKEN).toBe('real');
    expect(result.__VOID_PROJECT_ID).toBe('proj');
    expect(result.__VOID_PROXY_URL).toBe('https://proxy.example.test');
    expect(result).not.toHaveProperty('__VOID_PROXY_TOKEN');
  });
});
