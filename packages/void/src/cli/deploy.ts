import { existsSync } from 'node:fs';
import { confirm, isCancel } from '@voidzero-dev/vite-plus-prompts';
import { join } from 'pathslash';
import { stashCloudflareDeployPointer } from '../cloudflare-config.ts';
import { readConfig } from '../config.ts';
import { detectFramework } from '../plugin-inference.ts';
import { buildEnv } from '../shared/untrusted-env.ts';
import { getApiUrl, getToken, getTokenSource } from './auth.ts';
import { isExpiredTokenError, PlatformClient } from './client.ts';
import { maybeLinkCloudflareDeploy } from './cloudflare-link.ts';
import { withRecordedReadinessAccessOrigin } from './cloudflare-readiness.ts';
import { runCloudflareDeploy } from './deploy-cloudflare.ts';
import {
  log,
  assertProjectDeployAccess,
  createProjectFromSlug,
  promptDeployProjectConfig,
  resolveStaticDeployPreset,
  getGitCommit,
  resolveStaticBuildCommand,
} from './deploy-helpers.ts';
import { runFrameworkDeploy } from './deploy-managed-framework.ts';
import { runFullDeploy } from './deploy-managed-full.ts';
import { runStaticDeploy } from './deploy-managed-static.ts';
import { printDeployContext } from './deploy-summary.ts';
import { type RunDeployOptions, type RunDeployTargetAdapter } from './deploy-types.ts';
import { collectGitDeployMetadata } from './git-metadata.ts';
import {
  exchangeGithubOidcForDeployToken,
  isGithubActionsOidcAvailable,
  maskGithubActionsSecret,
} from './github-oidc.ts';
import { assertInstalledVoidMatchesCli } from './installed-void.ts';
import { openDeployLog, type CliLogger } from './log-file.ts';
import { buildDeployLogSummary } from './log-summary.ts';
import { promptForLoginToken } from './login.ts';
import { migrateLegacyVoidConfig } from './migrate.ts';
import { listPlatformConnections } from './platform-registry.ts';
import { detectPreset, FRAMEWORK_PRESETS } from './preset.ts';
import {
  readDeploymentPlatform,
  readProjectConfig,
  type DeploymentPlatform,
  type ProjectConfig,
} from './project.ts';
import { getRequestedProjectSlug } from './resolve-project.ts';
import type { DeployTarget } from './types.ts';

export function resolveDeploymentPlatform(
  root: string,
  options?: RunDeployOptions,
): DeploymentPlatform {
  // Projects with no saved choice predate the init prompt and keep the Void default.
  return options?.platform ?? readDeploymentPlatform(root) ?? 'void';
}

/** Run `void deploy`; a failure carries a summary of the deploy log in its message. */
export async function runDeploy(root: string, options?: RunDeployOptions): Promise<void> {
  // The Cloudflare link check can evaluate void.config.ts, so record operator input first.
  options = withRecordedReadinessAccessOrigin(options ?? {});
  console.log();

  const cliLog = openDeployLog({
    mirrorToStderr: options?.debug === true || process.env.VOID_DEPLOY_DEBUG === '1',
  });
  cliLog.info('deploy_start', {
    cwd: root,
    projectSlug: options?.projectSlug,
    dir: options?.dir,
    spa: options?.spa === true ? true : undefined,
    skipBuild: options?.skipBuild === true ? true : undefined,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  });

  try {
    await runDeployInner(root, options, cliLog);
    cliLog.info('deploy_end', { ok: true });
  } catch (err) {
    cliLog.error('deploy_end', err, { ok: false });
    // Flush before reading the file back. The `Detailed log:` path is useless
    // on a CI runner that is destroyed with the job, so inline the errors and
    // the trailing timeline into the message the caller prints.
    await cliLog.close().catch(() => {});
    try {
      if (err instanceof Error) {
        const summary = buildDeployLogSummary(cliLog.path);
        if (summary) {
          err.message = `${err.message}\n${summary}`;
        }
      }
    } catch {
      // A postmortem aid must never replace the failure it describes. The
      // assignment alone can throw: `message` is read-only on a frozen Error
      // and getter-only on a DOMException, which an aborted fetch produces.
      // Losing the summary is fine; losing the deploy error is not.
    }
    throw err;
  } finally {
    await cliLog.close().catch(() => {});
  }
}

const cloudflareDeployTarget: RunDeployTargetAdapter = {
  target: 'cloudflare',
  capabilities: {
    managedProjects: false,
    skipBuild: true,
    appTypes: {
      void: 'supported',
      spa: 'supported',
      static: 'supported',
      framework: 'supported',
    },
    features: {
      auth: 'supported',
      cron: 'supported',
      queues: 'supported',
      durableState: 'supported',
      webSockets: 'supported',
      live: 'supported',
      sandbox: 'supported',
      isr: 'supported',
      remoteDevelopment: 'unsupported',
      deploymentHistory: 'supported',
      rollback: 'supported',
      secrets: 'supported',
      domains: 'supported',
      logs: 'partial',
    },
  },
  async deploy(root, options, cliLog): Promise<void> {
    if (options.projectSlug !== undefined) {
      throw new Error(
        'deploy: --project is not supported with platform cloudflare — this platform deploys to your own Cloudflare account and no Void project is involved.',
      );
    }
    assertInstalledVoidMatchesCli(root);
    if (migrateLegacyVoidConfig(root)) {
      log.step(
        'Migrated project configuration to void.config.ts. Commit void.config.ts and void.lock.json.',
      );
    }
    return runCloudflareDeploy(root, options, cliLog);
  },
};

const voidDeployTarget: RunDeployTargetAdapter = {
  target: 'void',
  capabilities: {
    managedProjects: true,
    skipBuild: true,
    appTypes: {
      void: 'supported',
      spa: 'supported',
      static: 'supported',
      framework: 'supported',
    },
    features: {
      auth: 'supported',
      cron: 'supported',
      queues: 'supported',
      durableState: 'unsupported',
      webSockets: 'supported',
      live: 'supported',
      sandbox: 'supported',
      isr: 'supported',
      remoteDevelopment: 'supported',
      deploymentHistory: 'supported',
      rollback: 'supported',
      secrets: 'supported',
      domains: 'supported',
      logs: 'supported',
    },
  },
  deploy: runManagedDeploy,
};

const deployTargets: Record<DeployTarget, RunDeployTargetAdapter> = {
  cloudflare: cloudflareDeployTarget,
  void: voidDeployTarget,
};

async function runDeployInner(
  root: string,
  options: RunDeployOptions | undefined,
  cliLog: CliLogger,
): Promise<void> {
  const link = await maybeLinkCloudflareDeploy(root, options);
  if (link === 'cancelled') {
    log.info('Deployment cancelled.');
    return;
  }
  if (link === 'existing') {
    options = { ...options, platform: 'cloudflare', reuseExistingWorker: true };
  }
  const platform = resolveDeploymentPlatform(root, options);
  if (options?.atomic && platform !== 'cloudflare') {
    throw new Error('deploy: --atomic is available only for Cloudflare Workers.');
  }

  if (platform === 'none') {
    throw new Error(
      'deploy: deployment setup was skipped during `void init`. Pass `--platform cloudflare` or `--platform void` to choose a destination.',
    );
  }

  cliLog.info('deploy_target', { target: platform });

  try {
    return await deployTargets[platform].deploy(root, options ?? {}, cliLog);
  } finally {
    if (existsSync(join(root, 'void.config.ts'))) {
      stashCloudflareDeployPointer(root);
    }
  }
}

async function runManagedDeploy(
  root: string,
  options: RunDeployOptions,
  cliLog: CliLogger,
): Promise<void> {
  // Resolve the connected recipient before credentials, OIDC, builds, or platform requests.
  const apiUrl = getApiUrl(root);
  const requestedProjectSlug = getRequestedProjectSlug(options);
  let reauthenticated = false;
  let displayedProject: string | undefined;
  while (true) {
    try {
      // Project IDs and implicit slugs belong to the platform that issued them.
      // Re-read after reauthentication: this attempt may have established its first link.
      const savedProject = readProjectConfig(root);
      const linkedProject = savedProject?.platformUrl === apiUrl ? savedProject : null;
      if (savedProject && !linkedProject && !requestedProjectSlug) {
        throw new Error(
          `deploy: This project is linked to ${savedProject.platformUrl}. Pass --project <slug> to deploy to ${apiUrl} without changing the saved link.`,
        );
      }
      // Token precedence: VOID_TOKEN, then GitHub Actions OIDC, then the saved
      // login. OIDC must beat the saved login so a leftover `void account login`
      // on a reused runner cannot preempt it.
      let token = process.env.VOID_TOKEN ? getToken(root) : null;
      if (!token && isGithubActionsOidcAvailable()) {
        // A workflow with `id-token: write` intends OIDC, so an unknown slug is a
        // hard error rather than a fallback to the saved login.
        const slug = requestedProjectSlug ?? linkedProject?.slug;
        if (!slug) {
          throw new Error(
            'deploy: running in GitHub Actions but the project is unknown — pass --project <slug> or link the project.',
          );
        }
        cliLog.info('github_oidc_exchange_start', { slug });
        const tokenOrigin = getApiUrl(root);
        token = await exchangeGithubOidcForDeployToken(tokenOrigin, slug);
        maskGithubActionsSecret(token);
        // Treat the exchanged token like an explicit CI token; `buildEnv()`
        // still removes it from every project-controlled child.
        process.env.VOID_TOKEN = token;
        process.env.VOID_API_URL = tokenOrigin;
        cliLog.info('github_oidc_exchange_success', { slug });
      }
      token ??= getToken(root);
      if (!token) {
        log.error('No auth token found. Run `void account login` first.');
        process.exit(1);
      }

      // Access credentials stay in `process.env` for the expired-token re-auth
      // below; `buildEnv()` removes them from each project-controlled child.
      const client = new PlatformClient(token, { root, cliLog });

      // Resolve the target project: CLI flag > env var > linked project file.
      let config: ProjectConfig | null = null;

      if (requestedProjectSlug) {
        // Most deploys already have a project ID. The existing single-project
        // endpoint avoids account-wide history/traffic queries even when CI
        // also sets VOID_PROJECT to the linked slug.
        const linked =
          linkedProject?.slug === requestedProjectSlug
            ? await client.getProject(linkedProject.projectId)
            : null;
        const project =
          linked?.slug === requestedProjectSlug
            ? linked
            : await client.findProjectBySlug(requestedProjectSlug);
        assertProjectDeployAccess(project ?? undefined);
        config = project ? { projectId: project.id, slug: project.slug } : null;

        if (!config) {
          if (!process.stdin.isTTY) {
            // CI: auto-create when --project is explicitly specified
            config = await createProjectFromSlug(root, client, requestedProjectSlug, cliLog);
          } else {
            const shouldCreate = await confirm({
              message: `Project "${requestedProjectSlug}" does not exist. Create it?`,
            });
            if (isCancel(shouldCreate) || !shouldCreate) {
              log.info('Deploy cancelled.');
              process.exit(0);
            }

            config = await createProjectFromSlug(root, client, requestedProjectSlug, cliLog);
          }
        }
      } else {
        config = linkedProject;
        if (config) {
          const { projectId, slug } = config;
          const project = await client.getProject(projectId);
          if (!project) {
            throw new Error(
              `deploy: The linked project "${slug}" is unavailable or you no longer have access. ` +
                'Ask a project admin or owner to restore access, or choose another project with `--project <slug>`.',
            );
          }
          assertProjectDeployAccess(project);
        }
      }

      if (!config && !process.stdin.isTTY) {
        log.error(
          'No project specified. Set `VOID_PROJECT`, pass `--project <slug>`, or commit `.void/project.json`.',
        );
        process.exit(1);
      }

      if (!config) {
        config = await promptDeployProjectConfig(root, client, cliLog);
      }

      cliLog.info('project_resolved', {
        projectId: config.projectId,
        slug: config.slug,
      });
      if (displayedProject !== config.slug) {
        const destination =
          listPlatformConnections().find((connection) => connection.apiUrl === apiUrl)
            ?.displayName ?? new URL(apiUrl).hostname;
        printDeployContext(config.slug, destination);
        displayedProject = config.slug;
      }

      if (migrateLegacyVoidConfig(root)) {
        log.step(
          'Migrated project configuration to void.config.ts. Commit void.config.ts and void.lock.json.',
        );
      }

      // Resolve the app type: void.config.ts > CLI flags > auto-detection.
      const voidConfig = readConfig(root);
      cliLog.info('config_resolved', {
        target: voidConfig.target,
        appType: voidConfig.inference?.appType,
        output: voidConfig.output,
      });

      let preset = resolveStaticDeployPreset(root, voidConfig, {
        dir: options?.dir,
        spa: options?.spa,
      });

      // Check for known framework after static overrides.
      const detected = detectFramework(root);
      // Detect git commit before build (only when not skipping build). Same scrub as
      // `getGitCommit`: these git children can reach repo-configured hooks/credential helpers.
      const gitMetadata = collectGitDeployMetadata(
        root,
        options?.skipBuild ? null : getGitCommit(root),
        process.env,
        buildEnv(),
      );
      if (!preset && detected) {
        cliLog.info('framework_detected', {
          name: detected.name,
          class: detected.class,
        });
        const fwPreset = FRAMEWORK_PRESETS[detected.name];
        if (detected.class === 'b' || detected.class === 'c') {
          if (!fwPreset) {
            log.error(`No deploy preset found for framework "${detected.name}".`);
            process.exit(1);
          }
          await runFrameworkDeploy(
            root,
            config,
            client,
            detected,
            fwPreset,
            voidConfig,
            options?.skipBuild,
            gitMetadata,
            cliLog,
          );
        } else {
          // Class A: preset is optional (e.g. vinext probes at runtime)
          await runFullDeploy(
            root,
            config,
            client,
            voidConfig,
            fwPreset,
            options?.skipBuild,
            gitMetadata,
            detected,
            cliLog,
          );
        }
        return;
      }
      if (!preset && !voidConfig.inference?.appType) {
        // No configured app type and no detected framework — detect from project structure.
        // `strictBackend` only here: this is the branch where the user has said
        // NOTHING about the app type, so an SSG project that also has a backend is
        // genuinely ambiguous and must be refused rather than silently deployed as
        // static. The explicit-intent paths (`--dir`, configured
        // `inference.appType`) resolve through `resolveStaticDeployPreset` above
        // and keep working without the guard.
        preset = detectPreset(root, { spa: options?.spa, strictBackend: true });
      }
      // appType === "void" or "framework" without a detected framework → full deploy.

      if (preset) {
        preset = {
          ...preset,
          buildCommand: resolveStaticBuildCommand(
            preset,
            voidConfig.inference?.build,
            Boolean(options?.dir),
          ),
        };
        await runStaticDeploy(
          root,
          config,
          client,
          preset,
          options?.skipBuild,
          gitMetadata,
          undefined,
          undefined,
          undefined,
          undefined,
          voidConfig.routing,
          cliLog,
        );
      } else {
        await runFullDeploy(
          root,
          config,
          client,
          voidConfig,
          undefined,
          options?.skipBuild,
          gitMetadata,
          undefined,
          cliLog,
        );
      }
      return;
    } catch (error) {
      if (isExpiredTokenError(error)) {
        if (getTokenSource() === 'ci') {
          throw new Error(
            '`VOID_TOKEN` is invalid or expired. Generate a new token and try again.',
          );
        }
        if (!process.stdin.isTTY || reauthenticated) {
          throw new Error('Auth token expired. Run `void account login` and try again.');
        }
        log.warn('Auth token expired. Re-authenticating...');
        await promptForLoginToken(root);
        log.step('Re-authenticated. Retrying deploy...');
        reauthenticated = true;
        continue;
      }
      throw error;
    }
  }
}

export { type RunDeployOptions } from './deploy-types.ts';

export { parseRootWranglerConfig } from '@void/deploy-cloudflare';
export { resolveDeployTransport } from './deploy-transport.ts';
export { deriveWorkerName } from './deploy-resources.ts';
export { checkWranglerMigrationApplySet } from './deploy-migrations.ts';
export {
  createDeployWranglerRunner,
  isWranglerNonInteractiveOrCI,
  runWranglerAuthToken,
} from './deploy-cloudflare-auth.ts';
export { discoverRootWranglerConfig } from './deploy-cloudflare.ts';
