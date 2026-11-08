import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { toSlash } from 'pathslash';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import voidNitroModule from '../../src/nitro.ts';
import { db } from '../../src/runtime/db.ts';
import { getRuntimeRequestResource, withRuntimeEnv } from '../../src/runtime/env.ts';

const roots: Array<string> = [];
const envModuleFile = fileURLToPath(import.meta.resolve('#self/_env'));
// The generated MySQL void/db imports mysql2 through Void's drizzle-orm.
const drizzleMysqlFile = fileURLToPath(import.meta.resolve('drizzle-orm/mysql2'));

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  delete (globalThis as { __env__?: unknown }).__env__;
});

function createApp(database: 'pg' | 'mysql' | 'd1', config: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'void-nitro-'));
  roots.push(root);
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ ...config, ...(database !== 'd1' && { database }) }),
  );
  mkdirSync(join(root, 'db'));
  writeFileSync(join(root, 'db', 'schema.ts'), 'export const users = {};\n');
  return root;
}

type NitroOptions = {
  dev: boolean;
  rootDir: string;
  buildDir: string;
  exportConditions: Array<string>;
  plugins: Array<string>;
  virtual: Record<string, string | (() => string | Promise<string>)>;
  rollupConfig: { plugins?: unknown };
  buildPlugins?: Array<unknown>;
  noExternals?: boolean | Array<string | RegExp>;
  cloudflare?: { nodeCompat?: boolean };
  devServer?: { runner?: string };
};

/** Run the module against the options of a Nitro Worker build. */
function setUp(
  root: string,
  options: {
    dev: boolean;
    plugins?: unknown;
    cloudflare?: NitroOptions['cloudflare'];
    devServer?: NitroOptions['devServer'];
    buildPlugins?: Array<unknown>;
    noExternals?: NitroOptions['noExternals'];
  },
): NitroOptions {
  const nitro = {
    options: {
      dev: options.dev,
      rootDir: root,
      buildDir: join(root, '.nitro'),
      exportConditions: ['workerd'],
      plugins: [],
      virtual: {},
      rollupConfig: { plugins: options.plugins },
      ...(options.cloudflare && { cloudflare: options.cloudflare }),
      ...(options.devServer && { devServer: options.devServer }),
      ...(options.buildPlugins && { buildPlugins: options.buildPlugins }),
      ...(options.noExternals !== undefined && { noExternals: options.noExternals }),
    } as NitroOptions,
  };
  voidNitroModule.setup(nitro);
  return nitro.options;
}

type ResolveResult = string | { id: string; external?: boolean } | null | undefined;

// Nitro's Rollup calls the hooks as plain functions, with its plugin context as `this`. Its
// resolver finds a package the way Node does.
const context = {
  async resolve(source: string, importer: string): Promise<{ id: string } | null> {
    if (isAbsolute(source)) {
      return { id: source };
    }
    try {
      return { id: createRequire(importer).resolve(source) };
    } catch {
      return null;
    }
  },
};

function resolve(plugin: Plugin, id: string, importer: string): Promise<ResolveResult> {
  return (plugin.resolveId as (id: string, importer: string) => Promise<ResolveResult>).call(
    context,
    id,
    importer,
  );
}

describe('void/nitro', () => {
  it('prepares SQL drivers and request scope for Nitro 3 workerd development', async () => {
    const root = createApp('mysql');
    const existing = { name: 'existing' };
    const options = setUp(root, {
      dev: true,
      devServer: { runner: 'miniflare' },
      buildPlugins: [existing],
      noExternals: ['app-package'],
    });
    const [plugin, asyncHooks, ...rest] = options.buildPlugins as Array<Plugin>;
    expect(rest).toEqual([existing]);
    expect(plugin?.enforce).toBe('pre');
    expect(options.rollupConfig.plugins).toBeUndefined();
    expect(options.cloudflare?.nodeCompat).toBe(true);
    expect(options.noExternals).toContain('app-package');
    expect(options.noExternals).toContain('drizzle-orm');
    const driver = await resolve(plugin!, 'mysql2', drizzleMysqlFile);
    expect(typeof driver).toBe('string');
    expect(existsSync(driver as string)).toBe(true);
    expect(await resolve(asyncHooks!, 'node:async_hooks', envModuleFile)).toEqual({
      id: 'node:async_hooks',
      external: true,
    });
  });

  it("serves the app's void/db and @schema before Nitro's own plugins", async () => {
    const root = createApp('pg');
    const existing = { name: 'existing' };
    const options = setUp(root, { dev: true, plugins: existing });
    const [plugin, ...rest] = options.rollupConfig.plugins as Array<Plugin>;
    expect(rest).toEqual([existing]);

    const route = join(root, 'server', 'api', 'users.ts');
    const schema = toSlash(join(root, 'db', 'schema.ts'));
    const id = await resolve(plugin!, 'void/db', route);
    const code = (plugin!.load as (id: string) => string | null)(id as string);
    expect(code).toMatch(/drizzle-orm[\\/]+node-postgres/);
    expect(code).toContain(JSON.stringify(schema));
    expect(await resolve(plugin!, '@schema', route)).toEqual({ id: schema });
    // Development runs in Node, which loads the driver itself.
    expect(await resolve(plugin!, 'pg', route)).toBeNull();
  });

  it('serves a workerd build of the driver to a Worker build', async () => {
    const root = createApp('mysql');
    const [plugin, asyncHooks] = setUp(root, { dev: false }).rollupConfig.plugins as Array<Plugin>;
    const route = join(root, 'server', 'api', 'users.ts');

    const driver = await resolve(plugin!, 'mysql2', drizzleMysqlFile);
    expect(typeof driver).toBe('string');
    expect(existsSync(driver as string)).toBe(true);
    expect(readFileSync(driver as string, 'utf8')).toContain('export {');
    // mysql2's promise API comes from the same build.
    const promiseApi = await resolve(plugin!, 'mysql2/promise', drizzleMysqlFile);
    expect(dirname(promiseApi as string)).toBe(dirname(driver as string));
    // The driver and Void's request scope keep workerd's Node modules instead of Nitro's stubs.
    expect(await resolve(plugin!, 'node:net', driver as string)).toEqual({
      id: 'node:net',
      external: true,
    });
    expect(await resolve(asyncHooks!, 'node:async_hooks', envModuleFile)).toEqual({
      id: 'node:async_hooks',
      external: true,
    });
    expect(await resolve(asyncHooks!, 'node:async_hooks', route)).toBeNull();
  });

  it("gives the app's own driver import the app's copy, built for workerd", async () => {
    const root = createApp('mysql');
    // An app that installs its own mysql2, which need not be the version Void's drizzle loads.
    mkdirSync(join(root, 'node_modules', 'mysql2'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'mysql2', 'package.json'),
      JSON.stringify({ name: 'mysql2', version: '3.13.0', main: 'index.js' }),
    );
    writeFileSync(
      join(root, 'node_modules', 'mysql2', 'index.js'),
      "exports.createPool = () => ({});\nexports.appCopy = require('node:util').format('app');\n",
    );
    const [plugin] = setUp(root, { dev: false }).rollupConfig.plugins as Array<Plugin>;

    const appDriver = (await resolve(
      plugin!,
      'mysql2',
      join(root, 'server', 'api', 'raw.ts'),
    )) as string;
    const voidDriver = (await resolve(plugin!, 'mysql2', drizzleMysqlFile)) as string;
    expect(appDriver).not.toBe(voidDriver);
    // Each is named by its native path, as Nitro's Rollup names modules: on Windows, Nitro's
    // lookup of the `global` polyfill that pg imports never ends from a forward-slash name.
    for (const driver of [appDriver, voidDriver]) {
      expect(driver).toBe(fileURLToPath(pathToFileURL(driver)));
    }
    // Each copy exports its own names.
    expect(readFileSync(appDriver, 'utf8')).toMatch(/export \{[^}]*\bappCopy\b/);
    expect(readFileSync(voidDriver, 'utf8')).not.toContain('appCopy');
    for (const driver of [appDriver, voidDriver]) {
      expect(await resolve(plugin!, 'node:util', driver)).toEqual({
        id: 'node:util',
        external: true,
      });
    }
    // An import the bundler cannot resolve stays its error.
    expect(await resolve(plugin!, 'mysql2', join(tmpdir(), 'elsewhere.ts'))).toBeNull();
  });

  it("serves mysql2/promise from the build of the copy's driver", async () => {
    const root = createApp('mysql');
    // Both entries of mysql2 load the same driver modules.
    const copy = join(root, 'node_modules', 'mysql2');
    mkdirSync(join(copy, 'lib'), { recursive: true });
    writeFileSync(
      join(copy, 'package.json'),
      JSON.stringify({
        name: 'mysql2',
        version: '3.13.0',
        main: 'index.js',
        exports: {
          '.': './index.js',
          './package.json': './package.json',
          './promise': './promise.js',
        },
      }),
    );
    writeFileSync(join(copy, 'lib', 'state.js'), 'module.exports = { parsers: new Map() };\n');
    writeFileSync(join(copy, 'index.js'), "exports.state = require('./lib/state.js');\n");
    writeFileSync(
      join(copy, 'promise.js'),
      "exports.state = require('./lib/state.js');\nexports.createPool = () => ({});\n",
    );
    const [plugin] = setUp(root, { dev: false }).rollupConfig.plugins as Array<Plugin>;
    const route = join(root, 'server', 'api', 'raw.ts');

    const promiseApi = await resolve(plugin!, 'mysql2/promise', route);
    expect(typeof promiseApi).toBe('string');
    const driver = (await resolve(plugin!, 'mysql2', route)) as string;
    const [promiseModule, driverModule] = (await Promise.all(
      [promiseApi as string, driver].map((file) => import(pathToFileURL(file).href)),
    )) as Array<{ default: Record<string, unknown>; state: object; createPool?: unknown }>;
    expect(typeof promiseModule!.createPool).toBe('function');
    expect(promiseModule!.default.createPool).toBe(promiseModule!.createPool);
    expect(promiseModule!.state).toBe(driverModule!.state);
  });

  it.each([
    // pg 8.10 predates pg-cloudflare, the socket pg uses in Workers.
    { database: 'pg' as const, name: 'pg', id: 'pg', version: '8.10.0', minimum: '8.11' },
    // mysql2 3.12 has no disableEval option, so it compiles its parsers with new Function.
    {
      database: 'mysql' as const,
      name: 'mysql2',
      id: 'mysql2',
      version: '3.12.0',
      minimum: '3.13',
    },
    {
      database: 'mysql' as const,
      name: 'mysql2',
      id: 'mysql2/promise',
      version: '3.12.0',
      minimum: '3.13',
    },
  ])(
    'names the import of $id from a $name too old for Workers',
    async ({ database, name, id, version, minimum }) => {
      const root = createApp(database);
      mkdirSync(join(root, 'node_modules', name), { recursive: true });
      writeFileSync(
        join(root, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, version, main: 'index.js' }),
      );
      writeFileSync(join(root, 'node_modules', name, 'index.js'), 'exports.Client = class {};\n');
      if (id !== name) {
        writeFileSync(
          join(root, 'node_modules', name, 'promise.js'),
          'exports.Client = class {};\n',
        );
      }
      const [plugin] = setUp(root, { dev: false }).rollupConfig.plugins as Array<Plugin>;

      await expect(resolve(plugin!, id, join(root, 'server', 'api', 'raw.ts'))).rejects.toThrow(
        `${name} ${version} cannot run in Cloudflare Workers, which need ${name} ${minimum} or later. ` +
          `Upgrade ${name}. Imported by server/api/raw.ts.`,
      );
    },
  );

  // Nitro keeps Node stubs unless it finds nodejs_compat in a Wrangler config, which it reads
  // from wrangler.* files only.
  it("turns on Nitro's Node compatibility for Workers that deploy with nodejs_compat", () => {
    const nodeCompat = (
      database: 'pg' | 'mysql' | 'd1',
      options: { dev?: boolean; config?: Record<string, unknown>; nodeCompat?: boolean } = {},
    ) =>
      setUp(createApp(database, options.config), {
        dev: options.dev ?? false,
        ...(options.nodeCompat !== undefined && {
          cloudflare: { nodeCompat: options.nodeCompat },
        }),
      }).cloudflare?.nodeCompat;

    expect(nodeCompat('pg')).toBe(true);
    expect(nodeCompat('mysql')).toBe(true);
    expect(nodeCompat('d1')).toBeUndefined();
    const flags = (worker: Array<string> | undefined, cloudflare: Array<string> | undefined) => ({
      config: {
        ...(worker && { worker: { compatibility_flags: worker } }),
        ...(cloudflare && { cloudflare: { compatibility_flags: cloudflare } }),
      },
    });
    expect(nodeCompat('d1', flags(undefined, ['nodejs_compat', 'nodejs_als']))).toBe(true);
    expect(nodeCompat('d1', flags(undefined, ['nodejs_compat_v2']))).toBe(true);
    // A native deploy gives the Worker only the Cloudflare config's flags, and a managed deploy
    // prefers `worker.compatibility_flags`. A Worker built for native modules needs the flag.
    expect(nodeCompat('d1', flags(['nodejs_compat'], undefined))).toBeUndefined();
    expect(nodeCompat('d1', flags(['nodejs_als'], ['nodejs_compat']))).toBeUndefined();
    expect(nodeCompat('pg', { nodeCompat: false })).toBe(false);
    expect(nodeCompat('pg', { dev: true })).toBeUndefined();
  });

  it('runs each PostgreSQL or MySQL request in one Void request scope', async () => {
    const options = setUp(createApp('pg'), { dev: true });
    expect(options.plugins).toHaveLength(1);
    const source = options.virtual[options.plugins[0]!] as string;
    const pluginFile = join(roots[0]!, 'request-scope.mjs');
    writeFileSync(
      pluginFile,
      source.replace(
        JSON.stringify(envModuleFile),
        JSON.stringify(pathToFileURL(envModuleFile).href),
      ),
    );
    const { default: requestScope } = (await import(pathToFileURL(pluginFile).href)) as {
      default: (nitroApp: { h3App: { handler: (event: string) => Promise<unknown> } }) => void;
    };

    const key = {};
    const nitroApp = {
      h3App: {
        // A route that reads its request's resource before and after an await.
        async handler(event: string) {
          const first = getRuntimeRequestResource(key, () => ({ event }));
          await new Promise((resolve) => setTimeout(resolve, 5));
          return [first, getRuntimeRequestResource(key, () => ({ event }))];
        },
      },
    };
    requestScope(nitroApp);
    // A dev plugin can set a promise of the env before the env itself.
    (globalThis as { __env__?: unknown }).__env__ = Promise.resolve({ DATABASE_URL: 'x' });

    const [a, b] = (await Promise.all([
      nitroApp.h3App.handler('a'),
      nitroApp.h3App.handler('b'),
    ])) as Array<[object, object]>;
    expect(a[1]).toBe(a[0]);
    expect(b[1]).toBe(b[0]);
    expect(a[0]).toEqual({ event: 'a' });
    expect(b[0]).toEqual({ event: 'b' });
  });

  it('runs Nitro 3 fetch requests in isolated Void scopes and preserves arguments and receiver', async () => {
    const options = setUp(createApp('pg'), { dev: true });
    const source = options.virtual[options.plugins[0]!] as string;
    const pluginFile = join(roots[0]!, 'request-scope-v3.mjs');
    writeFileSync(
      pluginFile,
      source.replace(
        JSON.stringify(envModuleFile),
        JSON.stringify(pathToFileURL(envModuleFile).href),
      ),
    );
    const { default: requestScope } = await import(pathToFileURL(pluginFile).href);
    const key = {};
    const nitroApp = {
      marker: 'nitro3',
      async fetch(request: Request, extra: string) {
        expect(this.marker).toBe('nitro3');
        expect(extra).toBe('forwarded');
        const first = getRuntimeRequestResource(key, () => ({
          path: new URL(request.url).pathname,
        }));
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [first, getRuntimeRequestResource(key, () => ({}))];
      },
    };
    requestScope(nitroApp);
    (globalThis as { __env__?: unknown }).__env__ = Promise.resolve({ DATABASE_URL: 'x' });
    const [a, b] = await Promise.all(
      ['/a', '/b'].map((path) =>
        nitroApp.fetch(new Request('http://localhost' + path), 'forwarded'),
      ),
    );
    expect(a[1]).toBe(a[0]);
    expect(b[1]).toBe(b[0]);
    expect(a[0]).toEqual({ path: '/a' });
    expect(b[0]).toEqual({ path: '/b' });
    expect(a[0]).not.toBe(b[0]);
  });

  it('keeps D1 requests and Node modules as Nitro has them', () => {
    const options = setUp(createApp('d1'), { dev: false });
    expect(options.plugins).toEqual([]);
    expect(options.virtual).toEqual({});
    expect(options.rollupConfig.plugins).toHaveLength(1);
  });

  it('tells an app whose bundle skipped the module to add it', () => {
    expect(() =>
      withRuntimeEnv({ HYPERDRIVE: { connectionString: 'postgresql://db/app' } }, () => db.select),
    ).toThrow("add 'void/nitro' to the Nitro modules");
    // Vite serves the app's void/db only to the installed packages it inlines.
    expect(() =>
      withRuntimeEnv({ HYPERDRIVE: { connectionString: 'postgresql://db/app' } }, () => db.select),
    ).toThrow(
      'An installed package that imports void/db must be an ES module that lists void in its dependencies or peerDependencies',
    );
  });
});
