import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'pathslash';
import type { ApplicationAnalysis } from '../../application-analysis.ts';
import {
  ignoreMaterializedCloudflareConfig,
  MATERIALIZED_CLOUDFLARE_FILE,
  VOID_LOCK_FILE,
} from '../../cloudflare-config.ts';
import { LEGACY_CONFIG_FILE, TYPED_CONFIG_FILE } from '../../config-loader.ts';
import { renderDeploySeedConfig } from '../../config-write.ts';
import type { VoidConfig } from '../../config.ts';
import { assertNoRootSourceConventionConflicts } from '../../project-paths.ts';
import { validateSsrEntry } from '../../ssr/entry.ts';
import { CANDIDATE_FILE } from '../cloudflare-candidate.ts';
import { log } from '../deploy-helpers.ts';
import { deriveWorkerName } from '../deploy-resources.ts';
import { getErrorMessage } from '../output.ts';
import { detectPreset, hasBackendFiles } from '../preset.ts';
import {
  LATEST_KNOWN_COMPAT_DATE,
  syncWranglerDurableObjects,
  syncWranglerWebSockets,
} from '../wrangler.ts';

const workerSources = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml', 'cloudflare.config.ts'];
const configSources = [TYPED_CONFIG_FILE, LEGACY_CONFIG_FILE, ...workerSources];
const savedFiles = [VOID_LOCK_FILE, MATERIALIZED_CLOUDFLARE_FILE, CANDIDATE_FILE];
const configChanged = 'deploy: Configuration changed during setup. Rerun `void deploy`.';

export function hasDeployConfigSource(root: string): boolean {
  return configSources.some((name) => existsSync(join(root, name)));
}

export type CloudflareDeployAppOptions = {
  dir?: string;
  spa?: boolean;
  seedConfig?: boolean;
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
    if (options.seedConfig && (!framework || framework.class === 'a')) {
      const hasSavedState = () => savedFiles.some((name) => existsSync(join(root, name)));
      if (hasSavedState()) {
        return unsupported('deploy: Restore void.config.ts from version control or a backup.');
      }
      ignoreMaterializedCloudflareConfig(root);
      if (hasDeployConfigSource(root) || hasSavedState()) {
        return unsupported(configChanged);
      }
      const worker = { compatibility_date: LATEST_KNOWN_COMPAT_DATE };
      const config = { cloudflare: { name: deriveWorkerName(root) }, worker };
      const contents = renderDeploySeedConfig(config);
      try {
        writeFileSync(join(root, TYPED_CONFIG_FILE), contents, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
          return unsupported(configChanged);
        }
        throw error;
      }
      log.step(
        'Created void.config.ts. Commit it, the .gitignore change, and void.lock.json when present.',
      );
    }
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
