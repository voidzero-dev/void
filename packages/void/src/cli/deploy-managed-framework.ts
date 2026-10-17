import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'pathslash';
import { analyzeApplicationSync } from '../application-analysis.ts';
import { type VoidConfig } from '../config.ts';
import { collectRevalidate } from '../isr-config.ts';
import { type DetectedFramework } from '../plugin-inference.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import { PlatformClient } from './client.ts';
import { assertDeploySchemaDriftFree } from './deploy-drift.ts';
import {
  log,
  generateDeployWrapperIfNeeded,
  resolveDeployWranglerCompat,
  assertEnvSchemaValid,
  validateDeployMigrations,
  ensureManagedHyperdrive,
  toManifestSchedulesAndQueues,
} from './deploy-helpers.ts';
import {
  mergeAndLintRoutingRules,
  warnIgnoredNotFoundForFramework,
  streamDirectR2Deploy,
  warnUnpublishedRouting,
} from './deploy-managed-events.ts';
import { formatDeploySummary, printDeploySuccess } from './deploy-summary.ts';
import { MANAGED_DEPLOY_BUILD_ENV } from './deploy-transport.ts';
import { type GitDeployMetadata } from './git-metadata.ts';
import { type CliLogger } from './log-file.ts';
import { createSpinner, formatCount, note } from './output.ts';
import { collectAndHashAssets, buildFrameworkManifest, collectWorkerFiles } from './package.ts';
import { formatProjectCommand, resolveProjectCommand, type FrameworkPreset } from './preset.ts';
import { type ProjectConfig } from './project.ts';
import type { WrapperFeatures } from './wrapper.ts';
import { needsWrapper, bundleEntry, cleanupWrapper } from './wrapper.ts';

/**
 * Class B/C framework deploy: build with framework CLI, package with preset output paths.
 */
export async function runFrameworkDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  detected: DetectedFramework,
  fwPreset: FrameworkPreset,
  voidConfig: VoidConfig,
  skipBuild?: boolean,
  gitMetadata?: GitDeployMetadata,
  cliLog?: CliLogger,
): Promise<void> {
  log.info(`${detected.name} framework deploy`);
  cliLog?.info('deploy_mode', { mode: 'framework', framework: detected.name });

  const buildCmd = voidConfig.inference?.build ?? formatProjectCommand(root, fwPreset.buildCommand);
  if (!skipBuild) {
    log.step(`Building (${buildCmd})...`);
    cliLog?.info('build_start', { command: buildCmd });
    const buildStartedAt = Date.now();
    execSync(voidConfig.inference?.build ?? resolveProjectCommand(root, fwPreset.buildCommand), {
      cwd: root,
      stdio: 'inherit',
      env: buildEnv({ ...MANAGED_DEPLOY_BUILD_ENV }, { localBinRoot: root }),
    });
    cliLog?.info('build_end', { durationMs: Date.now() - buildStartedAt });
  } else {
    cliLog?.info('build_skipped', { reason: 'skipBuild' });
  }

  const workerDir = join(root, fwPreset.workerDir);
  const assetsDir = join(root, fwPreset.assetsDir);
  const frameworkAssetIgnorePatterns =
    fwPreset.workerDir === fwPreset.assetsDir && fwPreset.workerMain === '_worker.js'
      ? [`/${fwPreset.workerMain}`, '/_routes.json']
      : [];

  // Merge framework-generated `_headers` / `_redirects` + void.config.ts routing rules.
  // Netlify-symmetric phases:
  //   - `_redirects` `200!` + routing.rewrites  → redirectRules (always-fires)
  //   - `_redirects` `200`  + routing.fallbacks → fallbackRules (asset-miss only)
  const { headerRules, redirectRules, fallbackRules } = mergeAndLintRoutingRules(
    assetsDir,
    voidConfig.routing,
  );

  // Warn before the packaging spinner starts.
  warnIgnoredNotFoundForFramework(voidConfig.routing?.notFound, detected.name);

  if (!existsSync(workerDir)) {
    log.error(`deploy: Worker output '${fwPreset.workerDir}' not found. Run '${buildCmd}' first.`);
    process.exit(1);
  }

  // Resolve the same application requirements consumed by build and native planning.
  const analysis = analyzeApplicationSync(root, { config: voidConfig, environment: 'prod' });
  const { paths, bindings, authEnabled, dialect } = analysis;

  if (authEnabled) {
    log.error(
      "deploy: Void-managed Better Auth is only supported in Void apps. Use Better Auth's official integration for this framework instead.",
    );
    process.exit(1);
  }
  if (bindings.needsLive) {
    log.error('deploy: void/live is currently supported in Void apps only.');
    process.exit(1);
  }

  assertDeploySchemaDriftFree(root, dialect);

  // Validate migrations before the Hyperdrive check so migrations can gate provisioning.
  const validatedMigrations = validateDeployMigrations(
    paths.migrationsDir,
    analysis.migrations,
    paths.sourceRelative,
  );

  // Pre-deploy: ensure Hyperdrive is provisioned for external SQL projects.
  if (dialect !== 'sqlite' && analysis.needsDatabase) {
    await ensureManagedHyperdrive(client, config.projectId, dialect);
  }

  const rawJobs = analysis.jobs;
  const rawQueues = analysis.queues;
  const originalEntry = join(workerDir, fwPreset.workerMain);

  const wrapperFeatures: WrapperFeatures = {
    crons: rawJobs,
    queues: rawQueues,
    hasMigrations: validatedMigrations != null && validatedMigrations.length > 0,
    migrationDialect: dialect,
  };

  let actualWorkerDir = workerDir;
  let actualWorkerMain = fwPreset.workerMain;

  // Bundle when the framework leaves bare imports unbundled (e.g. SvelteKit).
  if (fwPreset.bundle) {
    log.step('Bundling worker...');
    const bundleResult = await bundleEntry(root, originalEntry);
    actualWorkerDir = bundleResult.outputDir;
    actualWorkerMain = bundleResult.entryFilename;
    log.info('Worker bundled');
  }

  // Wrap in place, without re-bundling, when internal deploy endpoints are needed.
  if (needsWrapper(wrapperFeatures)) {
    log.step('Generating wrapper...');
    await generateDeployWrapperIfNeeded(root, actualWorkerDir, actualWorkerMain, wrapperFeatures);
    log.info('Wrapper generated');
  }

  // Read compat settings from the original workerDir: bundleEntry() may move
  // actualWorkerDir to a temporary output without the generated wrangler.json.
  const wranglerCompat = resolveDeployWranglerCompat(root, voidConfig, workerDir, { dialect });

  const revalidate = collectRevalidate(voidConfig, null);
  const prerender = voidConfig.routing?.isr === false ? undefined : voidConfig.routing?.prerender;

  const { schedules, queues } = toManifestSchedulesAndQueues(rawJobs, rawQueues);

  await assertEnvSchemaValid(root, client, config.projectId, voidConfig.worker?.vars);

  const s = createSpinner();
  const onProgress = (msg: string) => s.message(msg);

  // Preflight: hash assets and check which ones changed.
  // `assetFiles` is threaded through to the upload step so each asset is
  // read from disk once, end-to-end.
  s.start('Checking for changes...');
  cliLog?.info('preflight_start', { dir: assetsDir });
  const { assetManifest, assetFiles } = await collectAndHashAssets(assetsDir, onProgress, {
    ignorePatterns: frameworkAssetIgnorePatterns,
  });
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
    mode: 'framework',
    framework: detected.name,
  });
  const packageStartedAt = Date.now();
  const packageOptions = {
    bindingNames: analysis.bindingNames,
    compatibilityDate: wranglerCompat?.compatibilityDate,
    compatibilityFlags: wranglerCompat?.compatibilityFlags,
    cpuMs: voidConfig.worker?.limits?.cpu_ms,
  };

  const manifest = buildFrameworkManifest({
    frameworkName: detected.name,
    workerMain: actualWorkerMain,
    bindings,
    migrations: validatedMigrations,
    schedules,
    queues,
    revalidate,
    revalidateQueryAllowlist: voidConfig.routing?.revalidateQueryAllowlist,
    prerender,
    vars: voidConfig.worker?.vars,
    // Not `routing.notFound`; see `warnIgnoredNotFoundForFramework`.
    assetConfig: {
      not_found_handling: 'none',
      ...(fwPreset.htmlHandling ? { html_handling: fwPreset.htmlHandling } : {}),
    },
    packageOptions,
    hashedAssetsPrefix: fwPreset.hashedAssetsPrefix ?? 'assets',
    headerRules,
    redirectRules,
    fallbackRules,
    dialect,
  });
  const workerFiles = collectWorkerFiles(actualWorkerDir);
  cliLog?.info('package_end', {
    mode: 'framework',
    durationMs: Date.now() - packageStartedAt,
  });

  // Migration SQL bytes ride along inside the worker bundle (compiled in
  // by the framework via `migration-handler.ts`); the deploy body only
  // needs `manifest.migrations.pending` so the platform knows to invoke
  // the worker's `/__void/migrate` endpoint after dispatch.
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
      prerenderedPages: prerender?.length,
      revalidate,
      framework: detected.name,
    }),
    result.url,
  );

  // Clean up generated wrapper files
  cleanupWrapper(root);

  warnUnpublishedRouting(result);
  printDeploySuccess(result.published !== false);
}
