import { existsSync } from 'node:fs';
import { createDeployArtifact, type DeployArtifact } from '@void/deploy-core';
import { resolve, join } from 'pathslash';
import { analyzeApplication } from './application-routing.ts';
import { resolveAssetConfig, hasApiRoutes, hasDocumentRoutes } from './asset-routing.ts';
import { resolveDistDir, resolveWorkerDirName } from './cli/build-output-dir.ts';
import { prepareCfBuildOutput as prepareInternalCfBuildOutput } from './cli/cf-build-output.ts';
import { assertDeploySchemaDriftFree } from './cli/deploy-drift.ts';
import {
  resolveDeployWorkerMain,
  resolveDeployWranglerCompat,
  assertWorkerMainUploaded,
  validateDeployMigrations,
  toManifestSchedulesAndQueues,
  resolveStaticDeployPreset,
} from './cli/deploy-helpers.ts';
import { mergeAndLintRoutingRules } from './cli/deploy-managed-events.ts';
import { assembleVoidManifest } from './cli/deploy-managed-static.ts';
import { buildStaticManifest, collectAndHashAssets, collectWorkerFiles } from './cli/package.ts';
import { detectPreset } from './cli/preset.ts';
import { readConfig, isNodeTarget } from './config.ts';
import { collectRevalidate } from './isr-config.ts';
import { hasEmailHandlers } from './router/email.ts';
import { validateSsrEntry } from './ssr/entry.ts';

/**
 * A disposable Cloudflare Build Output directory. Experimental: it follows Cloudflare's draft
 * Build Output format, which can change between Void releases.
 */
export type CfBuildOutput = {
  directory: string;
  /** The input's static assets, when the Worker has any. */
  assetsDirectory?: string;
  dispose(): Promise<void>;
};

export type PrepareCfBuildOutputOptions = {
  /** The Cloudflare account the build must target. */
  accountId?: string;
  /** The Vite build mode. Native output must match it; legacy output defaults to production. */
  mode?: string;
};

/**
 * Convert an existing Cloudflare Worker build into a disposable Cloudflare Build Output directory.
 * Experimental. Returns null for an unsupported build or a conflicting account or mode.
 */
export async function prepareCfBuildOutput(
  directory: string,
  options: PrepareCfBuildOutputOptions = {},
): Promise<CfBuildOutput | null> {
  const prepared = await prepareInternalCfBuildOutput(directory, options.accountId, options.mode);
  // A fresh object keeps internal deploy state off the public result.
  return (
    prepared && {
      directory: prepared.directory,
      ...(prepared.assetsDirectory ? { assetsDirectory: prepared.assetsDirectory } : {}),
      dispose: prepared.dispose,
    }
  );
}

export type PreparedDeployArtifact = {
  artifact: DeployArtifact;
  /** Static asset bytes keyed by URL path, encoded as base64. */
  assets: Record<string, string>;
};

/** Package an already-built app for managed deployment, without platform credentials. */
export async function prepareDeployArtifact(
  root: string = process.cwd(),
): Promise<PreparedDeployArtifact> {
  root = resolve(root);
  const config = readConfig(root);
  if (isNodeTarget(config.target) || config.output === 'static') {
    throw new Error('Artifact preparation requires a Void Cloudflare Worker build.');
  }
  let preset = resolveStaticDeployPreset(root, config);
  let analysis: Awaited<ReturnType<typeof analyzeApplication>> | undefined;
  if (!preset) {
    analysis = await analyzeApplication(root, { config, environment: 'prod' });
    if (
      !config.inference?.appType &&
      !analysis.framework &&
      !analysis.durableObjects.length &&
      !analysis.websockets.length &&
      !Object.values(analysis.bindings).some(Boolean)
    ) {
      preset = detectPreset(root, { strictBackend: true });
    }
  }
  if (preset) {
    if (!existsSync(preset.outputDir)) {
      throw new Error('Static build output is missing. Run the app build first.');
    }
    const rules = mergeAndLintRoutingRules(preset.outputDir, config.routing);
    const { assetManifest, assetFiles } = await collectAndHashAssets(preset.outputDir);
    if (!assetFiles.size) {
      throw new Error('Static build output is empty. Run the app build first.');
    }
    return {
      artifact: createDeployArtifact({
        manifest: buildStaticManifest({
          appType: preset.appType,
          hashedAssetsPrefix: 'assets',
          notFound: config.routing?.notFound,
          ...rules,
        }),
        assetManifest,
      }),
      assets: Object.fromEntries(
        [...assetFiles].map(([path, bytes]) => [path, bytes.toString('base64')]),
      ),
    };
  }
  analysis ??= await analyzeApplication(root, { config, environment: 'prod' });
  if (analysis.bindings.needsSandbox || analysis.bindings.needsLive) {
    throw new Error(
      'Artifact preparation does not yet support Sandbox or Live resources. Use void deploy for those apps.',
    );
  }
  if (config.routing?.prerender?.length || config.remote) {
    throw new Error(
      'Artifact preparation requires a build without remote data or deploy-time prerendering.',
    );
  }
  const dist = resolveDistDir(root);
  const workerDir = join(dist, resolveWorkerDirName(dist));
  const clientDir = join(dist, 'client');
  const { paths, dialect, bindings, authEnabled, scan, websockets } = analysis;
  assertDeploySchemaDriftFree(root, dialect);
  const migrations = validateDeployMigrations(
    paths.migrationsDir,
    analysis.migrations,
    paths.sourceRelative,
  );
  const { schedules, queues } = toManifestSchedulesAndQueues(analysis.jobs, analysis.queues);
  const pages = existsSync(paths.pagesDir);
  const ssr = Boolean(validateSsrEntry(root, paths)) || pages;
  const compat = resolveDeployWranglerCompat(root, config, workerDir, { authEnabled, dialect });
  const workerMain = resolveDeployWorkerMain(config, workerDir);
  const workerFiles = collectWorkerFiles(workerDir);
  if (!workerFiles.size) {
    throw new Error('Worker build output is missing. Run the app build first.');
  }
  assertWorkerMainUploaded(workerFiles, workerMain);
  const rules = mergeAndLintRoutingRules(clientDir, config.routing);
  const manifest = assembleVoidManifest(
    pages ? scan.pages : null,
    false,
    {
      bindings,
      hasEmailHandlers: scan.email !== undefined && hasEmailHandlers(scan.email),
      migrations,
      schedules,
      queues,
      dialect,
      webSockets: websockets,
      durableObjects: analysis.durableObjects,
      ssr:
        ssr ||
        scan.routes.length > 0 ||
        scan.middleware.length > 0 ||
        websockets.length > 0 ||
        authEnabled,
      revalidate: collectRevalidate(config, pages ? scan.pages : null),
      assetConfig: resolveAssetConfig({
        isSsr: ssr,
        hasPages: pages,
        hasApiRoutes: hasApiRoutes(scan.routes) || hasApiRoutes(websockets) || authEnabled,
        hasDocumentRoutes: hasDocumentRoutes(scan.routes),
        hasMiddleware: scan.middleware.length > 0,
        hasWebSockets: hasDocumentRoutes(websockets),
        authEnabled,
        liveEnabled: false,
        notFound: config.routing?.notFound,
      }),
      options: {
        compatibilityDate: compat?.compatibilityDate,
        compatibilityFlags: compat?.compatibilityFlags,
        cpuMs: config.worker?.limits?.cpu_ms,
        workerMain,
        revalidateQueryAllowlist: config.routing?.revalidateQueryAllowlist,
      },
      ...rules,
    },
    config.routing?.revalidate,
    config.routing?.isr !== false,
  );
  const { assetManifest, assetFiles } = await collectAndHashAssets(clientDir);
  return {
    artifact: createDeployArtifact({
      manifest,
      assetManifest,
      workerFiles: Object.fromEntries(
        [...workerFiles].map(([path, bytes]) => [path, bytes.toString('base64')]),
      ),
    }),
    assets: Object.fromEntries(
      [...assetFiles].map(([path, bytes]) => [path, bytes.toString('base64')]),
    ),
  };
}
