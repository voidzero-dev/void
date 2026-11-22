import { type ApplicationAnalysis } from '../../application-analysis.ts';
import { type VoidConfig } from '../../config.ts';
import { assertNoRootSourceConventionConflicts } from '../../project-paths.ts';
import { validateSsrEntry } from '../../ssr/entry.ts';
import { getErrorMessage } from '../output.ts';
import { detectPreset, hasBackendFiles } from '../preset.ts';
import { syncWranglerDurableObjects, syncWranglerWebSockets } from '../wrangler.ts';

export type CloudflareDeployAppOptions = {
  dir?: string;
  spa?: boolean;
};

export type CloudflareDeployAppClassification =
  | { supported: true }
  | { supported: false; reason: string };

/**
 * Narrow native Cloudflare deploys to app shapes whose emitted Worker artifact
 * the current verifier understands. This runs before any account operation;
 * `runCloudflareDeploy` has already rejected node/bun/deno targets.
 */
export function classifyCloudflareDeployApp(
  root: string,
  voidConfig: VoidConfig,
  options: CloudflareDeployAppOptions,
  application: ApplicationAnalysis,
): CloudflareDeployAppClassification {
  const framework = application.framework;
  const configuredAppType = voidConfig.inference?.appType;

  // Infer a static preset only when neither the config nor a framework determines
  // the app type, just as in the static deployment path.
  const staticPreset =
    framework || configuredAppType
      ? null
      : detectPreset(root, { dir: options.dir, spa: options.spa });
  const configuredStatic = configuredAppType === 'static' || configuredAppType === 'spa';
  if (staticPreset || configuredStatic || options.dir || options.spa) {
    const appType = staticPreset?.appType ?? (options.spa ? 'spa' : 'static');
    return unsupported(
      [
        `deploy: --platform cloudflare could not resolve the ${appType} output to deploy.`,
        'Set inference.outputDir in void.config.ts, pass --dir with an existing build directory,',
        'or add a supported build tool so Void can locate the generated static assets.',
      ].join('\n'),
    );
  }

  if (!framework && !hasBackendFiles(root)) {
    return unsupported(
      [
        'deploy: --platform cloudflare found no Void backend to deploy.',
        'A full Void app has at least one of: routes/, pages/, middleware, crons/, queues/,',
        'email/, or an SSR entry. Add your server code, or use `void deploy` for a static site.',
      ].join('\n'),
    );
  }

  try {
    const paths = application.paths;
    assertNoRootSourceConventionConflicts(paths);
    validateSsrEntry(root, paths);
    syncWranglerDurableObjects(root, application.durableObjects);
    syncWranglerWebSockets(root, application.websockets);
  } catch (error) {
    return unsupported(`deploy: ${getErrorMessage(error)}`);
  }

  return { supported: true };
}

function unsupported(reason: string): CloudflareDeployAppClassification {
  return { supported: false, reason };
}
