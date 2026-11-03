import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { type NotFoundHandling, type RoutingConfig } from '../config.ts';
import { collectPages } from '../isr-config.ts';
import type { PageScanResult } from '../pages/types.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import { PlatformClient } from './client.ts';
import { log } from './deploy-helpers.ts';
import {
  mergeAndLintRoutingRules,
  streamDirectR2Deploy,
  warnUnpublishedRouting,
} from './deploy-managed-events.ts';
import { formatDeploySummary, printDeploySuccess } from './deploy-summary.ts';
import { MANAGED_DEPLOY_BUILD_ENV } from './deploy-transport.ts';
import { type GitDeployMetadata } from './git-metadata.ts';
import { type CliLogger } from './log-file.ts';
import { createSpinner, formatCount, note } from './output.ts';
import { collectAndHashAssets, buildVoidManifest, buildStaticManifest } from './package.ts';
import { type StaticPreset } from './preset.ts';
import { type ProjectConfig } from './project.ts';
import type { DeployManifest, DevRedirectRule, HeaderRule } from './types.ts';

/**
 * Assemble the Void deploy manifest, deriving the route-aware ISR `pages` table
 * from the page scan. This is the single production seam that forwards
 * `pageScan` → `manifest.pages`; `runFullDeploy` calls it so the wiring is
 * exercised (and regression-guarded) by a unit test.
 *
 * `pages` is a Void pages-mode concept. In framework mode (Class-A frameworks
 * routed through `runFullDeploy`) we must NOT emit it — the framework owns its
 * own routing/ISR — so `isFrameworkMode` suppresses the table.
 */
export function assembleVoidManifest(
  pageScan: PageScanResult | null,
  isFrameworkMode: boolean,
  opts: Parameters<typeof buildVoidManifest>[0],
  revalidateConfig?: number | Record<string, number> | undefined,
  isrEnabled = true,
): DeployManifest {
  return buildVoidManifest({
    ...opts,
    ...(isrEnabled ? {} : { revalidate: undefined, prerender: undefined }),
    // Bake each page's BUILD-time ISR TTL (3-state) from its own `export const
    // revalidate` first, then a global-NUMBER `routing.revalidate`. A page under
    // an OBJECT config bakes NO TTL (inherit-eligible) — see `collectPages`.
    pages: isFrameworkMode ? undefined : collectPages(pageScan, revalidateConfig, isrEnabled),
    // Ship the RAW per-path OBJECT config alongside so dispatch can resolve those
    // inherit-eligible pages against the ACTUAL request path (honoring per-path
    // `0` opt-outs a dynamic pattern straddles). Object form only: a number
    // config is already baked into every `pages` entry, so it is never consulted.
    pathRevalidate:
      !isrEnabled ||
      isFrameworkMode ||
      revalidateConfig == null ||
      typeof revalidateConfig !== 'object'
        ? undefined
        : revalidateConfig,
  });
}

export async function runStaticDeploy(
  root: string,
  config: ProjectConfig,
  client: PlatformClient,
  preset: StaticPreset,
  skipBuild?: boolean,
  gitMetadata?: GitDeployMetadata,
  hashedAssetsPrefix?: string,
  headerRules?: Array<HeaderRule>,
  redirectRules?: Array<DevRedirectRule>,
  fallbackRules?: Array<DevRedirectRule>,
  routing?: RoutingConfig,
  cliLog?: CliLogger,
  /**
   * Explicit `routing.notFound`. Normally carried by `routing`, but the
   * "all pages prerendered -> static" redirect in `runFullDeploy` passes
   * `routing: undefined` (its rules were already merged upstream), so that
   * call site hands the value over directly. Wins over `routing.notFound`.
   */
  notFound?: NotFoundHandling,
  alwaysUseHttps?: boolean,
): Promise<void> {
  const typeLabel = preset.appType === 'spa' ? 'Static SPA' : 'Static Site';
  log.info(`${typeLabel} deploy`);
  cliLog?.info('deploy_mode', { mode: 'static', appType: preset.appType });

  // Build (if needed)
  if (preset.buildCommand && !skipBuild) {
    log.step('Building...');
    cliLog?.info('build_start', { command: preset.buildCommand });
    const buildStartedAt = Date.now();
    execSync(preset.buildCommand, {
      cwd: root,
      stdio: 'inherit',
      env: buildEnv({ ...MANAGED_DEPLOY_BUILD_ENV }, { localBinRoot: root }),
    });
    cliLog?.info('build_end', { durationMs: Date.now() - buildStartedAt });
  } else if (skipBuild) {
    cliLog?.info('build_skipped', { reason: 'skipBuild' });
  }

  if (!existsSync(preset.outputDir)) {
    log.error(`deploy: Output directory '${preset.outputDir}' not found. Run the build first.`);
    process.exit(1);
  }

  // Full deploys can supply premerged rules; standalone static deploys still
  // need file-based rules when no routing config was provided.
  if (routing || (!headerRules && !redirectRules && !fallbackRules)) {
    const merged = mergeAndLintRoutingRules(preset.outputDir, routing);
    headerRules = merged.headerRules;
    redirectRules = merged.redirectRules;
    fallbackRules = merged.fallbackRules;
  }

  const s = createSpinner();
  const onProgress = (msg: string) => s.message(msg);

  // Preflight: hash assets and check which ones changed.
  // `assetFiles` carries the in-memory buffer cache so the upload step
  // consumes the same bytes that were hashed.
  s.start('Checking for changes...');
  cliLog?.info('preflight_start', { dir: preset.outputDir });
  const { assetManifest, assetFiles } = await collectAndHashAssets(preset.outputDir, onProgress);
  const { needed, skipped } = await client.preflight(config.projectId, assetManifest);
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
  cliLog?.info('package_start', { mode: 'static' });
  const packageStartedAt = Date.now();

  const manifest = buildStaticManifest({
    appType: preset.appType,
    alwaysUseHttps: alwaysUseHttps ?? routing?.alwaysUseHttps,
    hashedAssetsPrefix: hashedAssetsPrefix ?? 'assets',
    headerRules,
    redirectRules,
    fallbackRules,
    notFound: notFound ?? routing?.notFound,
  });
  cliLog?.info('package_end', {
    mode: 'static',
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
    spinner: s,
    cliLog,
  });

  note(
    formatDeploySummary({ typeLabel, assets: result.assets, unchangedAssets: skipped }),
    result.url,
  );

  warnUnpublishedRouting(result);
  printDeploySuccess(result.published !== false);
}
