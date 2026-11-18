import { resolve as resolveWindowsPath } from 'node:path/win32';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'pathslash';
import { normalizePath, type Plugin } from 'vite';
import { bundleWorkerSqlDriver } from './cli/wrapper.ts';
import { getDatabaseDialect, readConfig } from './config.ts';
import { voidDbBundlerPlugin } from './plugin-drizzle.ts';

const envModuleFile = fileURLToPath(import.meta.resolve('#self/_env'));
// The package's built modules, where the env runtime and its AsyncLocalStorage live.
const packageDistDir = `${normalizePath(dirname(dirname(envModuleFile)))}/`;
const REQUEST_SCOPE_PLUGIN = '#void/nitro-request-scope';

/** The parts of a Nitro instance that the module uses. */
type NitroInstance = {
  options: {
    dev: boolean;
    rootDir: string;
    buildDir: string;
    exportConditions?: Array<string>;
    plugins: Array<string>;
    virtual: Record<string, string | (() => string | Promise<string>)>;
    rollupConfig?: { plugins?: unknown };
    buildPlugins?: Array<unknown>;
    noExternals?: boolean | Array<string | RegExp>;
    cloudflare?: { nodeCompat?: boolean };
    devServer?: { runner?: string };
  };
};

const NODEJS_COMPAT_FLAGS = new Set(['nodejs_compat', 'nodejs_compat_v2']);

/**
 * `path` as Nitro's Rollup names its modules: with backslashes on Windows, as its node-resolve
 * plugin returns them. That plugin looks up an absolute import, such as the `global` polyfill
 * Nitro adds to pg, by walking up from the importer to a package.json. From a module named with
 * forward slashes there, the walk does not stop at the drive root, so it never ends when no
 * package.json is above the module.
 */
function nitroModuleId(path: string): string {
  return process.platform === 'win32' ? resolveWindowsPath(path) : path;
}

/**
 * A Nitro runtime plugin that runs each request in Void's request scope, as the Class A wrapper
 * does, so void/db keeps one PostgreSQL or MySQL client per request instead of one per query.
 */
function requestScopePluginSource(): string {
  return `import { getRuntimeEnv, withRuntimeEnv } from ${JSON.stringify(envModuleFile)};

export default function voidRequestScope(nitroApp) {
  // Nitro's Cloudflare entry and dev plugins keep the env here; a dev plugin may first set a
  // promise of it.
  if (nitroApp.h3App) {
    const handler = nitroApp.h3App.handler;
    nitroApp.h3App.handler = async (event) =>
      withRuntimeEnv(await globalThis.__env__, () => handler.call(nitroApp.h3App, event));
  } else {
    // Nitro 3 exposes fetch directly instead of the H3 v1 handler.
    const fetch = nitroApp.fetch;
    nitroApp.fetch = async (...args) =>
      withRuntimeEnv((await globalThis.__env__) ?? getRuntimeEnv(), () => fetch.apply(nitroApp, args));
  }
}
`;
}

/**
 * Keep Void's `node:async_hooks` imports for workerd's own module. With its `cloudflare.nodeCompat`
 * option off, Nitro bundles a stub whose AsyncLocalStorage loses the request scope at the first
 * await.
 */
const nativeAsyncHooksPlugin: Plugin = {
  name: 'void:nitro-async-hooks',
  resolveId(id, importer) {
    if (
      id === 'node:async_hooks' &&
      importer !== undefined &&
      normalizePath(importer).startsWith(packageDistDir)
    ) {
      return { id, external: true };
    }
    return null;
  },
};

/**
 * Nitro module for apps whose server routes Nitro bundles (Nuxt and Analog). Nitro's bundler
 * does not run Vite plugins, so without this module `void/db` in a server route, page server
 * load or cron job is the package's D1 client without the app's schema. Register it in the
 * Nitro config: `modules: ['void/nitro']`.
 */
const voidNitroModule = {
  name: 'void',
  setup(nitro: NitroInstance): void {
    const { options } = nitro;
    const config = readConfig(options.rootDir);
    const dialect = getDatabaseDialect(config);
    // Nitro 2 develops in Node; Nitro 3's Cloudflare dev runner uses workerd too.
    const workerd =
      options.devServer?.runner === 'miniflare' ||
      (!options.dev && options.exportConditions?.includes('workerd') === true);
    const plugins: Array<Plugin> = [
      voidDbBundlerPlugin(options.rootDir, {
        config,
        ...(workerd && {
          sqlDriver: async (sqlDialect, entry) =>
            nitroModuleId(
              await bundleWorkerSqlDriver(sqlDialect, entry, join(options.buildDir, 'void')),
            ),
        }),
      }),
    ];
    // Nitro uses workerd's own Node modules instead of its stubs only when it finds nodejs_compat
    // in a Wrangler config, and Void's Cloudflare config is not one it reads. Deploys add the flag
    // for PostgreSQL and MySQL, whose drivers need it. Otherwise the Worker gets the Cloudflare
    // config's flags, or in a managed deploy `worker.compatibility_flags` when those are set: a
    // Worker built for native modules does not start without the flag.
    const nodeCompat = (flags: Array<string> | undefined) =>
      flags?.some((flag) => NODEJS_COMPAT_FLAGS.has(flag)) === true;
    const cloudflareFlags = config.cloudflare?.compatibility_flags;
    if (
      workerd &&
      (dialect !== 'sqlite' ||
        (nodeCompat(cloudflareFlags) &&
          nodeCompat(config.worker?.compatibility_flags ?? cloudflareFlags)))
    ) {
      options.cloudflare ??= {};
      options.cloudflare.nodeCompat ??= true;
    }
    // D1 apps keep Nitro's requests as they are: in a request scope, void/db reads D1 through
    // a replica-capable session instead of the primary.
    if (dialect !== 'sqlite') {
      options.virtual[REQUEST_SCOPE_PLUGIN] = requestScopePluginSource();
      options.plugins.push(REQUEST_SCOPE_PLUGIN);
      if (workerd) {
        plugins.push(nativeAsyncHooksPlugin);
      }
    }
    if (options.buildPlugins) {
      if (workerd && options.noExternals !== true) {
        // Nitro's development preset externalizes dependencies for Node by default.
        // These modules must be bundled so the SQL driver hooks run for workerd.
        options.noExternals = [
          ...(Array.isArray(options.noExternals) ? options.noExternals : []),
          'drizzle-orm',
          packageDistDir,
        ];
      }
      // Nitro 3 uses these hooks for both bundled and unbundled development.
      options.buildPlugins.unshift(...plugins.map((plugin) => ({ ...plugin, enforce: 'pre' })));
      return;
    }
    const rollupConfig = (options.rollupConfig ??= {});
    const existing = rollupConfig.plugins;
    // Nitro adds its own resolvers after these, so `void/db` never reaches them.
    rollupConfig.plugins = [
      ...plugins,
      ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
    ];
  },
};

export default voidNitroModule;
