import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
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
import { toSlash } from 'pathslash';
import { createServer, normalizePath, type Plugin, type ResolvedConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getOriginalFrameworkEntry } from '../../src/plugin-framework-entry.ts';
import { frameworkTriggersDispatchPath } from '../../src/plugin-framework-triggers.ts';

vi.mock('@cloudflare/vite-plugin', () => import('../helpers/cloudflare-vite-plugin.ts'));

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
        server: { middlewareMode: true, ws: false, preTransformRequests: false },
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
