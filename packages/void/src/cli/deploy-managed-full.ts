import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'pathslash';
import { analyzeApplication } from '../application-routing.ts';
import {
  hasApiRoutes as routeScanHasApiRoutes,
  hasDocumentRoutes as routeScanHasDocumentRoutes,
  resolveAssetConfig,
} from '../asset-routing.ts';
import { type VoidConfig, isNodeTarget } from '../config.ts';
import { collectRevalidate } from '../isr-config.ts';
import { type DetectedFramework } from '../plugin-inference.ts';
import { assertNoPrerenderFailures } from '../prerender-render.ts';
import {
  collectPrerenderPaths,
  collectPrerenderPathsNode,
  prerenderPages,
  prerenderPagesNode,
} from '../prerender.ts';
import { hasEmailHandlers } from '../router/email.ts';
import { requiresSandboxPlatformImage, resolveSandboxConfig } from '../sandbox/config.ts';
import { resolveRemoteMode } from '../shared/env.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import { validateSsrEntry } from '../ssr/entry.ts';
import { resolveDistDir, resolveWorkerDirName } from './build-output-dir.ts';
import { PlatformClient } from './client.ts';
import { assertDeploySchemaDriftFree } from './deploy-drift.ts';
import {
  resolveFullDeployBuildCommand,
  log,
  getExitCode,
  resolveDeployLiveBindingConfig,
  hasNonPageBackend,
  hasPrerenderSources,
  resolveDeployWranglerCompat,
  resolveDeployWorkerMain,
  assertEnvSchemaValid,
  generateDeployWrapperIfNeeded,
  assertWorkerMainUploaded,
  validateDeployMigrations,
  ensureManagedHyperdrive,
  toManifestSchedulesAndQueues,
} from './deploy-helpers.ts';
import {
  mergeAndLintRoutingRules,
  streamDirectR2Deploy,
  warnUnpublishedRouting,
} from './deploy-managed-events.ts';
import { runStaticDeploy, assembleVoidManifest } from './deploy-managed-static.ts';
import { formatDeploySummary, printDeploySuccess } from './deploy-summary.ts';
import { MANAGED_DEPLOY_BUILD_ENV } from './deploy-transport.ts';
import { type GitDeployMetadata } from './git-metadata.ts';
import { type CliLogger } from './log-file.ts';
import { createSpinner, formatCount, note } from './output.ts';
import {
  collectAndHashAssets,
  collectWorkerFiles,
  detectNonSpaFallbackWarning,
} from './package.ts';
import { formatProjectCommand, type FrameworkPreset } from './preset.ts';
import { type ProjectConfig } from './project.ts';
import type { AssetConfig } from './types.ts';
import type { WrapperFeatures } from './wrapper.ts';
import { needsWrapper } from './wrapper.ts';

export async function runFullDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  /**
   * The already-read `void.config.ts`, threaded from `runDeploy` the same way
   * `runFrameworkDeploy` receives it. The build step reads `inference.build`
   * from it, so it must be available BEFORE the build.
   */
  voidConfig: VoidConfig,
  fwPreset?: FrameworkPreset,
  skipBuild?: boolean,
  gitMetadata?: GitDeployMetadata,
  detected?: DetectedFramework,
  cliLog?: CliLogger,
): Promise<void> {
  cliLog?.info('deploy_mode', {
    mode: 'full',
    framework: detected?.name,
  });

  // Build in a child process to avoid Vite API side effects on bundle output.
  if (!skipBuild) {
    const { label: buildCmd, command: buildExec } = resolveFullDeployBuildCommand(
      root,
      voidConfig.inference?.build,
    );
    log.step(`Building (${buildCmd})...`);
    cliLog?.info('build_start', { command: buildCmd });
    const buildStartedAt = Date.now();
    try {
      // VOID_DEPLOY_PROJECT_ID marks a managed build: platform dispatch owns routing and ISR.
      execSync(buildExec, {
        cwd: root,
        stdio: 'inherit',
        env: buildEnv(
          { VOID_DEPLOY_PROJECT_ID: config.projectId, ...MANAGED_DEPLOY_BUILD_ENV },
          { localBinRoot: root },
        ),
      });
      cliLog?.info('build_end', { durationMs: Date.now() - buildStartedAt });
    } catch (err: unknown) {
      cliLog?.error('build_failed', err, { durationMs: Date.now() - buildStartedAt });
      process.exit(getExitCode(err));
    }
  } else {
    cliLog?.info('build_skipped', { reason: 'skipBuild' });
  }

  // Resolve output paths from build artifacts instead of re-resolving the Vite
  // config here; plugins run only once, inside the build.
  const frameworkBuildCmd = fwPreset
    ? formatProjectCommand(root, fwPreset.buildCommand)
    : undefined;
  const distDir = resolveDistDir(root, fwPreset, frameworkBuildCmd);
  const workerDirName = resolveWorkerDirName(distDir, fwPreset, frameworkBuildCmd);

  // Detect non-default assetsDir from Vite client manifest for _headers generation
  let assetsPrefix = 'assets';
  const clientManifestPath = join(distDir, 'client', '.vite', 'manifest.json');
  if (existsSync(clientManifestPath)) {
    const manifest: Record<string, { file?: string }> = JSON.parse(
      readFileSync(clientManifestPath, 'utf-8'),
    );
    for (const entry of Object.values(manifest)) {
      if (entry.file?.includes('/')) {
        const dir = entry.file.slice(0, entry.file.indexOf('/'));
        if (dir !== 'assets') {
          assetsPrefix = dir;
        }
        break;
      }
    }
  }

  // Class A framework mode, detected by runDeploy.
  const isFrameworkMode = detected != null;

  // Managed static prerender is deliberately outside the Vite subprocess. The
  // build runs arbitrary project plugins with every platform credential
  // scrubbed; only this trusted parent receives the proxy-only token and
  // injects it into the built worker's Miniflare bindings.
  if (voidConfig.output === 'static' && !isFrameworkMode) {
    const result = isNodeTarget(voidConfig.target)
      ? await prerenderPagesNode({
          root,
          ssrDir: join(distDir, 'ssr'),
          clientDir: join(distDir, 'client'),
        })
      : await prerenderPages({
          root,
          workerDir: join(distDir, workerDirName),
          clientDir: join(distDir, 'client'),
          persistDir: join(root, '.void'),
          remoteMode: resolveRemoteMode(voidConfig.remote),
          projectId: config.projectId,
          voidToken: await client.createPrerenderToken(config.projectId),
        });

    if (result.paths.length === 0) {
      log.info('No pages to prerender');
    } else {
      assertNoPrerenderFailures(result.failed);
    }
  }

  const analysis = await analyzeApplication(root, { config: voidConfig, environment: 'prod' });
  const { paths, dialect, bindings, authEnabled, scan: routeScan } = analysis;

  if (isFrameworkMode && authEnabled) {
    log.error(
      "Void-managed Better Auth is only supported in Void apps. Use Better Auth's official integration for this framework instead.",
    );
    process.exit(1);
  }

  if (isFrameworkMode && bindings.needsSandbox) {
    log.error('deploy: Cloudflare Sandboxes are currently supported in Void apps only.');
    process.exit(1);
  }
  if (isFrameworkMode && bindings.needsLive) {
    log.error('deploy: void/live is currently supported in Void apps only.');
    process.exit(1);
  }

  const sandboxConfig = bindings.needsSandbox ? resolveSandboxConfig(voidConfig, root) : undefined;
  if (bindings.needsSandbox && requiresSandboxPlatformImage(voidConfig)) {
    log.error(
      'deploy: `sandbox.image` points at a local Dockerfile. Add `sandbox.platformImage` with a pushed registry image for `void deploy`, or deploy this sandbox directly with Wrangler.',
    );
    process.exit(1);
  }

  // Merge user/framework `_headers` / `_redirects` in the built client dir with
  // `void.config.ts` routing rules.
  const clientDir = join(distDir, 'client');
  const { headerRules, redirectRules, fallbackRules } = mergeAndLintRoutingRules(
    clientDir,
    voidConfig.routing,
  );

  assertDeploySchemaDriftFree(root, dialect);

  // Validate migrations before the Hyperdrive check so migrations can gate provisioning.
  const validatedMigrations = validateDeployMigrations(
    paths.migrationsDir,
    analysis.migrations,
    paths.sourceRelative,
  );

  // Pre-deploy: ensure Hyperdrive is provisioned for external SQL projects.
  // Migrations on disk also gate this — even if inference says needsD1: false,
  // buildVoidManifest will add the hyperdrive binding when migrations are present.
  if (dialect !== 'sqlite' && analysis.needsDatabase) {
    await ensureManagedHyperdrive(client, config.projectId, dialect);
  }
  const rawJobs = analysis.jobs;
  const rawQueues = analysis.queues;
  const { schedules, queues } = toManifestSchedulesAndQueues(rawJobs, rawQueues);
  const webSockets = analysis.websockets;
  const liveConfig = await resolveDeployLiveBindingConfig(root, client, config.projectId, {
    isFrameworkMode,
    needsLive: bindings.needsLive,
    webSockets,
    sandboxClassName: sandboxConfig?.className,
    cliLog,
  });
  const hasPages = existsSync(paths.pagesDir);
  const hasRoutes = routeScan.routes.length > 0;
  const hasApiRoutes =
    routeScanHasApiRoutes(routeScan.routes) || routeScanHasApiRoutes(webSockets) || authEnabled;
  const hasDocumentRoutes = routeScanHasDocumentRoutes(routeScan.routes);
  const hasMiddleware = routeScan.middleware.length > 0;
  const hasWebSockets = webSockets.length > 0;
  // A Class-A framework app has no Void SSR entry to validate.
  const ssrEntry = isFrameworkMode ? null : validateSsrEntry(root, paths);
  const isSsr = isFrameworkMode
    ? true
    : Boolean(ssrEntry) || (hasPages && voidConfig.output !== 'static');

  // Resolve revalidate config from void.config.ts + per-page .server.ts exports.
  // The page scan is also reused by the fully-static optimization below.
  const pageScan = hasPages ? routeScan.pages : null;
  const revalidate = collectRevalidate(voidConfig, pageScan);

  // Fully-static optimization: if output: "static" and all pages are prerendered
  // with no backend features, deploy as a static site (no worker needed)
  if (voidConfig.output === 'static' && pageScan && !isSsr) {
    const allPrerenderable = pageScan.pages.every(
      (p) =>
        p.shouldPrerender && ((p.params.length === 0 && !p.catchAll) || p.hasGetPrerenderPaths),
    );
    const nonPageBackend = hasNonPageBackend({
      hasRoutes,
      hasMiddleware,
      hasWebSockets,
      hasEmail: routeScan.email !== undefined && hasEmailHandlers(routeScan.email),
      authEnabled,
      hasLive: liveConfig !== undefined,
    });
    if (
      allPrerenderable &&
      !nonPageBackend &&
      analysis.durableObjects.length === 0 &&
      schedules.length === 0 &&
      queues.length === 0
    ) {
      log.info('All pages prerendered — deploying as static site');
      cliLog?.info('full_to_static_redirect', { reason: 'all_pages_prerendered' });
      return runStaticDeploy(
        root,
        config,
        client,
        {
          buildCommand: null,
          outputDir: clientDir,
          appType: 'static',
        },
        true,
        gitMetadata,
        assetsPrefix,
        headerRules,
        redirectRules,
        fallbackRules,
        // Rules were already merged above.
        undefined,
        cliLog,
        voidConfig.routing?.notFound,
        voidConfig.routing?.alwaysUseHttps,
      );
    }
  }

  // Resolve prerender paths. Skip in three cases:
  //   - output: "static" — pages are already built as static assets.
  //   - framework mode (Class A) — the framework's own worker entry has no
  //     /__void/prerender-paths endpoint (only compileWorkerEntry /
  //     compileNodeApp emit it for Void apps). Class-A frameworks handle
  //     prerendering through their own build pipelines.
  //   - the app has no prerender source at all (no `pages/`, no SSR entry, no
  //     `routing.prerender`) — the collector provably returns `[]`, so booting
  //     the worker in Miniflare can only fail, never contribute. See
  //     `hasPrerenderSources` for why that failure mode matters.
  const prerenderSourcesPresent = hasPrerenderSources({
    hasPages,
    hasSsrEntry: ssrEntry !== null,
    explicitPrerenderPaths: voidConfig.routing?.prerender,
  });
  const uniquePrerenderPaths =
    voidConfig.routing?.isr === false ||
    voidConfig.output === 'static' ||
    isFrameworkMode ||
    !prerenderSourcesPresent
      ? []
      : isNodeTarget(voidConfig.target)
        ? await collectPrerenderPathsNode({
            root,
            ssrDir: join(distDir, 'ssr'),
            clientDir,
          })
        : await collectPrerenderPaths({
            root,
            workerDir: join(distDir, workerDirName),
            clientDir,
            persistDir: join(root, '.void'),
            // Match the runtime remote-mode switch so getPrerenderPaths()
            // reads real D1/KV/R2 during deploy-time path discovery when
            // the project is in remote mode. Without this the manifest
            // would be built from local bindings even for remote projects.
            remoteMode: resolveRemoteMode(voidConfig.remote),
            projectId: config.projectId,
            voidToken: await client.createPrerenderToken(config.projectId),
          });

  const wranglerCompat = resolveDeployWranglerCompat(
    root,
    voidConfig,
    join(distDir, workerDirName),
    {
      authEnabled,
      dialect,
      needsSandbox: bindings.needsSandbox,
    },
  );
  const workerMain = resolveDeployWorkerMain(voidConfig, join(distDir, workerDirName));

  await assertEnvSchemaValid(root, client, config.projectId, voidConfig.worker?.vars);

  const s = createSpinner();
  const onProgress = (msg: string) => s.message(msg);

  const assetConfig: AssetConfig = resolveAssetConfig({
    isSsr,
    hasPages,
    hasApiRoutes,
    hasDocumentRoutes,
    hasMiddleware,
    hasWebSockets: routeScanHasDocumentRoutes(webSockets),
    authEnabled,
    liveEnabled: liveConfig !== undefined,
    notFound: voidConfig.routing?.notFound,
  });

  // Preflight: hash assets and check which ones changed.
  // `assetFiles` carries the in-memory buffer cache through to the upload
  // step so each asset is read from disk exactly once.
  s.start('Checking for changes...');
  cliLog?.info('preflight_start', { dir: clientDir });
  const { assetManifest, assetFiles } = await collectAndHashAssets(clientDir, onProgress);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest, true);
  s.stop('Checked for changes');
  cliLog?.info('preflight_end', {
    total: Object.keys(assetManifest).length,
    needed: needed.length,
    skipped,
  });

  if (skipped > 0) {
    log.info(`Skipping ${formatCount(skipped, 'unchanged asset')}`);
  }

  s.start('Packaging...');
  cliLog?.info('package_start', {
    mode: 'full',
    isSsr,
    hasRoutes,
    hasMiddleware,
    hasWebSockets,
    authEnabled,
    framework: detected?.name,
  });
  const packageStartedAt = Date.now();
  const voidPackageOptions = {
    bindingNames: analysis.bindingNames,
    compatibilityDate: wranglerCompat?.compatibilityDate,
    compatibilityFlags: wranglerCompat?.compatibilityFlags,
    cpuMs: voidConfig.worker?.limits?.cpu_ms,
    ...(workerMain && { workerMain }),
    ...(sandboxConfig && { sandbox: sandboxConfig }),
    ...(liveConfig && { live: liveConfig }),
    revalidateQueryAllowlist: voidConfig.routing?.revalidateQueryAllowlist,
  };

  // Surface the non-SPA-fallbacks mismatch (if any) before invoking the
  // I/O-free manifest builder.
  const fallbackWarning = detectNonSpaFallbackWarning(assetConfig, fallbackRules);
  if (fallbackWarning) {
    onProgress(fallbackWarning);
    console.warn(`[void] ${fallbackWarning}`);
  }

  const manifest = assembleVoidManifest(
    pageScan,
    isFrameworkMode,
    {
      bindings: liveConfig ? { ...bindings, needsLive: true } : bindings,
      alwaysUseHttps: voidConfig.routing?.alwaysUseHttps,
      hasEmailHandlers:
        !isFrameworkMode && routeScan.email !== undefined && hasEmailHandlers(routeScan.email),
      migrations: validatedMigrations,
      schedules,
      ssr: isSsr || hasRoutes || hasMiddleware || hasWebSockets || authEnabled,
      framework: isFrameworkMode ? detected!.name : undefined,
      revalidate,
      vars: voidConfig.worker?.vars,
      queues,
      prerender: uniquePrerenderPaths,
      assetConfig,
      options: voidPackageOptions,
      hashedAssetsPrefix: assetsPrefix,
      headerRules,
      redirectRules,
      fallbackRules,
      dialect,
      webSockets,
      durableObjects: analysis.durableObjects,
    },
    voidConfig.routing?.revalidate,
    voidConfig.routing?.isr !== false,
  );
  const workerDir = join(distDir, workerDirName);
  if (isFrameworkMode) {
    const wrapperFeatures: WrapperFeatures = {
      crons: rawJobs,
      queues: rawQueues,
      hasMigrations: validatedMigrations != null && validatedMigrations.length > 0,
      migrationDialect: dialect,
    };
    if (needsWrapper(wrapperFeatures)) {
      log.step('Generating wrapper...');
      await generateDeployWrapperIfNeeded(
        root,
        workerDir,
        fwPreset?.workerMain ?? 'index.js',
        wrapperFeatures,
      );
      log.info('Wrapper generated');
    }
  }
  const workerFiles = collectWorkerFiles(workerDir);
  assertWorkerMainUploaded(workerFiles, workerMain);
  cliLog?.info('package_end', {
    mode: 'full',
    durationMs: Date.now() - packageStartedAt,
  });
  const result = await streamDirectR2Deploy({
    client,
    projectId: config.projectId,
    manifest,
    assetManifest,
    assetFiles,
    needed,
    gitMetadata,
    preflightUsed: skipped > 0,
    workerFiles,
    spinner: s,
    cliLog,
  });

  note(
    formatDeploySummary({
      workers: result.workers,
      assets: result.assets,
      unchangedAssets: skipped,
      migrations: result.migrations,
      cronJobs: schedules.length,
      queues: queues.length,
      prerenderedPages: uniquePrerenderPaths.length,
      ssr: isSsr,
      revalidate,
      framework: isFrameworkMode || undefined,
    }),
    result.url,
  );

  warnUnpublishedRouting(result);
  printDeploySuccess(result.published !== false);
}
