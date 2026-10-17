import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  activateCloudflareVersion,
  encodeCloudflareVersionMessage,
  parseRootWranglerConfig,
  readCloudflareTriggerConfig,
  readWranglerTopLevelString,
  renderCloudflareStaticEntry,
  stageCloudflareStaticAssets,
  writeCloudflareFrameworkDeployConfig,
  writeCloudflareStaticDeployConfig,
  assertExistingCloudflareConfig,
} from '@void/deploy-cloudflare';
import { dirname, join, relative } from 'pathslash';
import { analyzeApplicationSync } from '../application-analysis.ts';
import { analyzeApplication } from '../application-routing.ts';
import { type VoidConfig } from '../config.ts';
import { collectRevalidate, hasRevalidate } from '../isr-config.ts';
import { detectFramework, type DetectedFramework } from '../plugin-inference.ts';
import { hasEmailHandlers } from '../router/email.ts';
import { selectNativeVersionMetadataBinding } from '../shared/version-metadata.ts';
import { validateSsrEntry } from '../ssr/entry.ts';
import { prepareCfStaticBuildOutput } from './cf-build-output.ts';
import { type CloudflareCandidateReceipt } from './cloudflare-candidate.ts';
import { readCloudflareLink, type CloudflareLink } from './cloudflare-link.ts';
import { deduplicateGeneratedCompatibilityFlags } from './deploy-artifact-validation.ts';
import { deployPointerPath } from './deploy-binding-snapshot.ts';
import { prepareExistingCloudflareDeployWithAuth } from './deploy-cloudflare-auth.ts';
import {
  discoverRootWranglerConfig,
  activateCloudflareVersionWithProgress,
  assertCloudflareDeployTargetUnchanged,
  cloudflareCandidateActivationOptions,
  confirmCloudflareDeployAuthentication,
  connectCloudflareDeployAccount,
  createCfActivationRunner,
  recordCloudflareActivation,
  reportCloudflareActivationFailure,
  formatCloudflareActivationError,
} from './deploy-cloudflare-helpers.ts';
import {
  generateDeployWrapperIfNeeded,
  resolveStaticDeployPreset,
  resolveStaticBuildCommand,
  hasNonPageBackend,
  resolveFullDeployBuildCommand,
  log,
  getExitCode,
} from './deploy-helpers.ts';
import { mergeAndLintRoutingRules } from './deploy-managed-events.ts';
import { deriveWorkerName } from './deploy-resources.ts';
import { formatDeploySummary, printDeployContext, printDeploySuccess } from './deploy-summary.ts';
import {
  scrubManagedDeployBuildMarkers,
  scrubWranglerAuthCredentials,
  deployChildEnv,
} from './deploy-transport.ts';
import { type RunDeployOptions, type CloudflareDeployDeps } from './deploy-types.ts';
import { type CliLogger } from './log-file.ts';
import { getErrorMessage, note } from './output.ts';
import { buildStaticManifest } from './package.ts';
import { detectPreset, type StaticPreset, type FrameworkPreset } from './preset.ts';
import { deleteEnvVarCaseAware } from './provision.ts';
import { readWranglerManagedQueueCleanupCandidates } from './wrangler.ts';

/** Default runtime date for static and framework Workers that set none. */
const DEFAULT_COMPATIBILITY_DATE = '2026-09-11';

/** Build the trusted Wrangler pointer for a framework that emits Worker files directly. */
export async function prepareCloudflareFrameworkArtifact(options: {
  root: string;
  configPath: string;
  accountId: string;
  workerName: string;
  voidConfig: VoidConfig;
  framework: DetectedFramework;
  preset: FrameworkPreset;
  requiredSecretNames?: ReadonlyArray<string>;
  ai?: { binding: string };
  preserveBindings?: boolean;
}): Promise<void> {
  const { root, configPath, accountId, workerName, voidConfig, framework, preset, ai } = options;
  const { requiredSecretNames = [], preserveBindings = false } = options;
  const workerMain = join(root, preset.workerDir, preset.workerMain);
  const assetsDirectory = join(root, preset.assetsDir);
  if (!existsSync(workerMain)) {
    throw new Error(
      `framework ${framework.name} did not emit its Worker entry at ${preset.workerDir}/${preset.workerMain}`,
    );
  }
  if (!existsSync(assetsDirectory)) {
    throw new Error(
      `framework ${framework.name} did not emit its asset directory at ${preset.assetsDir}`,
    );
  }
  const analysis = analyzeApplicationSync(root, { config: voidConfig, environment: 'prod' });
  const crons = analysis.jobs;
  const queues = analysis.queues;
  const revalidate = collectRevalidate(voidConfig, null);
  const rootConfig = parseRootWranglerConfig(configPath);
  const versionMetadataBinding = selectNativeVersionMetadataBinding(rootConfig, {
    nativeBuild: true,
    preserveBindings,
  });
  await generateDeployWrapperIfNeeded(root, join(root, preset.workerDir), preset.workerMain, {
    crons,
    queues,
    // Direct deployment applies migrations before upload; it does not need the
    // hosted platform's internal migration endpoint in its framework wrapper.
    hasMigrations: false,
    migrationDialect: analysis.dialect,
    readiness: true,
    versionMetadataBinding,
    ...(hasRevalidate(revalidate) && {
      isr: {
        revalidate: revalidate!,
        queryAllowlist: voidConfig.routing?.revalidateQueryAllowlist,
      },
    }),
  });
  if (preset.cloudflareArtifact === 'vite-plugin') {
    return;
  }
  writeCloudflareFrameworkDeployConfig({
    configPath,
    deployPointerPath: deployPointerPath(root),
    name: workerName,
    accountId,
    main: relative(dirname(configPath), workerMain),
    assetsDirectory: relative(dirname(configPath), assetsDirectory),
    compatibilityDate:
      voidConfig.worker?.compatibility_date ??
      readWranglerTopLevelString(rootConfig, 'compatibility_date') ??
      DEFAULT_COMPATIBILITY_DATE,
    // The PostgreSQL and MySQL drivers need workerd's Node modules, as in a managed deploy.
    compatibilityFlags:
      analysis.dialect === 'sqlite'
        ? preset.cloudflareCompatibilityFlags
        : [...(preset.cloudflareCompatibilityFlags ?? []), 'nodejs_compat'],
    crons: [...new Set(crons.flatMap((job) => job.crons))],
    ...(preset.htmlHandling ? { htmlHandling: preset.htmlHandling } : {}),
    requiredSecrets: requiredSecretNames,
    versionMetadataBinding,
    ...(ai ? { ai: { ...ai, gateway: voidConfig.ai?.gateway } } : {}),
    ...(preset.workerDir === preset.assetsDir
      ? {
          assetsIgnore: [
            preset.workerMain,
            '_routes.json',
            '__original.js',
            '__original.mjs',
            '__void_handlers.mjs',
            '__void_isr*.mjs',
            '__void_migration_handler*.mjs',
          ],
        }
      : {}),
  });
}

export function resolveCloudflareStaticPreset(
  root: string,
  voidConfig: VoidConfig,
  options: Pick<RunDeployOptions, 'dir' | 'spa'>,
): StaticPreset | null {
  const configured = resolveStaticDeployPreset(root, voidConfig, options);
  if (configured) {
    return {
      ...configured,
      buildCommand: resolveStaticBuildCommand(
        configured,
        voidConfig.inference?.build,
        Boolean(options.dir),
      ),
    };
  }
  if (detectFramework(root)) {
    return null;
  }
  const detected = detectPreset(root, { spa: options.spa, strictBackend: true });
  return detected
    ? {
        ...detected,
        buildCommand: resolveStaticBuildCommand(detected, voidConfig.inference?.build, false),
      }
    : null;
}

/**
 * Resolve a Void Pages `output: "static"` app to the thin static edge worker
 * only when the same source-level conditions used by the managed deploy prove
 * that no request can require the application worker at runtime. Hybrid SSG
 * apps deliberately fall through to the normal Worker deploy path.
 */
export async function resolveCloudflareVoidStaticPreset(
  root: string,
  voidConfig: VoidConfig,
): Promise<StaticPreset | null> {
  if (voidConfig.output !== 'static') {
    return null;
  }

  const analysis = await analyzeApplication(root, { config: voidConfig, environment: 'prod' });
  const { paths, authEnabled, bindings, scan: routeScan } = analysis;
  if (!existsSync(paths.pagesDir) || validateSsrEntry(root, paths) !== null) {
    return null;
  }

  const pageScan = routeScan.pages;
  if (
    pageScan.pages.length === 0 ||
    !pageScan.pages.every(
      (page) =>
        page.shouldPrerender &&
        ((page.params.length === 0 && !page.catchAll) || page.hasGetPrerenderPaths),
    )
  ) {
    return null;
  }

  // The SAME predicate the managed path's fully-static optimization uses
  // (`hasNonPageBackend`), so the two static branches can never disagree on
  // whether an `email/` handler needs a worker: the thin static edge Worker
  // exports no `email()`, so inbound mail to a project routed there bounces.
  const hasRuntimeBackend =
    hasNonPageBackend({
      hasRoutes: routeScan.routes.length > 0,
      hasMiddleware: routeScan.middleware.length > 0,
      hasWebSockets: (routeScan.websockets?.length ?? 0) > 0,
      hasEmail: routeScan.email !== undefined && hasEmailHandlers(routeScan.email),
      authEnabled,
      hasLive: bindings.needsLive === true,
    }) ||
    analysis.jobs.length > 0 ||
    analysis.queues.length > 0;
  if (hasRuntimeBackend) {
    return null;
  }

  return {
    buildCommand: resolveFullDeployBuildCommand(root, voidConfig.inference?.build).command,
    outputDir: join(root, 'dist', 'client'),
    appType: 'static',
  };
}

export async function runCloudflareStaticDeploy(
  root: string,
  options: RunDeployOptions,
  voidConfig: VoidConfig,
  preset: StaticPreset,
  cliLog: CliLogger,
  deps: CloudflareDeployDeps,
  initialCloudflareLink: CloudflareLink | null,
  initialCloudflareCandidate: CloudflareCandidateReceipt | null,
): Promise<void> {
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const configPath = discoverRootWranglerConfig(root);
  const connection = await connectCloudflareDeployAccount({
    root,
    configPath,
    rootConfig: parseRootWranglerConfig(configPath),
    deps,
    persistAccount: !(options.reuseExistingWorker || initialCloudflareLink),
  });
  if (!connection || !(await confirmCloudflareDeployAuthentication(connection, configPath))) {
    return exit(1);
  }
  const {
    apiBaseUrl,
    usesCf,
    cfUploaderIsPinned,
    assertUploaderStillPinned,
    accountId,
    workersDevSubdomain,
    runWrangler,
  } = connection;

  const existingWorker = await prepareExistingCloudflareDeployWithAuth(
    {
      root,
      configPath,
      accountId,
      reuse: options.reuseExistingWorker,
      pinnedLink: initialCloudflareLink,
      runWrangler,
      readExistingWorker: deps.readExistingWorker,
    },
    assertUploaderStillPinned,
  );
  const pinnedHandoffLink = existingWorker ? readCloudflareLink(root) : null;
  if (existingWorker && !pinnedHandoffLink) {
    throw new Error('The pending Cloudflare handoff was not saved before deployment.');
  }
  const rootConfig = parseRootWranglerConfig(configPath);
  const workerName = readWranglerTopLevelString(rootConfig, 'name') ?? deriveWorkerName(root);
  printDeployContext(workerName, 'Cloudflare');
  const rootConfigBeforeBuild = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
  if (preset.buildCommand && !options.skipBuild) {
    log.step('Building...');
    const buildChildEnv = scrubManagedDeployBuildMarkers(
      scrubWranglerAuthCredentials(deployChildEnv(accountId, apiBaseUrl)),
    );
    deleteEnvVarCaseAware(buildChildEnv, 'NODE_ENV');
    buildChildEnv.NODE_ENV = 'production';
    const runStaticBuild =
      deps.runStaticBuild ??
      ((command: string, env: NodeJS.ProcessEnv) => {
        execSync(command, { cwd: root, stdio: 'inherit', env });
      });
    try {
      runStaticBuild(preset.buildCommand, buildChildEnv);
    } catch (error) {
      log.error(`deploy: build failed — ${getErrorMessage(error)}`);
      return exit(getExitCode(error));
    }
  }
  log.step('Preparing deployment...');
  if (!existsSync(preset.outputDir)) {
    log.error(`deploy: Output directory '${preset.outputDir}' not found. Run the build first.`);
    return exit(1);
  }
  if (!assertUploaderStillPinned()) {
    return exit(1);
  }
  const rootConfigAfterBuild = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
  if (rootConfigAfterBuild !== rootConfigBeforeBuild) {
    log.error(
      [
        'deploy: the root Wrangler config changed during the static build.',
        'Refusing to upload a config rewritten by project build code. Restore the config and retry.',
      ].join('\n'),
    );
    return exit(1);
  }

  const merged = mergeAndLintRoutingRules(preset.outputDir, voidConfig.routing);
  const manifest = buildStaticManifest({
    appType: preset.appType,
    hashedAssetsPrefix: 'assets',
    headerRules: merged.headerRules,
    redirectRules: merged.redirectRules,
    fallbackRules: merged.fallbackRules,
    notFound: voidConfig.routing?.notFound,
  });
  const entryPath = join(root, '.void', 'deploy', 'cloudflare', 'static-edge.mjs');
  mkdirSync(dirname(entryPath), { recursive: true });

  // Write the static config separately so the root config, with its Worker-only bindings and
  // comments, stays untouched for a later switch back to a Worker app.
  const staticConfigPath = join(dirname(entryPath), 'wrangler-static.json');
  writeFileSync(staticConfigPath, `${JSON.stringify(rootConfig, null, 2)}\n`, { mode: 0o600 });
  writeCloudflareStaticDeployConfig({
    configPath: staticConfigPath,
    name: workerName,
    accountId,
    main: relative(dirname(staticConfigPath), entryPath),
    assetsDirectory: relative(dirname(staticConfigPath), preset.outputDir),
    compatibilityDate:
      voidConfig.worker?.compatibility_date ??
      readWranglerTopLevelString(rootConfig, 'compatibility_date') ??
      DEFAULT_COMPATIBILITY_DATE,
    assetConfig: manifest.assetConfig ?? { not_found_handling: 'none' },
  });
  deduplicateGeneratedCompatibilityFlags(staticConfigPath, configPath);
  const staticConfig = parseRootWranglerConfig(staticConfigPath);
  const versionMetadataBinding = selectNativeVersionMetadataBinding(staticConfig, {
    nativeBuild: true,
    preserveBindings: existingWorker !== null,
  });
  if (versionMetadataBinding && staticConfig.version_metadata === undefined) {
    writeFileSync(
      staticConfigPath,
      `${JSON.stringify({ ...staticConfig, version_metadata: { binding: versionMetadataBinding } }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  writeFileSync(
    entryPath,
    renderCloudflareStaticEntry({
      runtimeImport: 'void/edge',
      headerRules: manifest.headerRules,
      redirectRules: manifest.redirectRules,
      fallbackRules: manifest.fallbackRules,
      versionMetadataBinding,
    }),
  );

  if (existingWorker) {
    assertExistingCloudflareConfig(existingWorker, parseRootWranglerConfig(staticConfigPath), true);
  }

  const stagedAssetsDirectory = join(root, '.void', 'deploy', 'cloudflare', 'assets');
  stageCloudflareStaticAssets({
    sourceDirectory: preset.outputDir,
    destinationDirectory: stagedAssetsDirectory,
  });

  const queueConsumerCleanup = readWranglerManagedQueueCleanupCandidates(configPath);
  assertCloudflareDeployTargetUnchanged({
    root,
    existingWorker,
    pinnedHandoffLink,
    initialCloudflareCandidate,
    accountId,
    workerName,
  });
  if (usesCf && !cfUploaderIsPinned()) {
    return exit(1);
  }
  const cfOutput = usesCf
    ? await prepareCfStaticBuildOutput({
        projectRoot: root,
        configPath: staticConfigPath,
        assetsDirectory: stagedAssetsDirectory,
        accountId,
      })
    : null;
  if (!cfOutput && usesCf) {
    log.error('deploy: cf could not prepare the static Worker for deployment.');
    return exit(1);
  }
  const activationRunner = createCfActivationRunner({
    cfOutput,
    accountId,
    apiBaseUrl,
    workerName,
    configPath: staticConfigPath,
    runWrangler,
    cfUploaderIsPinned,
    verifyCompatibilityRunner: assertUploaderStillPinned,
  });
  const execution = await activateCloudflareVersionWithProgress(
    deps.activateVersion ?? activateCloudflareVersion,
    {
      ...cloudflareCandidateActivationOptions({
        root,
        rootConfigPath: configPath,
        uploadConfigPath: staticConfigPath,
        accountId,
        apiBaseUrl,
        workerName,
        workersDevSubdomain,
        runWrangler,
        readExistingWorker: deps.readExistingWorker,
        existingWorker,
        pinnedHandoffLink,
        initialCloudflareCandidate,
        assertUploaderStillPinned,
        approvedKv: [],
        staticAssetsBinding: 'ASSETS',
        queueConsumerCleanup,
      }),
      runWrangler: activationRunner,
      verifyUploader: cfOutput ? cfUploaderIsPinned : assertUploaderStillPinned,
      requireVersionMetadata: existingWorker === null || versionMetadataBinding !== undefined,
      requirePreviewForReadiness: existingWorker !== null && versionMetadataBinding === undefined,
      message: encodeCloudflareVersionMessage([], {
        ...readCloudflareTriggerConfig(staticConfigPath, configPath),
        ...(existingWorker ? { preserve: true } : {}),
      }),
      assetsDirectoryOverride: stagedAssetsDirectory,
    },
  ).finally(() => cfOutput?.dispose());
  if (!execution.ok) {
    await reportCloudflareActivationFailure(cliLog, formatCloudflareActivationError(execution));
    return exit(1);
  }
  recordCloudflareActivation({
    root,
    configPath,
    accountId,
    workerName,
    existingWorker,
    queueConsumerCleanup,
    execution,
    cliLog,
  });
  note(
    formatDeploySummary({
      workerName,
      typeLabel: preset.appType === 'spa' ? 'Static SPA' : 'Static Site',
    }),
    execution.previewUrl,
  );
  printDeploySuccess();
}
