import { stripVTControlCharacters } from 'node:util';
import {
  cloudflareCommandDiagnostic,
  stabilizeCloudflareVersionTriggers,
  type CloudflareCommandResult,
} from '@void/deploy-cloudflare';
import { formatUrl } from './output.ts';

// Cloudflare refuses a Worker with an Analytics Engine binding (code 10089)
// until Analytics Engine is enabled for the account, including on Workers Free.
const ANALYTICS_ENGINE_NOT_ENABLED = 10089;

// Without a terminal, the Cloudflare CLI stops an upload when it must ask
// about a conflict. Its advice to remove `--strict` does not apply: the CLI
// sets that mode itself.
const UPLOAD_CONFLICT = 'Aborting the upload operation because of conflicts';

/** Why the Cloudflare CLI stopped an upload, and what to do. Null for other failures. */
function uploadConflictMessage(result: CloudflareCommandResult, operation: string): string | null {
  const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  if (!output.includes(UPLOAD_CONFLICT)) {
    return null;
  }
  const lines = output.split(/\r?\n/).map((line) => line.replace(/^[\s▲│]+/, '').trim());
  // The Worker was last changed in the dashboard or with the Workers API. Keep
  // the first line only: a dashboard diff shows values.
  const outsideChange = lines.find(
    (line) =>
      line.includes('last updated via the script API') ||
      line.includes('set via the Cloudflare Dashboard'),
  );
  if (outsideChange) {
    return `platform: The Cloudflare CLI did not ${operation}: ${outsideChange.replace(/:$/, '.')} This Worker was changed outside Void. Run the same command in a terminal. Void then lists the changes and asks you before it replaces them.`;
  }
  // A config variable or binding has the name of a secret on the Worker. Keep
  // only the names: the CLI stopped, so its sentence about the replacement of
  // the secrets is not true.
  const secret = lines.find((line) => / with (?:an )?existing remote secrets?\./.test(line));
  const secretNames = [...(secret?.split(' conflict')[0] ?? '').matchAll(/`[^`]+`/g)].map(
    ([name]) => name,
  );
  if (secretNames.length === 1) {
    return `platform: The Cloudflare CLI did not ${operation}: the Worker has a secret with the same name as a value that Void sets: ${secretNames[0]}. Delete that secret from the Worker in the Cloudflare dashboard, then run the command again.`;
  }
  if (secretNames.length > 1) {
    return `platform: The Cloudflare CLI did not ${operation}: the Worker has secrets with the same names as values that Void sets: ${new Intl.ListFormat('en').format(secretNames)}. Delete those secrets from the Worker in the Cloudflare dashboard, then run the command again.`;
  }
  // Another Worker owns a workflow that this Worker binds. Keep the workflow
  // and Worker names, and not the advice about a config file.
  const workflow = lines.findIndex((line) =>
    line.includes('already exist and belong to different workers'),
  );
  if (workflow !== -1) {
    const owners = lines.slice(workflow + 1);
    const end = owners.findIndex((line) => !line.startsWith('- '));
    const workflows = owners.slice(0, end === -1 ? undefined : end);
    return `platform: The Cloudflare CLI did not ${operation}: ${[lines[workflow], ...workflows].join(' ')}. ${
      workflows.length > 1
        ? 'Other Workers own these workflows. Delete each workflow, or rename it in the configuration of the Worker that owns it.'
        : 'Another Worker owns this workflow. Delete the workflow, or rename it in the configuration of that Worker.'
    } Then run the command again.`;
  }
  return `platform: The Cloudflare CLI did not ${operation}. It stopped the upload because of a conflict that it could not confirm without a terminal. Fix the conflict, then run the command again.`;
}

export function assertCleanPlatformWrangler(
  result: CloudflareCommandResult,
  operation: string,
  accountId?: string,
): void {
  if (result.status !== 0 || result.signal || result.error) {
    const conflict = uploadConflictMessage(result, operation);
    if (conflict) {
      throw new Error(conflict);
    }
    const diagnostic = cloudflareCommandDiagnostic({
      ...result,
      stderr: result.stderr.trim() || result.errors?.map((error) => error.message).join('\n') || '',
    });
    const analyticsEngineDisabled =
      result.errorCode === ANALYTICS_ENGINE_NOT_ENABLED ||
      result.errors?.some((error) => error.code === ANALYTICS_ENGINE_NOT_ENABLED) ||
      (result.errorCode === undefined &&
        !result.errors?.some((error) => error.code !== undefined) &&
        (diagnostic?.includes('[code: 10089]') || diagnostic?.includes('[10089]')));
    if (analyticsEngineDisabled) {
      const dashboard = accountId
        ? `https://dash.cloudflare.com/${accountId}/workers/analytics-engine`
        : 'https://dash.cloudflare.com/';
      throw new Error(
        `platform: Cloudflare could not ${operation}: Analytics Engine is not enabled for this account (code 10089). ` +
          `Open ${formatUrl(dashboard)}${accountId ? '' : ', select your account, and open Analytics Engine'}, then select Enable. ` +
          'Analytics Engine is available on Workers Free. After enabling it, use the printed recovery command if one is shown; otherwise retry this command. ' +
          `If Enable is unavailable, see ${formatUrl('https://void.cloud/guide/platform/installation/prerequisites#if-cloudflare-rejects-analytics-engine')}.`,
      );
    }
    throw new Error(
      `platform: Cloudflare failed to ${operation} (${diagnostic || `exit ${result.status}`}).`,
    );
  }
}

export function assertPlatformTriggerStabilization(
  result: Awaited<ReturnType<typeof stabilizeCloudflareVersionTriggers>>,
  workerName: string,
  targetVersionId: string,
  operation: string,
): void {
  if (!result.ok) {
    throw new Error(
      `platform: Failed to ${operation} triggers for ${workerName} (${result.reason}).`,
    );
  }
  if (!result.targetOwnsTraffic) {
    throw new Error(
      `platform: Worker ${workerName} was superseded by ${result.activeVersionId} while publishing ${targetVersionId}; its active trigger state was repaired.`,
    );
  }
}
