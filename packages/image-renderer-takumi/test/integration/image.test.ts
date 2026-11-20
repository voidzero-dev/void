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
import { collectPrerenderWorkerModules } from '../../../void/src/prerender.ts';
import { fontVariant } from '../fixtures/font-variants.ts';

const repository = join(import.meta.dirname, '..', '..', '..', '..');
const CACHE_HEADER = null;
// Vitest sets NODE_ENV=test, which would make Vite build in development mode.
const { NODE_ENV: _nodeEnv, ...userEnv } = process.env;

it('has Bun available in CI', () => {
  if (process.env.CI) {
    expect(spawn.sync('bun', ['--version']).status).toBe(0);
  }
});

it('publishes renderer-independent image declarations without React imports', () => {
  const declarations = readFileSync(
    join(repository, 'packages/void/dist/runtime/image/index.d.mts'),
    'utf8',
  );
  expect(declarations).not.toMatch(
    /from ["'](?:@void\/image-renderer-takumi|takumi-js|react)(?:\/|["'])/,
  );
  for (const name of ['ImageFont', 'ImageInput']) {
    expect(declarations).toMatch(new RegExp(`\\b${name}\\b`));
  }
});

const IMAGE_ROUTE = `import { html } from 'void/html';
import { jsx } from 'void/jsx';
import { ImageResponse, renderImage, type ImageResponseOptions } from 'void/image';
import { takumiRenderer } from '@void/image-renderer-takumi';
export const GET = async (c) => {
  const content = html\`<div style="display:flex;width:100%;height:100%;background:#111;color:#fff">\${Promise.resolve('Hello Привет Ελληνικά Łódź <img src="https://example.com/injected.png">')}</div>\`;
  const options = { width: 320, height: 168, renderer: [takumiRenderer, { fallbackFonts: false }], font: c.req.query('font') === 'Geist' ? 'Geist' : 'Roboto' } satisfies ImageResponseOptions<typeof takumiRenderer>;
  if (c.req.query('render') === 'async') {
    try {
      const input = c.req.query('fail')
        ? jsx(() => { throw new Error('render failed'); }, {})
        : content;
      return new Response(await renderImage(input, options), { headers: { 'Content-Type': 'image/png' } });
    } catch {
      return new Response('render failed', { status: 503 });
    }
  }
  return new ImageResponse(content, options);
};
`;
// A .tsx route, as the guide shows.
const CARD_ROUTE = `/** @jsxImportSource void/jsx */
import { ImageResponse } from 'void/image';
import { takumiRenderer } from '@void/image-renderer-takumi';
function Card({ title }: { title: string }) {
  return <div style={{ display: 'flex', width: '100%', height: '100%', fontSize: 64 }}>{title}</div>;
}
export const GET = () => new ImageResponse(<Card title="Hello from JSX" />, { width: 320, height: 168, renderer: takumiRenderer });
`;

// Miniflare types its own Response, without Cloudflare's `cf`.
type Runtime = {
  dispatchFetch(input: string, init?: RequestInit): Promise<Response>;
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
  const needsImage = Object.values(files).some((source) =>
    source.includes('@void/image-renderer-takumi'),
  );
  const packages = {
    'vite-plus': 'node_modules/vite-plus',
    void: 'packages/void',
    ...(needsImage ? { '@void/image-renderer-takumi': 'packages/image-renderer-takumi' } : {}),
    ...links,
  };
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
      dependencies: {
        ...(needsImage ? { '@void/image-renderer-takumi': 'workspace:*' } : {}),
        void: 'workspace:*',
      },
    }),
    'vite.config.ts': `import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';
export default defineConfig({ oxc: { jsx: { runtime: 'automatic' } }, plugins: [voidPlugin()] });
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

function typecheckApp(root: string) {
  return spawn.sync(
    join(repository, 'packages/image-renderer-takumi/node_modules/.bin/tsc'),
    ['-p', 'tsconfig.json', '--listFiles'],
    { cwd: root, encoding: 'utf8', timeout: 30_000 },
  );
}

function builtRuntime(root: string) {
  const output = join(root, 'dist/ssr');
  const config = JSON.parse(readFileSync(join(output, 'wrangler.json'), 'utf8'));
  const modules = collectPrerenderWorkerModules(output, config.main);
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags,
      modules,
      modulesRoot: output,
    }),
  ) as unknown as Runtime;
  return { runtime, modules };
}

async function renderBuilt(root: string, path: string, cacheControl: string | null) {
  const { runtime, modules } = builtRuntime(root);
  try {
    expect(modules.filter((module) => module.type === 'CompiledWasm')).toHaveLength(1);
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

async function expectImage(response: Response, cacheControl: string | null) {
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

async function expectFontSelection(
  request: (query: string) => Promise<Response>,
  cacheControl: string | null = CACHE_HEADER,
) {
  const roboto = await expectImage(await request(''), cacheControl);
  const geist = await expectImage(await request('?font=Geist'), cacheControl);
  expect(roboto).not.toEqual(geist);
  expect(await expectImage(await request(''), cacheControl)).toEqual(roboto);
  expect(await expectImage(await request('?render=async'), cacheControl)).toEqual(roboto);
  const failed = await request('?render=async&fail=1');
  expect(failed.status).toBe(503);
  expect(await failed.text()).toBe('render failed');
}

function builtFiles(root: string): Array<string> {
  return readdirSync(join(root, 'dist/ssr'), { recursive: true }).map(String);
}

afterAll(() => {
  for (const root of fixtures) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

it('bounds same-family font churn in a warm workerd renderer without changing pixels', async () => {
  const rendererSource = join(
    repository,
    'packages/image-renderer-takumi/src/image-renderer.ts',
  ).replaceAll('\\', '/');
  const root = createApp(
    {
      'routes/cache.ts': `
import { render } from 'takumi-js';
import { withImageRenderer } from ${JSON.stringify(rendererSource)};
export const POST = async (c) => {
  const data = new Uint8Array(await c.req.raw.arrayBuffer());
  return withImageRenderer(async (renderer) => {
    const bytes = await render(
      { type: 'text', text: 'A Ω', style: { fontFamily: 'Churn', fontSize: 24 } },
      {
        width: 120, height: 48, renderer,
        fonts: [{ name: 'Churn', key: c.req.query('sequence'), data: () => data }],
      },
    );
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const stats = renderer.cacheStats();
    return Response.json({ hash, bytes: stats.memory.current, evictions: stats.fonts.evictions });
  });
};
`,
    },
    { 'takumi-js': 'packages/image-renderer-takumi/node_modules/takumi-js' },
  );
  build(root);
  const { runtime } = builtRuntime(root);
  try {
    let first: string | undefined;
    let previousEvictions = 0;
    for (let index = 0; index < 48; index++) {
      const response = await runtime.dispatchFetch(`http://localhost/cache?sequence=${index}`, {
        method: 'POST',
        body: fontVariant(index),
      });
      expect(response.status, response.ok ? undefined : await response.text()).toBe(200);
      const sample = (await response.json()) as { hash: string; bytes: number; evictions: number };
      first ??= sample.hash;
      expect(sample.hash).toBe(first);
      expect(sample.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      if (index === 23 || index === 47) {
        expect(sample.evictions).toBeGreaterThan(previousEvictions);
        previousEvictions = sample.evictions;
      }
    }
  } finally {
    await runtime.dispose();
  }
});

it('typechecks a public image consumer without loading renderer or React declarations', () => {
  const root = createApp(
    {
      'input.ts': `import { ImageResponse, OgImageResponse, renderImage, renderOgImage, type BrowserRunFontData, type ImageFont, type ImageInput, type OgImageResponseOptions, type RenderOgImageOptions } from 'void/image';
import { jsx } from 'void/jsx';
import { html } from 'void/html';
const node = jsx('div', null, 'Hello');
const font: ImageFont<'Brand', BrowserRunFontData> = { name: 'Brand', data: new Uint8Array(), weight: 400 };
const inputs: ImageInput[] = [node, html\`<div>Hello</div>\`];
for (const input of inputs) {
  new ImageResponse(input, { width: 320, height: 168, fonts: [font] });
  new OgImageResponse(input);
  new Response(await renderImage(input, { width: 320, height: 168 }));
  new Response(await renderOgImage(input));
}
const renderOptions: RenderOgImageOptions = { width: 1200, height: 600 };
new Response(await renderOgImage(node, renderOptions));
new Response(await renderOgImage(node, { width: 600 }));
new Response(await renderOgImage(node, { height: 600 }));
const responseOptions: OgImageResponseOptions = { ...renderOptions, status: 201, headers: { 'x-image': 'card' } };
new OgImageResponse(node, responseOptions);
// @ts-expect-error Set dimensions explicitly instead of using a social preset.
renderOgImage(node, { preset: 'x' });
// @ts-expect-error Set dimensions explicitly instead of using a social preset.
new OgImageResponse(node, { preset: 'x' });
// @ts-expect-error HTTP options belong to the response wrapper.
renderOgImage(node, { headers: {} });
// @ts-expect-error HTTP options belong to the response wrapper.
renderImage(node, { width: 320, height: 168, status: 200 });
`,
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'DOM'],
          types: [],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        files: ['input.ts'],
      }),
    },
    {},
  );
  const result = typecheckApp(root);
  expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
  const files = result.stdout.replaceAll('\\', '/');
  expect(files).not.toMatch(/node_modules\/(?:@types\/react|takumi-js|@takumi-rs)\//);
});

it('typechecks Hono TSX, including async components, with Takumi but without React', () => {
  const root = createApp(
    {
      'input.tsx': `
import { ImageResponse, type ImageInput } from 'void/image';
import { takumiRenderer } from '@void/image-renderer-takumi';
const normal = <div style={{ display: 'flex', color: 'white', fontSize: 24 }}>Hello</div>;
async function Title({ title }: { title: string }) { return <span>{title}</span>; }
const inputs: ImageInput[] = [normal, <Title title="Function" />];
for (const input of inputs) new ImageResponse(input, { renderer: takumiRenderer, width: 320, height: 168 });
`,
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          jsx: 'react-jsx',
          jsxImportSource: 'void/jsx',
          lib: ['ES2022', 'DOM'],
          types: [],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        files: ['input.tsx'],
      }),
    },
    {},
  );
  const result = typecheckApp(root);
  expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
  expect(result.stdout.replaceAll('\\', '/')).not.toMatch(
    /\/(?:@types\/react|react|takumi-js|@takumi-rs)\//,
  );
});

describe('Takumi via void/image in a Cloudflare app', () => {
  let root: string;
  beforeAll(() => {
    root = createApp(
      {
        'routes/api/image.ts': IMAGE_ROUTE,
        'routes/api/card.tsx': CARD_ROUTE,
      },
      {},
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
      await expectFontSelection((query) => fetch(`${server.base}/api/image${query}`), 'no-store');
      await expectImage(await fetch(`${server.base}/api/card`), 'no-store');
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

describe('Takumi via void/image in a Cloudflare app without React', () => {
  it('renders HTML in the built Worker', async () => {
    // Takumi's JSX helper imports React as an optional peer; the HTML route needs none.
    const root = createApp({ 'routes/api/image.ts': IMAGE_ROUTE }, {});
    build(root);
    await renderBuilt(root, '/api/image', CACHE_HEADER);
  });
});

describe.each(['cloudflare', 'node'] as const)(
  'a %s app with void/html but without image generation',
  (target) => {
    it('bundles no image renderer for escaped HTML', async () => {
      const root = createApp(
        {
          'routes/api/hello.ts': `import { defineHandler } from 'void';
import { html, raw } from 'void/html';
export const GET = defineHandler(async (c) => c.html(await html\`<h1>\${Promise.resolve('<Hello>')}</h1>\${raw('<strong>Trusted</strong>')}\`));
`,
        },
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
      if (target === 'node') {
        return;
      }
      const { runtime } = builtRuntime(root);
      try {
        const response = await runtime.dispatchFetch('http://localhost/api/hello');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/^text\/html;/);
        expect(await response.text()).toBe('<h1>&lt;Hello&gt;</h1><strong>Trusted</strong>');
      } finally {
        await runtime.dispose();
      }
    });
  },
);

describe.each(['node', 'bun', 'deno'] as const)(
  'Takumi via void/image on the %s target',
  (target) => {
    let child: ReturnType<typeof spawn> | undefined;
    afterAll(async () => {
      if (child) {
        await killChild(child);
      }
    });

    it.skipIf(spawn.sync(target, ['--version']).status !== 0)(
      'renders installed WASM without app-installed Takumi, even after moving the output',
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
        expect(builtFiles(root).filter((file) => file.endsWith('.wasm'))).toHaveLength(0);
        expect(code).not.toContain('@takumi-rs/core');
        expect(code).not.toMatch(/^import .* from ["']takumi-js/m);
        expect(code).toContain('@void/image-renderer-takumi');
        const relocated = mkdtempSync(join(tmpdir(), 'void-image-output-'));
        fixtures.push(relocated);
        cpSync(join(root, 'dist'), join(relocated, 'dist'), { recursive: true });
        // Install the image package with its own transitive dependencies, not app-owned Takumi.
        mkdirSync(join(relocated, 'node_modules/@void'), { recursive: true });
        symlinkSync(
          realpathSync(join(repository, 'packages/image-renderer-takumi')),
          join(relocated, 'node_modules/@void/image-renderer-takumi'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
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
            dependencies: {
              hono: '*',
              '@hono/node-server': '*',
              '@void/image-renderer-takumi': '*',
            },
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
        await expectImage(await fetch(`${server.base}/api/image`), 'no-store');
        const response = await fetch(`${server.base}/api/renderer`);
        expect(response.status, server.output()).toBe(200);
        expect(await response.text()).toBe('app-owned');
      },
    );
  },
);
