import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { collectWorkerFiles } from '../../src/cli/package.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/vinext-pages';
let DEV_BASE: string;

/** The response surface shared by `fetch` and Miniflare's `dispatchFetch`. */
type Fetch = (path: string) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/**
 * The playground's `middleware.ts` and `next.config.mjs` each add a redirect, a
 * rewrite and a response header. They run only when the worker goes through vinext's own
 * Pages Router request pipeline.
 */
function expectNextRequestPipeline(fetchPath: Fetch) {
  return Promise.all([
    ...['/', '/middleware-rewrite', '/config-rewrite'].map(async (path) => {
      const response = await fetchPath(path);
      const html = await response.text();
      expect(response.status, `${path}: ${html.slice(0, 500)}`).toBe(200);
      expect(html, path).toContain('vinext Pages Router + Void');
      expect(response.headers.get('x-void-middleware'), path).toBe('1');
      expect(response.headers.get('x-void-config'), path).toBe('1');
    }),
    ...['/middleware-redirect', '/config-redirect'].map(async (path) => {
      const response = await fetchPath(path);
      expect(response.status, path).toBe(307);
      expect(new URL(response.headers.get('location')!, 'http://localhost').pathname).toBe('/');
    }),
  ]);
}

describe('playground/vinext-pages dev', () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    const server = await startServer((port) => {
      child = spawn(
        'vp',
        [
          'run',
          '--filter',
          `./${PLAYGROUND}`,
          'dev',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--strictPort',
        ],
        {
          cwd: ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            VOID_INSPECTOR_PORT: 'false',
          },
        },
      );
      return child;
    }, 20_000);
    DEV_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('vinext Pages Router + Void');
  });

  it('smoke route exercises D1 and KV', async () => {
    const response = await fetch(`${DEV_BASE}/smoke`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Alice');
    expect(html).toContain('ok');
  });

  it('runs middleware and next.config redirects, rewrites and headers', async () => {
    await expectNextRequestPipeline((path) => fetch(`${DEV_BASE}${path}`, { redirect: 'manual' }));
  });
});

describe('playground/vinext-pages build', () => {
  const playgrounds: Array<IsolatedPlayground> = [];
  let runtime: Miniflare | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
  });

  afterAll(() => {
    for (const playground of playgrounds.splice(0)) {
      playground.cleanup();
    }
  });

  it.each([['voidPlugin(), vinext()'], ['vinext(), voidPlugin()']])(
    'builds a worker that runs the Next.js request pipeline with plugins [%s]',
    async (order) => {
      const playground = createIsolatedPlayground(ROOT, PLAYGROUND);
      playgrounds.push(playground);
      writeFileSync(
        join(playground.root, 'vite.config.ts'),
        `import vinext from 'vinext';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [${order}],
});
`,
      );
      const result = await new Promise<{ status: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn('vp', ['build'], {
            cwd: playground.root,
            env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let output = '';
          child.stdout!.on('data', (chunk: Buffer) => (output += String(chunk)));
          child.stderr!.on('data', (chunk: Buffer) => (output += String(chunk)));
          child.on('error', reject);
          child.on('close', (status) => resolve({ status, output }));
        },
      );
      expect(result.status, result.output).toBe(0);

      const serverDir = join(playground.root, 'dist', 'ssr');
      const config = JSON.parse(readFileSync(join(serverDir, 'wrangler.json'), 'utf8'));
      const files = collectWorkerFiles(serverDir);
      const modulePaths = [
        config.main,
        ...Array.from(files.keys()).filter((path) => path !== config.main),
      ];
      runtime = new Miniflare(
        convertV4MiniflareOptions({
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          modules: modulePaths
            .filter((path) => /\.(?:js|mjs)$/.test(path))
            .map((path) => ({
              type: 'ESModule',
              path: join(serverDir, path),
              contents: files.get(path)!,
            })),
          modulesRoot: serverDir,
          d1Databases: ['DB'],
          kvNamespaces: ['KV'],
        }),
      );
      await expectNextRequestPipeline((path) =>
        runtime!.dispatchFetch(`http://localhost${path}`, { redirect: 'manual' }),
      );
    },
    180_000,
  );
});
