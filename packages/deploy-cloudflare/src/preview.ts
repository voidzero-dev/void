import { isRecord } from '@void/deploy-core';
import { commandDiagnosticFields } from './diagnostics.ts';
import {
  isCleanCommandExit,
  isCompletedCommand,
  isWorkerNotFound,
  type CloudflareCommandRunner,
} from './execute.ts';
import type { CloudflarePreviewUploadResult } from './operations.ts';

/**
 * A Preview name becomes the first label of `<name>-<worker>.<subdomain>.workers.dev`. Accept only
 * names Cloudflare uses unchanged, so the URL Void prints is the one CI expects.
 */
const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A DNS label holds at most 63 characters. */
const MAX_HOST_LABEL = 63;
/** Cloudflare's "Preview not found" API error. */
const PREVIEW_NOT_FOUND = 10025;

/** Return why `name` cannot name a Preview of `workerName`, or null when it can. */
export function validateCloudflarePreviewName(name: string, workerName?: string): string | null {
  if (!PREVIEW_NAME.test(name)) {
    return `"${name}" is not a valid preview name. Use lowercase letters, digits and hyphens, starting and ending with a letter or digit (for example "pr-64").`;
  }
  if (workerName !== undefined && name.length + 1 + workerName.length > MAX_HOST_LABEL) {
    return `The preview name "${name}" is too long for the Worker "${workerName}": "${name}-${workerName}" must fit in ${MAX_HOST_LABEL} characters to be a workers.dev hostname.`;
  }
  return null;
}

export type CloudflarePreviewDeployResult =
  | {
      ok: true;
      previewId: string;
      deploymentId: string;
      /** The stable URL that always serves this Preview's latest deployment. */
      previewUrl: string;
      /** The URL of this deployment only. */
      deploymentUrl: string | undefined;
    }
  | {
      ok: false;
      reason: 'uploader-changed' | 'invalid-name' | 'output-invalid';
      diagnostic?: string;
    }
  | { ok: false; reason: 'deploy-failed'; status: number; diagnostic?: string }
  /** Cloudflare created the deployment but returned no Preview URL: `preview_urls` is off. */
  | { ok: false; reason: 'preview-urls-disabled' };

/**
 * Create or update a named Workers Preview from the prepared output. This only ever sends
 * `previews.deploy`: production versions, deployments, traffic and triggers are not read or
 * changed, and no migration, provisioning or secret operation runs.
 */
export async function deployCloudflarePreview(options: {
  runWrangler: CloudflareCommandRunner;
  workerName: string;
  previewName: string;
  verifyUploader: () => boolean;
  configPath?: string;
}): Promise<CloudflarePreviewDeployResult> {
  const invalid = validateCloudflarePreviewName(options.previewName, options.workerName);
  if (invalid) {
    return { ok: false, reason: 'invalid-name', diagnostic: invalid };
  }
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  const result = await options.runWrangler(
    {
      type: 'previews.deploy',
      workerName: options.workerName,
      previewName: options.previewName,
      ...(options.configPath ? { configPath: options.configPath } : {}),
    },
    { capture: true },
  );
  if (!isCleanCommandExit(result)) {
    return {
      ok: false,
      reason: 'deploy-failed',
      status: result.status,
      ...commandDiagnosticFields(result),
    };
  }
  const uploaded = readPreviewUploadResult(result.data);
  if (!uploaded || uploaded.previewName !== options.previewName) {
    return { ok: false, reason: 'output-invalid' };
  }
  if (!uploaded.previewUrl) {
    return { ok: false, reason: 'preview-urls-disabled' };
  }
  return {
    ok: true,
    previewId: uploaded.previewId,
    deploymentId: uploaded.deploymentId,
    previewUrl: uploaded.previewUrl,
    deploymentUrl: uploaded.deploymentUrl,
  };
}

export type CloudflarePreviewDeleteResult =
  | { ok: true; deleted: boolean }
  | { ok: false; reason: 'uploader-changed' | 'invalid-name'; diagnostic?: string }
  | { ok: false; reason: 'delete-failed'; status: number; diagnostic?: string };

/**
 * Delete a named Preview and all its deployments. A Preview that does not exist is reported as
 * `deleted: false`, so a pull-request cleanup job can run more than once.
 */
export async function deleteCloudflarePreview(options: {
  runWrangler: CloudflareCommandRunner;
  workerName: string;
  previewName: string;
  verifyUploader: () => boolean;
  configPath?: string;
}): Promise<CloudflarePreviewDeleteResult> {
  const invalid = validateCloudflarePreviewName(options.previewName);
  if (invalid) {
    return { ok: false, reason: 'invalid-name', diagnostic: invalid };
  }
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  const result = await options.runWrangler(
    {
      type: 'previews.delete',
      workerName: options.workerName,
      previewName: options.previewName,
      ...(options.configPath ? { configPath: options.configPath } : {}),
    },
    { capture: true },
  );
  if (isCleanCommandExit(result)) {
    return { ok: true, deleted: true };
  }
  // Neither the Preview nor, with 10007, its Worker exists: there is nothing left to delete.
  if (
    isWorkerNotFound(result) ||
    (isCompletedCommand(result) && result.errorCode === PREVIEW_NOT_FOUND)
  ) {
    return { ok: true, deleted: false };
  }
  return {
    ok: false,
    reason: 'delete-failed',
    status: result.status,
    ...commandDiagnosticFields(result),
  };
}

/** Validate the structured result the runner decoded from the provider's Preview record. */
function readPreviewUploadResult(value: unknown): CloudflarePreviewUploadResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const { previewId, previewName, deploymentId, previewUrl, deploymentUrl } = value;
  const optionalUrl = (url: unknown) =>
    url === undefined || (typeof url === 'string' && url.startsWith('https://'));
  if (
    typeof previewId !== 'string' ||
    !previewId ||
    typeof previewName !== 'string' ||
    typeof deploymentId !== 'string' ||
    !deploymentId ||
    !optionalUrl(previewUrl) ||
    !optionalUrl(deploymentUrl)
  ) {
    return null;
  }
  return {
    previewId,
    previewName,
    deploymentId,
    ...(previewUrl ? { previewUrl: previewUrl as string } : {}),
    ...(deploymentUrl ? { deploymentUrl: deploymentUrl as string } : {}),
  };
}
