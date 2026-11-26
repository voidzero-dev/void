import {
  cloudflarePreviewNameProblem,
  deleteCloudflarePreview,
  deployCloudflarePreview,
  readWranglerTopLevelString,
} from '@void/deploy-cloudflare';
import type {
  CloudflareCommandRunner,
  CloudflarePreviewDeployResult,
} from '@void/deploy-cloudflare';
import { log } from '@voidzero-dev/vite-plus-prompts';
import { basename } from 'pathslash';
import type { CfBuildOutput } from './cf-build-output.ts';
import type { CloudflareChildReporter } from './cloudflare-child-report.ts';
import type { CloudflareOperationRunner } from './cloudflare-operations.ts';
import { log as deployLog } from './deploy-helpers.ts';
import { formatDeploySummary } from './deploy-summary.ts';
import type { RunDeployOptions } from './deploy-types.ts';
import type { CliLogger } from './log-file.ts';
import { note, printSuccess } from './output.ts';

/** A workers.dev hostname label holds at most 63 characters. */
const MAX_HOST_LABEL = 63;

/** Where the user sets a top-level Cloudflare config key, for messages. */
export function cloudflareConfigKey(configPath: string, key: string): string {
  const file = basename(configPath);
  return file === 'wrangler.jsonc' || file === 'wrangler.json'
    ? `${key} in ${file}`
    : `cloudflare.${key} in void.config.ts`;
}

/**
 * Check a `deploy --preview` request before connecting to Cloudflare. A Worker name and a pinned
 * account make the deploy and `void project preview delete` reach the same Worker.
 */
export function checkCloudflarePreviewRequest(options: {
  previewName: string;
  rootConfig: Record<string, unknown>;
  configPath: string;
}): string | undefined {
  const { previewName, rootConfig, configPath } = options;
  const problem = cloudflarePreviewNameProblem(previewName);
  if (problem) {
    return `deploy: "${previewName}" is not a valid preview name: ${problem}. For example: pr-64.`;
  }
  const workerName = readWranglerTopLevelString(rootConfig, 'name');
  if (!workerName) {
    return `deploy: --preview needs the Worker name (${cloudflareConfigKey(configPath, 'name')}), so the preview and its cleanup reach the same Worker.`;
  }
  if (
    !readWranglerTopLevelString(rootConfig, 'account_id') &&
    !process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
  ) {
    return 'deploy: --preview needs a pinned Cloudflare account. Set cloudflare.account_id in void.config.ts or CLOUDFLARE_ACCOUNT_ID.';
  }
  // Stricter than a Preview that serves only a custom domain needs, but CI reads the workers.dev
  // URL.
  if (previewName.length + 1 + workerName.length > MAX_HOST_LABEL) {
    return `deploy: preview name "${previewName}" is too long for Worker "${workerName}". On workers.dev, "${previewName}-${workerName}" must be at most ${MAX_HOST_LABEL} characters, so use at most ${MAX_HOST_LABEL - 1 - workerName.length}.`;
  }
  return undefined;
}

/** Deploy a static Preview from the prepared output and report it. Production is unchanged. */
export async function runCloudflareStaticPreview(options: {
  runWrangler: CloudflareCommandRunner;
  cfOutput: CfBuildOutput | null;
  workerName: string;
  previewName: string;
  accountId: string;
  configPath: string;
  staticConfigPath: string;
  verifyUploader: () => boolean;
  typeLabel: string;
  writeResult: RunDeployOptions['writeResult'];
  reporter: CloudflareChildReporter;
  cliLog: CliLogger;
  exit: (code: number) => never;
}): Promise<void> {
  const { previewName, workerName, cliLog } = options;
  deployLog.step(`Deploying Preview ${previewName}...`);
  let result: CloudflarePreviewDeployResult;
  try {
    result = await deployCloudflarePreview({
      runWrangler: options.runWrangler,
      workerName,
      previewName,
      verifyUploader: options.verifyUploader,
      configPath: options.staticConfigPath,
    });
  } finally {
    await options.cfOutput?.dispose();
  }
  if (!result.ok) {
    const message = options.reporter.redactor.redact(formatCloudflarePreviewError(result, options));
    cliLog.error('cloudflare_preview_failed', new Error(message), { reason: result.reason });
    deployLog.error(message);
    return options.exit(1);
  }
  cliLog.info('cloudflare_preview_deployed', {
    previewName,
    previewId: result.previewId,
    deploymentId: result.deploymentId,
  });
  const record = {
    type: 'preview',
    workerName,
    previewName,
    previewUrl: result.previewUrl,
    deploymentId: result.deploymentId,
    deploymentUrl: result.deploymentUrl,
  };
  options.writeResult?.(`${JSON.stringify(record)}\n`);
  note(
    [
      formatDeploySummary({ workerName, typeLabel: options.typeLabel }),
      `Preview: ${previewName}`,
      ...(result.deploymentUrl ? [`This deployment: ${result.deploymentUrl}`] : []),
    ].join('\n'),
    result.previewUrl,
  );
  printSuccess(`Preview ${previewName} deployed. Production is unchanged.`);
}

function formatCloudflarePreviewError(
  result: Extract<CloudflarePreviewDeployResult, { ok: false }>,
  options: { previewName: string; workerName: string; accountId: string; configPath: string },
): string {
  const { previewName, workerName } = options;
  switch (result.reason) {
    case 'worker-not-found':
      return [
        `deploy: Worker "${workerName}" has no production deployment in Cloudflare account ${options.accountId}. Nothing was uploaded.`,
        'Deploy production first: void deploy --platform cloudflare',
      ].join('\n');
    case 'worker-check-failed':
      return [
        `deploy: could not check Worker "${workerName}" on Cloudflare. Nothing was uploaded.`,
        ...(result.diagnostic ? [result.diagnostic] : []),
      ].join('\n');
    case 'uploader-changed':
      return 'deploy: the Cloudflare uploader changed during the preview deploy. Nothing was deployed.';
    case 'output-invalid':
      return 'deploy: Cloudflare accepted the preview but did not return a readable Preview record. Check the Worker in the Cloudflare dashboard before retrying.';
    case 'preview-urls-disabled':
      return [
        `deploy: Cloudflare created deployment ${result.deploymentId} for preview "${previewName}", but Preview URLs are off for Worker "${workerName}", so it has no URL.`,
        `Set preview_urls: true (${cloudflareConfigKey(options.configPath, 'preview_urls')}), run void deploy --platform cloudflare once, then deploy the preview again. This also turns on version URLs for production versions.`,
      ].join('\n');
    case 'deploy-failed':
      return [
        'deploy: Cloudflare could not deploy the preview. Production is unchanged.',
        ...(result.diagnostic ? [result.diagnostic] : []),
      ].join('\n');
  }
}

/**
 * `void project preview delete <name>`: delete a Preview of this project's Worker. Production is
 * not read or changed. A Preview that does not exist is not an error, so a cleanup job can rerun.
 */
export async function runCloudflarePreviewDelete(
  root: string,
  { name }: { name: string },
  runner?: CloudflareOperationRunner,
): Promise<void> {
  const problem = cloudflarePreviewNameProblem(name);
  if (problem) {
    throw new Error(`project: "${name}" is not a valid preview name: ${problem}.`);
  }
  // The same Worker and account as rollback, logs and deploy --preview.
  const { resolveCloudflareOperationContext } = await import('./cloudflare-operations.ts');
  const context = resolveCloudflareOperationContext(root, runner);
  const { workerName } = context;
  const result = await deleteCloudflarePreview({
    runWrangler: context.runWrangler,
    workerName,
    previewName: name,
    configPath: context.configPath,
  });
  if (result.ok) {
    if (result.deleted) {
      printSuccess(`Deleted preview ${name} of Worker ${workerName}. Production is unchanged.`);
    } else {
      log.info(`Preview ${name} does not exist on Worker ${workerName}. Nothing to delete.`);
    }
    return;
  }
  if (result.reason === 'worker-not-found') {
    throw new Error(
      `project: Worker "${workerName}" was not found in Cloudflare account ${context.accountId}. Nothing was deleted. Check cloudflare.name and CLOUDFLARE_ACCOUNT_ID.`,
    );
  }
  throw new Error(
    [
      `project: Cloudflare could not delete preview "${name}" of Worker "${workerName}".`,
      ...(result.diagnostic ? [result.diagnostic] : []),
    ].join('\n'),
  );
}
