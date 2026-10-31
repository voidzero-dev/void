import { fileURLToPath } from 'node:url';
import { dirname } from 'pathslash';
import { defaultServerConditions, type Plugin } from 'vite';
import { type ApplicationAnalysis } from './application-analysis.ts';
import {
  ensureWranglerCompat,
  ensureWranglerCompatibilityDate,
  ensureWranglerNodejsAlsFlag,
  readWranglerCompat,
  resolveLiveBindingConfig,
  syncWranglerBindings,
} from './cli/wrangler.ts';
import { getDatabaseCasing, readConfig } from './config.ts';
import { findDependencyClosure, findVoidDependentPackages } from './installed-packages.ts';
import { resolveLocalD1Target } from './local-d1.ts';
import { voidLog } from './log.ts';
import { bindingRuntimePlugin } from './plugin-binding-runtime.ts';
import { devTriggerSecretGuardPlugin } from './plugin-dev-config.ts';
import { devTriggersHintPlugin } from './plugin-dev-triggers-hint.ts';
import { drizzlePlugin } from './plugin-drizzle.ts';
import { envClientFoldPlugin } from './plugin-env-client-fold.ts';
import { envClientGuardPlugin } from './plugin-env-client-guard.ts';
import { envSchemaPlugin } from './plugin-env-schema.ts';
import {
  analogDevTriggerInjectPlugin,
  astroDevTriggerInjectPlugin,
  frameworkTriggersDispatchPath,
  frameworkTriggersPlugin,
  hasOwnAstroMiddleware,
  nitroDevTriggerInjectPlugin,
} from './plugin-framework-triggers.ts';
import { migrationPlugin } from './plugin-migration.ts';
import {
  createBareVoidRedirectPlugin,
  createCloudflareBuiltinsExternalPlugin,
} from './plugin-worker-environment.ts';
import { injectSvelteKitBuildHooks, injectSvelteKitHooks } from './sveltekit-hooks-transform.ts';

const handlerFile = fileURLToPath(import.meta.resolve('#self/handler'));
const envModuleFile = fileURLToPath(import.meta.resolve('#self/_env'));
// Packages Void depends on are installed for code in this directory.
const voidDir = dirname(fileURLToPath(import.meta.url));

const ASTRO_SERVER_ENTRY = '@astrojs/cloudflare/entrypoints/server';
const ASTRO_SCOPED_SERVER_ENTRY = '\0void:astro-server-entry';

const PRACHT_SERVER_ENTRY = 'virtual:pracht/server';
const PRACHT_DEV_SERVER_ENTRY = '\0void:pracht-dev-server-entry';

export function createFrameworkPlugins(input: {
  readonly localD1: ReturnType<typeof resolveLocalD1Target>;
  readonly root: string;
  readonly directCloudflareDestination: boolean;
  readonly bindings: ApplicationAnalysis['bindings'];
  readonly config: ReturnType<typeof readConfig>;
  readonly dialect: ApplicationAnalysis['dialect'];
  readonly application: ApplicationAnalysis;
  readonly bindingNames: ApplicationAnalysis['bindingNames'];
  readonly websocketRoutes: ApplicationAnalysis['allWebsockets'];
  readonly liveConfig: ReturnType<typeof resolveLiveBindingConfig> | undefined;
  readonly detected: NonNullable<ApplicationAnalysis['framework']>;
  readonly clientStubsPlugin: Plugin;
  readonly serverRuntimeOptimizerPlugin: Plugin;
  readonly devTriggerToken: string;
  readonly implicitDeployGuard: Plugin;
}): Array<Plugin> {
  const {
    localD1,
    root,
    directCloudflareDestination,
    bindings,
    config,
    dialect,
    application,
    bindingNames,
    websocketRoutes,
    liveConfig,
    detected,
    clientStubsPlugin,
    serverRuntimeOptimizerPlugin,
    devTriggerToken,
    implicitDeployGuard,
  } = input;
  const frameworkPersistRoot = localD1.persistRoot;
  const syncFrameworkCompat = (compat: ReturnType<typeof readWranglerCompat>) => {
    const syncedDate = ensureWranglerCompatibilityDate(root, compat.compatibilityDate);
    if (syncedDate) {
      voidLog('Synced compatibility_date to Cloudflare config');
    }
  };

  // Adapters read the root Wrangler file by default, so a project with no config gets
  // the date there instead of in a new void.config.ts.
  const ensureFrameworkCompat = () =>
    ensureWranglerCompat(root, config, undefined, { rootWrangler: true });

  // Ensure required compat flags are written before framework adapters
  // initialize Cloudflare dev runtime / Miniflare.
  const wranglerCompatPlugin: Plugin = {
    name: 'void:wrangler-compat',
    enforce: 'pre',
    config(_, env) {
      syncFrameworkCompat(ensureFrameworkCompat());
      if (env.command !== 'serve') {
        return;
      }
      const synced = ensureWranglerNodejsAlsFlag(root);
      if (synced) {
        voidLog('Synced nodejs_als to Cloudflare config');
      }
    },
    buildStart() {
      syncFrameworkCompat(ensureFrameworkCompat());
    },
    configureServer() {
      syncFrameworkCompat(ensureFrameworkCompat());
    },
  };

  // Sync before framework adapters read Wrangler during Vite configuration.
  // Repeat at configResolved for adapters that create the file later.
  const syncFrameworkBindings = (command: string): void => {
    if (command !== 'serve') {
      return;
    }
    const synced = syncWranglerBindings(
      root,
      {
        ...bindings,
        needsD1: dialect === 'sqlite' && application.needsDatabase,
      },
      {
        bindingNames,
        ...(directCloudflareDestination && bindings.needsAI
          ? { directCloudflareAi: { gateway: config.ai?.gateway } }
          : {}),
        websockets: websocketRoutes,
        live: liveConfig,
      },
    );
    if (synced) {
      voidLog('Synced bindings to Cloudflare config');
    }
  };

  const wranglerSyncPlugin: Plugin = {
    name: 'void:wrangler-sync',
    enforce: 'pre',
    config(_, env) {
      syncFrameworkBindings(env.command);
    },
    configResolved(resolvedConfig) {
      syncFrameworkCompat(readWranglerCompat(root, config));
      syncFrameworkBindings(resolvedConfig.command);
    },
  };

  // Nuxt's SSR Vite server can inherit the client HTTP server while also
  // receiving its own HMR port. That attaches two upgrade handlers to the
  // same socket under current Vite, so keep the SSR transport on its
  // dedicated port. Update both keys for Vite 7 and Vite 8 compatibility.
  const nuxtVite8WebSocketCompatPlugin: Plugin | undefined =
    detected.name === 'nuxt'
      ? {
          name: 'void:nuxt-vite8-websocket-compat',
          enforce: 'post',
          configResolved(resolvedConfig) {
            if (!resolvedConfig.build.ssr) {
              return;
            }
            if (
              typeof resolvedConfig.server.hmr === 'object' &&
              resolvedConfig.server.hmr.port !== undefined
            ) {
              resolvedConfig.server.hmr = {
                ...resolvedConfig.server.hmr,
                server: undefined,
              };
            }
            if (
              typeof resolvedConfig.server.ws === 'object' &&
              resolvedConfig.server.ws.port !== undefined
            ) {
              resolvedConfig.server.ws = {
                ...resolvedConfig.server.ws,
                server: undefined,
              };
            }
          },
        }
      : undefined;

  // SvelteKit hooks injection: transform get_hooks() to wrap `handle` with
  // withRuntimeEnv(adapter env, ...). Kit 2 passes event.platform.env;
  // Kit 3 exposes cloudflare:workers. This stores the env in
  // AsyncLocalStorage so void/db resolves it via envContext.getStore(), and
  // intercepts /__void/scheduled and /__void/queue so cron and queue
  // handlers run with the framework adapter's real bindings.
  // Single Miniflare instance (adapter-cloudflare's), no private APIs.
  const svelteKitHooksInjectPlugin: Plugin = {
    name: 'void:sveltekit-hooks-inject',
    apply: 'serve',
    config() {
      if (detected.class !== 'b') {
        return;
      }
      // Kit's dev server runs server code in Vite's Node SSR graph. That graph
      // externalizes a bare import resolving into node_modules before any plugin
      // sees it, so an installed void/db would load the package's D1 runtime
      // instead of the virtual module. Inlining keeps every void import, including
      // the injected env import below and those of PostgreSQL and MySQL apps'
      // installed packages that import void, in the graph that holds void/db's env
      // module. In a D1 app, a package's own void/db reads the same D1 binding, so
      // those packages stay with Node, unless `database.casing` is set: only the
      // virtual module applies it.
      const inlineDependents = dialect !== 'sqlite' || getDatabaseCasing(config) !== undefined;
      return {
        ssr: {
          noExternal: ['void', ...(inlineDependents ? findVoidDependentPackages(root) : [])],
        },
      };
    },
    resolveId: {
      order: 'pre',
      filter: { id: /^void$/ },
      handler() {
        if (detected.class !== 'b' || this.environment?.name === 'client') {
          return;
        }
        // Inlined, the package entry would load the whole Vite plugin into Kit's module
        // runner. Server code gets the lightweight handler subpath, as in Void apps.
        return handlerFile;
      },
    },
    transform(code, id) {
      if (detected.class !== 'b') {
        return;
      }
      if (
        !id.includes('.svelte-kit/generated/server/internal') &&
        !id.includes('.svelte-kit/generated/dev/server.js')
      ) {
        return;
      }
      return injectSvelteKitHooks(code, id, frameworkTriggersDispatchPath(root));
    },
  };

  // Astro's Cloudflare adapter owns the Worker entry. Void wraps its default entry:
  // - For PostgreSQL and MySQL, each request runs inside Void's request scope
  //   (`withRuntimeEnv`), as the Class A wrapper does, so void/db keeps one client per request
  //   instead of one per query. D1 apps run without it: inside a request scope, void/db reads D1
  //   through a replica-capable session instead of the primary.
  // - In dev, Void's own middleware answers `/__void/scheduled` and `/__void/queue`
  //   (`astroDevTriggerInjectPlugin`). When the app has its own middleware, Void cannot add
  //   one, so the wrapper sends these requests to the generated trigger dispatch before Astro
  //   sees them. A build never imports the dispatch file, which exists only in dev and embeds
  //   the dev-trigger token.
  const scopeAstroRequests = dialect !== 'sqlite';
  let astroDevTriggers = false;
  const astroServerEntryPlugin: Plugin | undefined =
    detected.name === 'astro'
      ? {
          name: 'void:astro-server-entry',
          enforce: 'pre',
          configResolved(resolvedConfig) {
            astroDevTriggers = resolvedConfig.command === 'serve' && hasOwnAstroMiddleware(root);
          },
          resolveId: {
            filter: { id: /^@astrojs\/cloudflare\/entrypoints\/server(?:\.js)?$/ },
            handler(_id, importer) {
              if (
                (!scopeAstroRequests && !astroDevTriggers) ||
                importer === ASTRO_SCOPED_SERVER_ENTRY ||
                this.environment?.name === 'client'
              ) {
                return;
              }
              return ASTRO_SCOPED_SERVER_ENTRY;
            },
          },
          load: {
            // oxlint-disable-next-line no-control-regex -- \0 prefix is Vite's virtual module convention
            filter: { id: /^\0void:astro-server-entry$/ },
            handler() {
              const imports = [
                `import original from ${JSON.stringify(ASTRO_SERVER_ENTRY)};`,
                ...(scopeAstroRequests
                  ? [`import { withRuntimeEnv } from ${JSON.stringify(envModuleFile)};`]
                  : []),
                ...(astroDevTriggers
                  ? [
                      `import { handleDevTrigger } from ${JSON.stringify(frameworkTriggersDispatchPath(root))};`,
                    ]
                  : []),
              ];
              const handle = astroDevTriggers
                ? 'async () => (await handleDevTrigger(request, env, ctx)) ?? original.fetch(request, env, ctx)'
                : '() => original.fetch(request, env, ctx)';
              return `${imports.join('\n')}
export * from ${JSON.stringify(ASTRO_SERVER_ENTRY)};

export default {
  ...original,
  fetch(request, env, ctx) {
    const handle = ${handle};
    return ${scopeAstroRequests ? 'withRuntimeEnv(env, handle)' : 'handle()'};
  },
};
`;
            },
          },
        }
      : undefined;

  // Pracht loads routes lazily, so its entry imports the env module up front; otherwise the
  // first void/db call can run before `cloudflare:workers` has settled. Only dev wraps the
  // entry for triggers: `void deploy` wraps the built `worker.js` instead.
  let prachtServe = false;
  const prachtServerEntryPlugin: Plugin | undefined =
    detected.name === 'pracht'
      ? {
          name: 'void:pracht-server-entry',
          enforce: 'pre',
          configResolved(resolvedConfig) {
            prachtServe = resolvedConfig.command === 'serve';
          },
          transform: {
            filter: { id: /^virtual:pracht\/server$/ },
            handler(code) {
              if (this.environment?.name === 'client') {
                return;
              }
              return { code: `import ${JSON.stringify(envModuleFile)};\n${code}`, map: null };
            },
          },
          resolveId: {
            filter: { id: /^virtual:pracht\/server$/ },
            handler(_id, importer) {
              if (
                !prachtServe ||
                importer === PRACHT_DEV_SERVER_ENTRY ||
                this.environment?.name === 'client'
              ) {
                return;
              }
              return PRACHT_DEV_SERVER_ENTRY;
            },
          },
          load: {
            // oxlint-disable-next-line no-control-regex -- \0 prefix is Vite's virtual module convention
            filter: { id: /^\0void:pracht-dev-server-entry$/ },
            handler() {
              const scoped = dialect !== 'sqlite';
              const body = `    if (request.method === "POST") {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/__void/scheduled" || pathname === "/__void/queue") {
        const { handleDevTrigger } = await import(${JSON.stringify(frameworkTriggersDispatchPath(root))});
        const response = await handleDevTrigger(request, env, ctx);
        if (response) return response;
      }
    }
    return original.fetch(request, env, ctx);`;
              return `import original from ${JSON.stringify(PRACHT_SERVER_ENTRY)};
${scoped ? `import { withRuntimeEnv } from ${JSON.stringify(envModuleFile)};\n` : ''}export * from ${JSON.stringify(PRACHT_SERVER_ENTRY)};

export default {
  ...original,
${
  scoped
    ? `  fetch(request, env, ctx) {
    return withRuntimeEnv(env, async () => {
${body.replace(/^/gm, '  ')}
    });
  },`
    : `  async fetch(request, env, ctx) {
${body}
  },`
}
};
`;
            },
          },
        }
      : undefined;

  // SvelteKit builds its server in Vite's Node `ssr` environment, and the adapter's Worker runs
  // that output as it is. For PostgreSQL and MySQL, void/db's driver then fails in workerd: pg
  // loads pg-cloudflare's Node stub, and CommonJS requires of Node built-ins become
  // `createRequire(import.meta.url)`. A driver that Vite can resolve from the app root (npm, Yarn
  // and Bun installs, or an app that lists it) even stays external, and Void's browser-target
  // packaging bundles it with browser stubs. Build void/db as the Cloudflare plugin builds
  // Workers: void, drizzle-orm, the driver with every package it depends on, and installed
  // packages that import void. Other dependencies stay external, as in Kit's own build: Kit's
  // analyse step loads this output in Node, and a package's `workerd` build may import
  // `cloudflare:` modules (capnweb does). Run each request in Void's request scope, as in dev, so
  // void/db keeps one client per request. D1 apps keep Kit's output: in a request scope, void/db
  // reads D1 through a replica-capable session instead of the primary.
  const svelteKitWorkerBuildPlugin: Plugin | undefined =
    detected.class === 'b' && dialect !== 'sqlite'
      ? {
          name: 'void:sveltekit-worker-build',
          apply: 'build',
          enforce: 'pre',
          configEnvironment(name, environment) {
            if (name !== 'ssr') {
              return;
            }
            return {
              resolve: {
                conditions: environment.resolve?.conditions
                  ? ['workerd', 'worker']
                  : ['workerd', 'worker', ...defaultServerConditions],
                noExternal: [
                  'void',
                  // By name as well: a Yarn PnP install has no node_modules to read. The
                  // driver's own dependencies then resolve only through it, so they are bundled.
                  'drizzle-orm',
                  dialect === 'mysql' ? 'mysql2' : 'pg',
                  ...findDependencyClosure('drizzle-orm', voidDir),
                  ...findDependencyClosure(dialect === 'mysql' ? 'mysql2' : 'pg', voidDir),
                  ...findVoidDependentPackages(root),
                ],
              },
              // Node output binds `require` at load with createRequire(import.meta.url). Neutral
              // output throws only when a require runs, as for mysql2's optional `cardinal`.
              build: { rolldownOptions: { platform: 'neutral' } },
            };
          },
          transform(code, id) {
            if (
              !id.includes('.svelte-kit/generated/server/internal') &&
              !id.includes('.svelte-kit/generated/build/server.js')
            ) {
              return;
            }
            return injectSvelteKitBuildHooks(code, id, envModuleFile);
          },
        }
      : undefined;

  // A D1 build keeps Kit's output, so installed packages that import void stay external and
  // load their own void/db. Only the virtual module applies `database.casing`: bundle them when
  // it is set, as the dev server inlines them.
  const svelteKitD1CasingBuildPlugin: Plugin | undefined =
    detected.class === 'b' && dialect === 'sqlite' && getDatabaseCasing(config) !== undefined
      ? {
          name: 'void:sveltekit-d1-casing-build',
          apply: 'build',
          configEnvironment(name) {
            if (name !== 'ssr') {
              return;
            }
            return { resolve: { noExternal: findVoidDependentPackages(root) } };
          },
        }
      : undefined;

  return [
    devTriggerSecretGuardPlugin(),
    createCloudflareBuiltinsExternalPlugin(),
    wranglerCompatPlugin,
    wranglerSyncPlugin,
    ...(nuxtVite8WebSocketCompatPlugin ? [nuxtVite8WebSocketCompatPlugin] : []),
    ...(astroServerEntryPlugin ? [astroServerEntryPlugin] : []),
    ...(prachtServerEntryPlugin ? [prachtServerEntryPlugin] : []),
    svelteKitHooksInjectPlugin,
    ...(svelteKitWorkerBuildPlugin ? [svelteKitWorkerBuildPlugin] : []),
    ...(svelteKitD1CasingBuildPlugin ? [svelteKitD1CasingBuildPlugin] : []),
    clientStubsPlugin,
    // Also serves the Node built-ins that the driver requires in SvelteKit's workerd build.
    serverRuntimeOptimizerPlugin,
    bindingRuntimePlugin(bindingNames),
    // Framework-agnostic env DX: typegen, client leak guard, and build-time
    // folding all operate on env.ts + the Vite client module graph, so they
    // apply equally to SvelteKit/Nuxt/Analog/Astro. We intentionally omit
    // envPlugin itself — it mutates workerConfig.vars for Void's own CF
    // build, which Class B/C frameworks don't go through.
    envSchemaPlugin(root),
    envClientGuardPlugin(root),
    envClientFoldPlugin(),
    drizzlePlugin(root, false, dialect, {
      d1BindingName: bindingNames?.d1,
      forceVirtualDb: bindingNames?.d1 !== undefined,
      casing: getDatabaseCasing(config),
      localD1DatabaseId: localD1.databaseId,
      localD1PersistRoot: frameworkPersistRoot,
      nitroBundlesServer: detected.name === 'nuxt' || detected.name === 'analog',
    }),
    migrationPlugin(root, dialect, localD1.databaseId, frameworkPersistRoot, {
      enabled: false,
    }),
    devTriggersHintPlugin(root, devTriggerToken),
    frameworkTriggersPlugin(root, { devTriggerToken }),
    ...(detected.name === 'nuxt'
      ? [nitroDevTriggerInjectPlugin(root, { serverDir: 'server' })]
      : []),
    ...(detected.name === 'analog' ? [analogDevTriggerInjectPlugin(root)] : []),
    // Astro runs its server code, the dev cron and queue dispatch included, in workerd.
    ...(detected.name === 'astro'
      ? [createBareVoidRedirectPlugin(), astroDevTriggerInjectPlugin(root)]
      : []),
    ...(detected.name === 'pracht' ? [createBareVoidRedirectPlugin()] : []),
    implicitDeployGuard,
  ];
}
