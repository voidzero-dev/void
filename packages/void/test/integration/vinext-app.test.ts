import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const PLAYGROUND = 'playground/vinext-app';
let DEV_BASE: string;

describe('playground/vinext-app dev', () => {
  let child: ReturnType<typeof spawn>;
  let playground: IsolatedPlayground;

  beforeAll(async () => {
    playground = createIsolatedPlayground(ROOT, PLAYGROUND);
    const server = await startServer((port) => {
      child = spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: playground.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          VOID_INSPECTOR_PORT: 'false',
        },
      });
      return child;
    }, 30_000);
    DEV_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    playground?.cleanup();
  });

  it('applies env.ts to server routes', async () => {
    const response = await fetch(`${DEV_BASE}/api/env`);
    expect(await response.json()).toEqual({ SCHEMA_DEFAULT: 48213 });
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('vinext App Router + Void');
  });

  it('smoke route exercises D1 and KV', async () => {
    const response = await fetch(`${DEV_BASE}/smoke`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Alice');
    expect(html).toContain('ok');
  });
});

describe('playground/vinext-app build', () => {
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

  it.each([
    { fixture: PLAYGROUND, order: 'voidPlugin(), vinext()', middleware: true },
    { fixture: PLAYGROUND, order: 'vinext(), voidPlugin()', middleware: false },
    { fixture: 'playground/vinext-pages', order: 'voidPlugin(), vinext()', middleware: true },
    { fixture: 'playground/vinext-pages', order: 'vinext(), voidPlugin()', middleware: false },
  ])(
    'builds $fixture with plugins [$order] (middleware: $middleware)',
    async ({ fixture, order, middleware }) => {
      const playground = createIsolatedPlayground(ROOT, fixture);
      playgrounds.push(playground);
      mkdirSync(join(playground.root, 'public/reports'), { recursive: true });
      for (const name of ['allowed', 'hidden', 'forbidden', 'redirect']) {
        writeFileSync(join(playground.root, `public/reports/${name}.txt`), 'private report');
      }
      if (middleware) {
        writeFileSync(
          join(playground.root, 'middleware.ts'),
          `
import { NextResponse } from 'next/server';
export function middleware(request: Request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/hidden.txt')) return new Response('Hidden', { status: 404 });
  if (path.endsWith('/forbidden.txt')) return new Response('Forbidden', { status: 403 });
  if (path.endsWith('/redirect.txt')) return NextResponse.redirect(new URL('/login', request.url));
  const response = NextResponse.next();
  response.headers.set('X-Middleware', 'ran');
  return response;
}
export const config = { matcher: ['/reports/:path*'] };
`,
        );
      }
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

      // A worker whose entry is vinext's bare RSC handler (a function default
      // export) never reaches Void's wrapper and cannot serve requests.
      const serverDir = join(playground.root, 'dist', fixture === PLAYGROUND ? 'server' : 'ssr');
      const config = JSON.parse(readFileSync(join(serverDir, 'wrangler.json'), 'utf8'));
      if (middleware) {
        expect(config.assets.binding).toBe('ASSETS');
        expect(config.assets.run_worker_first).toEqual(['/*']);
      } else {
        expect(config.assets.run_worker_first).toBeUndefined();
      }
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
          assets: {
            directory: join(playground.root, 'dist/client'),
            binding: config.assets.binding,
            run_worker_first: config.assets.run_worker_first,
            routerConfig: { has_user_worker: true },
            assetConfig: { not_found_handling: 'none' },
          },
        }),
      );
      const response = await runtime.dispatchFetch('http://localhost/');
      const html = await response.text();
      expect(response.status, html.slice(0, 500)).toBe(200);
      expect(html).toContain(
        fixture === PLAYGROUND ? 'vinext App Router + Void' : 'vinext Pages Router + Void',
      );
      for (const method of ['GET', 'HEAD']) {
        for (const [name, status] of [
          ['hidden', 404],
          ['forbidden', 403],
          ['redirect', 307],
        ] as const) {
          const denied = await runtime.dispatchFetch(`http://localhost/reports/${name}.txt`, {
            method,
            redirect: 'manual',
          });
          expect(denied.status, `${method} ${name}`).toBe(middleware ? status : 200);
          if (middleware) {
            expect(await denied.text()).not.toContain('private report');
          }
        }
        const allowed = await runtime.dispatchFetch('http://localhost/reports/allowed.txt', {
          method,
        });
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get('X-Middleware')).toBe(middleware ? 'ran' : null);
        expect(await allowed.text()).toBe(method === 'HEAD' ? '' : 'private report');
      }
    },
    180_000,
  );
});
