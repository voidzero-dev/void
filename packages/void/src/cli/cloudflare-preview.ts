import { cloudflarePreviewNameProblem, deleteCloudflarePreview } from '@void/deploy-cloudflare';
import { log } from '@voidzero-dev/vite-plus-prompts';
import type { CloudflareOperationRunner } from './cloudflare-operations.ts';
import { printSuccess } from './output.ts';

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
