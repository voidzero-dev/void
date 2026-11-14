import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { toSlash } from 'pathslash';
import { createServer, normalizePath, type Plugin, type ResolvedConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { bundleEntry } from '../../src/cli/wrapper.ts';
import {
  getOriginalFrameworkEntry,
  hasVinextMiddleware,
} from '../../src/plugin-framework-entry.ts';
import { frameworkTriggersDispatchPath } from '../../src/plugin-framework-triggers.ts';

vi.mock('../../src/plugin-cloudflare.ts', () => import('../helpers/cloudflare-vite-plugin.ts'));

const roots: Array<string> = [];

function createTanStackRoot(voidConfig?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'void-class-a-wrapper-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      dependencies: {
        '@tanstack/react-start': '^1.168.19',
      },
    }),
  );
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' }, ...voidConfig }),
  );
  return root;
}

/** The generated wrappers import Void's runtime env module by package name, as an app does. */
function linkVoidPackage(root: string): void {
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(
    join(import.meta.dirname, '..', '..'),
    join(root, 'node_modules', 'void'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

function callConfigResolved(plugin: Plugin, config: Partial<ResolvedConfig>) {
  const hook = plugin.configResolved;
  const fn = typeof hook === 'function' ? hook : hook?.handler;
  if (typeof fn !== 'function') {
    throw new Error('configResolved not callable');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (fn as any)(config);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe('Class A framework custom entry', () => {
  it.each([
    'middleware.ts',
    'src/middleware.js',
    'proxy.ts',
    'src/proxy.custom.ts',
    'Middleware.ts',
    'src/Proxy.ts',
  ])('detects vinext convention file %s without importing application code', (file) => {
    const root = createTanStackRoot();
    expect(hasVinextMiddleware(root)).toBe(false);
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), 'throw new Error("must not execute during config");');
    expect(hasVinextMiddleware(root)).toBe(true);
  });

  it.each(['serve', 'build'] as const)(
    'preserves a custom TanStack Worker entry and named exports during %s',
    async (command) => {
      const root = createTanStackRoot({ cloudflare: { main: './server.mjs' } });
      writeFileSync(
        join(root, 'server.mjs'),
        'export class Counter {}\n' +
          'export const marker = "custom entry";\n' +
          'export default { fetch() { return new Response(marker); }, scheduled() { return "scheduled"; } };\n',
      );
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      const { voidPlugin } = await import('../../src/index.ts');
      const plugins = voidPlugin();
      if (command === 'build') {
        const wrapperPlugin = plugins.find(
          (plugin) => plugin.name === 'void:framework-build-wrapper',
        );
        if (!wrapperPlugin) {
          throw new Error('Expected Class A wrapper plugin.');
        }
        callConfigResolved(wrapperPlugin, {
          command,
          build: { assetsDir: 'assets' } as ResolvedConfig['build'],
        });
      }
      const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        optimizeDeps: { noDiscovery: true },
        // No watcher: macOS can report server.mjs, written just before startup, as
        // changed, and the reload would give the second import a new Counter.
        server: { middlewareMode: true, ws: false, watch: null, preTransformRequests: false },
      });
      try {
        const wrapped = await server.ssrLoadModule(
          join(root, '.void/tanstack-start-trigger-wrapper.ts'),
        );
        const original = await server.ssrLoadModule(join(root, 'server.mjs'));
        const response = await wrapped.default.fetch(new Request('https://example.test/'), {}, {});
        expect(await response.text()).toBe('custom entry');
        expect(wrapped.Counter).toBe(original.Counter);
        expect(wrapped.marker).toBe('custom entry');
        expect(wrapped.default.scheduled()).toBe('scheduled');
      } finally {
        await server.close();
      }
    },
  );

  it('keeps the default TanStack server entry when no custom entry is configured', () => {
    expect(getOriginalFrameworkEntry('tanstack-start', createTanStackRoot())).toBe(
      '@tanstack/react-start/server-entry',
    );
  });

  it.each(['@tanstack/react-start/server-entry', '@tanstack/react-start/server-entry.js'])(
    'keeps the default TanStack server entry for a migrated main of %s',
    (main) => {
      expect(getOriginalFrameworkEntry('tanstack-start', createTanStackRoot(), main)).toBe(
        '@tanstack/react-start/server-entry',
      );
    },
  );

  it.each(['@acme/worker/entry', '@acme/worker/entry.js', 'acme-worker/entry.js'])(
    'leaves the package entry %s for Vite to resolve',
    (main) => {
      expect(getOriginalFrameworkEntry('tanstack-start', createTanStackRoot(), main)).toBe(main);
    },
  );

  it.each(['src/server.ts', 'src/worker.cjs', './src/server', '../shared/server.tsx'])(
    'reads the file entry %s from the app root',
    (main) => {
      const root = createTanStackRoot();
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src/server.ts'), 'export default {};\n');
      writeFileSync(join(root, 'src/worker.cjs'), 'module.exports = {};\n');
      expect(getOriginalFrameworkEntry('tanstack-start', root, main)).toBe(
        toSlash(resolve(root, main)),
      );
    },
  );

  it.each(['', '  ', null, false, 1])('rejects an invalid custom entry %s', (main) => {
    expect(() => getOriginalFrameworkEntry('tanstack-start', createTanStackRoot(), main)).toThrow(
      'cloudflare.main must be a non-empty Worker entry path',
    );
  });

  it('rejects a custom entry that points back to the generated wrapper', () => {
    const root = createTanStackRoot();
    expect(() =>
      getOriginalFrameworkEntry(
        'tanstack-start',
        root,
        './.void/../.void/tanstack-start-trigger-wrapper.ts',
      ),
    ).toThrow("cloudflare.main cannot point to Void's generated framework wrapper");
  });
});

describe('Class A framework build wrapper', () => {
  it.each([
    [undefined, 'none'],
    ['404-page', '404-page'],
  ] as const)(
    'falls through framework 404s to ASSETS with routing.notFound %s',
    async (notFound, expected) => {
      const root = createTanStackRoot(notFound ? { routing: { notFound } } : undefined);
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      const { voidPlugin } = await import('../../src/index.ts');
      const plugins = voidPlugin();
      const wrapperPlugin = plugins.find(
        (plugin) => plugin.name === 'void:framework-build-wrapper',
      );
      if (!wrapperPlugin) {
        throw new Error('Expected Class A wrapper plugin.');
      }

      callConfigResolved(wrapperPlugin, {
        command: 'build',
        build: { assetsDir: 'static' } as ResolvedConfig['build'],
      } as Partial<ResolvedConfig>);

      const code = readFileSync(join(root, '.void', 'tanstack-start-trigger-wrapper.ts'), 'utf-8');
      expect(code).toContain('return serveWithAssets(request, env, await original.fetch');
      expect(code).toContain('import { createAssetFallback as __createAssetFallback }');
      expect(code).toContain(
        `const serveWithAssets = __createAssetFallback({"assetsDir":"static","serveSpaFallback":false,"notFound":"${expected}"});`,
      );
    },
  );
});

describe('Class A framework dev wrapper', () => {
  it('serves an ordinary request without loading a broken cron dependency', async () => {
    const root = createTanStackRoot();
    mkdirSync(join(root, 'crons'), { recursive: true });
    mkdirSync(join(root, 'helpers'), { recursive: true });
    writeFileSync(join(root, 'helpers/explode.ts'), 'throw new Error("cron dependency loaded");');
    writeFileSync(
      join(root, 'crons/tick.ts'),
      'import "../helpers/explode.ts"; export const cron = "* * * * *"; export default async function tick() {}',
    );
    const packageRoot = join(root, 'node_modules/@tanstack/react-start');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ type: 'module', exports: { './server-entry': './server-entry.js' } }),
    );
    writeFileSync(
      join(packageRoot, 'server-entry.js'),
      'export default { fetch: async () => new Response("ordinary page") };',
    );

    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { voidPlugin } = await import('../../src/index.ts');
    voidPlugin();

    const runner = join(root, 'run.mjs');
    writeFileSync(
      runner,
      `import worker from ${JSON.stringify(pathToFileURL(join(root, '.void/tanstack-start-trigger-wrapper.ts')).href)};\n` +
        'const response = await worker.fetch(new Request("https://example.test/"), {}, {});\n' +
        'process.stdout.write(await response.text());\n',
    );
    expect(execFileSync(process.execPath, [runner], { cwd: root, encoding: 'utf8' })).toBe(
      'ordinary page',
    );
  });
});

describe('Class A bare void imports', () => {
  // The package entry is the whole Vite plugin; a cron needs only `defineScheduled` and friends.
  it.each([
    ['ssr', true],
    ['client', false],
  ] as const)(
    'sends bare void in the %s environment to the handler entry: %s',
    async (environment, redirected) => {
      const root = realpathSync.native(createTanStackRoot());
      const installed = join(root, 'node_modules/void');
      mkdirSync(installed, { recursive: true });
      writeFileSync(
        join(installed, 'package.json'),
        JSON.stringify({ name: 'void', type: 'module', exports: { '.': './index.mjs' } }),
      );
      writeFileSync(join(installed, 'index.mjs'), 'export {};\n');
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      const { voidPlugin } = await import('../../src/index.ts');

      const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [voidPlugin()],
        optimizeDeps: { noDiscovery: true },
        server: { middlewareMode: true, ws: false, preTransformRequests: false },
      });
      try {
        const resolved = await server.environments[environment]!.pluginContainer.resolveId(
          'void',
          join(root, 'crons/tick.ts'),
        );

        expect(resolved?.id).toBe(
          normalizePath(
            redirected
              ? createRequire(import.meta.url).resolve('void/handler')
              : join(installed, 'index.mjs'),
          ),
        );
      } finally {
        await server.close();
      }
    },
  );
});

describe('Class A framework request scope', () => {
  /** The dev wrapper, written when the plugin is created, and the build wrapper. */
  async function generateWrappers(root: string): Promise<{ dev: string; build: string }> {
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { voidPlugin } = await import('../../src/index.ts');
    const wrapperPlugin = voidPlugin().find(
      (plugin) => plugin.name === 'void:framework-build-wrapper',
    );
    if (!wrapperPlugin) {
      throw new Error('Expected Class A wrapper plugin.');
    }
    const wrapperPath = join(root, '.void', 'tanstack-start-trigger-wrapper.ts');
    const dev = readFileSync(wrapperPath, 'utf-8');
    callConfigResolved(wrapperPlugin, {
      command: 'build',
      build: { assetsDir: 'assets' } as ResolvedConfig['build'],
    } as Partial<ResolvedConfig>);
    const build = readFileSync(wrapperPath, 'utf-8');
    // The asset fallback helper that ends the build wrapper is covered above.
    return { dev, build: build.slice(0, build.indexOf('import { createAssetFallback')) };
  }

  // A request scope would move D1 reads from the primary to a replica-capable session.
  it.each([
    ['without a database', undefined],
    ['with D1', 'export {};\n'],
  ])('keeps the framework fetch unscoped for an app %s', async (_name, schema) => {
    const root = createTanStackRoot();
    if (schema) {
      mkdirSync(join(root, 'db'));
      writeFileSync(join(root, 'db/schema.ts'), schema);
    }

    const { dev, build } = await generateWrappers(root);

    expect(dev).toBe(`// @ts-nocheck — Auto-generated by Void in dev. Do NOT edit.
import original from "@tanstack/react-start/server-entry";
export * from "@tanstack/react-start/server-entry";

export default {
  ...original,
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/__void/scheduled" || pathname === "/__void/queue") {
        const { handleDevTrigger } = await import(${JSON.stringify(frameworkTriggersDispatchPath(root))});
        const response = await handleDevTrigger(request, env, ctx);
        if (response) return response;
      }
    }
    return original.fetch(request, env, ctx);
  },
};
`);
    expect(build).toBe(`// @ts-nocheck — Auto-generated by Void for vite build. Do NOT edit.
import original from "@tanstack/react-start/server-entry";
export * from "@tanstack/react-start/server-entry";

export default {
  ...original,
  async fetch(request, env, ctx) {
    return serveWithAssets(request, env, await original.fetch(request, env, ctx));
  },
};
`);
  });

  it.each(['pg', 'mysql'])(
    'runs the framework fetch in the request scope with %s',
    async (database) => {
      const root = createTanStackRoot({ database });

      const { dev, build } = await generateWrappers(root);

      expect(dev).toBe(`// @ts-nocheck — Auto-generated by Void in dev. Do NOT edit.
import original from "@tanstack/react-start/server-entry";
export * from "@tanstack/react-start/server-entry";
import { withRuntimeEnv } from "void/_env";

export default {
  ...original,
  fetch(request, env, ctx) {
    return withRuntimeEnv(env, async () => {
      if (request.method === "POST") {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/__void/scheduled" || pathname === "/__void/queue") {
          const { handleDevTrigger } = await import(${JSON.stringify(frameworkTriggersDispatchPath(root))});
          const response = await handleDevTrigger(request, env, ctx);
          if (response) return response;
        }
      }
      return original.fetch(request, env, ctx);
    });
  },
};
`);
      expect(build).toBe(`// @ts-nocheck — Auto-generated by Void for vite build. Do NOT edit.
import original from "@tanstack/react-start/server-entry";
export * from "@tanstack/react-start/server-entry";
import { withRuntimeEnv } from "void/_env";

export default {
  ...original,
  fetch(request, env, ctx) {
    return withRuntimeEnv(env, async () => {
      return serveWithAssets(request, env, await original.fetch(request, env, ctx));
    });
  },
};
`);
    },
  );

  it.each(['pg', 'mysql'])(
    'runs each dev request inside its own Void request scope with %s',
    async (database) => {
      const root = createTanStackRoot({ database });
      const packageRoot = join(root, 'node_modules/@tanstack/react-start');
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({ type: 'module', exports: { './server-entry': './server-entry.js' } }),
      );
      // void/db keeps its PostgreSQL/MySQL client in this request resource.
      writeFileSync(
        join(packageRoot, 'server-entry.js'),
        'import { getRuntimeRequestResource } from "void/_env";\n' +
          'const key = {};\n' +
          'let created = 0;\n' +
          'export default { async fetch() {\n' +
          '  const first = getRuntimeRequestResource(key, () => ++created);\n' +
          '  await new Promise((resolve) => setTimeout(resolve, 0));\n' +
          '  const second = getRuntimeRequestResource(key, () => ++created);\n' +
          '  return Response.json([first, second]);\n' +
          '} };\n',
      );
      linkVoidPackage(root);

      vi.spyOn(process, 'cwd').mockReturnValue(root);
      const { voidPlugin } = await import('../../src/index.ts');
      voidPlugin();

      const runner = join(root, 'run.mjs');
      writeFileSync(
        runner,
        `import worker from ${JSON.stringify(pathToFileURL(join(root, '.void/tanstack-start-trigger-wrapper.ts')).href)};\n` +
          'const env = {};\n' +
          'const responses = await Promise.all([1, 2].map(() => worker.fetch(new Request("https://example.test/"), env, {})));\n' +
          'process.stdout.write(JSON.stringify(await Promise.all(responses.map((response) => response.json()))));\n',
      );
      expect(
        JSON.parse(execFileSync(process.execPath, [runner], { cwd: root, encoding: 'utf8' })),
      ).toEqual([
        [1, 1],
        [2, 2],
      ]);
    },
  );
});

describe('Class A framework env schema', () => {
  const ENV_TS = `import { defineEnv, number, string } from 'void/env';

// An async validator, like zod's async refine.
const upper = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: async (value) =>
      typeof value === 'string'
        ? { value: value.toUpperCase() }
        : { issues: [{ message: 'TOKEN must be a string' }] },
  },
};

export default defineEnv({
  STRIPE_KEY: string(),
  SCHEMA_DEFAULT: number().default(48213),
  TOKEN: upper,
});
`;

  /** A TanStack app with env.ts, and its wrappers for dev and build. */
  async function createApp(voidConfig?: Record<string, unknown>) {
    const root = createTanStackRoot(voidConfig);
    writeFileSync(join(root, 'env.ts'), ENV_TS);
    linkVoidPackage(root);
    const packageRoot = join(root, 'node_modules/@tanstack/react-start');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ type: 'module', exports: { './server-entry': './server-entry.js' } }),
    );
    // Each path names the env key that the request reads.
    writeFileSync(
      join(packageRoot, 'server-entry.js'),
      'import { env } from "void/env";\n' +
        'export default { async fetch(request) {\n' +
        '  const key = new URL(request.url).pathname.slice(1);\n' +
        '  if (!key) return new Response("ok");\n' +
        '  try { return Response.json({ [key]: env[key] }); }\n' +
        '  catch (error) { return new Response(error.message, { status: 500 }); }\n' +
        '} };\n',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const { voidPlugin } = await import('../../src/index.ts');
    const wrapperPlugin = voidPlugin().find(
      (plugin) => plugin.name === 'void:framework-build-wrapper',
    )!;
    const wrapperPath = join(root, '.void', 'tanstack-start-trigger-wrapper.ts');
    const dev = readFileSync(wrapperPath, 'utf-8');
    callConfigResolved(wrapperPlugin, {
      command: 'build',
      build: { assetsDir: 'assets' } as ResolvedConfig['build'],
    } as Partial<ResolvedConfig>);
    return { root, wrapperPath, dev, build: readFileSync(wrapperPath, 'utf-8') };
  }

  const MISSING_VALUES = [
    { path: '/', expected: '200 ok' },
    { path: '/SCHEMA_DEFAULT', expected: '200 {"SCHEMA_DEFAULT":48213}' },
    { path: '/STRIPE_KEY', expected: expect.stringMatching(/^500 Invalid env "STRIPE_KEY"/) },
    { path: '/TOKEN', expected: '500 Invalid env "TOKEN": TOKEN must be a string' },
  ];
  const VALID_ENV = { STRIPE_KEY: 'sk_test', TOKEN: 'sk_token' };
  const VALID_VALUES = [
    { path: '/STRIPE_KEY', expected: '200 {"STRIPE_KEY":"sk_test"}' },
    { path: '/TOKEN', expected: '200 {"TOKEN":"SK_TOKEN"}' },
    { path: '/TOKEN', expected: '200 {"TOKEN":"SK_TOKEN"}' },
  ];

  /**
   * The wrappers import env.ts and the routing runtime by absolute path, which Vite resolves.
   * Node reads a Windows path (`C:/…` or `C:\…`) as a URL with the scheme `c:` and rejects it
   * with ERR_UNSUPPORTED_ESM_URL_SCHEME, so the runner gives Node a file URL for it.
   */
  const WINDOWS_PATH_HOOK = String.raw`import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
registerHooks({
  resolve(specifier, context, nextResolve) {
    const windowsPath = /^[A-Za-z]:[\\/]/.test(specifier);
    return nextResolve(windowsPath ? pathToFileURL(specifier).href : specifier, context);
  },
});
`;

  /** Answer each request in a Node process, with a new env object for each, as dev can. */
  function fetchInNode(
    root: string,
    wrapper: string,
    requests: Array<{ path: string; env?: Record<string, string> }>,
  ): Array<string> {
    const path = join(root, '.void', 'run-wrapper.ts');
    writeFileSync(path, wrapper);
    const runner = join(root, 'run.mjs');
    writeFileSync(
      runner,
      WINDOWS_PATH_HOOK +
        `const { default: worker } = await import(${JSON.stringify(pathToFileURL(path).href)});\n` +
        'const results = [];\n' +
        `for (const { path, env } of ${JSON.stringify(requests)}) {\n` +
        '  const response = await worker.fetch(new Request("https://example.test" + path), { ...env }, {});\n' +
        '  results.push(response.status + " " + (await response.text()));\n' +
        '}\n' +
        'process.stdout.write(JSON.stringify(results));\n',
    );
    return JSON.parse(execFileSync(process.execPath, [runner], { cwd: root, encoding: 'utf8' }));
  }

  /** Bundle a wrapper for workerd and answer each request there, with `bindings` as its env. */
  async function fetchInWorkerd(
    root: string,
    wrapperPath: string,
    bindings: Record<string, string>,
    paths: Array<string>,
  ): Promise<Array<string>> {
    const { outputDir, entryFilename } = await bundleEntry(root, wrapperPath);
    const modules = readdirSync(outputDir)
      .filter((file) => /\.m?js$/.test(file))
      .sort((a, b) => Number(b === entryFilename) - Number(a === entryFilename))
      .map((file) => ({ type: 'ESModule' as const, path: join(outputDir, file) }));
    // A D1 framework Worker has `nodejs_als`, and no `nodejs_compat`.
    const miniflare = new Miniflare(
      convertV4MiniflareOptions({
        modulesRoot: outputDir,
        modules,
        compatibilityDate: '2026-02-24',
        compatibilityFlags: ['nodejs_als'],
        bindings,
      }),
    );
    try {
      const results: Array<string> = [];
      for (const path of paths) {
        const response = await miniflare.dispatchFetch(`https://example.test${path}`);
        results.push(`${response.status} ${await response.text()}`);
      }
      return results;
    } finally {
      await miniflare.dispose();
    }
  }

  it('imports env.ts ahead of the framework entry and prepares the env on every request', async () => {
    const { root, dev, build } = await createApp();
    const imports = `import ${JSON.stringify(toSlash(join(root, 'env.ts')))};
import { _prepareEnv } from "void/env";
import original from "@tanstack/react-start/server-entry";
export * from "@tanstack/react-start/server-entry";
`;
    expect(dev).toBe(`// @ts-nocheck — Auto-generated by Void in dev. Do NOT edit.
${imports}
export default {
  ...original,
  async fetch(request, env, ctx) {
    await _prepareEnv(env);
    if (request.method === "POST") {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/__void/scheduled" || pathname === "/__void/queue") {
        const { handleDevTrigger } = await import(${JSON.stringify(frameworkTriggersDispatchPath(root))});
        const response = await handleDevTrigger(request, env, ctx);
        if (response) return response;
      }
    }
    return original.fetch(request, env, ctx);
  },
};
`);
    expect(build).toContain(`// @ts-nocheck — Auto-generated by Void for vite build. Do NOT edit.
${imports}
export default {
  ...original,
  async fetch(request, env, ctx) {
    await _prepareEnv(env);
    return serveWithAssets(request, env, await original.fetch(request, env, ctx));
  },
};
`);
  });

  // Reads in Node need a request scope, which a PostgreSQL app's wrapper opens.
  it.each(['dev', 'build'] as const)(
    'serves env.ts values in the PostgreSQL %s wrapper and fails only the requests that read an invalid one',
    async (mode) => {
      const app = await createApp({ database: 'pg' });
      const requests = [
        ...MISSING_VALUES,
        ...VALID_VALUES.map((request) => ({ ...request, env: VALID_ENV })),
      ];
      expect(fetchInNode(app.root, app[mode], requests)).toEqual(
        requests.map(({ expected }) => expected),
      );
    },
  );

  // A D1 app's framework fetch runs outside a request scope, so its reads use the
  // `cloudflare:workers` env rather than the env object that the wrapper prepared.
  it('serves env.ts values to a D1 app built for workerd', async () => {
    const app = await createApp();
    expect(
      await fetchInWorkerd(
        app.root,
        app.wrapperPath,
        {},
        MISSING_VALUES.map(({ path }) => path),
      ),
    ).toEqual(MISSING_VALUES.map(({ expected }) => expected));
    expect(
      await fetchInWorkerd(
        app.root,
        app.wrapperPath,
        VALID_ENV,
        VALID_VALUES.map(({ path }) => path),
      ),
    ).toEqual(VALID_VALUES.map(({ expected }) => expected));
  });
});

describe('Class A routing.notFound self-host warning', () => {
  /** Run a Class A `build` twice and return every line the plugin logged. */
  async function buildTwiceWithNotFound(): Promise<Array<string>> {
    const root = createTanStackRoot({ routing: { notFound: '404-page' } });
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { voidPlugin } = await import('../../src/index.ts');
    const wrapperPlugin = voidPlugin().find(
      (plugin) => plugin.name === 'void:framework-build-wrapper',
    );
    if (!wrapperPlugin) {
      throw new Error('Expected Class A wrapper plugin.');
    }
    const resolved = {
      command: 'build',
      build: { assetsDir: 'static' } as ResolvedConfig['build'],
    } as Partial<ResolvedConfig>;
    // Twice on purpose: at most one warning per build, however many times the
    // hook runs (the Cloudflare plugin resolves config per environment).
    callConfigResolved(wrapperPlugin, resolved);
    callConfigResolved(wrapperPlugin, resolved);

    return logSpy.mock.calls.map((args) => args.join(' '));
  }

  function notFoundWarnings(lines: Array<string>): Array<string> {
    return lines.filter((line) => line.includes('"routing.notFound" in void.config.ts'));
  }

  it('warns once that a self-hosted build generates no policy for routing.notFound', async () => {
    const warnings = notFoundWarnings(await buildTwiceWithNotFound());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('tanstack-start');
    expect(warnings[0]).toContain('direct Cloudflare deployment');
    expect(warnings[0]).toContain('void deploy');
    for (const field of ['binding', 'directory', 'not_found_handling', 'run_worker_first']) {
      expect(warnings[0]).toContain(field);
    }
  });

  it('stays quiet when a managed `void deploy` drives the build', async () => {
    vi.stubEnv('VOID_DEPLOY_BUILD', '1');
    expect(notFoundWarnings(await buildTwiceWithNotFound())).toEqual([]);
  });

  it('says nothing when routing.notFound is unset', async () => {
    const root = createTanStackRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { voidPlugin } = await import('../../src/index.ts');
    const wrapperPlugin = voidPlugin().find(
      (plugin) => plugin.name === 'void:framework-build-wrapper',
    );
    if (!wrapperPlugin) {
      throw new Error('Expected Class A wrapper plugin.');
    }
    callConfigResolved(wrapperPlugin, {
      command: 'build',
      build: { assetsDir: 'static' } as ResolvedConfig['build'],
    } as Partial<ResolvedConfig>);

    expect(notFoundWarnings(logSpy.mock.calls.map((args) => args.join(' ')))).toEqual([]);
  });
});
