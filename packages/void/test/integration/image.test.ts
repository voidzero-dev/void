import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import spawn from 'cross-spawn';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { killChild, startServer, waitForServer } from '../../../../test/integration-helpers.ts';
import { collectPrerenderWorkerModules } from '../../src/prerender.ts';

const repository = join(import.meta.dirname, '..', '..', '..', '..');
const CACHE_HEADER = 'public, max-age=0, must-revalidate';
// Vitest sets NODE_ENV=test, which would make Vite build in development mode.
const { NODE_ENV: _nodeEnv, ...userEnv } = process.env;

const IMAGE_ROUTE = `import { ImageResponse } from 'void/image';
export const GET = (c) => new ImageResponse('<div style="display:flex;width:100%;height:100%;background:#111;color:#fff">Hello Привет Ελληνικά Łódź</div>', { width: 320, height: 168, fallbackFonts: false, defaultFont: c.req.query('font') === 'Geist' ? 'Geist' : 'Inter' });
`;
// A .tsx route, as the guide shows.
const CARD_ROUTE = `import { ImageResponse } from 'void/image';
function Card({ title }: { title: string }) {
  return <div style={{ display: 'flex', width: '100%', height: '100%', fontSize: 64 }}>{title}</div>;
}
export const GET = () => new ImageResponse(<Card title="Hello from JSX" />, { width: 320, height: 168 });
`;

// Miniflare types its own Response, without Cloudflare's `cf`.
type Runtime = {
  dispatchFetch(input: string): Promise<Response>;
  dispose(): Promise<void>;
};

const fixtures: Array<string> = [];

/** An app inside the workspace, so Vite serves the linked packages, outside its package globs. */
function createApp(
  files: Record<string, string>,
  links: Record<string, string>,
  config = `{ cloudflare: { name: 'image-fixture', compatibility_date: '2026-07-01' } }`,
): string {
  const parent = join(repository, 'playground-local', '.test-fixtures');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'test-image-'));
  fixtures.push(root);
  const packages = { 'vite-plus': 'node_modules/vite-plus', void: 'packages/void', ...links };
  for (const [name, source] of Object.entries(packages)) {
    mkdirSync(dirname(join(root, 'node_modules', name)), { recursive: true });
    symlinkSync(
      realpathSync(join(repository, source)),
      join(root, 'node_modules', name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  const all: Record<string, string> = {
    'package.json': JSON.stringify({
      name: `image-${root.slice(-6)}`,
      private: true,
      type: 'module',
    }),
    'vite.config.ts': `import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';
export default defineConfig({ plugins: [voidPlugin()] });
`,
    'void.config.ts': `export default ${config};\n`,
    ...files,
  };
  for (const [path, source] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

function runBuild(root: string) {
  return spawn.sync('vp', ['build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...userEnv, VOID_INSPECTOR_PORT: 'false' },
  });
}

function build(root: string) {
  const result = runBuild(root);
  expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
}

async function renderBuilt(root: string, path: string, cacheControl: string) {
  const output = join(root, 'dist/ssr');
  const config = JSON.parse(readFileSync(join(output, 'wrangler.json'), 'utf8'));
  const modules = collectPrerenderWorkerModules(output, config.main);
  expect(modules.filter((module) => module.type === 'CompiledWasm')).toHaveLength(1);
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      modules,
      modulesRoot: output,
    }),
  ) as unknown as Runtime;
  try {
    if (path === '/api/image') {
      await expectFontSelection((query) =>
        runtime.dispatchFetch(`http://localhost${path}${query}`),
      );
    } else {
      await expectImage(await runtime.dispatchFetch(`http://localhost${path}`), cacheControl);
    }
  } finally {
    await runtime.dispose();
  }
}

async function expectImage(response: Response, cacheControl: string) {
  expect(response.status, response.ok ? undefined : await response.text()).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('cache-control')).toBe(cacheControl);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect({ width: view.getUint32(16), height: view.getUint32(20) }).toEqual({
    width: 320,
    height: 168,
  });
  return bytes;
}

async function expectFontSelection(request: (query: string) => Promise<Response>) {
  const inter = await expectImage(await request(''), CACHE_HEADER);
  const geist = await expectImage(await request('?font=Geist'), CACHE_HEADER);
  expect(inter).not.toEqual(geist);
  expect(await expectImage(await request(''), CACHE_HEADER)).toEqual(inter);
}

function builtFiles(root: string): Array<string> {
  return readdirSync(join(root, 'dist/ssr'), { recursive: true }).map(String);
}

afterAll(() => {
  for (const root of fixtures) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

describe('void/image in a Cloudflare app', () => {
  let root: string;
  beforeAll(() => {
    root = createApp(
      {
        'routes/api/image.ts': IMAGE_ROUTE,
        'routes/api/card.tsx': CARD_ROUTE,
      },
      { react: 'playground/react-pages/node_modules/react' },
    );
  });

  describe('dev server', () => {
    let child: ReturnType<typeof spawn> | undefined;
    afterAll(async () => {
      if (child) {
        await killChild(child);
      }
    });

    it('renders HTML and JSX in workerd', async () => {
      const server = await startServer((port) => {
        child = spawn(
          'vp',
          ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
          {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...userEnv, VOID_INSPECTOR_PORT: 'false' },
          },
        );
        return child;
      }, 30_000);
      // The first import of takumi-js reloads the optimized dependencies once.
      await waitForServer(`${server.base}/api/image`, 30_000, {
        expectStatus: 200,
        diagnostics: server.output,
      });
      await expectFontSelection((query) => fetch(`${server.base}/api/image${query}`));
      await expectImage(await fetch(`${server.base}/api/card`), CACHE_HEADER);
    });
  });

  describe('build', () => {
    it('renders HTML and JSX in the built Worker', async () => {
      build(root);
      await renderBuilt(root, '/api/image', CACHE_HEADER);
      await renderBuilt(root, '/api/card', CACHE_HEADER);
    });
  });
});

describe('void/image in a Cloudflare app without React', () => {
  it('renders HTML in the built Worker', async () => {
    // Takumi's JSX helper imports React as an optional peer; the HTML route needs none.
    const root = createApp({ 'routes/api/image.ts': IMAGE_ROUTE }, {});
    build(root);
    await renderBuilt(root, '/api/image', CACHE_HEADER);
  });
});

describe.each(['cloudflare', 'node'] as const)('a %s app without void/image', (target) => {
  it('bundles no image renderer', () => {
    const root = createApp(
      { 'routes/api/hello.ts': "export const GET = () => 'hello';\n" },
      {},
      `{ target: '${target}', cloudflare: { name: 'no-image', compatibility_date: '2026-07-01' } }`,
    );
    build(root);
    const files = builtFiles(root);
    expect(files.filter((file) => file.endsWith('.wasm'))).toEqual([]);
    const code = files
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(join(root, 'dist/ssr', file), 'utf8'))
      .join('\n');
    expect(code).not.toContain('takumi');
  });
});

describe.each(['node', 'bun', 'deno'] as const)('void/image on the %s target', (target) => {
  let child: ReturnType<typeof spawn> | undefined;
  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it.skipIf(spawn.sync(target, ['--version']).status !== 0)(
    'renders bundled WASM without app-installed Takumi, even after moving the output',
    async () => {
      const root = createApp(
        { 'routes/api/image.ts': IMAGE_ROUTE },
        {
          hono: 'packages/void/node_modules/hono',
          '@hono/node-server': 'playground/node-app/node_modules/@hono/node-server',
        },
        `{ target: '${target}' }`,
      );
      build(root);
      expect(builtFiles(root).filter((file) => file.endsWith('.node'))).toEqual([]);
      const code = builtFiles(root)
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFileSync(join(root, 'dist/ssr', file), 'utf8'))
        .join('\n');
      expect(builtFiles(root).filter((file) => file.endsWith('.wasm'))).toHaveLength(1);
      expect(code).not.toContain('@takumi-rs/core');
      expect(code).not.toMatch(/^import .* from ["']takumi-js/m);
      const relocated = mkdtempSync(join(tmpdir(), 'void-image-output-'));
      fixtures.push(relocated);
      cpSync(join(root, 'dist'), join(relocated, 'dist'), { recursive: true });
      // Only HTTP dependencies are external. Neither Void nor Takumi is installed here.
      mkdirSync(join(relocated, 'node_modules/@hono'), { recursive: true });
      symlinkSync(
        realpathSync(join(repository, 'playground/node-app/node_modules/@hono/node-server')),
        join(relocated, 'node_modules/@hono/node-server'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      symlinkSync(
        realpathSync(join(repository, 'packages/void/node_modules/hono')),
        join(relocated, 'node_modules/hono'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      writeFileSync(
        join(relocated, 'package.json'),
        JSON.stringify({
          type: 'module',
          dependencies: { hono: '*', '@hono/node-server': '*' },
        }),
      );
      const server = await startServer((port) => {
        const entry = join(relocated, 'dist/ssr/index.js');
        child = spawn(target, target === 'deno' ? ['run', '--allow-all', entry] : [entry], {
          cwd: repository,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...userEnv, PORT: String(port) },
        });
        return child;
      }, 20_000);
      await expectFontSelection((query) => fetch(`${server.base}/api/image${query}`));
    },
  );

  it.runIf(target === 'node')(
    'keeps an app-owned incompatible Takumi separate in build and dev',
    async () => {
      const root = createApp(
        {
          'routes/api/image.ts': IMAGE_ROUTE,
          'routes/api/renderer.ts':
            "import { renderer } from 'takumi-js'; export const GET = () => renderer;",
          'node_modules/takumi-js/package.json': JSON.stringify({
            name: 'takumi-js',
            version: '3.0.0',
            type: 'module',
            exports: './index.mjs',
          }),
          'node_modules/takumi-js/index.mjs': "export const renderer = 'app-owned';",
        },
        { '@hono/node-server': 'playground/node-app/node_modules/@hono/node-server' },
        `{ target: 'node' }`,
      );
      build(root);
      const code = builtFiles(root)
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFileSync(join(root, 'dist/ssr', file), 'utf8'))
        .join('\n');
      expect(code).toMatch(/^import .* from ["']takumi-js/m);
      if (child) {
        await killChild(child);
      }
      const server = await startServer((port) => {
        child = spawn(
          'vp',
          ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
          {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: userEnv,
          },
        );
        return child;
      }, 30_000);
      await expectImage(await fetch(`${server.base}/api/image`), CACHE_HEADER);
      const response = await fetch(`${server.base}/api/renderer`);
      expect(response.status, server.output()).toBe(200);
      expect(await response.text()).toBe('app-owned');
    },
  );
});
