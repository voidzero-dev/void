import { readConfig, isNodeTarget } from '../config.ts';
import { detectFramework } from '../plugin-inference.ts';
import { readCloudflareCandidate } from './cloudflare-candidate.ts';
import { readCloudflareLink } from './cloudflare-link.ts';
import {
  hasConfiguredVoidWorkerRoutingRules,
  removeDeployPointer,
} from './deploy-artifact-validation.ts';
import { buildCloudflareWorker } from './deploy-cloudflare-build.ts';
import { migrateCloudflareWorker } from './deploy-cloudflare-migrate.ts';
import {
  prepareCloudflareDeploySource,
  preflightCloudflareWorker,
} from './deploy-cloudflare-preflight.ts';
import { publishCloudflareWorker } from './deploy-cloudflare-publish.ts';
import {
  resolveCloudflareStaticPreset,
  resolveCloudflareVoidStaticPreset,
  runCloudflareStaticDeploy,
} from './deploy-cloudflare-static.ts';
import { log } from './deploy-helpers.ts';
import { logD1RestoreAfterDeployFailure } from './deploy-migrations.ts';
import { printDeploySuccess } from './deploy-summary.ts';
import { type RunDeployOptions, type CloudflareDeployDeps } from './deploy-types.ts';
import { renderAddressMap } from './email-cloudflare.ts';
import { type CliLogger } from './log-file.ts';
import { FRAMEWORK_PRESETS } from './preset.ts';

/** Deploy to the user's own Cloudflare account through the guarded native Worker flow. */
export async function runCloudflareDeploy(
  root: string,
  options: RunDeployOptions,
  cliLog: CliLogger,
  deps: CloudflareDeployDeps = {},
): Promise<void> {
  const initialCloudflareLink = readCloudflareLink(root);
  const initialCloudflareCandidate = readCloudflareCandidate(root);
  const exit = deps.exit ?? ((code: number): never => process.exit(code));
  const voidConfig = readConfig(root);
  const atomic = options.atomic === true || voidConfig.deploy?.cloudflare?.mode === 'atomic';
  if (atomic && (options.reuseExistingWorker || initialCloudflareLink)) {
    log.error(
      'deploy: atomic deployment is unavailable during the existing Worker handoff. Complete the handoff first.',
    );
    return exit(1);
  }
  const detectedFramework = detectFramework(root);
  const frameworkPreset = detectedFramework ? FRAMEWORK_PRESETS[detectedFramework.name] : undefined;
  cliLog.info('cloudflare_deploy_start', {
    provision: options.provision === true ? true : undefined,
  });

  // Keep this guard ahead of the static branch, so a node/bun/deno project is never
  // deployed as a Workers Assets app.
  if (isNodeTarget(voidConfig.target)) {
    log.error(
      [
        `deploy: --platform cloudflare is not supported for the "${voidConfig.target}" target.`,
        'This backend deploys Cloudflare Workers only. Deploy a node/bun/deno build with its',
        'own host/runtime, or use the default Cloudflare target for --platform cloudflare.',
      ].join('\n'),
    );
    return exit(1);
  }

  if (detectedFramework?.class === 'a' && hasConfiguredVoidWorkerRoutingRules(voidConfig.routing)) {
    log.error(
      [
        `deploy: native Cloudflare deployment cannot apply Void routing.alwaysUseHttps, redirects, rewrites, fallbacks, or headers to ${detectedFramework.name}.`,
        'This framework owns its Worker request handler, so these rules would otherwise be ignored.',
        'Move the rules into the framework or its Cloudflare Worker, then retry.',
      ].join('\n'),
    );
    return exit(1);
  }

  const staticPreset =
    resolveCloudflareStaticPreset(root, voidConfig, options) ??
    (await resolveCloudflareVoidStaticPreset(root, voidConfig));
  if (staticPreset) {
    if (atomic) {
      log.error('deploy: atomic deployment is only for Workers with Durable Objects.');
      return exit(1);
    }
    return runCloudflareStaticDeploy(
      root,
      options,
      voidConfig,
      staticPreset,
      cliLog,
      deps,
      initialCloudflareLink,
      initialCloudflareCandidate,
    );
  }

  const source = await prepareCloudflareDeploySource(root, options, voidConfig);
  if (!source) {
    return exit(1);
  }
  const preflight = await preflightCloudflareWorker({
    root,
    voidConfig,
    options,
    deps,
    exit,
    cliLog,
    initialCloudflareLink,
    detectedFramework,
    source,
  });

  // Only a deploy pointer this build writes may pass the post-build checks.
  removeDeployPointer(root);
  const build = await buildCloudflareWorker({
    root,
    voidConfig,
    deps,
    exit,
    atomic,
    frameworkPreset,
    detectedFramework,
    source,
    preflight,
  });
  const migration = await migrateCloudflareWorker({
    root,
    deps,
    exit,
    cliLog,
    source,
    preflight,
    build,
  });
  // The migrations are already applied, so every later failure names the restore point again.
  let restoreReported = false;
  const reportRestore = () => {
    if (migration.d1RestoreCommand && !restoreReported) {
      restoreReported = true;
      logD1RestoreAfterDeployFailure(migration.d1RestoreCommand);
    }
  };
  const exitAfterMigrations = (code: number): never => {
    if (code !== 0) {
      reportRestore();
    }
    return exit(code);
  };
  try {
    await publishCloudflareWorker({
      root,
      deps,
      exit: exitAfterMigrations,
      cliLog,
      atomic,
      detectedFramework,
      initialCloudflareCandidate,
      source,
      preflight,
      build,
      migration,
    });
  } catch (error) {
    reportRestore();
    throw error;
  }
  // A deploy without email setup already said so during preflight.
  if (preflight.emailMap) {
    log.message(renderAddressMap(preflight.emailMap));
  }
  printDeploySuccess();
}

export {
  discoverRootWranglerConfig,
  formatCloudflareActivationError,
} from './deploy-cloudflare-helpers.ts';
