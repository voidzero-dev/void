import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { cloudflare, type PluginConfig, type WorkerConfig } from '@cloudflare/vite-plugin';
import { join, resolve } from 'pathslash';
import pc from 'picocolors';
import { type Plugin } from 'vite';
import { analyzeApplicationSync, type ApplicationAnalysis } from './application-analysis.ts';
import { applyBindingOverrides } from './application-features.ts';
import {
  hasApiRoutes as routeScanHasApiRoutes,
  hasDocumentRoutes as routeScanHasDocumentRoutes,
  resolveAssetRoutingPolicy,
  type AssetRoutingPolicy,
} from './asset-routing.ts';
import { mergeRoutingRules } from './cli/headers.ts';
import { readDeploymentPlatform } from './cli/project.ts';
import {
  normalizeWranglerCompatibilityFlags,
  readWranglerCompat,
  readWranglerWebSocketTombstones,
  readExistingLiveBindingConfig,
  resolveLiveBindingConfig,
  syncWranglerDurableObjects,
  syncWranglerWebSockets,
} from './cli/wrangler.ts';
import {
  materializeCloudflareConfig,
  restoreCloudflarePreviewPointer,
  stashCloudflareDeployPointer,
} from './cloudflare-config.ts';
import { readConfig, isNodeTarget } from './config.ts';
import { inferBindingsFromSource } from './inference/walk.ts';
import { resolveLocalD1Target, writeLocalD1PersistState } from './local-d1.ts';
import { voidLog, voidWarn } from './log.ts';
import { pagesDevCssAssetsPlugin } from './pages/dev-css-assets.ts';
import { readVoidDevCredentials, runAiSetupPrompt } from './plugin-ai-setup.ts';
import { bindingRuntimePlugin } from './plugin-binding-runtime.ts';
import { createClientStubsPlugin } from './plugin-client-stubs.ts';
import {
  afterServerReady,
  warnIfPackageJsonIsNotEsm,
  isViteBuildOrPreview,
  getOrCreateDevTriggerToken,
  devTriggerSecretGuardPlugin,
  selectVoidCloudflareLogin,
} from './plugin-dev-config.ts';
import { devTriggersHintPlugin } from './plugin-dev-triggers-hint.ts';
import { drizzlePlugin } from './plugin-drizzle.ts';
import { emailDevInboxPlugin } from './plugin-email-dev-inbox.ts';
import { envClientFoldPlugin } from './plugin-env-client-fold.ts';
import { envClientGuardPlugin } from './plugin-env-client-guard.ts';
import { envSchemaPlugin, type EnvSchemaFacts } from './plugin-env-schema.ts';
import {
  getFrameworkEntry,
  generateClassATriggerWrapper,
  getOriginalFrameworkEntry,
} from './plugin-framework-entry.ts';
import { frameworkTriggersPlugin } from './plugin-framework-triggers.ts';
import { createFrameworkPlugins } from './plugin-framework.ts';
import { DEFAULT_SCAN_DIRS, FRAMEWORK_SCAN_DIRS, type Framework } from './plugin-inference.ts';
import { migrationPlugin } from './plugin-migration.ts';
import { nodeTargetPlugin } from './plugin-node-target.ts';
import { prerenderPlugin } from './plugin-prerender.ts';
import { restartPlugin } from './plugin-restart.ts';
import { routingPlugin } from './plugin-routing.ts';
import { mergeWorkerBindings } from './plugin-worker-bindings.ts';
import {
  createBareVoidRedirectPlugin,
  createServerRuntimeOptimizerPlugin,
  DEV_ASSET_ROUTING_EXCLUSIONS,
  createCloudflareBuiltinsExternalPlugin,
  createWorkerEnvironmentSanitizerPlugin,
  createWranglerCompatPersistPlugin,
  createDefaultWorkerEnvironmentPlugin,
  DEFAULT_WORKER_ENVIRONMENT_NAME,
  createSandboxSdkResolvePlugin,
} from './plugin-worker-environment.ts';
import { assertNoRootSourceConventionConflicts } from './project-paths.ts';
import { hasEmailHandlers } from './router/email.ts';
import { isRouteEnabledForEnvironment, type RouteEnvironment } from './router/parse-filename.ts';
import { resolveSandboxConfig } from './sandbox/config.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV, loadLocalEnv, resolveRemoteMode } from './shared/env.ts';
import { validateSsrEntry } from './ssr/entry.ts';

const scheduledPointerCleanups = new Set<string>();

const scheduledPreviewPointerCleanups = new Set<string>();

/** Returns the Vite plugins that build and serve a Void app for its configured target. */
export function voidPlugin(options?: {
  persistTo?: string;
  auxiliaryWorkers?: PluginConfig['auxiliaryWorkers'];
}): Array<Plugin> {
  // Resolve root relative to CWD — this runs at config time
  const root = process.cwd();
  const directCloudflareDestination = readDeploymentPlatform(root) === 'cloudflare';
  if (directCloudflareDestination) {
    // Here, not in a hook: `astro preview` runs no plugin hooks. Every command
    // needs it, because build prerendering can open a remote session too.
    selectVoidCloudflareLogin();
  }
  warnIfPackageJsonIsNotEsm(root);
  // Token only matters in serve — the dispatch module that uses it is
  // DCE'd from production worker bundles. In build/preview we still need
  // *some* string (the wrapper embeds it for completeness), but we skip
  // persisting it so build-only CI workflows don't materialize dev state.
  const devTriggerToken = isViteBuildOrPreview()
    ? crypto.randomUUID()
    : getOrCreateDevTriggerToken(root);
  const config = readConfig(root);
  const projectCloudflareConfigPath = !isNodeTarget(config.target)
    ? materializeCloudflareConfig(root)
    : undefined;
  const cloudflareConfigPath =
    projectCloudflareConfigPath && existsSync(projectCloudflareConfigPath)
      ? projectCloudflareConfigPath
      : undefined;
  let previewing = false;
  // A preview reads the build's Wrangler deploy config, which the build moved aside. Put it back
  // until the preview exits.
  const restorePreviewPointer = () => {
    if (!existsSync(join(root, 'void.config.ts'))) {
      return;
    }
    if (restoreCloudflarePreviewPointer(root) && !scheduledPreviewPointerCleanups.has(root)) {
      scheduledPreviewPointerCleanups.add(root);
      process.once('exit', () => {
        rmSync(join(root, '.wrangler', 'deploy', 'config.json'), { force: true });
      });
    }
  };
  const implicitDeployGuard: Plugin = {
    name: 'void:remove-implicit-cloudflare-deploy-pointer',
    enforce: 'pre',
    config(_config, environment) {
      previewing = environment.isPreview === true;
      if (previewing) {
        restorePreviewPointer();
      }
    },
    closeBundle() {
      if (
        !previewing &&
        existsSync(join(root, 'void.config.ts')) &&
        process.env[CLOUDFLARE_DEPLOY_BUILD_ENV] !== '1'
      ) {
        const removePointer = () => stashCloudflareDeployPointer(root);
        if (detected?.name === 'astro') {
          // Astro previews the built Worker after Vite closes its bundle.
          if (!scheduledPointerCleanups.has(root)) {
            scheduledPointerCleanups.add(root);
            process.once('exit', removePointer);
          }
        } else {
          removePointer();
        }
      }
    },
  };
  let application = analyzeApplicationSync(root, { config });
  const { paths, dialect, bindingNames, authConfigPath } = application;
  const analyses = new Map<RouteEnvironment, ApplicationAnalysis>();
  const getApplicationAnalysis = (environment: RouteEnvironment, refresh = false) => {
    let result = refresh ? undefined : analyses.get(environment);
    if (!result) {
      result = analyzeApplicationSync(root, { config, environment });
      analyses.set(environment, result);
    }
    application = result;
    return result;
  };
  let routeEnvironment: RouteEnvironment = 'prod';
  assertNoRootSourceConventionConflicts(paths);
  const detected = application.framework;
  const framework = detected?.class === 'a' ? (detected.name as Framework) : undefined;
  if (detected?.name === 'astro' && process.argv[2] === 'preview') {
    // `astro preview` loads this config but starts the adapter's preview server without its
    // Vite plugins, after the adapter checks for the deploy config.
    restorePreviewPointer();
  }

  const scanDirs = config.inference?.scanDirs ?? (detected ? FRAMEWORK_SCAN_DIRS : undefined);
  const frameworkOwnsCloudflareRuntime =
    detected !== undefined && (detected.class === 'b' || detected.class === 'c');
  const localD1PersistRoot = frameworkOwnsCloudflareRuntime
    ? join(root, '.wrangler', 'state')
    : (options?.persistTo ?? join(root, '.void'));
  const localD1 = resolveLocalD1Target(root, {
    bindingName: bindingNames?.d1 ?? 'DB',
    persistRoot: localD1PersistRoot,
  });
  writeLocalD1PersistState(
    root,
    !isNodeTarget(config.target) && !frameworkOwnsCloudflareRuntime
      ? options?.persistTo
      : undefined,
  );
  let bindings = application.bindings;
  const sandboxConfig = bindings.needsSandbox ? resolveSandboxConfig(config, root) : undefined;
  let authEnabled = application.authEnabled;

  if (detected && authEnabled) {
    throw new Error(
      "auth: Void-managed Better Auth is only supported in Void apps. Use Better Auth's official integration for this framework instead.",
    );
  }
  if (detected && bindings.needsSandbox) {
    throw new Error('sandbox: Cloudflare Sandboxes are currently supported in Void apps only.');
  }
  if (detected && bindings.needsLive) {
    throw new Error('live: void/live is currently supported in Void apps only.');
  }
  // Inbound handlers compile into the worker's `email()` export via `routingPlugin`, which
  // framework mode never installs. Outbound `sendEmail` is a binding and works everywhere.
  const hasInboundEmail = hasEmailHandlers(application.email);
  if (detected && hasInboundEmail) {
    throw new Error(
      'email: inbound email handlers are only supported in Void apps. Remove the email/ directory — `sendEmail` from void/email keeps working.',
    );
  }

  // Server-only void/* imports (db, kv, ai, etc.) must not pull in
  // cloudflare:workers or node: builtins when bundled for the browser.
  // Resolve them to empty stubs in any client environment.
  const clientStubsPlugin = createClientStubsPlugin();

  // Generated server entries import the env module by its resolved file path.
  // Prebundling a bare `void` runtime subpath creates another package module
  // graph and therefore another envContext, so request bindings disappear for
  // the prebundled copy. Every return path includes this plugin, including
  // framework and Node targets that do not all use bindingRuntimePlugin.
  const serverRuntimeOptimizerPlugin = createServerRuntimeOptimizerPlugin(dialect, () =>
    readWranglerCompat(root, config),
  );
  // Scan queues/websocket routes early so both framework-mode and default-mode
  // branches can safely close over these bindings.
  const queues = framework ? [] : application.queues;
  // Deliberately scanned with NO environment: this list is the superset used to
  // RESERVE binding and Durable Object class names below, and reservation must
  // not depend on which command is running. A filtered list would let the live
  // DO resolve to `VOID_LIVE` under `vite dev` and `VOID_LIVE_2` under
  // `vite build` for the same project. Consumers that emit config rather than
  // reserve names re-filter by `routeEnvironment` (see `mergeBindings` and
  // `resolveConfiguredAssetRoutingPolicy`).
  const websocketRoutes = framework ? [] : application.allWebsockets;
  const durableObjects = application.durableObjects;
  if (detected && durableObjects.length > 0) {
    throw new Error(
      'durable: durable-objects/ is currently supported in Void apps only, not framework adapter mode.',
    );
  }
  for (const module of durableObjects) {
    const websocketCollision = websocketRoutes.find(
      (route) => route.bindingName === module.bindingName || route.className === module.className,
    );
    if (websocketCollision) {
      throw new Error(
        `durable: durable-objects/${module.filePath.split('/').pop()} conflicts with WebSocket route '${websocketCollision.filePath}'. Rename one of the files.`,
      );
    }
    if (
      sandboxConfig &&
      (sandboxConfig.binding === module.bindingName || sandboxConfig.className === module.className)
    ) {
      throw new Error(
        `durable: durable-objects/${module.filePath.split('/').pop()} conflicts with the configured Sandbox binding or class. Rename the Durable Object file.`,
      );
    }
  }
  let websocketTombstones: Array<string> = [];
  if (!isNodeTarget(config.target)) {
    syncWranglerDurableObjects(root, durableObjects);
    const productionWebSocketRoutes = websocketRoutes.filter((route) =>
      isRouteEnabledForEnvironment(route, 'prod'),
    );
    syncWranglerWebSockets(root, productionWebSocketRoutes);
    websocketTombstones = readWranglerWebSocketTombstones(root, productionWebSocketRoutes);
  }
  const existingLiveConfig = !isNodeTarget(config.target)
    ? readExistingLiveBindingConfig(root)
    : undefined;
  const liveConfig = !isNodeTarget(config.target)
    ? bindings.needsLive
      ? resolveLiveBindingConfig(root, {
          reservedBindings: [
            ...websocketRoutes.map((route) => route.bindingName),
            ...durableObjects.map((module) => module.bindingName),
          ],
          reservedClasses: [
            ...websocketRoutes.map((route) => route.className),
            ...durableObjects.map((module) => module.className),
            sandboxConfig?.className,
          ],
        })
      : existingLiveConfig
    : undefined;
  const shouldEmitLive = () => bindings.needsLive || existingLiveConfig !== undefined;

  // Class B/C: the framework's own adapter handles the CF worker build and dev
  // server. Void adds only its supporting plugins (see `createFrameworkPlugins`).
  if (detected && (detected.class === 'b' || detected.class === 'c')) {
    return createFrameworkPlugins({
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
    });
  }

  // Remote mode — use platform proxy for D1/KV/R2 instead of local miniflare.
  const remoteMode = resolveRemoteMode(config.remote);

  // Core worker config — always set by voidPlugin (main, triggers, assets).
  // Bindings are handled separately in the config function below.
  const workerConfig: Record<string, unknown> = {};
  const jobs = application.jobs;
  if (jobs.length > 0) {
    workerConfig.triggers = {
      crons: [...new Set(jobs.flatMap((job) => job.crons))],
    };
  }
  let envSchemaFacts: EnvSchemaFacts | undefined;
  let assetRouting: AssetRoutingPolicy;
  if (config.worker?.vars) {
    workerConfig.vars = { ...config.worker.vars };
  }

  // Tracks whether vite is running in dev or build mode. Set early in
  // envPlugin.config so mergeBindings can gate credential injection on 'serve'.
  let viteCommand: 'serve' | 'build' = 'build';
  let versionMetadataBinding: string | undefined;

  // Merge curated wrangler fields from void.config.ts
  const wranglerCompat = isNodeTarget(config.target) ? undefined : readWranglerCompat(root, config);
  if (wranglerCompat) {
    workerConfig.compatibility_date = wranglerCompat.compatibilityDate;
    if (wranglerCompat.compatibilityFlags) {
      workerConfig.compatibility_flags = wranglerCompat.compatibilityFlags;
    }
  }
  if (config.worker?.limits?.cpu_ms) {
    workerConfig.limits = { cpu_ms: config.worker.limits.cpu_ms };
  }
  const inspectorPortEnv = process.env.VOID_INSPECTOR_PORT;
  const inspectorPort =
    inspectorPortEnv === 'false'
      ? false
      : typeof inspectorPortEnv === 'string' && inspectorPortEnv.length > 0
        ? Number.parseInt(inspectorPortEnv, 10)
        : undefined;

  const inspectorPortOption: { inspectorPort?: number | false } =
    inspectorPort === false
      ? { inspectorPort: false }
      : typeof inspectorPort === 'number'
        ? { inspectorPort }
        : {};

  const outDir = join(root, '.void');
  mkdirSync(outDir, { recursive: true });

  // Config function that merges inferred bindings with the resolved Cloudflare
  // config. Bindings already declared there (with real IDs) take precedence;
  // placeholders are added only for inferred bindings that are missing.
  function mergeBindings(resolved: WorkerConfig): Partial<WorkerConfig> {
    const merged = mergeWorkerBindings(resolved, {
      websocketRoutes,
      routeEnvironment,
      workerConfig,
      envSchemaFacts,
      authEnabled,
      viteCommand,
      bindingNames,
      dialect,
      application,
      bindings,
      directCloudflareDestination,
      config,
      devTriggerToken,
      queues,
      durableObjects,
      sandboxConfig,
      shouldEmitLive,
      liveConfig,
      root,
      remoteMode,
    });
    versionMetadataBinding = merged.versionMetadataBinding;
    return merged.patch;
  }

  function applyEnvSchema(facts: EnvSchemaFacts): void {
    envSchemaFacts = facts;
  }

  // Plugin that loads the single local `.env` file into worker bindings for
  // local dev and preview only. Production values come from remote secrets;
  // builds never turn local dotenv entries into deployable Worker vars.
  const envPlugin: Plugin = {
    name: 'void:env',
    config(userConfig, { command, isPreview }) {
      viteCommand = command;
      // `dev` is the Vite dev server only. Every build, `void deploy`, and
      // `vite preview` (which reports `command: 'serve'`) is `prod`.
      routeEnvironment = command === 'serve' && !isPreview ? 'dev' : 'prod';
      application = getApplicationAnalysis(routeEnvironment);
      bindings = application.bindings;
      authEnabled = application.authEnabled;
      // Re-resolve for the real environment. Framework and node-target branches return before
      // `ssrEntry` is declared (TDZ) and must leave `workerConfig.assets` unset.
      if (!framework && !isNodeTarget(config.target)) {
        managedCloudflareBuild = command === 'build' && Boolean(process.env.VOID_DEPLOY_PROJECT_ID);
        assetRoutingPublicDir =
          userConfig.publicDir === false
            ? null
            : typeof userConfig.publicDir === 'string'
              ? resolve(root, userConfig.publicDir)
              : join(root, 'public');
        assetRouting = resolveConfiguredAssetRoutingPolicy();
        applyAssetRoutingPolicy(assetRouting);
      }
      // Exclude the .void cache directory from the file watcher so that
      // miniflare SQLite writes don't trigger infinite HMR refreshes.
      const ignored = ['**/.void/**'];
      if (command === 'serve') {
        const local = loadLocalEnv(root, { onWarn: (message) => voidWarn(message) });
        // Keep the dev Worker on the same values that env-schema validation
        // sees. Shell values override .env, and shell-only values are included
        // only when declared by the schema. Never copy unrelated host secrets.
        // envSchemaPlugin rejects `__VOID_*` names in .env and env.ts, so no
        // reserved key can enter here.
        const env = { ...local };
        for (const key of new Set([...Object.keys(local), ...(envSchemaFacts?.keys ?? [])])) {
          if (process.env[key] !== undefined) {
            env[key] = process.env[key];
          }
        }
        workerConfig.vars = {
          ...(workerConfig.vars as Record<string, string> | undefined),
          ...env,
        };
        // The Cloudflare preview server runs the already-built wrangler
        // artifact and sources its declared secrets from process.env instead
        // of the in-memory worker config. Populate only missing entries so the
        // shell still wins and `.env` remains a local runtime input.
        if (isPreview) {
          for (const [key, value] of Object.entries(env)) {
            process.env[key] ??= value;
          }
        }
      }

      // In dev, keep document requests on the user worker. If this is deleted,
      // the CF router may route a page request to the user worker, the dev
      // override sends that request back through Vite middleware, and Vite's
      // final Cloudflare handler routes it to the CF router again. Workerd
      // reports that loop as a hung request.
      //
      // Vite's own module URLs still need to bypass the worker so HMR,
      // virtual modules, and dev CSS are served by Vite middleware directly.
      const assets = workerConfig.assets as { run_worker_first?: Array<string> } | undefined;
      if (command === 'serve' && !isPreview && assets?.run_worker_first?.includes('/**')) {
        assets.run_worker_first = [...DEV_ASSET_ROUTING_EXCLUSIONS, '/**'];
      }

      const watchConfig = { server: { watch: { ignored } } };

      // Minify worker bundles for smaller deploys (skip when output: "static"
      // because prerendering runs the SSR bundle in Miniflare, which cannot
      // resolve template-literal dynamic imports produced by the minifier)
      if (!isNodeTarget(config.target) && config.output !== 'static') {
        const envNames = framework === 'vinext-app' ? ['rsc', 'ssr'] : ['ssr'];
        return {
          ...watchConfig,
          environments: Object.fromEntries(envNames.map((n) => [n, { build: { minify: true } }])),
        };
      }

      return watchConfig;
    },
    configureServer(server) {
      // Remote mode status — log which bindings are using the proxy
      if (remoteMode && (bindings.needsD1 || bindings.needsKV || bindings.needsR2)) {
        const credentials = readVoidDevCredentials(root);
        if (credentials.status === 'ok') {
          const lines = [pc.blue('Remote bindings active')];
          if (bindings.needsD1) {
            lines.push(`  DB      ${pc.dim('→ remote D1')}`);
          }
          if (bindings.needsKV) {
            lines.push(`  KV      ${pc.dim('→ remote KV')}`);
          }
          if (bindings.needsR2) {
            lines.push(`  STORAGE ${pc.dim('→ remote R2')}`);
          }
          afterServerReady(server, () => {
            console.log();
            voidLog(lines.join('\n         '));
          });
        } else if (credentials.status === 'no-token') {
          afterServerReady(server, () => {
            console.log();
            voidWarn(
              'Remote mode requires authentication. Run `void account login`, then restart.',
            );
            voidWarn('Falling back to local bindings.');
          });
        } else {
          afterServerReady(server, () => {
            console.log();
            voidWarn('Remote mode requires a linked project. Run `void project link` first.');
            voidWarn('Falling back to local bindings.');
          });
        }
      }

      // AI onboarding: detect missing credentials early and guide users
      if (bindings.needsAI && !directCloudflareDestination) {
        const credentials = readVoidDevCredentials(root);
        if (credentials.status === 'no-token') {
          afterServerReady(server, () => {
            console.log();
            voidWarn(
              'AI requires authentication. Run `void account login`, then restart the dev server.',
            );
          });
        } else if (credentials.status === 'no-project') {
          if (process.stdin.isTTY) {
            // Fire-and-forget interactive setup
            afterServerReady(server, () => {
              console.log();
              runAiSetupPrompt(root, credentials.token, credentials.apiUrl, server);
            });
          } else {
            afterServerReady(server, () => {
              console.log();
              voidWarn('AI requires a linked project. Run `void project link` to set one up.');
            });
          }
        }
      }
    },
  };

  // Binding watch plugin — detects new binding imports mid-session and
  // notifies the developer via terminal log + browser toast.
  const autoDetectAuth = !authEnabled;
  const bindingWatchPlugin: Plugin = {
    name: 'void:binding-watch',
    apply: 'serve',
    configureServer(server) {
      const effectiveDirs = scanDirs ?? DEFAULT_SCAN_DIRS;
      const watchDirs = [...new Set([...effectiveDirs, 'src'])].map((d) => join(root, d));
      let hintShown = false;
      const check = (path: string) => {
        if (hintShown) {
          return;
        }
        if (!watchDirs.some((d) => path.startsWith(d))) {
          return;
        }
        try {
          const code = readFileSync(path, 'utf-8');
          const fileBindings = applyBindingOverrides(
            inferBindingsFromSource(code, path.split('/').pop()!),
            config.inference?.bindings,
          );
          const newBindings: Array<string> = [];
          if (fileBindings.needsD1 && !bindings.needsD1) {
            newBindings.push('D1 (void/db)');
          }
          if (fileBindings.needsKV && !bindings.needsKV) {
            newBindings.push('KV (void/kv)');
          }
          if (fileBindings.needsR2 && !bindings.needsR2) {
            newBindings.push('R2 (void/storage)');
          }
          if (fileBindings.needsAI && !bindings.needsAI) {
            newBindings.push('AI (void/ai)');
          }
          if (fileBindings.needsSandbox && !bindings.needsSandbox) {
            newBindings.push('Sandbox (void/sandbox)');
          }
          if (fileBindings.needsEmail && !bindings.needsEmail) {
            newBindings.push('Email (void/email)');
          }
          if (autoDetectAuth && fileBindings.needsAuth) {
            newBindings.push('Auth (void/auth)');
          }
          if (newBindings.length > 0) {
            hintShown = true;
            const detected = newBindings.join(', ');
            setTimeout(() => {
              voidLog(`New ${detected} binding detected. Restart to apply.`);
            }, 300);
            server.hot.send({
              type: 'custom',
              event: 'void:new-binding',
              data: { message: `New ${detected} binding detected.` },
            });
          }
        } catch {
          // Ignore transient read errors while files are being written or removed.
        }
      };
      // Attach after the HTTP server is listening so initial plugin file
      // writes (typegen, entry generation) don't trigger a spurious check.
      const attach = () => {
        server.watcher.on('add', check);
        server.watcher.on('change', check);
      };
      if (server.httpServer) {
        server.httpServer.once('listening', attach);
      } else {
        attach();
      }
    },
  };

  if (framework) {
    workerConfig.main = getFrameworkEntry(
      framework,
      root,
      devTriggerToken,
      dialect,
      config.routing?.notFound,
      config.cloudflare?.main,
    );
    // Class A builds write no `assets` config, and `not_found_handling` alone would keep
    // unmatched requests from the framework worker. Managed `void deploy` supplies the policy.
    let notFoundIgnoredWarned = false;
    const frameworkBuildWrapperPlugin: Plugin = {
      name: 'void:framework-build-wrapper',
      configResolved(resolved) {
        if (resolved.command !== 'build') {
          return;
        }
        if (
          config.routing?.notFound !== undefined &&
          !process.env.VOID_DEPLOY_BUILD &&
          !notFoundIgnoredWarned
        ) {
          notFoundIgnoredWarned = true;
          voidWarn(
            `Void generates no asset routing policy for a ${framework} build, so "routing.notFound" in ` +
              'void.config.ts is not written to the built worker config. During a self-hosted build and ' +
              'direct Cloudflare deployment, it takes effect only if your own Cloudflare config declares a complete ' +
              '`assets` policy (`binding`, `directory`, `not_found_handling`, `run_worker_first`); ' +
              "otherwise Cloudflare's default applies. Managed `void deploy` supplies the policy for you.",
          );
        }
        generateClassATriggerWrapper(
          root,
          framework,
          getOriginalFrameworkEntry(framework, root, config.cloudflare?.main),
          true,
          dialect,
          resolved.build.assetsDir,
          config.routing?.notFound,
        );
      },
    };
    const existingFlags = (workerConfig.compatibility_flags as Array<string> | undefined) ?? [];
    if (!existingFlags.includes('nodejs_compat')) {
      workerConfig.compatibility_flags = [...existingFlags, 'nodejs_compat'];
    }

    // vinext App Router uses RSC with SSR as child environment;
    // all other Class A frameworks and vinext Pages Router use plain SSR.
    const viteEnvironment: { name: string; childEnvironments?: Array<string> } =
      framework === 'vinext-app' ? { name: 'rsc', childEnvironments: ['ssr'] } : { name: 'ssr' };
    const redirectDbTypePaths = framework !== 'vinext-app' && framework !== 'vinext-pages';

    // vinext injects vite-tsconfig-paths which spams warnings for every
    // tsconfig that extends a non-existent .void/tsconfig.json. Void
    // already generates its own tsconfig — the plugin is unnecessary.
    const vinextCompat: import('vite').Plugin | undefined =
      framework === 'vinext-app' || framework === 'vinext-pages'
        ? {
            name: 'void:vinext-compat',
            enforce: 'pre',
            config(userConfig) {
              // Neuter vite-tsconfig-paths before Vite wires up hooks.
              // Must happen in `config` — by `configResolved` hooks are
              // already cached and can't be removed.
              const plugins = Array.isArray(userConfig.plugins) ? userConfig.plugins : [];
              for (const p of plugins) {
                if (
                  p &&
                  typeof p === 'object' &&
                  !Array.isArray(p) &&
                  'name' in p &&
                  (p as { name?: unknown }).name === 'vite-tsconfig-paths'
                ) {
                  const plugin = p as Record<string, unknown>;
                  for (const key of Object.keys(plugin)) {
                    if (key !== 'name' && typeof plugin[key] === 'function') {
                      plugin[key] = () => {};
                    }
                  }
                }
              }
            },
          }
        : undefined;

    // vinext's `config` hook sets the worker environment's build input to its
    // own RSC entry. Vite merges `config` results in plugin order, so with
    // `[voidPlugin(), vinext()]` that input replaced the Cloudflare plugin's
    // worker entry, and the build shipped vinext's bare handler instead of
    // `workerConfig.main` (Void's trigger wrapper). Restore the Cloudflare
    // entry after every plugin's config is applied so plugin order does not
    // matter. The entry id is the Cloudflare plugin's own virtual module, which
    // re-exports `main` and injects its nodejs_compat globals.
    const vinextWorkerEntry: import('vite').Plugin | undefined =
      framework === 'vinext-app' || framework === 'vinext-pages'
        ? {
            name: 'void:vinext-worker-entry',
            enforce: 'post',
            configEnvironment(name, environmentConfig) {
              if (name !== viteEnvironment.name) {
                return;
              }
              environmentConfig.build ??= {};
              environmentConfig.build.rolldownOptions = {
                ...environmentConfig.build.rolldownOptions,
                input: { index: 'virtual:cloudflare/worker-entry' },
              };
            },
          }
        : undefined;

    return [
      createCloudflareBuiltinsExternalPlugin(),
      createBareVoidRedirectPlugin(),
      createWorkerEnvironmentSanitizerPlugin([
        viteEnvironment.name,
        ...(viteEnvironment.childEnvironments ?? []),
      ]),
      createWranglerCompatPersistPlugin(root, config),
      devTriggerSecretGuardPlugin(),
      restartPlugin(),
      bindingWatchPlugin,
      ...(bindings.needsEmail ? [emailDevInboxPlugin({ devTriggerToken })] : []),
      envPlugin,
      envSchemaPlugin(root, { onSchema: applyEnvSchema }),
      envClientGuardPlugin(root),
      envClientFoldPlugin(),
      clientStubsPlugin,
      serverRuntimeOptimizerPlugin,
      bindingRuntimePlugin(bindingNames),
      drizzlePlugin(root, false, dialect, {
        d1BindingName: bindingNames?.d1,
        forceVirtualDb: authEnabled || bindingNames?.d1 !== undefined,
        localD1DatabaseId: localD1.databaseId,
        localD1PersistRoot: localD1.persistRoot,
        redirectDbTypePaths,
      }),
      migrationPlugin(root, dialect, localD1.databaseId, localD1.persistRoot),
      ...(vinextCompat ? [vinextCompat] : []),
      ...(vinextWorkerEntry ? [vinextWorkerEntry] : []),
      frameworkBuildWrapperPlugin,
      frameworkTriggersPlugin(root, { devTriggerToken }),
      devTriggersHintPlugin(root, devTriggerToken),
      ...cloudflare({
        configPath: cloudflareConfigPath,
        ...inspectorPortOption,
        persistState: { path: localD1.persistRoot },
        auxiliaryWorkers: options?.auxiliaryWorkers,
        viteEnvironment,
        config: mergeBindings,
      }),
      implicitDeployGuard,
    ];
  }

  // Default mode: full Hono routing + generated entry

  // Non-CF targets: skip binding inference, D1, migrations, wrangler
  if (isNodeTarget(config.target)) {
    if (authEnabled) {
      throw new Error(
        'auth: Void-managed Better Auth is only supported in Cloudflare Void apps. Use Better Auth directly for this target instead.',
      );
    }
    if (config.inference?.bindings) {
      voidWarn(
        '"inference.bindings" in void.config.ts is ignored with target: "' + config.target + '"',
      );
    }
    if (config.worker) {
      voidWarn('"worker" in void.config.ts is ignored with target: "' + config.target + '"');
    }
    if (config.remote) {
      voidWarn('"remote" in void.config.ts is ignored with target: "' + config.target + '"');
    }
    if (bindings.needsSandbox) {
      throw new Error(
        `sandbox: Cloudflare Sandboxes require target: "cloudflare". They are not available with target: '${config.target}'.`,
      );
    }
    if (bindings.needsLive) {
      throw new Error(
        `live: void/live requires target: "cloudflare". It is not available with target: '${config.target}'.`,
      );
    }
    if (durableObjects.length > 0) {
      throw new Error(
        `durable: durable-objects/ requires target: "cloudflare". It is not available with target: '${config.target}'.`,
      );
    }
    // `compileNodeApp` imports only the Hono app from the route table; the
    // `__emailHandler` the table exports for `email/` is never invoked, so
    // without this the build succeeds and every inbound handler is dead code.
    if (hasInboundEmail) {
      throw new Error(
        `email: inbound email handlers (email/) require target: "cloudflare". They are not available with target: '${config.target}'.`,
      );
    }
    if (config.routing?.revalidate) {
      voidWarn(
        '"routing.revalidate" in void.config.ts is ignored with target: "' +
          config.target +
          '" (edge caching is CF-only)',
      );
    }

    return [
      devTriggerSecretGuardPlugin(),
      restartPlugin(),
      envPlugin,
      serverRuntimeOptimizerPlugin,
      envSchemaPlugin(root),
      ...pagesDevCssAssetsPlugin(root, devTriggerToken),
      routingPlugin(root, {
        getApplicationAnalysis,
        isAuthEnabled: () => false,
        devTriggerToken,
        headConfig: config.head,
        prerenderPaths: config.routing?.prerender,
        target: config.target as 'node' | 'bun' | 'deno',
        routing: config.routing,
        hasSandbox: false,
      }),
      prerenderPlugin(root, config),
      ...nodeTargetPlugin(config.target as 'node' | 'bun' | 'deno'),
    ];
  }

  // Void-managed auth uses native node:crypto password hashing.
  // PostgreSQL needs nodejs_compat for the `pg` driver (events, net, tls, dns, etc.).
  // Cloudflare's Sandbox SDK also imports Node built-ins.
  // Other apps only need nodejs_als for AsyncLocalStorage (isomorphic fetch context threading).
  const existingFlags = (workerConfig.compatibility_flags as Array<string> | undefined) ?? [];
  const needsNodejsCompat = authEnabled || dialect !== 'sqlite' || bindings.needsSandbox;
  const normalizedFlags = normalizeWranglerCompatibilityFlags(existingFlags, {
    needsNodejsCompat,
  });
  if (normalizedFlags && normalizedFlags !== existingFlags) {
    workerConfig.compatibility_flags = normalizedFlags;
  }

  const ssrEntry = validateSsrEntry(root, paths);
  const hasPages = existsSync(paths.pagesDir);
  let assetRoutingPublicDir: string | null = join(root, 'public');
  let managedCloudflareBuild = false;

  function resolveConfiguredAssetRoutingPolicy(): AssetRoutingPolicy {
    const routePatterns = application.routes;
    const environmentWebsocketRoutes = websocketRoutes.filter((route) =>
      isRouteEnabledForEnvironment(route, routeEnvironment),
    );
    const policy = resolveAssetRoutingPolicy({
      isSsr: Boolean(ssrEntry),
      hasPages,
      hasApiRoutes:
        routeScanHasApiRoutes(routePatterns) ||
        routeScanHasApiRoutes(environmentWebsocketRoutes) ||
        authEnabled,
      hasDocumentRoutes: routeScanHasDocumentRoutes(routePatterns),
      hasMiddleware: application.middleware.length > 0,
      hasWebSockets: routeScanHasDocumentRoutes(environmentWebsocketRoutes),
      authEnabled,
      liveEnabled: shouldEmitLive() && liveConfig !== undefined,
      notFound: config.routing?.notFound,
    });
    const rules = mergeRoutingRules({ dir: assetRoutingPublicDir, routing: config.routing });
    const nativeOwnsEdgeRouting =
      !managedCloudflareBuild &&
      (rules.headerRules.length > 0 ||
        rules.redirectRules.length > 0 ||
        (rules.fallbackRules?.length ?? 0) > 0);
    if (nativeOwnsEdgeRouting) {
      // Cloudflare otherwise serves an existing asset before the generated
      // Worker can apply redirects or response headers. Native builds own the
      // rule pipeline, so send every path through the Worker first. Managed
      // builds keep their inferred policy because dispatch owns these rules.
      policy.assetConfig.run_worker_first = ['/**'];
      // A SPA asset binding resolves its shell before the Worker can observe
      // an asset miss. Disable that platform fallback when native fallback
      // rules exist, then restore the SPA shell in serveWithAssets after the
      // ordered user fallbacks have had their chance.
      if (
        rules.fallbackRules?.length &&
        policy.assetConfig.not_found_handling === 'single-page-application'
      ) {
        policy.assetConfig.not_found_handling = 'none';
        policy.workerSpaFallback = true;
      }
    }
    return policy;
  }

  // Provisional: `routeEnvironment` is still its `prod` default here, because no
  // `config` hook has run yet. `envPlugin.config` recomputes this before any
  // consumer reads it — `mergeBindings` runs inside the Cloudflare plugin's own
  // `config` hook, which Vite sorts after `envPlugin`'s. It is assigned here so
  // `assetRouting` is never read while unassigned.
  assetRouting = resolveConfiguredAssetRoutingPolicy();

  workerConfig.main = join(root, '.void', 'entry.ts');

  function applyAssetRoutingPolicy(policy: AssetRoutingPolicy): void {
    workerConfig.assets = {
      binding: 'ASSETS',
      ...policy.assetConfig,
    };
  }

  function updateDevAssetRoutingPolicy(next: AssetRoutingPolicy): boolean {
    const previous = assetRouting;
    const requiresRestart =
      previous.workerFirst !== next.workerFirst ||
      previous.apiWorkerFirst !== next.apiWorkerFirst ||
      previous.assetConfig.not_found_handling !== next.assetConfig.not_found_handling ||
      JSON.stringify(previous.assetConfig.run_worker_first) !==
        JSON.stringify(next.assetConfig.run_worker_first);
    assetRouting = next;
    if (requiresRestart) {
      applyAssetRoutingPolicy(next);
    }
    return requiresRestart;
  }

  applyAssetRoutingPolicy(assetRouting);

  return [
    createCloudflareBuiltinsExternalPlugin(),
    createDefaultWorkerEnvironmentPlugin(),
    createWorkerEnvironmentSanitizerPlugin([DEFAULT_WORKER_ENVIRONMENT_NAME]),
    createWranglerCompatPersistPlugin(root, config),
    devTriggerSecretGuardPlugin(),
    restartPlugin(),
    bindingWatchPlugin,
    ...(bindings.needsEmail ? [emailDevInboxPlugin({ devTriggerToken })] : []),
    envPlugin,
    envSchemaPlugin(root, { onSchema: applyEnvSchema }),
    envClientGuardPlugin(root),
    envClientFoldPlugin(),
    clientStubsPlugin,
    serverRuntimeOptimizerPlugin,
    bindingRuntimePlugin(bindingNames),
    ...(bindings.needsSandbox ? [createSandboxSdkResolvePlugin()] : []),
    ...pagesDevCssAssetsPlugin(root, devTriggerToken),
    routingPlugin(root, {
      getApplicationAnalysis,
      isAuthEnabled: () => authEnabled,
      getVersionMetadataBinding: () => versionMetadataBinding,
      devTriggerToken,
      headConfig: config.head,
      prerenderPaths: config.routing?.prerender,
      remoteMode,
      // Merged with `public/_redirects` and `_headers`; managed builds omit them (dispatch owns them).
      routing: config.routing,
      bindingNames,
      get hasSandbox() {
        return bindings.needsSandbox;
      },
      sandboxBindingName: sandboxConfig?.binding,
      sandboxClassName: sandboxConfig?.className,
      sandboxInstanceType: sandboxConfig?.instanceType,
      get live() {
        return shouldEmitLive() ? liveConfig : undefined;
      },
      durableObjects,
      websocketTombstones,
      onDevAssetRoutingPolicyChange: updateDevAssetRoutingPolicy,
    }),
    drizzlePlugin(root, true, dialect, {
      d1BindingName: bindingNames?.d1,
      forceVirtualDb: authEnabled || bindingNames?.d1 !== undefined,
      localD1DatabaseId: localD1.databaseId,
      localD1PersistRoot: localD1.persistRoot,
    }),
    migrationPlugin(root, dialect, localD1.databaseId, localD1.persistRoot, {
      enabled: authEnabled,
      configPath: authConfigPath,
    }),
    prerenderPlugin(root, config),
    devTriggersHintPlugin(root, devTriggerToken),
    ...cloudflare({
      configPath: cloudflareConfigPath,
      ...inspectorPortOption,
      persistState: { path: localD1.persistRoot },
      auxiliaryWorkers: options?.auxiliaryWorkers,
      viteEnvironment: { name: DEFAULT_WORKER_ENVIRONMENT_NAME },
      config: mergeBindings,
    }),
    implicitDeployGuard,
  ];
}

// Re-export runtime types and functions
export {
  defineHandler,
  defineMiddleware,
  basicAuth,
  defineScheduled,
  defineRender,
  defineHead,
  defineQueue,
  VoidAssetRewriteError,
} from './runtime/handler.ts';

export type {
  CloudContext,
  CloudContextVariables,
  CloudEnv,
  BasicAuthOptions,
  RenderAssetTags,
  TypedHandler,
  TypedQueueHandler,
  QueueBatch,
  QueueMessage,
  QueueRetryOptions,
} from './runtime/handler.ts';

export type { ValidatorSlots, HandlerInput } from './runtime/validator.ts';

export type { AuthUser } from './runtime/auth.ts';

export type { QueueMap } from './runtime/queues.ts';

export { defer } from './pages/defer.ts';

export type { Deferred, DeferredState, InferProps } from './pages/defer.ts';

export type { HeadDescriptor } from './pages/head.ts';

export { shouldInjectEmailDevInboxVar } from './plugin-binding-utils.ts';

export { shouldBindWorkersAi, resolveWorkersAiBindingName } from './plugin-ai-setup.ts';
