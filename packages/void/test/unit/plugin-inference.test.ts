import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { LATEST_KNOWN_COMPAT_DATE } from '../../src/cli/wrangler.ts';
import { voidPlugin } from '../../src/index.ts';
import { inferProjectBindings, detectFramework } from '../../src/plugin-inference.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

const tempDirs: Array<string> = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-inference-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function writeCompatConfig(root: string): void {
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
}

describe('inferProjectBindings', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('infers bindings from src/main.ssr.tsx', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'main.ssr.tsx'),
      `
      export async function render(request, env) {
        await env.KV.put("k", "v");
        return new Response("ok");
      }
      `,
    );

    expect(inferProjectBindings(root)).toEqual({
      needsD1: false,
      needsKV: true,
      needsR2: false,
      needsAuth: false,
      needsQueues: false,
      needsAI: false,
      needsSandbox: false,
      needsEmail: false,
      needsLive: false,
    });
  });

  it('filters route-only bindings for the selected environment', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes', 'api'), { recursive: true });
    writeFileSync(
      join(root, 'routes', 'api', 'debug.dev.ts'),
      `
      import { storage } from "void/storage";
      export const GET = async () => Response.json(await storage.list());
      `,
    );
    writeFileSync(
      join(root, 'routes', 'api', 'events.dev.ws.ts'),
      "import { defineLiveStream } from 'void/live';",
    );

    expect(inferProjectBindings(root, undefined, ['routes']).needsR2).toBe(true);
    expect(inferProjectBindings(root, { environment: 'dev' }, ['routes']).needsR2).toBe(true);
    const production = inferProjectBindings(root, { environment: 'prod' }, ['routes']);
    expect(production.needsR2).toBe(false);
    expect(production.needsLive).toBe(false);
  });

  it('keeps bindings from non-route files with environment-like suffixes', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'queues'), { recursive: true });
    writeFileSync(join(root, 'queues', 'sync.dev.ts'), "import { storage } from 'void/storage';");
    writeFileSync(join(root, 'routes', 'helper.dev.tsx'), "import { kv } from 'void/kv';");

    const result = inferProjectBindings(root, { environment: 'prod' });
    expect(result.needsR2).toBe(true);
    expect(result.needsKV).toBe(true);
  });

  it('detects auth from void/client import with auth specifier in src/', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'App.tsx'),
      `
      import { auth } from "void/client";
      export default function App() {
        auth.signIn;
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it('detects auth from framework-specific void/client subpaths in src/', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'App.tsx'),
      `
      import { auth } from "void/client/react";
      export default function App() {
        auth.useSession();
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it('detects live from the documented src/live.ts module', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'live.ts'),
      `
      import { defineLiveStream } from "void/live";
      export const live = defineLiveStream({ id: "app" });
      `,
    );
    writeFileSync(
      join(root, 'routes', 'live.ts'),
      `
      import { defineHandler } from "void";
      import { live } from "../src/live";
      export const GET = defineHandler((c) => live.connect(c));
      export const POST = defineHandler((c) => live.control(c));
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsLive).toBe(true);
  });

  it('infers resources used only by Durable Object modules', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'durable-objects'), { recursive: true });
    writeFileSync(
      join(root, 'durable-objects', 'agent.ts'),
      `
      import { createAi } from 'void/ai';
      import { createStorage } from 'void/storage';
      export function resources(env) { return [createAi(env), createStorage(env.STORAGE)]; }
    `,
    );
    expect(inferProjectBindings(root)).toMatchObject({
      needsAI: true,
      needsR2: true,
      needsSandbox: false,
    });
    expect(inferProjectBindings(root, undefined, ['durable-objects'])).toMatchObject({
      needsAI: true,
      needsR2: true,
    });
  });

  it('detects live from a stream module outside the default directories only when scanned', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(
      join(root, 'lib', 'live.ts'),
      `
      import { defineLiveStream } from "void/live";
      export const live = defineLiveStream({ id: "app" });
      `,
    );
    writeFileSync(
      join(root, 'routes', 'live.ts'),
      `
      import { defineHandler } from "void";
      import { live } from "../lib/live";
      export const GET = defineHandler((c) => live.connect(c));
      `,
    );

    expect(inferProjectBindings(root).needsLive).toBe(false);
    expect(inferProjectBindings(root, undefined, ['routes', 'lib']).needsLive).toBe(true);
  });

  it('detects auth from void/auth import in routes/', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes', 'api'), { recursive: true });
    writeFileSync(
      join(root, 'routes', 'api', 'profile.ts'),
      `
      import { requireAuth } from "void/auth";
      export const GET = (c) => {
        const user = requireAuth(c);
        return { user };
      };
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(true);
  });

  it('does not detect auth from void/client with only fetch', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'App.tsx'),
      `
      import { fetch } from "void/client";
      export default function App() {
        fetch("/api/hello");
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsAuth).toBe(false);
  });

  it('detects bindings from pages/ .server.ts files', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'index.server.ts'),
      `
      import { db } from "void/db";
      export function loader() {
        return db.select().from(users);
      }
      `,
    );

    const result = inferProjectBindings(root);
    expect(result.needsD1).toBe(true);
  });

  it('does not scan src/ twice in framework mode', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'src', 'App.tsx'),
      `
      import { auth } from "void/client";
      `,
    );

    // When scanDirs already includes "src", it should not double-scan
    const result = inferProjectBindings(root, undefined, ['src', 'routes']);
    expect(result.needsAuth).toBe(true);
  });

  it('detects bindings from .astro frontmatter', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'pages', 'smoke.astro'),
      `---
import { db } from "void/db";
import { kv } from "void/kv";
const row = await Astro.locals.runtime.env.DB.prepare("SELECT 1").first();
---
<h1>{row ? "ok" : "none"}</h1>
`,
    );

    const result = inferProjectBindings(root);
    expect(result.needsD1).toBe(true);
    expect(result.needsKV).toBe(true);
  });

  it('ignores env.* references outside Astro frontmatter', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'pages', 'index.astro'),
      `
<script>
  console.log(env.DB);
</script>
`,
    );

    const result = inferProjectBindings(root);
    expect(result.needsD1).toBe(false);
    expect(result.needsKV).toBe(false);
  });
});

describe('detectFramework', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects vinext-pages when no app/ directory', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { vinext: '^0.0.5', react: '^19.0.0' } }),
    );
    const result = detectFramework(root);
    expect(result).toEqual({ name: 'vinext-pages', class: 'a' });
  });

  it('detects vinext-app when app/ directory exists', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'app'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { vinext: '^0.0.5', react: '^19.0.0' } }),
    );
    const result = detectFramework(root);
    expect(result).toEqual({ name: 'vinext-app', class: 'a' });
  });

  it('detects vinext-pages from devDependencies', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ devDependencies: { vinext: '^0.0.5' } }),
    );
    const result = detectFramework(root);
    expect(result).toEqual({ name: 'vinext-pages', class: 'a' });
  });

  it('detects pracht from its Cloudflare adapter', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { '@pracht/adapter-cloudflare': '^0.1.0', '@pracht/core': '^0.1.0' },
        devDependencies: { '@pracht/vite-plugin': '^0.1.0' },
      }),
    );
    expect(detectFramework(root)).toEqual({ name: 'pracht', class: 'c' });
  });

  it('does not detect pracht without its Cloudflare adapter', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { '@pracht/adapter-node': '^0.1.0', '@pracht/core': '^0.1.0' },
        devDependencies: { '@pracht/vite-plugin': '^0.1.0' },
      }),
    );
    expect(detectFramework(root)).toBeUndefined();
  });

  it('lets framework-mode configResolved run without touching websocket TDZ state', () => {
    const root = createTempRoot();
    writeCompatConfig(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { astro: '^5.0.0' } }),
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      const wranglerSyncPlugin = plugins.find((plugin) => plugin.name === 'void:wrangler-sync');
      const configResolved = wranglerSyncPlugin?.configResolved;
      const handler =
        typeof configResolved === 'function' ? configResolved : configResolved?.handler;

      expect(wranglerSyncPlugin).toBeTruthy();
      expect(handler).toBeTypeOf('function');
      expect(() =>
        handler?.call({} as never, { command: 'serve' } as import('vite').ResolvedConfig),
      ).not.toThrow();
    } finally {
      cwd.mockRestore();
    }
  });

  it('does not create void.json during plugin construction', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      voidPlugin();
      expect(existsSync(join(root, 'void.json'))).toBe(false);
    } finally {
      cwd.mockRestore();
    }
  });

  it('pins framework default compatibility before syncing wrangler config', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { astro: '^5.0.0' } }),
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      const compatPlugin = plugins.find((plugin) => plugin.name === 'void:wrangler-compat');
      const config = getHookHandler(compatPlugin?.config) as (
        this: object,
        config: Record<string, never>,
        env: import('vite').ConfigEnv,
      ) => void;

      expect(compatPlugin).toBeTruthy();
      expect(existsSync(join(root, 'void.json'))).toBe(false);

      config.call({}, {}, { command: 'serve', mode: 'development' } as import('vite').ConfigEnv);

      expect(JSON.parse(readFileSync(join(root, 'void.json'), 'utf-8'))).toEqual({
        worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE },
      });
      expect(JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8'))).toMatchObject({
        compatibility_date: LATEST_KNOWN_COMPAT_DATE,
      });
    } finally {
      cwd.mockRestore();
    }
  });

  it('keeps Nuxt SSR WebSockets on their dedicated port', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', dependencies: { nuxt: '^4.0.0' } }),
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      const compatPlugin = plugins.find(
        (plugin) => plugin.name === 'void:nuxt-vite8-websocket-compat',
      );
      const configResolved = getHookHandler(compatPlugin?.configResolved) as (
        config: import('vite').ResolvedConfig,
      ) => void;
      const sharedServer = {};
      const config = {
        build: { ssr: true },
        server: {
          hmr: { port: 24678, server: sharedServer },
          ws: { port: 24678, server: sharedServer },
        },
      } as unknown as import('vite').ResolvedConfig;

      configResolved(config);

      expect(config.server.hmr).toMatchObject({ port: 24678, server: undefined });
      expect(config.server.ws).toMatchObject({ port: 24678, server: undefined });
    } finally {
      cwd.mockRestore();
    }
  });

  it('persists default void.json compatibility during build startup', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      const persistPlugin = plugins.find(
        (plugin) => plugin.name === 'void:wrangler-compat-persist',
      );
      const buildStart = getHookHandler(persistPlugin?.buildStart) as (this: object) => void;

      expect(persistPlugin).toBeTruthy();
      buildStart.call({});
      expect(JSON.parse(readFileSync(join(root, 'void.json'), 'utf-8'))).toEqual({
        worker: { compatibility_date: LATEST_KNOWN_COMPAT_DATE },
      });
    } finally {
      cwd.mockRestore();
    }
  });

  it.each([
    { kind: 'default worker builds', dependencies: undefined, compat: true },
    {
      kind: 'class A frameworks',
      dependencies: { '@tanstack/react-start': '^1.0.0' },
      compat: true,
    },
    { kind: 'class B/C server builds', dependencies: { '@sveltejs/kit': '^2.0.0' }, compat: false },
  ])('externalizes Cloudflare builtins for $kind', ({ dependencies, compat }) => {
    const root = createTempRoot();
    if (compat) {
      writeCompatConfig(root);
    }
    if (dependencies) {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies }));
    }
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      const externalPlugin = plugins.find(
        (plugin) => plugin.name === 'void:cloudflare-builtins-external',
      );
      const config = getHookHandler(externalPlugin?.config) as (
        this: object,
        config: import('vite').UserConfig,
        env: import('vite').ConfigEnv,
      ) => import('vite').UserConfig | void;

      expect(externalPlugin).toBeTruthy();
      const result = config.call({} as never, {}, { command: 'build', mode: 'production' });
      const rootExternal = result?.build?.rollupOptions?.external as Array<unknown>;
      expect(rootExternal).toBeTruthy();
      expect(
        rootExternal.some((value) => value instanceof RegExp && value.test('cloudflare:workers')),
      ).toBe(true);
      expect(result?.environments).toBeUndefined();
    } finally {
      cwd.mockRestore();
    }
  });

  it('fails client builds that import server-only state runtimes', () => {
    const root = createTempRoot();
    writeCompatConfig(root);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      const stubsPlugin = plugins.find((plugin) => plugin.name === 'void:client-stubs');
      const resolveId = getHookHandler(stubsPlugin?.resolveId) as (
        this: { environment?: { name?: string }; error(message: string): never },
        id: string,
      ) => string | undefined;

      expect(stubsPlugin).toBeTruthy();
      expect(() =>
        resolveId.call(
          {
            environment: { name: 'client' },
            error(message: string): never {
              throw new Error(message);
            },
          },
          'void/live',
        ),
      ).toThrow('void/live is server-only');
      expect(() =>
        resolveId.call(
          {
            environment: { name: 'client' },
            error(message: string): never {
              throw new Error(message);
            },
          },
          'void/durable',
        ),
      ).toThrow('void/durable is server-only');
    } finally {
      cwd.mockRestore();
    }
  });

  it('does not add Cloudflare builtin externalization for node targets', () => {
    const root = createTempRoot();
    writeFileSync(join(root, 'void.json'), JSON.stringify({ target: 'node' }));

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const plugins = voidPlugin();
      expect(plugins.some((plugin) => plugin.name === 'void:cloudflare-builtins-external')).toBe(
        false,
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it('wires void/live for explicit Cloudflare targets', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    writeFileSync(join(root, 'void.json'), JSON.stringify({ target: 'cloudflare' }));
    writeFileSync(
      join(root, 'src', 'live.ts'),
      `
      import { defineLiveStream } from "void/live";
      export const live = defineLiveStream({ id: "app" });
      `,
    );
    writeFileSync(
      join(root, 'routes', 'live.ts'),
      `
      import { defineHandler } from "void";
      import { live } from "../src/live";
      export const GET = defineHandler((c) => live.connect(c));
      export const POST = defineHandler((c) => live.control(c));
      `,
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      voidPlugin();
      const entry = readFileSync(join(root, '.void', 'entry.ts'), 'utf-8');
      expect(entry).toContain('VoidLiveStreamDurableObject');
      expect(entry).toContain('export { VoidLiveStreamDurableObject };');
      expect(entry).toContain('__setLiveBindingName("VOID_LIVE");');
    } finally {
      cwd.mockRestore();
    }
  });

  it('exports convention-based typed Durable Objects from the worker entry', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    mkdirSync(join(root, 'durable-objects'), { recursive: true });
    writeFileSync(join(root, 'routes', 'index.ts'), 'export const GET = () => new Response("ok");');
    writeFileSync(
      join(root, 'durable-objects', 'shopping-cart.ts'),
      'export default { class: class ShoppingCart {}, __bind() {} }',
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      voidPlugin();
      const entry = readFileSync(join(root, '.void', 'entry.ts'), 'utf-8');
      expect(entry).toContain('import __voidDurableObject0 from');
      expect(entry).toContain('/durable-objects/shopping-cart.ts');
      expect(entry).toContain('__voidDurableObject0.__bind("SHOPPING_CART")');
      expect(entry).toContain(
        'export const ShoppingCartDurableObject = __voidDurableObject0.class',
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it('rejects typed Durable Object modules in framework adapter mode', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'durable-objects'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@sveltejs/kit': '^2.0.0' } }),
    );
    writeFileSync(
      join(root, 'durable-objects', 'counter.ts'),
      'export default { class: class Counter {}, __bind() {} }',
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      expect(() => voidPlugin()).toThrow(
        'durable-objects/ is currently supported in Void apps only',
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it('rejects void/live on non-Cloudflare targets', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    writeFileSync(join(root, 'void.json'), JSON.stringify({ target: 'node' }));
    writeFileSync(
      join(root, 'routes', 'live.ts'),
      `
      import { defineLiveStream } from "void/live";
      export const live = defineLiveStream({ id: "app" });
      `,
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      expect(() => voidPlugin()).toThrow('void/live requires target: "cloudflare"');
    } finally {
      cwd.mockRestore();
    }
  });

  // Inbound handlers compile through `routingPlugin`, which the framework
  // branches never install. Without this guard the build succeeds and every
  // handler in `email/` is dead code.
  it('rejects an email/ handler directory in framework adapter mode', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@sveltejs/kit': '^2.0.0' } }),
    );
    mkdirSync(join(root, 'email'), { recursive: true });
    writeFileSync(
      join(root, 'email', '_default.ts'),
      `
      import { defineEmail } from "void/email";
      export default defineEmail(async () => {});
      `,
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      expect(() => voidPlugin()).toThrow(
        'email: inbound email handlers are only supported in Void apps',
      );
    } finally {
      cwd.mockRestore();
    }
  });

  // `compileNodeApp` never imports `__emailHandler`, so on `node`/`bun`/`deno`
  // an `email/` directory compiled cleanly into a bundle that could not
  // receive mail. Same shape as the live / sandbox / durable-objects guards
  // in the node-target branch.
  for (const target of ['node', 'bun', 'deno'] as const) {
    it(`rejects an email/ handler directory with target: "${target}"`, () => {
      const root = createTempRoot();
      mkdirSync(join(root, 'routes'), { recursive: true });
      mkdirSync(join(root, 'email'), { recursive: true });
      writeFileSync(join(root, 'void.json'), JSON.stringify({ target }));
      writeFileSync(
        join(root, 'routes', 'index.ts'),
        'export const GET = () => new Response("ok");',
      );
      writeFileSync(
        join(root, 'email', '_default.ts'),
        `
        import { defineEmail } from "void/email";
        export default defineEmail(async () => {});
        `,
      );

      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

      try {
        expect(() => voidPlugin()).toThrow(
          `email: inbound email handlers (email/) require target: "cloudflare". They are not available with target: '${target}'.`,
        );
      } finally {
        cwd.mockRestore();
      }
    });
  }

  it('still builds a non-Cloudflare target without an email/ directory', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'routes'), { recursive: true });
    writeFileSync(join(root, 'void.json'), JSON.stringify({ target: 'node' }));
    writeFileSync(join(root, 'routes', 'index.ts'), 'export const GET = () => new Response("ok");');

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      expect(() => voidPlugin()).not.toThrow();
    } finally {
      cwd.mockRestore();
    }
  });

  // Outbound is a binding, not a compiled export, so it stays supported.
  it('allows sendEmail without an email/ directory in framework adapter mode', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@sveltejs/kit': '^2.0.0' } }),
    );
    writeFileSync(
      join(root, 'src', 'mailer.ts'),
      `
      import { sendEmail } from "void/email";
      export const send = () => sendEmail({ to: "a@b.dev", subject: "x", text: "y" });
      `,
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      expect(() => voidPlugin()).not.toThrow();
    } finally {
      cwd.mockRestore();
    }
  });

  it('rejects void/live in framework adapter mode', () => {
    const root = createTempRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { '@sveltejs/kit': '^2.0.0' } }),
    );
    writeFileSync(
      join(root, 'src', 'live.ts'),
      `
      import { defineLiveStream } from "void/live";
      export const live = defineLiveStream({ id: "app" });
      `,
    );

    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      expect(() => voidPlugin()).toThrow('void/live is currently supported in Void apps only');
    } finally {
      cwd.mockRestore();
    }
  });
});
