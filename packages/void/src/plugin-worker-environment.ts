import { readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'pathslash';
import { type Plugin } from 'vite';
import { ensureWranglerCompat, type WranglerCompat } from './cli/wrangler.ts';
import { readConfig, isNodeTarget, type DatabaseDialect } from './config.ts';

const CLOUDFLARE_BUILTIN_IMPORT = /^cloudflare:/;

const SANDBOX_SDK_IMPORT = '@cloudflare/sandbox';

const SANDBOX_SDK_IMPORT_FILTER = /^@cloudflare\/sandbox$/;

export const DEFAULT_WORKER_ENVIRONMENT_NAME = 'void_worker';

const DEFAULT_WORKER_OUT_DIR = 'dist/ssr';

export const DEV_ASSET_ROUTING_EXCLUSIONS: Array<string> = [
  '!/@vite/*',
  '!/@id/*',
  '!/@fs/*',
  '!/@react-refresh',
  '!/@svelte/*',
  '!/node_modules/*',
  '!/__uno.css',
];

function resolveSandboxSdkEntry(): string {
  return fileURLToPath(import.meta.resolve(SANDBOX_SDK_IMPORT));
}

export function createCloudflareBuiltinsExternalPlugin(): Plugin {
  return {
    name: 'void:cloudflare-builtins-external',
    config(_, env) {
      if (env.command !== 'build') {
        return;
      }

      return {
        build: {
          rollupOptions: {
            external: [CLOUDFLARE_BUILTIN_IMPORT],
          },
        },
      };
    },
  };
}

/**
 * Send a bare `void` import in server code to the handler helpers (`defineScheduled`,
 * `defineQueue`, ...), as Void apps and the cron/queue deploy bundles do. The package entry is the
 * Vite plugin: loaded in a worker environment, it pulls Wrangler into the dependency optimizer.
 */
export function createBareVoidRedirectPlugin(): Plugin {
  let handlerFile: string | undefined;
  return {
    name: 'void:bare-void-redirect',
    resolveId: {
      order: 'pre',
      filter: { id: /^void$/ },
      handler() {
        if (this.environment?.config.consumer === 'client') {
          return;
        }
        handlerFile ??= fileURLToPath(import.meta.resolve('#self/handler'));
        return handlerFile;
      },
    },
  };
}

export function createDefaultWorkerEnvironmentPlugin(): Plugin {
  return {
    name: 'void:default-worker-environment',
    config(config) {
      const currentEnvironment = config.environments?.[DEFAULT_WORKER_ENVIRONMENT_NAME];
      return {
        environments: {
          [DEFAULT_WORKER_ENVIRONMENT_NAME]: {
            ...currentEnvironment,
            build: {
              ...currentEnvironment?.build,
              outDir: currentEnvironment?.build?.outDir ?? DEFAULT_WORKER_OUT_DIR,
            },
          },
        },
      };
    },
  };
}

export function createWorkerEnvironmentSanitizerPlugin(
  environmentNames: ReadonlyArray<string>,
): Plugin {
  const names = new Set(environmentNames);
  return {
    name: 'void:worker-environment-sanitizer',
    enforce: 'pre',
    configResolved(config) {
      for (const name of names) {
        const resolve = config.environments[name]?.resolve;
        if (resolve && 'external' in resolve) {
          // Test runners may seed Node externals into every Vite environment.
          // Cloudflare Worker environments cannot externalize dependencies, but
          // Cloudflare's validator expects the normalized array shape to remain.
          resolve.external = [];
        }
      }
    },
  };
}

export function createSandboxSdkResolvePlugin(): Plugin {
  let resolved: string | undefined;

  return {
    name: 'void:sandbox-sdk-resolve',
    enforce: 'pre',
    resolveId: {
      filter: { id: SANDBOX_SDK_IMPORT_FILTER },
      handler(id) {
        if (id !== SANDBOX_SDK_IMPORT) {
          return;
        }
        resolved ??= resolveSandboxSdkEntry();
        return resolved;
      },
    },
  };
}

export function createWranglerCompatPersistPlugin(
  root: string,
  config: ReturnType<typeof readConfig>,
): Plugin {
  let persisted = false;
  const persist = () => {
    if (persisted || isNodeTarget(config.target)) {
      return;
    }
    persisted = true;
    ensureWranglerCompat(root, config);
  };

  return {
    name: 'void:wrangler-compat-persist',
    buildStart() {
      persist();
    },
    configureServer() {
      persist();
    },
  };
}

// void/db leaves its driver import to drizzle, so these nested prebundles serve it.
const DATABASE_DRIVER_DEPS: Record<DatabaseDialect, Array<string>> = {
  sqlite: [],
  postgresql: ['void > pg'],
  mysql: ['void > mysql2'],
};

const NODE_BUILTIN = new RegExp(`^(?:node:)?(?:${builtinModules.join('|')})$`);
const NODE_BUILTIN_REQUIRE_PREFIX = '\0void:node-require:';

/**
 * The Node built-ins that workerd provides for the given compatibility settings, from the preset
 * the Cloudflare plugin builds Workers with (a dependency of `@cloudflare/vite-plugin`). Before
 * 2025-09-15 the preset fills in parts of `node:process` instead of listing it, but workerd
 * provides that module at every date.
 */
async function readWorkerdNodeBuiltins(compat: WranglerCompat): Promise<Set<string>> {
  const vitePlugin = fileURLToPath(import.meta.resolve('@cloudflare/vite-plugin'));
  const manifestPath = createRequire(vitePlugin).resolve('@cloudflare/unenv-preset/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    exports: { '.': { import: string } };
  };
  const { getCloudflarePreset } = (await import(
    pathToFileURL(join(dirname(manifestPath), manifest.exports['.'].import)).href
  )) as {
    getCloudflarePreset(compat: { compatibilityDate: string; compatibilityFlags: Array<string> }): {
      external: Array<string>;
    };
  };
  const { external } = getCloudflarePreset({
    compatibilityDate: compat.compatibilityDate,
    compatibilityFlags: compat.compatibilityFlags ?? [],
  });
  return new Set([...external.map((name) => name.replace(/^node:/, '')), 'process']);
}

export function createServerRuntimeOptimizerPlugin(
  dialect: DatabaseDialect,
  readCompat: () => WranglerCompat,
): Plugin {
  let workerdNodeBuiltins: Promise<Set<string>> | undefined;
  const serverRuntimeOptimizerPlugin: Plugin = {
    name: 'void:server-runtime-optimizer',
    configEnvironment(name, environment) {
      if (name === 'client') {
        return;
      }
      // The Cloudflare plugin gives every environment it runs in workerd these conditions from
      // its config hook, which runs before any configEnvironment hook. That covers Void's own
      // worker, class A frameworks and adapters such as @astrojs/cloudflare. Node runtimes load
      // CommonJS themselves, and an include there turns on SSR prebundling nobody asked for.
      if (!environment.resolve?.conditions?.includes('workerd')) {
        return { optimizeDeps: { exclude: ['void'] } };
      }
      return {
        optimizeDeps: {
          // `better-auth` keeps OAuth request state on a module-local ref. Prebundling an app
          // import of `better-auth/api` while this excluded package loads `better-auth` from
          // source gives the dev worker two copies, so `getOAuthState()` misses the state the
          // runtime set. A production build already bundles one copy.
          exclude: ['void', 'better-auth'],
          // Excluding void also skips converting its CommonJS dependencies, which workerd cannot
          // evaluate: an installed void/email fails with "exports is not defined".
          include: ['void > email-validator', ...DATABASE_DRIVER_DEPS[dialect]],
        },
      };
    },
    // A build bundles void/db's driver, which is CommonJS. The Cloudflare plugin turns its requires
    // of Node built-ins that workerd provides into imports with rolldown's esmExternalRequirePlugin,
    // but rolldown skips that plugin unless the Vite copy running the build made it. pnpm installs
    // Vite once per set of peers, so the app's Vite can differ from the one the Cloudflare plugin
    // imports, and each require then throws in workerd. Serve those built-ins from an import here.
    // A require of any other built-in stays as it is and throws only if it runs.
    resolveId: {
      // Before Vite's resolver, which makes a required built-in external.
      order: 'pre',
      filter: { id: NODE_BUILTIN },
      async handler(id, _importer, options) {
        if (
          dialect === 'sqlite' ||
          options.kind !== 'require-call' ||
          this.environment?.mode !== 'build' ||
          !this.environment.config.resolve.conditions.includes('workerd')
        ) {
          return;
        }
        const name = id.replace(/^node:/, '');
        workerdNodeBuiltins ??= readWorkerdNodeBuiltins(readCompat());
        if (!(await workerdNodeBuiltins).has(name)) {
          return;
        }
        return `${NODE_BUILTIN_REQUIRE_PREFIX}${name}`;
      },
    },
    load: {
      // oxlint-disable-next-line no-control-regex -- \0 prefix is Vite's virtual module convention
      filter: { id: /^\0void:node-require:/ },
      handler(id) {
        // A built-in's default export is its CommonJS exports, and `require` returns an ES
        // module's "module.exports" export.
        const name = id.slice(NODE_BUILTIN_REQUIRE_PREFIX.length);
        return `import builtin from "node:${name}";\nexport { builtin as "module.exports" };\n`;
      },
    },
  };

  return serverRuntimeOptimizerPlugin;
}
