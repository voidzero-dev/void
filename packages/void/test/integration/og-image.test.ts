import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import spawn from 'cross-spawn';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { killChild, startServer, waitForServer } from '../../../../test/integration-helpers.ts';
import { collectPrerenderWorkerModules } from '../../src/prerender.ts';

const repository = join(import.meta.dirname, '..', '..', '..', '..');
const DEV_HEADER = 'no-cache, no-store';
const BUILD_HEADER = 'public, immutable, no-transform, max-age=31536000';
// Vitest sets NODE_ENV=test, which would make Vite build in development mode.
const { NODE_ENV: _nodeEnv, ...userEnv } = process.env;

const OG_ROUTE = `import { ImageResponse } from 'void/og';
export const GET = () => new ImageResponse('<div style="display:flex;width:100%;height:100%;background:#111;color:#fff">Hello</div>');
`;
const CARD_ROUTE = `import { ImageResponse } from 'void/og';
import { card } from '../../src/card';
export const GET = () => new ImageResponse(card('Hello from JSX'));
`;
const CARD_COMPONENT = `export function card(title: string) {
  return <div style={{ display: 'flex', width: '100%', height: '100%', fontSize: 64 }}>{title}</div>;
}
`;

const fixtures: Array<string> = [];

/** An app inside the workspace, so Vite serves the linked packages, outside its package globs. */
function createApp(
  files: Record<string, string>,
  links: Record<string, string>,
  config = `{ cloudflare: { name: 'og-fixture', compatibility_date: '2026-07-01' } }`,
): string {
  const parent = join(repository, 'playground-local', '.test-fixtures');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'test-og-'));
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
    'package.json': JSON.stringify({ name: `og-${root.slice(-6)}`, private: true, type: 'module' }),
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

function build(root: string) {
  const result = spawn.sync('vp', ['build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...userEnv, VOID_INSPECTOR_PORT: 'false' },
  });
  expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
}

async function expectImage(response: Response, cacheControl: string) {
  expect(response.status, response.ok ? undefined : await response.text()).toBe(200);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('cache-control')).toBe(cacheControl);
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect({ width: view.getUint32(16), height: view.getUint32(20) }).toEqual({
    width: 1200,
    height: 630,
  });
}

function builtFiles(root: string): Array<string> {
  return readdirSync(join(root, 'dist/ssr'), { recursive: true }).map(String);
}

afterAll(() => {
  for (const root of fixtures) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

describe('void/og in a Cloudflare app', () => {
  let root: string;
  beforeAll(() => {
    root = createApp(
      {
        'routes/api/og.ts': OG_ROUTE,
        'routes/api/card.ts': CARD_ROUTE,
        'src/card.tsx': CARD_COMPONENT,
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
      await waitForServer(`${server.base}/api/og`, 30_000, {
        expectStatus: 200,
        diagnostics: server.output,
      });
      await expectImage(await fetch(`${server.base}/api/og`), DEV_HEADER);
      await expectImage(await fetch(`${server.base}/api/card`), DEV_HEADER);
    });
  });

  describe('build', () => {
    let runtime: Miniflare | undefined;
    afterAll(async () => {
      await runtime?.dispose();
    });

    it('renders HTML and JSX in the built Worker', async () => {
      build(root);
      const output = join(root, 'dist/ssr');
      const config = JSON.parse(readFileSync(join(output, 'wrangler.json'), 'utf8'));
      const modules = collectPrerenderWorkerModules(output, config.main);
      expect(modules.filter((module) => module.type === 'CompiledWasm')).toHaveLength(1);
      runtime = new Miniflare(
        convertV4MiniflareOptions({
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          modules,
          modulesRoot: output,
        }),
      );
      await expectImage(await runtime.dispatchFetch('http://localhost/api/og'), BUILD_HEADER);
      await expectImage(await runtime.dispatchFetch('http://localhost/api/card'), BUILD_HEADER);
    });
  });
});

describe('a Cloudflare app without void/og', () => {
  it('bundles no image renderer', () => {
    const root = createApp({ 'routes/api/hello.ts': "export const GET = () => 'hello';\n" }, {});
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

describe('void/og on the Node.js target', () => {
  let child: ReturnType<typeof spawn> | undefined;
  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it("renders with the app's takumi-js", async () => {
    const root = createApp(
      { 'routes/api/og.ts': OG_ROUTE },
      {
        'takumi-js': 'packages/void/node_modules/takumi-js',
        '@hono/node-server': 'playground/node-app/node_modules/@hono/node-server',
      },
      `{ target: 'node' }`,
    );
    build(root);
    expect(builtFiles(root).filter((file) => file.endsWith('.node'))).toEqual([]);
    const server = await startServer((port) => {
      child = spawn('node', ['dist/ssr/index.js'], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...userEnv, PORT: String(port) },
      });
      return child;
    }, 20_000);
    await expectImage(await fetch(`${server.base}/api/og`), BUILD_HEADER);
  });
});
