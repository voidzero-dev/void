import {
  deleteCloudflarePreview,
  parseRootWranglerConfig,
  readWranglerTopLevelString,
  type CloudflarePreviewDeleteResult,
} from '@void/deploy-cloudflare';
import { createCloudflareChildReporter } from './cloudflare-child-report.ts';
import {
  confirmCloudflareDeployAuthentication,
  connectCloudflareDeployAccount,
  discoverRootWranglerConfig,
} from './deploy-cloudflare-helpers.ts';
import { log } from './deploy-helpers.ts';
import { deriveWorkerName } from './deploy-resources.ts';
import type { CloudflareDeployDeps } from './deploy-types.ts';
import { openDeployLog } from './log-file.ts';
import { printSuccess } from './output.ts';
import type { PreviewArgs } from './preview-args.ts';

/**
 * Delete a Preview of this project's Cloudflare Worker. Production is not read or changed. A
 * Preview that no longer exists is not an error, so a pull-request cleanup job can rerun.
 */
export async function runPreviewCommand(
  root: string,
  args: PreviewArgs,
  deps: CloudflareDeployDeps = {},
): Promise<void> {
  const cliLog = openDeployLog();
  try {
    const reporter = createCloudflareChildReporter(cliLog);
    const configPath = discoverRootWranglerConfig(root);
    const connection = await connectCloudflareDeployAccount({
      root,
      configPath,
      rootConfig: parseRootWranglerConfig(configPath),
      deps,
      // Deleting a Preview never chooses or saves an account for the project.
      persistAccount: false,
      readinessAccessOrigin: undefined,
      reporter,
      // Deleting is one API call: there is no prebuilt upload to pin.
      usesPrebuiltUploader: false,
    });
    if (!connection || !(await confirmCloudflareDeployAuthentication(connection, configPath))) {
      throw new Error('preview: could not connect to Cloudflare.');
    }
    const workerName =
      readWranglerTopLevelString(connection.rootConfig, 'name') ?? deriveWorkerName(root);
    const result = await deleteCloudflarePreview({
      runWrangler: connection.runWrangler,
      workerName,
      previewName: args.name,
      verifyUploader: connection.assertUploaderStillPinned,
      configPath,
    });
    if (!result.ok) {
      const message = reporter.redactor.redact(formatDeleteError(result, args.name, workerName));
      cliLog.error('cloudflare_preview_delete_failed', new Error(message), {
        reason: result.reason,
      });
      throw new Error(message);
    }
    cliLog.info('cloudflare_preview_deleted', { previewName: args.name, deleted: result.deleted });
    if (result.deleted) {
      printSuccess(`Deleted the preview ${args.name} of ${workerName}.`);
    } else {
      log.info(`The preview ${args.name} of ${workerName} does not exist. Nothing to delete.`);
    }
  } finally {
    await cliLog.close().catch(() => {});
  }
}

function formatDeleteError(
  result: Extract<CloudflarePreviewDeleteResult, { ok: false }>,
  name: string,
  workerName: string,
): string {
  switch (result.reason) {
    case 'invalid-name':
      return `preview: ${result.diagnostic}`;
    case 'uploader-changed':
      return 'preview: the Cloudflare uploader changed. Nothing was deleted.';
    case 'delete-failed':
      return [
        `preview: Cloudflare could not delete the preview "${name}" of the Worker "${workerName}".`,
        ...(result.diagnostic ? [result.diagnostic] : []),
      ].join('\n');
  }
}
