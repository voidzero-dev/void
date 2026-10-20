import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'pathslash';
import { normalizePath, type Plugin } from 'vite';
import type { ApplicationAnalysis } from './application-analysis.ts';
import { completeApplicationAnalysis } from './application-routing.ts';
import {
  hasApiRoutes,
  hasDocumentRoutes,
  resolveAssetRoutingPolicy,
  type AssetRoutingPolicy,
} from './asset-routing.ts';
import { loadVoidAuthConfig } from './auth/config.ts';
import { lintRoutingPhases, mergeRoutingRules } from './cli/headers.ts';
import { stampClientAssetCachePolicy } from './client-asset-manifest.ts';
import { findEnvFileForPaths } from './codegen/env-types.ts';
import { generateQueueTypes } from './codegen/queue-types.ts';
import { generateRouteTypes } from './codegen/route-types.ts';
import { writeFileIfChanged } from './codegen/write-if-changed.ts';
import { readConfig, getDatabaseDialect } from './config.ts';
import { collectPages, collectRevalidate, hasRevalidate } from './isr-config.ts';
import { readProjectPaths } from './project-paths.ts';
import {
  compileRouteTable,
  compileBrowserClient,
  compileWorkerEntry,
  compileWorkerClient,
  compileNodeApp,
  compileNodeServer,
  type CompileOptions,
  type SsrCompileOptions,
  type PagesCompileOptions,
  type WorkerEntryOptions,
} from './router/compile.ts';
import type { RouteEnvironment } from './router/parse-filename.ts';
import type { ScanResult } from './router/scan.ts';
import type { VoidAuthRuntimeOptions } from './runtime/better-auth-shared.ts';
import { loadLocalEnv } from './shared/env.ts';
import {
  validateSsrEntries,
  SSR_SERVER_ENTRY_RELATIVE_PATHS,
  SSR_CLIENT_ENTRY_RELATIVE_PATHS,
} from './ssr/entry.ts';

const VIRTUAL_ROUTES_ID = 'virtual:void-routes';
const VIRTUAL_CLIENT_WORKER_ID = 'virtual:void-client-worker';
const VIRTUAL_CLIENT_BROWSER_ID = 'virtual:void-client-browser';
const AUTH_CLIENT_FRAMEWORKS = ['react', 'vue', 'svelte', 'solid'] as const;
type AuthClientFramework = (typeof AUTH_CLIENT_FRAMEWORKS)[number];
const CLIENT_IMPORT_RE = /^void\/client(?:\/(react|vue|svelte|solid))?$/;
const VIRTUAL_CLIENT_RE = /^virtual:void-client-(browser|worker)(?::(react|vue|svelte|solid))?$/;
const PAGE_VIRTUAL_MODULE_IDS = [
  '\0virtual:void-pages-renderer',
  '\0virtual:void-pages-client',
  '\0virtual:void-islands-renderer',
  '\0virtual:void-islands-client',
];
// Rolldown resolveId hook filters currently require RegExp for `id`.
const RESOLVE_ID_FILTER =
  /^(virtual:void-(routes|client-worker(?::(react|vue|svelte|solid))?|client-browser(?::(react|vue|svelte|solid))?)|void(\/client(\/(react|vue|svelte|solid))?|\/queues)?)$/;
const LOAD_ID_FILTER =
  /^virtual:void-(routes|client-worker(?::(react|vue|svelte|solid))?|client-browser(?::(react|vue|svelte|solid))?)$/;

type RoutingPluginOptions = {
  getApplicationAnalysis: (environment: RouteEnvironment, refresh?: boolean) => ApplicationAnalysis;
  isAuthEnabled: () => boolean;
  getVersionMetadataBinding?: () => string | undefined;
  devTriggerToken?: string;
  headConfig?: import('./pages/head.ts').HeadConfig;
  prerenderPaths?: Array<string>;
  remoteMode?: boolean;
  bindingNames?: { d1?: string; kv?: string; r2?: string };
  target?: 'node' | 'bun' | 'deno';
  /** Merged with `_redirects` / `_headers` under Vite's `publicDir`; config rules take precedence. */
  routing?: import('./config.ts').RoutingConfig;
  hasSandbox?: boolean;
  sandboxBindingName?: string;
  sandboxClassName?: string;
  sandboxInstanceType?: string;
  live?: { bindingName: string; className: string };
  durableObjects?: Array<{
    bindingName: string;
    className: string;
    filePath: string;
    name?: string;
  }>;
  /** Data-preserving exports for removed WebSocket Durable Object routes. */
  websocketTombstones?: Array<string>;
  onDevAssetRoutingPolicyChange?: (policy: AssetRoutingPolicy) => boolean;
};

/**
 * Vite plugin that provides file-based routing.
 * - Scans routes/ and middleware/ directories
 * - Generates virtual modules for the route table and worker entry
 * - Watches for file changes and triggers HMR
 */
export function routingPlugin(root: string, options: RoutingPluginOptions): Plugin {
  let scan: ScanResult | null = null;
  let routeEnvironment: RouteEnvironment = 'prod';
  let previewing = false;
  let ssr: SsrCompileOptions | null = null;
  let authConfigPath: string | null = null;
  const paths = readProjectPaths(root);
  const routesDir = paths.routesDir;
  const middlewareDir = paths.middlewareDir;
  const jobsDir = paths.cronsDir;
  const queuesDir = paths.queuesDir;
  const emailDir = paths.emailDir;
  const pagesDir = paths.pagesDir;
  const ssrDir = paths.ssrDir;
  const authConfigPaths = new Set(paths.authConfigCandidates.map((path) => normalizePath(path)));
  const envFilePaths = new Set(paths.envFileCandidates.map((path) => normalizePath(path)));
  const normalizedRoutesDir = normalizePath(routesDir);
  const normalizedMiddlewareDir = normalizePath(middlewareDir);
  const normalizedJobsDir = normalizePath(jobsDir);
  const normalizedQueuesDir = normalizePath(queuesDir);
  const normalizedEmailDir = normalizePath(emailDir);
  const normalizedPagesDir = normalizePath(pagesDir);
  const ssrEntryAbsPaths = new Set(
    [...SSR_SERVER_ENTRY_RELATIVE_PATHS, ...SSR_CLIENT_ENTRY_RELATIVE_PATHS].map((path) =>
      normalizePath(join(ssrDir, path.split('/').pop()!)),
    ),
  );

  function hasEmailHandlers(): boolean {
    const email = scan?.email;
    return Boolean(email && (email.addresses.length > 0 || email.defaultHandler));
  }

  function isInDirectory(path: string, directory: string): boolean {
    return path === directory || path.startsWith(directory + '/');
  }

  function writeRouteTypes() {
    if (!scan) {
      return;
    }
    const { dts } = generateRouteTypes(scan, routesDir, outDir, pagesDir);
    writeFileIfChanged(join(outDir, 'routes.d.ts'), dts);
  }

  function writeQueueTypes() {
    if (!scan) {
      return;
    }
    const dts = generateQueueTypes(scan.queues, queuesDir, outDir);
    writeFileIfChanged(join(outDir, 'queues.d.ts'), dts);
  }

  async function rescan(refresh = false) {
    const analysis = options.getApplicationAnalysis(routeEnvironment, refresh);
    scan = (await completeApplicationAnalysis(analysis)).scan;
    authConfigPath = analysis.authConfigPath;
    const entries = validateSsrEntries(root, paths);
    ssr = entries
      ? {
          serverEntryPath: entries.server.absolutePath,
          clientEntryRelativePath: entries.client.relativePath,
        }
      : null;
  }

  // Pre-resolve all runtime module paths so generated code uses absolute paths.
  // This is necessary because:
  // 1. "void" bare import would pull in the entire plugin
  // 2. "hono" is a dep of void, not the user's project
  // 3. Virtual modules have no filesystem location for relative resolution
  const resolveFile = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));

  const handlerFile = resolveFile('#self/handler');
  const runtimeDir = dirname(resolveFile('#self/client'));
  const fetchPath = resolveFile('#self/runtime/fetch');
  const fetchStreamPath = resolveFile('#self/runtime/fetch-stream');
  const sandboxRuntimePath = resolveFile('#self/sandbox');
  const drizzleAdapterPath = resolveFile('better-auth/adapters/drizzle');
  let authClientPath = join(runtimeDir, 'auth-client.mjs');
  const explicitAuthClientPaths: Record<AuthClientFramework, string> = {
    react: join(runtimeDir, 'auth-client-react.mjs'),
    vue: join(runtimeDir, 'auth-client-vue.mjs'),
    svelte: join(runtimeDir, 'auth-client-svelte.mjs'),
    solid: join(runtimeDir, 'auth-client-solid.mjs'),
  };
  const remote = options.remoteMode
    ? {
        bindingNames: options.bindingNames,
        remotePath: resolveFile('#self/remote'),
      }
    : undefined;
  // If the project has env.ts, splice boot-time validation into the worker
  // entry. The user file path is absolute so generated entry's import resolves
  // regardless of bundler cwd; the validator helper resolves to void/env.
  function getEnvSchemaModule(): { importPath: string; helperPath: string } | undefined {
    const envFile = findEnvFileForPaths(root, paths);
    if (!envFile) {
      return undefined;
    }
    return {
      importPath: envFile,
      helperPath: resolveFile('#self/env'),
    };
  }
  const runtimeEmailPath = resolveFile('#self/email');
  const compileOptions: CompileOptions = {
    honoPath: resolveFile('hono'),
    runtimeEnvPath: resolveFile('#self/_env'),
    emailDir,
    projectRoot: root,
    homeDir: homedir(),
    webSocketRuntimePath: resolveFile('#self/runtime/ws-server'),
    liveRuntimePath: resolveFile('#self/runtime/live-server'),
    hasLive: options.live !== undefined,
    webSocketTombstones: options.websocketTombstones,
    reactRefresh: false,
    dev: false,
    devTriggerToken: options.devTriggerToken,
    auth: null,
    nodeTarget: !!options.target,
    managedDispatch: false,
    explicitPrerenderPaths: options.prerenderPaths,
    bindingHandlerPath: options.target ? undefined : resolveFile('#self/remote/binding-handler'),
    bindingNames: options.bindingNames,
  };

  // Vite's default until `configResolved` reads the real value; null when `publicDir: false`.
  let publicDir: string | null = join(root, 'public');
  function reloadFileRules(): void {
    // Config rules still apply without a public dir, and stale preload rules are cleared.
    const merged = mergeRoutingRules({ dir: publicDir, routing: options.routing });
    lintRoutingPhases(merged);
    compileOptions.headerRules = merged.headerRules.length > 0 ? merged.headerRules : undefined;
    compileOptions.redirectRules =
      merged.redirectRules.length > 0 ? merged.redirectRules : undefined;
    compileOptions.fallbackRules = merged.fallbackRules;
  }
  reloadFileRules();

  // Auth compile options are set up lazily in buildStart (after env plugin
  // has run its config hook and the auth config file path is known).
  function resolveAuthCompileOptions(): void {
    if (!options.isAuthEnabled() && !authConfigPath) {
      compileOptions.auth = null;
      return;
    }
    const config = readConfig(root);
    const dialect = getDatabaseDialect(config);
    compileOptions.auth = {
      authRuntimePath:
        dialect === 'postgresql'
          ? join(runtimeDir, 'better-auth-pg.mjs')
          : dialect === 'mysql'
            ? join(runtimeDir, 'better-auth-mysql.mjs')
            : join(runtimeDir, 'better-auth.mjs'),
      authConfigPath,
      authDatabasePath: join(outDir, 'better-auth-db.ts'),
      authSchemaPath: join(outDir, 'better-auth-schema.ts'),
      dialect,
      providers: config.auth?.providers ?? null,
    };
  }

  async function writeAuthDatabaseFiles(): Promise<void> {
    if (!compileOptions.auth) {
      return;
    }

    // Better Auth's schema helpers load zod and most of better-auth; only auth apps need them.
    const { generateVoidAuthDatabaseModule, generateVoidAuthDrizzleSchema } =
      await import('./auth/drizzle.ts');
    const authRuntime: VoidAuthRuntimeOptions = {
      dialect: compileOptions.auth.dialect,
      providers: compileOptions.auth.providers,
      userConfig: await loadVoidAuthConfig(compileOptions.auth.authConfigPath),
    };
    const local = resolvedConfig?.command === 'serve' ? loadLocalEnv(root) : {};
    const env = { ...local, ...process.env } as Record<string, unknown>;
    const { authSchemaPath, authDatabasePath } = compileOptions.auth;

    writeFileIfChanged(authSchemaPath, generateVoidAuthDrizzleSchema(authRuntime, env));
    writeFileIfChanged(
      authDatabasePath,
      generateVoidAuthDatabaseModule({
        dialect: compileOptions.auth.dialect,
        schemaImportPath: authSchemaPath,
        drizzleAdapterPath,
      }),
    );
  }

  let resolvedConfig: import('vite').ResolvedConfig | null = null;

  // ISR policy for the CURRENT build, gated by `emitIsr` (see buildStart). The
  // ordered page table is the same 3-state policy shipped to managed dispatch:
  // positive TTL, explicit 0 opt-out, or absent to inherit path config.
  let isrRevalidate: number | Record<string, number> | undefined;
  let isrPages: Array<{ pattern: string; revalidate?: number }> | undefined;
  let isrPathRevalidate: Record<string, number> | undefined;

  function resolveAuthClientPath(config: import('vite').ResolvedConfig): string {
    if (config.plugins.some((plugin) => plugin.name === 'void-react:pages')) {
      return explicitAuthClientPaths.react;
    }
    if (config.plugins.some((plugin) => plugin.name === 'void-vue:pages')) {
      return explicitAuthClientPaths.vue;
    }
    if (config.plugins.some((plugin) => plugin.name === 'void-svelte:pages')) {
      return explicitAuthClientPaths.svelte;
    }
    if (config.plugins.some((plugin) => plugin.name === 'void-solid:pages')) {
      return explicitAuthClientPaths.solid;
    }
    return join(runtimeDir, 'auth-client.mjs');
  }

  function getClientAuthPath(id: string): string {
    const framework = VIRTUAL_CLIENT_RE.exec(id)?.[2] as AuthClientFramework | undefined;
    return framework ? explicitAuthClientPaths[framework] : authClientPath;
  }

  function resolveVirtualClientId(
    id: string,
    environmentName: string | undefined,
  ): string | undefined {
    const framework = CLIENT_IMPORT_RE.exec(id)?.[1] as AuthClientFramework | undefined;
    const base =
      environmentName === 'client' ? VIRTUAL_CLIENT_BROWSER_ID : VIRTUAL_CLIENT_WORKER_ID;
    return framework ? `${base}:${framework}` : base;
  }

  function isPotentialAuthConfigPath(path: string): boolean {
    return authConfigPaths.has(normalizePath(path));
  }

  function isPotentialEnvFilePath(path: string): boolean {
    return envFilePaths.has(normalizePath(path));
  }

  function getPagesCompileOptions(): PagesCompileOptions | null {
    if (!scan || scan.pages.pages.length === 0) {
      return null;
    }
    const hasIslandPages = scan.pages.pages.some((p) => p.island);
    // Detect md plugin and read its client entry ID for island pages
    const mdPlugin = resolvedConfig?.plugins?.find((p) => p.name === 'void-md');
    const mdClientEntryId =
      hasIslandPages && mdPlugin?.api?.clientEntryId
        ? (mdPlugin.api.clientEntryId as string)
        : undefined;
    return {
      pagesDir,
      pagesDirRelative: relative(root, pagesDir).replaceAll('\\', '/'),
      clientEntryId: 'virtual:void-pages-client',
      islandClientEntryId: hasIslandPages ? 'virtual:void-islands-client' : undefined,
      mdClientEntryId,
      headConfig: options.headConfig,
    };
  }

  function resolveCurrentAssetRoutingPolicy(): AssetRoutingPolicy {
    const { pages, routes, websockets = [], middleware } = scan!;
    return resolveAssetRoutingPolicy({
      isSsr: Boolean(ssr),
      hasPages: pages.pages.length > 0,
      hasApiRoutes:
        hasApiRoutes(routes) || hasApiRoutes(websockets) || compileOptions.auth !== null,
      hasDocumentRoutes: hasDocumentRoutes(routes),
      hasMiddleware: middleware.length > 0,
      hasWebSockets: hasDocumentRoutes(websockets),
      authEnabled: compileOptions.auth !== null,
      liveEnabled: options.live !== undefined,
      notFound: options.routing?.notFound,
    });
  }

  const sandboxEntry = options.hasSandbox
    ? {
        bindingName: options.sandboxBindingName,
        className: options.sandboxClassName,
        instanceType: options.sandboxInstanceType,
        runtimePath: sandboxRuntimePath,
      }
    : false;

  function writeNodeEntries(target: NonNullable<RoutingPluginOptions['target']>): void {
    writeFileIfChanged(
      join(outDir, 'app.ts'),
      compileNodeApp(target, compileOptions.honoPath, getEnvSchemaModule()),
    );
    writeFileIfChanged(join(outDir, 'index.ts'), compileNodeServer(target));
  }

  /** Write the Cloudflare worker entry from the completed scan. */
  function writeWorkerEntry(isr: WorkerEntryOptions['isr']): void {
    const policy = resolveCurrentAssetRoutingPolicy();
    writeFileIfChanged(
      join(outDir, 'entry.ts'),
      compileWorkerEntry({
        versionMetadataBinding: options.getVersionMetadataBinding?.(),
        hasQueues: scan!.queues.length > 0,
        remote,
        assetsDir: resolvedConfig?.build.assetsDir,
        webSocketClasses: [
          ...(scan!.websockets ?? []).map((route) => route.className),
          ...(options.websocketTombstones ?? []),
        ],
        runtimeEnvPath: compileOptions.runtimeEnvPath,
        runtimeEmailPath,
        envSchemaModule: getEnvSchemaModule(),
        sandbox: sandboxEntry,
        hasEmail: hasEmailHandlers(),
        serveSpaFallback: policy.workerSpaFallback,
        live: options.live,
        dev: compileOptions.dev,
        isr,
        notFound: policy.assetConfig.not_found_handling ?? 'none',
        durableObjects: options.durableObjects,
      }),
    );
  }

  // Generate the entry file and tsconfig eagerly (at plugin creation time,
  // during voidPlugin()). The CF plugin needs the `main` file to exist at
  // config resolution time, which is before any hooks like buildStart fire.
  // The tsconfig.json allows users to extend it from their root tsconfig
  // so generated types (.void/routes.d.ts) are discovered automatically.
  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });
  // Write initial entry — will be re-written with hasQueues once scan completes
  if (options.target) {
    writeNodeEntries(options.target);
  } else {
    writeFileIfChanged(
      join(outDir, 'entry.ts'),
      compileWorkerEntry({
        versionMetadataBinding: options.getVersionMetadataBinding?.(),
        remote,
        webSocketClasses: options.websocketTombstones,
        runtimeEnvPath: compileOptions.runtimeEnvPath,
        runtimeEmailPath,
        envSchemaModule: getEnvSchemaModule(),
        sandbox: sandboxEntry,
        live: options.live,
        durableObjects: options.durableObjects,
      }),
    );
  }

  return {
    name: 'void:routing',
    enforce: 'pre',
    configResolved(config) {
      resolvedConfig = config;
      authClientPath = resolveAuthClientPath(config);
      // `vite preview` reports `command: 'serve'` but runs the built bundle,
      // so it never compiles the route table as dev.
      compileOptions.dev = config.command === 'serve' && !previewing;
      compileOptions.assetsDir = config.build.assetsDir;
      compileOptions.reactRefresh = config.plugins.some(
        (plugin) =>
          plugin.name === 'vite:react-babel' ||
          plugin.name === 'vite:react-refresh' ||
          plugin.name === 'vite:react-swc',
      );
      // Vite resolves `publicDir: false` to ''.
      const resolvedPublicDir =
        config.publicDir && config.publicDir.length > 0 ? config.publicDir : null;
      if (resolvedPublicDir !== publicDir) {
        publicDir = resolvedPublicDir;
        reloadFileRules();
      }
    },
    config(_, env) {
      previewing = env.isPreview === true;
      routeEnvironment = env.command === 'serve' && !env.isPreview ? 'dev' : 'prod';
      compileOptions.hasLive = options.live !== undefined;
      compileOptions.managedDispatch =
        !options.target && env.command === 'build' && Boolean(process.env.VOID_DEPLOY_PROJECT_ID);

      if (env.command === 'serve' && options.isAuthEnabled()) {
        // Alias better-auth client subpaths to absolute file paths so
        // Vite can resolve them during SSR without the bare specifiers
        // needing to be hoisted into the user's node_modules (pnpm
        // strict mode). Without this, Vite discovers them lazily on
        // first auth page load, triggering a disruptive program reload.
        const betterAuthSubpaths = ['client', 'react', 'vue', 'svelte', 'solid'];
        const resolvedAliases = betterAuthSubpaths.flatMap((sub) => {
          try {
            return [{ find: `better-auth/${sub}`, replacement: resolveFile(`better-auth/${sub}`) }];
          } catch {
            return [];
          }
        });

        return { resolve: { alias: resolvedAliases } };
      }

      const entries = validateSsrEntries(root, paths);
      if (env.command !== 'build') {
        return;
      }

      return {
        build: {
          manifest: entries ? true : (_.build?.manifest ?? true),
          ...(entries
            ? {
                rollupOptions: {
                  input: entries.client.absolutePath,
                },
              }
            : {}),
        },
      };
    },

    generateBundle: {
      order: 'post',
      handler(_output, bundle) {
        const manifest = this.environment.config.build.manifest;
        if (this.environment.name === 'client' && manifest) {
          stampClientAssetCachePolicy(
            bundle,
            typeof manifest === 'string' ? manifest : '.vite/manifest.json',
            compileOptions.headerRules,
          );
        }
      },
    },

    async buildStart() {
      await rescan();
      if (options.target && (scan?.websockets?.length ?? 0) > 0) {
        throw new Error('routing: WebSocket routes require the default Cloudflare target.');
      }
      resolveAuthCompileOptions();
      await writeAuthDatabaseFiles();
      writeRouteTypes();
      writeQueueTypes();

      // Bundle migrations into the worker for CF targets (in-worker migration runner)
      if (!options.target) {
        const migrationsDir = paths.migrationsDir;
        if (existsSync(migrationsDir) || compileOptions.auth) {
          const { collectMigrations } = await import('./migrations/collect.ts');
          const { buildMigrationPlanBundle } = await import('./migrations/plan.ts');
          const migrations = existsSync(migrationsDir) ? collectMigrations(migrationsDir) : [];
          const dialect = getDatabaseDialect(readConfig(root));
          compileOptions.migrationHandlerPath = resolveFile(
            dialect === 'postgresql'
              ? '#self/runtime/migration-handler-pg'
              : dialect === 'mysql'
                ? '#self/runtime/migration-handler-mysql'
                : '#self/runtime/migration-handler',
          );
          compileOptions.migrations = migrations;
          compileOptions.migrationPlanBundle =
            dialect === 'sqlite' ? buildMigrationPlanBundle(migrations) : undefined;
        }
      }
      // Re-write entries from the completed scan.
      if (options.target) {
        writeNodeEntries(options.target);
      } else {
        // Only a non-managed production build bakes ISR in; managed deploys leave it to the platform.
        const buildConfig = readConfig(root);
        const merged = collectRevalidate(buildConfig, scan!.pages);
        const configuredRevalidate = buildConfig.routing?.revalidate;
        const emitIsr =
          resolvedConfig?.command === 'build' &&
          !process.env.VOID_DEPLOY_PROJECT_ID &&
          hasRevalidate(merged);
        // Route table + worker entry must agree within one build. All constants
        // derive from `emitIsr` so they are present or absent together.
        isrRevalidate = emitIsr ? merged : undefined;
        isrPages = emitIsr ? collectPages(scan!.pages, configuredRevalidate) : undefined;
        isrPathRevalidate =
          emitIsr && configuredRevalidate && typeof configuredRevalidate === 'object'
            ? configuredRevalidate
            : undefined;
        // Resolve the ISR runtime path LAZILY — only when ISR is actually emitted
        // — so non-ISR/managed/dev builds never depend on it.
        const isr = emitIsr
          ? {
              runtimePath: resolveFile('@void/isr/runtime'),
              queryAllowlist: buildConfig.routing?.revalidateQueryAllowlist,
            }
          : undefined;
        writeWorkerEntry(isr);
      }
    },

    resolveId: {
      filter: { id: RESOLVE_ID_FILTER },
      handler(id) {
        if (id === VIRTUAL_ROUTES_ID) {
          return VIRTUAL_ROUTES_ID;
        }
        if (id === VIRTUAL_CLIENT_WORKER_ID) {
          return VIRTUAL_CLIENT_WORKER_ID;
        }
        if (id === VIRTUAL_CLIENT_BROWSER_ID) {
          return VIRTUAL_CLIENT_BROWSER_ID;
        }
        // Redirect bare "void" imports to the lightweight handler
        // subpath to avoid pulling the entire plugin into the Worker bundle.
        if (id === 'void') {
          return handlerFile;
        }
        // Redirect void/queues to the built runtime module
        if (id === 'void/queues') {
          return resolveFile('#self/queues');
        }
        if (CLIENT_IMPORT_RE.test(id)) {
          return resolveVirtualClientId(id, this.environment?.name);
        }
      },
    },

    load: {
      filter: { id: LOAD_ID_FILTER },
      async handler(id) {
        const virtualClient = VIRTUAL_CLIENT_RE.exec(id);
        if (virtualClient?.[1] === 'browser') {
          return compileBrowserClient(getClientAuthPath(id), fetchPath, fetchStreamPath);
        }
        if (virtualClient?.[1] === 'worker') {
          return compileWorkerClient(getClientAuthPath(id), Boolean(options.target));
        }
        if (id !== VIRTUAL_ROUTES_ID) {
          return;
        }
        // The route table embeds the dev-trigger token. Only server environments import
        // it; refusing the client environment keeps `/@id/virtual:void-routes` from
        // returning it, either as the module or as code on Vite's error page.
        if (this?.environment?.name === 'client') {
          throw new Error(
            `${VIRTUAL_ROUTES_ID} is server-only and cannot be loaded by client code.`,
          );
        }
        if (!scan) {
          await rescan();
        }
        return compileRouteTable(
          scan!,
          routesDir,
          middlewareDir,
          jobsDir,
          queuesDir,
          ssr,
          compileOptions,
          getPagesCompileOptions(),
          isrRevalidate,
          isrPages,
          isrPathRevalidate,
        );
      },
    },

    configureServer(devServer) {
      // Watch the source convention directories for file changes
      const watcher = devServer.watcher;

      const handleFileChange = async (path: string, event: 'add' | 'change' | 'unlink') => {
        const normalizedPath = normalizePath(path);
        const sourceConventionChanged =
          isInDirectory(normalizedPath, normalizedRoutesDir) ||
          isInDirectory(normalizedPath, normalizedMiddlewareDir) ||
          isInDirectory(normalizedPath, normalizedJobsDir) ||
          isInDirectory(normalizedPath, normalizedQueuesDir) ||
          isInDirectory(normalizedPath, normalizedEmailDir) ||
          isInDirectory(normalizedPath, normalizedPagesDir) ||
          isPotentialAuthConfigPath(normalizedPath) ||
          isPotentialEnvFilePath(normalizedPath);
        if (!sourceConventionChanged && !ssrEntryAbsPaths.has(normalizedPath)) {
          return;
        }

        // Re-scan and invalidate the virtual module in ALL environments.
        // The route table virtual module lives in the workerd environment,
        // not the client — so we must iterate all environments.
        await rescan(true);
        resolveAuthCompileOptions();
        const shouldRestartForAssetRouting =
          event !== 'change' &&
          options.onDevAssetRoutingPolicyChange?.(resolveCurrentAssetRoutingPolicy()) === true;
        if (shouldRestartForAssetRouting) {
          await devServer.restart();
          return;
        }
        await writeAuthDatabaseFiles();
        writeRouteTypes();
        writeQueueTypes();
        if (options.target) {
          writeNodeEntries(options.target);
        } else {
          writeWorkerEntry(undefined);
        }

        // For structural changes (file add/remove), send full-reload to trigger
        // a program reload so the workerd picks up new/removed routes.
        // For content-only changes, module invalidation alone is sufficient —
        // the workerd re-evaluates stale modules on the next request. Sending
        // full-reload for content changes triggers an unnecessary program reload
        // that can break React SSR (dual module instances).
        const structural = event !== 'change';

        const pageManifestChanged =
          isInDirectory(normalizedPath, normalizedPagesDir) &&
          (structural || normalizedPath.endsWith('.md'));
        for (const env of Object.values(devServer.environments)) {
          if (pageManifestChanged) {
            for (const id of PAGE_VIRTUAL_MODULE_IDS) {
              const pageMod = env.moduleGraph.getModuleById(id);
              if (pageMod) {
                env.moduleGraph.invalidateModule(pageMod);
              }
            }
          }
          const mod = env.moduleGraph.getModuleById(VIRTUAL_ROUTES_ID);
          if (mod) {
            env.moduleGraph.invalidateModule(mod);
            if (structural) {
              env.hot.send({ type: 'full-reload' });
            }
          }
        }

        // Reload the browser for island page changes — islands are
        // server-rendered only, so there's no client HMR to handle updates.
        // .md pages are implicit islands (no client JS), so reload those too.
        if (/\.island\./.test(normalizedPath) || normalizedPath.endsWith('.md')) {
          devServer.environments.client?.hot.send({ type: 'full-reload' });
        }
      };

      watcher.on('add', (path) => handleFileChange(path, 'add'));
      watcher.on('change', (path) => handleFileChange(path, 'change'));
      watcher.on('unlink', (path) => handleFileChange(path, 'unlink'));

      // File-based routing rule HMR: `public/_redirects` / `public/_headers`
      // changes re-merge + invalidate the route module so rules take effect
      // without restarting the dev server. Runs on every target because
      // `vite dev` bakes rules into the compiled Hono app on all of them.
      if (publicDir) {
        const redirectsPath = join(publicDir, '_redirects');
        const headersPath = join(publicDir, '_headers');
        const handleRulesFileChange = (path: string) => {
          if (path !== redirectsPath && path !== headersPath) {
            return;
          }
          reloadFileRules();
          for (const env of Object.values(devServer.environments)) {
            const mod = env.moduleGraph.getModuleById(VIRTUAL_ROUTES_ID);
            if (mod) {
              env.moduleGraph.invalidateModule(mod);
              env.hot.send({ type: 'full-reload' });
            }
          }
        };
        watcher.on('add', handleRulesFileChange);
        watcher.on('change', handleRulesFileChange);
        watcher.on('unlink', handleRulesFileChange);
      }
    },
  };
}
