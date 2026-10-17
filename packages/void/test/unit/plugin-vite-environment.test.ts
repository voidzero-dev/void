import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { createBuilder, createServer, normalizePath, resolveConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { voidPlugin } from '../../src/index.ts';
import { findVoidDependentPackages } from '../../src/installed-packages.ts';
import { getHookHandler } from '../helpers/vite-hooks.ts';

const roots: Array<string> = [];

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-vite-env-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      dependencies: {},
    }),
  );
  writeFileSync(
    join(root, 'void.json'),
    JSON.stringify({ worker: { compatibility_date: '2026-02-24' } }),
  );
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0, roots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('voidPlugin Vite environments', () => {
  it('does not create void.json during Vite config resolution', async () => {
    const root = createProjectRoot();
    rmSync(join(root, 'void.json'), { force: true });
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await resolveConfig(
      {
        root,
        plugins: [voidPlugin()],
      },
      'serve',
      'development',
    );

    expect(existsSync(join(root, 'void.json'))).toBe(false);
  });

  it('does not claim Vite SSR environments configured by test runners', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    await expect(
      resolveConfig(
        {
          root,
          plugins: [voidPlugin()],
          environments: {
            ssr: {
              resolve: {
                external: ['node:fs'],
              },
            },
          },
        },
        'serve',
        'test',
      ),
    ).resolves.toMatchObject({
      environments: {
        void_worker: {
          build: {
            outDir: 'dist/ssr',
          },
        },
      },
    });
  });

  it('clears resolve.external from the worker environment configured by test runners', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const config = await resolveConfig(
      {
        root,
        plugins: [voidPlugin()],
        environments: {
          void_worker: {
            resolve: {
              external: ['node:fs'],
              conditions: ['workerd'],
            },
            build: {
              emptyOutDir: false,
            },
          },
        },
      },
      'serve',
      'test',
    );

    expect(config.environments.void_worker.resolve.external).toEqual([]);
    expect(config.environments.void_worker.resolve.conditions).toContain('workerd');
    expect(config.environments.void_worker.build).toMatchObject({
      emptyOutDir: false,
      outDir: 'dist/ssr',
    });
  });

  it('clears resolve.external from class A framework worker environments', async () => {
    const root = createProjectRoot();
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: {
          '@tanstack/react-start': '^1.0.0',
        },
      }),
    );

    const config = await resolveConfig(
      {
        root,
        plugins: [voidPlugin()],
        environments: {
          ssr: {
            resolve: {
              external: ['node:fs'],
              conditions: ['workerd'],
            },
          },
        },
      },
      'serve',
      'test',
    );

    expect(config.environments.ssr.resolve.external).toEqual([]);
    expect(config.environments.ssr.resolve.conditions).toContain('workerd');
  });

  it('prebundles void CommonJS dependencies only in the worker environment', async () => {
    const root = createProjectRoot();
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ database: 'pg', worker: { compatibility_date: '2026-02-24' } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const config = await resolveConfig({ root, plugins: [voidPlugin()] }, 'serve', 'development');

    expect(config.environments.void_worker.optimizeDeps.include).toEqual(
      expect.arrayContaining(['void > email-validator', 'void > pg']),
    );
    expect(config.environments.ssr.optimizeDeps.include).toEqual([]);
  });

  it.each(['before', 'after'])(
    'prebundles them in an adapter-owned workerd environment with Void listed %s it',
    async (order) => {
      const root = createProjectRoot();
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ type: 'module', dependencies: { astro: '^7.0.0' } }),
      );
      writeFileSync(
        join(root, 'void.json'),
        JSON.stringify({ database: 'mysql', worker: { compatibility_date: '2026-02-24' } }),
      );
      writeFileSync(join(root, 'worker.ts'), 'export default {};\n');
      writeFileSync(
        join(root, 'wrangler.jsonc'),
        JSON.stringify({
          name: 'adapter-app',
          main: './worker.ts',
          compatibility_date: '2026-02-24',
        }),
      );
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      // @astrojs/cloudflare runs Astro's ssr environment in workerd this way.
      const adapter = cloudflare({
        configPath: join(root, 'wrangler.jsonc'),
        viteEnvironment: { name: 'ssr' },
      });

      const config = await resolveConfig(
        { root, plugins: order === 'before' ? [voidPlugin(), adapter] : [adapter, voidPlugin()] },
        'serve',
        'development',
      );

      expect(config.environments.ssr.optimizeDeps.include).toEqual(
        expect.arrayContaining(['void > email-validator', 'void > mysql2']),
      );
    },
  );

  it.each([
    ['sveltekit', '@sveltejs/kit', 'serve', true],
    ['sveltekit', '@sveltejs/kit', 'build', false],
    ['nuxt', 'nuxt', 'serve', false],
    ['analog', '@analogjs/platform', 'serve', false],
    ['astro', 'astro', 'serve', false],
  ] as const)(
    'keeps void in the Node SSR graph for %s (%s, %s): %s',
    async (_name, dependency, command, inlined) => {
      const root = createProjectRoot();
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ type: 'module', dependencies: { [dependency]: '*' } }),
      );
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      const config = await resolveConfig({ root, plugins: [voidPlugin()] }, command, 'development');

      expect(config.ssr.noExternal).toEqual(
        inlined ? expect.arrayContaining(['void']) : expect.not.arrayContaining(['void']),
      );
    },
  );

  it('serves the void/db virtual module to SvelteKit server code from an installed void', async () => {
    // Windows runners report a short-name temp path, which Vite refuses to serve.
    const root = realpathSync.native(createProjectRoot());
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', devDependencies: { '@sveltejs/kit': '*', void: '*' } }),
    );
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ database: 'pg', worker: { compatibility_date: '2026-02-24' } }),
    );
    mkdirSync(join(root, 'db'));
    writeFileSync(
      join(root, 'db/schema.ts'),
      "import { pgTable, serial } from 'void/schema-pg';\nexport const users = pgTable('users', { id: serial('id') });\n",
    );
    // A packed install: Vite externalizes bare SSR imports that resolve into node_modules.
    const installed = join(root, 'node_modules/void');
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({
        name: 'void',
        type: 'module',
        exports: { './db': './db.mjs', './_env': './env.mjs', './schema-pg': './schema-pg.mjs' },
      }),
    );
    for (const file of ['db.mjs', 'env.mjs', 'schema-pg.mjs']) {
      writeFileSync(join(installed, file), 'export {};\n');
    }
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src/server.ts'),
      "import { db } from 'void/db';\nimport { withRuntimeEnv } from 'void/_env';\nexport { db, withRuntimeEnv };\n",
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [voidPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, preTransformRequests: false },
    });
    try {
      const result = await server.environments.ssr.transformRequest('/src/server.ts');

      expect(result?.code).toContain('virtual:void-db');
      expect(result?.code).not.toMatch(/__vite_ssr_import__\("void\/(?:db|_env)"/);
    } finally {
      await server.close();
    }
  });

  it('rejects Cloudflare-only imports from an installed void on the Node target dev server', async () => {
    const root = realpathSync.native(createProjectRoot());
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', devDependencies: { void: '*' } }),
    );
    writeFileSync(join(root, 'void.json'), JSON.stringify({ target: 'node' }));
    const installed = join(root, 'node_modules/void');
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({ name: 'void', type: 'module', exports: { './kv': './kv.mjs' } }),
    );
    writeFileSync(join(installed, 'kv.mjs'), 'export const kv = {};\n');
    mkdirSync(join(root, 'routes/api'), { recursive: true });
    writeFileSync(
      join(root, 'routes/api/cache.ts'),
      "import { kv } from 'void/kv';\nexport const GET = () => Response.json({ kv: typeof kv });\n",
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [voidPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, preTransformRequests: false },
    });
    try {
      await expect(
        server.environments.ssr.transformRequest('/routes/api/cache.ts'),
      ).rejects.toThrow("target: 'void/kv' is not available with target 'node'.");
    } finally {
      await server.close();
    }
  });

  /** An installed package with the given manifest and `index.js`. */
  function installPackage(root: string, name: string, manifest: object, index: string): void {
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, main: 'index.js', ...manifest }),
    );
    writeFileSync(join(dir, 'index.js'), index);
  }

  it('serves the app void/db to installed ES module packages that depend on void in SvelteKit dev', async () => {
    const root = realpathSync.native(createProjectRoot());
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: {
          'db-lib': '*',
          'cjs-db-lib': '*',
          'wrapped-db-lib': '*',
          'esm-wrapped-db-lib': '*',
        },
        devDependencies: { '@sveltejs/kit': '*', void: '*' },
      }),
    );
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ database: 'pg', worker: { compatibility_date: '2026-02-24' } }),
    );
    mkdirSync(join(root, 'db'));
    writeFileSync(
      join(root, 'db/schema.ts'),
      "import { pgTable, serial } from 'void/schema-pg';\nexport const users = pgTable('users', { id: serial('id') });\n",
    );
    installPackage(
      root,
      'void',
      { type: 'module', exports: { './db': './db.mjs', './schema-pg': './schema-pg.mjs' } },
      '',
    );
    for (const file of ['db.mjs', 'schema-pg.mjs']) {
      writeFileSync(join(root, 'node_modules/void', file), 'export {};\n');
    }
    installPackage(
      root,
      'db-lib',
      { type: 'module', peerDependencies: { void: '*' } },
      "export { db } from 'void/db';\n",
    );
    // Vite's module runner cannot evaluate CommonJS, so these stay with Node: one CommonJS
    // package, and one with an ES module wrapper that imports its CommonJS build.
    installPackage(
      root,
      'cjs-db-lib',
      { peerDependencies: { void: '*' } },
      "exports.db = require('void/db').db;\n",
    );
    installPackage(
      root,
      'wrapped-db-lib',
      {
        exports: { import: './wrapper.mjs', require: './index.js' },
        peerDependencies: { void: '*' },
      },
      "exports.db = require('void/db').db;\n",
    );
    writeFileSync(
      join(root, 'node_modules/wrapped-db-lib/wrapper.mjs'),
      "import lib from './index.js';\nexport const db = lib.db;\n",
    );
    // The same wrapper in an ES module package, as in Node's dual-package guide.
    installPackage(
      root,
      'esm-wrapped-db-lib',
      {
        type: 'module',
        exports: { import: './wrapper.mjs', require: './index.cjs' },
        peerDependencies: { void: '*' },
      },
      '',
    );
    writeFileSync(
      join(root, 'node_modules/esm-wrapped-db-lib/index.cjs'),
      "exports.db = require('void/db').db;\n",
    );
    writeFileSync(
      join(root, 'node_modules/esm-wrapped-db-lib/wrapper.mjs'),
      "import lib from './index.cjs';\nexport const db = lib.db;\n",
    );
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src/server.ts'),
      "import { db } from 'db-lib';\nimport { db as cjsDb } from 'cjs-db-lib';\nimport { db as wrappedDb } from 'wrapped-db-lib';\nimport { db as esmWrappedDb } from 'esm-wrapped-db-lib';\nexport { db, cjsDb, wrappedDb, esmWrappedDb };\n",
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [voidPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, preTransformRequests: false },
    });
    try {
      const app = await server.environments.ssr.transformRequest('/src/server.ts');
      const lib = await server.environments.ssr.transformRequest('/node_modules/db-lib/index.js');

      expect(app?.code).not.toContain('__vite_ssr_import__("db-lib"');
      expect(app?.code).toContain('__vite_ssr_import__("cjs-db-lib"');
      expect(app?.code).toContain('__vite_ssr_import__("wrapped-db-lib"');
      expect(app?.code).toContain('__vite_ssr_import__("esm-wrapped-db-lib"');
      expect(lib?.code).toContain('virtual:void-db');
    } finally {
      await server.close();
    }
  });

  it('leaves installed packages that depend on void to Node in SvelteKit D1 dev', async () => {
    const root = realpathSync.native(createProjectRoot());
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { 'db-lib': '*' },
        devDependencies: { '@sveltejs/kit': '*', void: '*' },
      }),
    );
    installPackage(root, 'void', { type: 'module', exports: { './db': './db.mjs' } }, '');
    writeFileSync(join(root, 'node_modules/void/db.mjs'), 'export {};\n');
    installPackage(
      root,
      'db-lib',
      { type: 'module', peerDependencies: { void: '*' } },
      "export { db } from 'void/db';\n",
    );
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/server.ts'), "export { db } from 'db-lib';\n");
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [voidPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, preTransformRequests: false },
    });
    try {
      const app = await server.environments.ssr.transformRequest('/src/server.ts');

      expect(app?.code).toContain('__vite_ssr_import__("db-lib"');
    } finally {
      await server.close();
    }
  });

  // The rule vite-plugin-svelte applies to Svelte libraries.
  it("finds installed ES module packages that depend on void among the app's dependencies and theirs", () => {
    const root = createProjectRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: {
          'db-lib': '*',
          'plain-lib': '*',
          'module-db-lib': '*',
          'mjs-db-lib': '*',
        },
        devDependencies: { 'dev-db-lib': '*' },
      }),
    );
    const usesVoid = { peerDependencies: { void: '*' } };
    installPackage(
      root,
      'db-lib',
      { type: 'module', dependencies: { 'inner-db-lib': '*' }, ...usesVoid },
      '',
    );
    installPackage(root, 'inner-db-lib', { type: 'module', ...usesVoid }, '');
    installPackage(root, 'dev-db-lib', { type: 'module', ...usesVoid }, '');
    // Packages that a package without void depends on stay with it.
    installPackage(
      root,
      'plain-lib',
      { type: 'module', dependencies: { 'hidden-db-lib': '*' } },
      '',
    );
    installPackage(root, 'hidden-db-lib', { type: 'module', ...usesVoid }, '');
    // ES module entries outside a `type: "module"` package.
    installPackage(root, 'module-db-lib', { module: './index.mjs', ...usesVoid }, '');
    installPackage(root, 'mjs-db-lib', { exports: './index.mjs', ...usesVoid }, '');
    for (const name of ['module-db-lib', 'mjs-db-lib']) {
      writeFileSync(join(root, 'node_modules', name, 'index.mjs'), '');
    }

    expect(findVoidDependentPackages(root)).toEqual([
      'db-lib',
      'dev-db-lib',
      'inner-db-lib',
      'mjs-db-lib',
      'module-db-lib',
    ]);
  });

  it('finds packages that depend on void through the Yarn PnP runtime', () => {
    const root = createProjectRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', dependencies: { 'db-lib': '*' } }),
    );
    // No node_modules: Yarn serves each package from its cache, and `exports` may hide its
    // package.json, so the runtime's unqualified resolution finds the package.
    const store = join(root, '.yarn/cache');
    const usesVoid = { type: 'module', exports: './index.js', peerDependencies: { void: '*' } };
    for (const [name, manifest] of [
      ['db-lib', { ...usesVoid, dependencies: { 'inner-db-lib': '*' } }],
      ['inner-db-lib', usesVoid],
    ] as const) {
      mkdirSync(join(store, name), { recursive: true });
      writeFileSync(join(store, name, 'package.json'), JSON.stringify({ name, ...manifest }));
      writeFileSync(join(store, name, 'index.js'), "export { db } from 'void/db';\n");
    }
    // Yarn's API reads a Windows path with either separator, and the crawler passes
    // forward slashes.
    const inRoot = (path: string) => normalizePath(path).startsWith(normalizePath(root));
    const pnp = {
      resolveToUnqualified(request: string, issuer: string) {
        expect(inRoot(issuer)).toBe(true);
        const [name] = request.split('/package.json');
        if (!existsSync(join(store, name!))) {
          throw new Error(`${name} is not a dependency of ${issuer}`);
        }
        return join(store, request);
      },
    };
    const runtime = module as { findPnpApi?: (path: string) => typeof pnp | null };
    runtime.findPnpApi = (path) => (inRoot(path) ? pnp : null);
    try {
      expect(findVoidDependentPackages(root)).toEqual(['db-lib', 'inner-db-lib']);
    } finally {
      delete runtime.findPnpApi;
    }
  });

  // Vite's module runner evaluates an inlined package as ES modules, so a package whose import
  // entry reaches CommonJS through relative imports stays with Node.
  const wrapper = {
    'wrapper.mjs': "import lib from './index.cjs';\nexport const db = lib.db;\n",
    'index.cjs': 'exports.db = 1;\n',
  };
  it.each([
    {
      shape: 'separate ES module and CommonJS entries',
      manifest: { exports: { '.': { import: './index.mjs', require: './index.cjs' } } },
      files: { 'index.mjs': 'export const db = 1;\n', 'index.cjs': 'exports.db = 1;\n' },
      found: true,
    },
    {
      shape: 'a nested type: module folder',
      manifest: { exports: { import: './esm/index.js', require: './index.js' } },
      files: { 'esm/package.json': '{"type":"module"}', 'esm/index.js': 'export const db = 1;\n' },
      found: true,
    },
    {
      shape: "Node's dual-package wrapper",
      manifest: { exports: { import: './wrapper.mjs', require: './index.cjs' } },
      files: wrapper,
      found: false,
    },
    {
      shape: 'that wrapper under type: module',
      manifest: { type: 'module', exports: { import: './wrapper.mjs', require: './index.cjs' } },
      files: wrapper,
      found: false,
    },
    {
      shape: 'an ES module entry that imports .cjs',
      manifest: { type: 'module' },
      files: {
        'index.js': "import vendor from './vendor.cjs';\nexport const db = vendor.db;\n",
        'vendor.cjs': 'module.exports = { db: 1 };\n',
      },
      found: false,
    },
    ...[
      "export * from './vendor.cjs';\n",
      "export {} from './vendor.cjs';\n",
      "import './vendor.cjs';\n",
      "export const db = await import('./vendor.cjs');\n",
    ].map((entry) => ({
      shape: `an ES module entry with \`${entry.trim()}\``,
      manifest: { type: 'module' },
      files: { 'index.js': entry, 'vendor.cjs': 'module.exports = { db: 1 };\n' },
      found: false,
    })),
    {
      shape: 'CommonJS imports only in comments and strings',
      manifest: { type: 'module' },
      files: {
        'index.js': [
          "// Before 2.0 this file did `import './legacy.cjs'`.",
          "/* export * from './legacy.cjs'; */",
          'export const note = "import legacy from \'./legacy.cjs\'";',
          "export const hint = `await import('./legacy.cjs')`;",
          'export const db = 1;',
          '',
        ].join('\n'),
        'legacy.cjs': 'module.exports = { db: 1 };\n',
      },
      found: true,
    },
    // Vite's module runner parses the entry with the same parser, and cannot load it either.
    {
      shape: 'an entry that does not parse',
      manifest: { type: 'module' },
      files: { 'index.js': 'export const db = ;\n' },
      found: false,
    },
    {
      shape: 'a CommonJS file that a relative ES module imports',
      manifest: { type: 'module' },
      files: {
        'index.js': "export { db } from './internal.js';\n",
        'internal.js': "import legacy from './legacy.cjs';\nexport const db = legacy.db;\n",
        'legacy.cjs': 'module.exports = { db: 1 };\n',
      },
      found: false,
    },
    {
      shape: 'a CommonJS folder that a dynamically imported ES module imports',
      manifest: { type: 'module' },
      files: {
        'index.js': "export const load = () => import('./lib/internal.js');\n",
        'lib/internal.js': "export { db } from '../cjs/db.js';\n",
        'cjs/package.json': '{"type":"commonjs"}',
        'cjs/db.js': 'exports.db = 1;\n',
      },
      found: false,
    },
    {
      shape: 'a relative ES module that does not parse',
      manifest: { type: 'module' },
      files: {
        'index.js': "export * from './internal.js';\n",
        'internal.js': 'export const db = ;\n',
      },
      found: false,
    },
    {
      shape: 'ES modules that import each other and CommonJS of another package',
      manifest: { type: 'module' },
      files: {
        'index.js': "export * from './a.js';\n",
        'a.js': "export * from './b.mjs';\nexport const a = 1;\n",
        'b.mjs':
          "import { a } from './a.js';\nimport 'other-lib/legacy.cjs';\nexport const db = () => a;\n",
      },
      found: true,
    },
    {
      shape: 'more relative modules than the check reads',
      manifest: { type: 'module' },
      files: {
        'index.js': Array.from({ length: 2000 }, (_, i) => `import './${i}.js';\n`).join(''),
        ...Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`${i}.js`, ''])),
      },
      found: false,
    },
    // Vite also matches `development`, or `production` when NODE_ENV is production, as in a build.
    {
      shape: 'ES modules only under development',
      manifest: { exports: { development: './dev.mjs', default: './index.cjs' } },
      files: { 'dev.mjs': 'export const db = 1;\n', 'index.cjs': 'exports.db = 1;\n' },
      found: true,
    },
    {
      shape: 'ES modules only under development, in production',
      nodeEnv: 'production',
      manifest: { exports: { development: './dev.mjs', default: './index.cjs' } },
      files: { 'dev.mjs': 'export const db = 1;\n', 'index.cjs': 'exports.db = 1;\n' },
      found: false,
    },
    {
      shape: 'CommonJS under development',
      manifest: { exports: { development: './dev.cjs', default: './index.mjs' } },
      files: { 'dev.cjs': 'exports.db = 1;\n', 'index.mjs': 'export const db = 1;\n' },
      found: false,
    },
  ])('finds an installed package with $shape: $found', ({ manifest, files, found, nodeEnv }) => {
    if (nodeEnv) {
      vi.stubEnv('NODE_ENV', nodeEnv);
    }
    const root = createProjectRoot();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', dependencies: { 'db-lib': '*' } }),
    );
    installPackage(
      root,
      'db-lib',
      { ...manifest, peerDependencies: { void: '*' } },
      'exports.db = 1;\n',
    );
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, 'node_modules/db-lib', path, '..'), { recursive: true });
      writeFileSync(join(root, 'node_modules/db-lib', path), content);
    }

    expect(findVoidDependentPackages(root)).toEqual(found ? ['db-lib'] : []);
  });

  // Nitro bundles a Nuxt or Analog server build's output, and serves it the app's void/db.
  it.each([
    ['nuxt', 'nuxt', true],
    ['analog', '@analogjs/platform', true],
    ['sveltekit', '@sveltejs/kit', false],
  ] as const)(
    'leaves a PostgreSQL void/db to Nitro in a %s build (dependency %s): %s',
    async (_name, dependency, external) => {
      const root = createProjectRoot();
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ type: 'module', dependencies: { [dependency]: '*' } }),
      );
      writeFileSync(
        join(root, 'void.json'),
        JSON.stringify({ database: 'pg', worker: { compatibility_date: '2026-02-24' } }),
      );
      mkdirSync(join(root, 'db'));
      writeFileSync(join(root, 'db/schema.ts'), 'export {};\n');
      vi.spyOn(process, 'cwd').mockReturnValue(root);

      const config = await resolveConfig(
        { root, configFile: false, logLevel: 'silent', plugins: [voidPlugin()] },
        'build',
        'production',
      );
      const plugin = config.plugins.find((candidate) => candidate.name === 'void:drizzle')!;
      const resolveId = getHookHandler(plugin.resolveId) as (
        this: { environment: { name: string; mode: string } },
        source: string,
        importer: string,
        options: { isEntry: boolean },
      ) => unknown;

      expect(
        await resolveId.call(
          { environment: { name: 'ssr', mode: 'build' } },
          'void/db',
          join(root, 'src/server/users.ts'),
          { isEntry: false },
        ),
      ).toEqual(external ? { id: 'void/db', external: true } : '\0virtual:void-db');
    },
  );

  it('rejects Cloudflare-only imports from installed packages on the Node target dev server', async () => {
    const root = realpathSync.native(createProjectRoot());
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { 'kv-lib': '*' },
        devDependencies: { void: '*' },
      }),
    );
    writeFileSync(join(root, 'void.json'), JSON.stringify({ target: 'node' }));
    installPackage(root, 'void', { type: 'module', exports: { './kv': './kv.mjs' } }, '');
    writeFileSync(join(root, 'node_modules/void/kv.mjs'), 'export const kv = {};\n');
    installPackage(
      root,
      'kv-lib',
      { type: 'module', peerDependencies: { void: '*' } },
      "export { kv } from 'void/kv';\n",
    );
    mkdirSync(join(root, 'routes/api'), { recursive: true });
    writeFileSync(
      join(root, 'routes/api/cache.ts'),
      "import { kv } from 'kv-lib';\nexport const GET = () => Response.json({ kv: typeof kv });\n",
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [voidPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, preTransformRequests: false },
    });
    try {
      await expect(server.ssrLoadModule('/routes/api/cache.ts')).rejects.toThrow(
        "target: 'void/kv' is not available with target 'node'. CF bindings require target: \"cloudflare\". Imported by node_modules/kv-lib/index.js.",
      );
    } finally {
      await server.close();
    }
  });

  describe('Node target builds with an installed void', () => {
    /** An API-only Node-target app whose route imports void and an adapter from node_modules. */
    function createNodeApp(route: string): string {
      const root = realpathSync.native(createProjectRoot());
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          type: 'module',
          dependencies: { 'kv-lib': '*' },
          devDependencies: { void: '*', '@void/adapter': '*' },
        }),
      );
      writeFileSync(join(root, 'void.json'), JSON.stringify({ target: 'node' }));
      installPackage(
        root,
        'void',
        { type: 'module', exports: { './handler': './handler.mjs', './_env': './env.mjs' } },
        '',
      );
      writeFileSync(
        join(root, 'node_modules/void/handler.mjs'),
        'export class ValidationError extends Error {}\n',
      );
      // Void's runtime imports cloudflare:workers only when it runs in workerd.
      writeFileSync(
        join(root, 'node_modules/void/env.mjs'),
        "export const workers = () => typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers' ? import('cloudflare:workers') : null;\n",
      );
      installPackage(
        root,
        '@void/adapter',
        { type: 'module' },
        "export { ValidationError } from 'void/handler';\n",
      );
      installPackage(
        root,
        'kv-lib',
        { type: 'module', peerDependencies: { void: '*' } },
        "export { kv } from 'void/kv';\n",
      );
      mkdirSync(join(root, 'routes/api'), { recursive: true });
      writeFileSync(join(root, 'routes/api/ping.ts'), route);
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      return root;
    }

    async function buildApp(root: string): Promise<string> {
      // The CLI's builder, which runs the plugins' buildApp hooks.
      const builder = await createBuilder(
        { root, configFile: false, logLevel: 'silent', plugins: [voidPlugin()] },
        null,
      );
      await builder.buildApp();
      const output = join(root, 'dist/ssr');
      return readdirSync(output, { recursive: true })
        .map(String)
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFileSync(join(output, file), 'utf8'))
        .join('\n');
    }

    it('bundles void and its adapters, as the dev server inlines them', async () => {
      const root = createNodeApp(
        "import { ValidationError } from 'void/handler';\nimport { ValidationError as AdapterError } from '@void/adapter';\nimport { workers } from 'void/_env';\nexport const GET = () => Response.json({ same: ValidationError === AdapterError, workers: typeof workers });\n",
      );

      const code = await buildApp(root);

      expect(code).toContain('ValidationError = class extends Error');
      expect(code).not.toMatch(/from\s*"(?:void|@void)\//);
      expect(code).toContain('import("cloudflare:workers")');
    });

    // A Pages app's build has a client environment too.
    it('inlines void, its adapters and the packages that depend on it in a Pages app build', async () => {
      const root = createNodeApp('export const GET = () => Response.json({});\n');
      mkdirSync(join(root, 'pages'));

      const config = await resolveConfig(
        { root, configFile: false, logLevel: 'silent', plugins: [voidPlugin()] },
        'build',
        'production',
      );

      expect(config.environments.ssr!.resolve.noExternal).toEqual(
        expect.arrayContaining(['void', /^@void\//, 'kv-lib']),
      );
    });

    it('rejects Cloudflare-only imports from installed packages', async () => {
      const root = createNodeApp(
        "import { kv } from 'kv-lib';\nexport const GET = () => Response.json({ kv: typeof kv });\n",
      );

      await expect(buildApp(root)).rejects.toThrow(
        "target: 'void/kv' is not available with target 'node'. CF bindings require target: \"cloudflare\". Imported by node_modules/kv-lib/index.js.",
      );
    });

    it('rejects a static cloudflare: import, which Node cannot load', async () => {
      const root = createNodeApp(
        "import { env } from 'cloudflare:workers';\nexport const GET = () => Response.json({ env: typeof env });\n",
      );

      await expect(buildApp(root)).rejects.toThrow(
        "target: 'cloudflare:workers' is not available with target 'node'. CF bindings require target: \"cloudflare\". Imported by routes/api/ping.ts.",
      );
    });
  });

  // The package entry is the whole Vite plugin; server code needs only its handler helpers.
  it.each([
    ['sveltekit', '@sveltejs/kit', 'ssr', true],
    ['sveltekit', '@sveltejs/kit', 'client', false],
    ['astro', 'astro', 'ssr', true],
    ['astro', 'astro', 'client', false],
  ] as const)(
    'sends bare void from %s %s code in the %s environment to the handler entry: %s',
    async (_name, dependency, environment, redirected) => {
      const root = realpathSync.native(createProjectRoot());
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ type: 'module', devDependencies: { [dependency]: '*', void: '*' } }),
      );
      const installed = join(root, 'node_modules/void');
      mkdirSync(installed, { recursive: true });
      writeFileSync(
        join(installed, 'package.json'),
        JSON.stringify({ name: 'void', type: 'module', exports: { '.': './index.mjs' } }),
      );
      writeFileSync(join(installed, 'index.mjs'), 'export {};\n');
      vi.spyOn(process, 'cwd').mockReturnValue(root);

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
          join(root, 'src/hooks.server.ts'),
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

describe('Astro preview', () => {
  // `astro preview` loads the Astro config, which calls voidPlugin(), but runs none of its hooks.
  it.each([
    ['preview', true],
    ['dev', false],
  ] as const)(
    "puts back the build's Wrangler deploy config for `astro %s`: %s",
    (command, restored) => {
      const root = createProjectRoot();
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ type: 'module', dependencies: { astro: '*' } }),
      );
      rmSync(join(root, 'void.json'));
      writeFileSync(join(root, 'void.config.ts'), 'export default {};\n');
      const pointer = '{"configPath":"../../dist/server/wrangler.json"}';
      mkdirSync(join(root, '.void'));
      writeFileSync(join(root, '.void/preview-deploy-config.json'), pointer);
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      // Run the process exit cleanup below, before the temp root is removed.
      const once = vi.spyOn(process, 'once').mockReturnValue(process);
      const argv = process.argv;
      process.argv = [argv[0]!, 'astro.mjs', command];
      try {
        voidPlugin();
      } finally {
        process.argv = argv;
      }

      const deployConfig = join(root, '.wrangler/deploy/config.json');
      expect(existsSync(deployConfig) ? readFileSync(deployConfig, 'utf8') : undefined).toBe(
        restored ? pointer : undefined,
      );
      // As after a Vite preview, a deploy then finds no implicit Wrangler config.
      for (const [event, listener] of once.mock.calls) {
        if (event === 'exit') {
          (listener as () => void)();
        }
      }
      expect(existsSync(deployConfig)).toBe(false);
    },
  );
});

describe('Astro server entry', () => {
  const entry = '@astrojs/cloudflare/entrypoints/server';
  const scopedEntry = '\0void:astro-server-entry';
  const envUrl = new URL('../../src/runtime/env.ts', import.meta.url).href;

  type WrapperModule = {
    named: string;
    default: {
      marker: string;
      fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
    };
  };

  function createAstroRoot(database: 'pg' | 'mysql' | undefined): string {
    const root = realpathSync.native(createProjectRoot());
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', dependencies: { astro: '*' } }),
    );
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ database, worker: { compatibility_date: '2026-02-24' } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    return root;
  }

  function startDevServer(root: string) {
    return createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [voidPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, preTransformRequests: false },
    });
  }

  /** Import the wrapper with stand-ins for the adapter entry and the generated trigger dispatch. */
  async function importWrapper(
    root: string,
    code: string,
    adapter: string,
    dispatch: string,
  ): Promise<WrapperModule> {
    writeFileSync(join(root, 'adapter-entry.mjs'), adapter);
    writeFileSync(join(root, 'dispatch.mjs'), dispatch);
    writeFileSync(
      join(root, 'entry.mjs'),
      code
        .replaceAll(JSON.stringify(entry), '"./adapter-entry.mjs"')
        .replace(
          /^import \{ withRuntimeEnv \} from .*;$/m,
          `import { withRuntimeEnv } from ${JSON.stringify(envUrl)};`,
        )
        .replace(
          /^import \{ handleDevTrigger \} from .*;$/m,
          'import { handleDevTrigger } from "./dispatch.mjs";',
        ),
    );
    return (await import(pathToFileURL(join(root, 'entry.mjs')).href)) as WrapperModule;
  }

  const loadedCode = (loaded: unknown): string =>
    typeof loaded === 'string' ? loaded : ((loaded as { code?: string } | null)?.code ?? '');

  const APP_MIDDLEWARE = 'export const onRequest = (_context, next) => next();\n';

  function writeAppMiddleware(root: string): void {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/middleware.ts'), APP_MIDDLEWARE);
  }

  // Void adds its own middleware for the dev triggers when the app has none, as it also runs for a
  // custom Worker entry. The wrapper answers the triggers only next to the app's own middleware.
  it.each([
    ['pg', false],
    ['mysql', false],
    [undefined, false],
    ['pg', true],
    [undefined, true],
  ] as const)(
    'wraps the Cloudflare adapter entry in dev (database: %s, app middleware: %s)',
    async (database, appMiddleware) => {
      const root = createAstroRoot(database);
      if (appMiddleware) {
        writeAppMiddleware(root);
      }
      const server = await startDevServer(root);
      try {
        const middleware = readFileSync(join(root, 'src/middleware.ts'), 'utf8');
        expect(middleware.includes('Auto-generated by Void in dev')).toBe(!appMiddleware);
        const container = server.environments.ssr!.pluginContainer;
        const wrapped = database !== undefined || appMiddleware;
        expect((await container.resolveId(entry))?.id === scopedEntry).toBe(wrapped);
        if (wrapped) {
          // The wrapper imports the adapter's own entry.
          expect((await container.resolveId(entry, scopedEntry))?.id).not.toBe(scopedEntry);
          const code = loadedCode(await container.load(scopedEntry));
          expect(code.includes('handleDevTrigger')).toBe(appMiddleware);
        }
      } finally {
        await server.close();
      }
    },
  );

  it.each(['pg', 'mysql'] as const)(
    'runs the Cloudflare adapter entry in a Void request scope (database: %s)',
    async (database) => {
      const root = createAstroRoot(database);
      const server = await startDevServer(root);
      try {
        const container = server.environments.ssr!.pluginContainer;
        const wrapper = await importWrapper(
          root,
          loadedCode(await container.load(scopedEntry)),
          `import { getRuntimeBinding, getRuntimeRequestResource } from ${JSON.stringify(envUrl)};
export const named = "kept";
export default {
  marker: "kept",
  fetch(request, env, ctx) {
    // Throws outside a request scope.
    getRuntimeRequestResource({}, () => ({}));
    return Response.json({ url: request.url, database: getRuntimeBinding("DATABASE_URL"), ctx });
  },
};
`,
          'export async function handleDevTrigger() {\n  return null;\n}\n',
        );

        expect([wrapper.named, wrapper.default.marker]).toEqual(['kept', 'kept']);
        const response = await wrapper.default.fetch(
          new Request('http://localhost/api'),
          { DATABASE_URL: 'postgres://request' },
          { id: 'ctx' },
        );
        expect(await response.json()).toEqual({
          url: 'http://localhost/api',
          database: 'postgres://request',
          ctx: { id: 'ctx' },
        });
      } finally {
        await server.close();
      }
    },
  );

  // Void cannot add its middleware next to the app's own, so the wrapper answers the triggers. A
  // build never imports the dev-only dispatch.
  it.each(['pg', undefined] as const)(
    'sends dev triggers to the generated dispatch before the adapter entry, only in dev (database: %s)',
    async (database) => {
      const root = createAstroRoot(database);
      writeAppMiddleware(root);
      const server = await startDevServer(root);
      let code: string;
      try {
        code = loadedCode(await server.environments.ssr!.pluginContainer.load(scopedEntry));
      } finally {
        await server.close();
      }
      expect(code).toContain(JSON.stringify(normalizePath(join(root, '.void/dev-triggers.ts'))));
      const wrapper = await importWrapper(
        root,
        code,
        'export default {\n  fetch() {\n    return new Response("astro");\n  },\n};\n',
        `export async function handleDevTrigger(request, env, ctx) {
  const { pathname } = new URL(request.url);
  if (request.method !== "POST" || pathname !== "/__void/scheduled") return null;
  return Response.json({ pathname, env, ctx });
}
`,
      );
      const trigger = await wrapper.default.fetch(
        new Request('http://localhost/__void/scheduled', { method: 'POST' }),
        { DB: 'binding' },
        { id: 'ctx' },
      );
      expect(await trigger.json()).toEqual({
        pathname: '/__void/scheduled',
        env: { DB: 'binding' },
        ctx: { id: 'ctx' },
      });
      const page = await wrapper.default.fetch(new Request('http://localhost/'), {}, {});
      expect(await page.text()).toBe('astro');

      const config = await resolveConfig(
        { root, configFile: false, logLevel: 'silent', plugins: [voidPlugin()] },
        'build',
        'production',
      );
      const plugin = config.plugins.find(
        (candidate) => candidate.name === 'void:astro-server-entry',
      )!;
      const resolveId = getHookHandler(plugin.resolveId) as (
        this: { environment: { name: string } },
        source: string,
        importer: string | undefined,
      ) => unknown;
      const resolved = await resolveId.call({ environment: { name: 'ssr' } }, entry, undefined);
      // A D1 build keeps the adapter's own entry; a PostgreSQL build keeps only the request scope.
      expect(resolved).toBe(database ? scopedEntry : undefined);
      if (database) {
        const load = getHookHandler(plugin.load) as (id: string) => unknown;
        const buildCode = loadedCode(await load(scopedEntry));
        expect(buildCode).toContain('withRuntimeEnv');
        expect(buildCode).not.toContain('dev-triggers');
        expect(buildCode).not.toContain('handleDevTrigger');
      }
    },
  );
});

describe('pracht server entry', () => {
  const entry = 'virtual:pracht/server';
  const devEntry = '\0void:pracht-dev-server-entry';
  const envUrl = new URL('../../src/runtime/env.ts', import.meta.url).href;
  const envFile = fileURLToPath(import.meta.resolve('#self/_env'));

  type WrapperModule = {
    named: string;
    default: {
      marker: string;
      fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
    };
  };

  function createPrachtRoot(database: 'pg' | undefined): string {
    const root = realpathSync.native(createProjectRoot());
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ type: 'module', dependencies: { '@pracht/adapter-cloudflare': '*' } }),
    );
    writeFileSync(
      join(root, 'void.json'),
      JSON.stringify({ database, worker: { compatibility_date: '2026-02-24' } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    return root;
  }

  function startDevServer(root: string) {
    return createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [voidPlugin()],
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, preTransformRequests: false },
    });
  }

  const loadedCode = (loaded: unknown): string =>
    typeof loaded === 'string' ? loaded : ((loaded as { code?: string } | null)?.code ?? '');

  async function importWrapper(
    root: string,
    code: string,
    dispatch: string,
  ): Promise<WrapperModule> {
    writeFileSync(
      join(root, 'pracht-entry.mjs'),
      `export const named = "kept";
export default {
  marker: "kept",
  fetch() {
    return new Response("pracht");
  },
};
`,
    );
    writeFileSync(join(root, 'dispatch.mjs'), dispatch);
    writeFileSync(
      join(root, 'entry.mjs'),
      code
        .replaceAll(JSON.stringify(entry), '"./pracht-entry.mjs"')
        .replace(
          /^import \{ withRuntimeEnv \} from .*;$/m,
          `import { withRuntimeEnv } from ${JSON.stringify(envUrl)};`,
        )
        .replace(
          JSON.stringify(normalizePath(join(root, '.void/dev-triggers.ts'))),
          '"./dispatch.mjs"',
        ),
    );
    return (await import(pathToFileURL(join(root, 'entry.mjs')).href)) as WrapperModule;
  }

  it.each(['pg', undefined] as const)(
    'wraps the pracht server entry in dev and sends dev triggers to the dispatch (database: %s)',
    async (database) => {
      const root = createPrachtRoot(database);
      const server = await startDevServer(root);
      let code: string;
      try {
        const container = server.environments.ssr!.pluginContainer;
        expect((await container.resolveId(entry))?.id).toBe(devEntry);
        expect((await container.resolveId(entry, devEntry))?.id).not.toBe(devEntry);
        code = loadedCode(await container.load(devEntry));
      } finally {
        await server.close();
      }
      expect(code.includes('withRuntimeEnv')).toBe(database !== undefined);
      expect(code).not.toMatch(/^import .*dev-triggers/m);

      const wrapper = await importWrapper(
        root,
        code,
        `export async function handleDevTrigger(request, env, ctx) {
  return Response.json({ pathname: new URL(request.url).pathname, env, ctx });
}
`,
      );
      expect([wrapper.named, wrapper.default.marker]).toEqual(['kept', 'kept']);
      const trigger = await wrapper.default.fetch(
        new Request('http://localhost/__void/queue', { method: 'POST' }),
        { DB: 'binding' },
        { id: 'ctx' },
      );
      expect(await trigger.json()).toEqual({
        pathname: '/__void/queue',
        env: { DB: 'binding' },
        ctx: { id: 'ctx' },
      });
      const page = await wrapper.default.fetch(
        new Request('http://localhost/__void/queue'),
        {},
        {},
      );
      expect(await page.text()).toBe('pracht');
    },
  );

  it('leaves the built entry in place and evaluates the env module with it', async () => {
    const root = createPrachtRoot(undefined);
    const config = await resolveConfig(
      { root, configFile: false, logLevel: 'silent', plugins: [voidPlugin()] },
      'build',
      'production',
    );
    const plugin = config.plugins.find(
      (candidate) => candidate.name === 'void:pracht-server-entry',
    )!;
    const context = { environment: { name: 'ssr' } };
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: typeof context,
      source: string,
      importer: string | undefined,
    ) => unknown;
    expect(await resolveId.call(context, entry, undefined)).toBeUndefined();

    const transform = getHookHandler(plugin.transform) as (
      this: typeof context,
      code: string,
      id: string,
    ) => unknown;
    expect(loadedCode(await transform.call(context, 'export default {};', entry))).toBe(
      `import ${JSON.stringify(envFile)};\nexport default {};`,
    );
    const client = { environment: { name: 'client' } };
    expect(await transform.call(client, 'export default {};', entry)).toBeUndefined();
  });
});
