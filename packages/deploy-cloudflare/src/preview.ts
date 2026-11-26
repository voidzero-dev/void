import { isRecord } from '@void/deploy-core';
import { commandDiagnosticFields } from './diagnostics.ts';
import { isCleanCommandExit, isCompletedCommand, isWorkerNotFound } from './execute.ts';
import type { CloudflareCommandRunner } from './execute.ts';
import type { CloudflarePreviewUploadResult } from './operations.ts';

/**
 * A Preview name becomes the first label of `<name>-<worker>.<subdomain>.workers.dev`. Accept only
 * names Cloudflare uses unchanged, so the URL Void prints is the one CI expects.
 */
const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A DNS label holds at most 63 characters. */
const MAX_HOST_LABEL = 63;
/** Cloudflare's "Preview not found" API error. */
const PREVIEW_NOT_FOUND = 10_025;

/**
 * Return why `name` cannot name a Preview, or undefined when it can. Cloudflare uses the name
 * unchanged as the start of a hostname label, so the URL Void prints is the one CI expects.
 */
export function cloudflarePreviewNameProblem(name: string): string | undefined {
  if (name.length === 0 || name.length > MAX_HOST_LABEL) {
    return `must be 1 to ${MAX_HOST_LABEL} characters`;
  }
  if (!isLowercaseLetter(name[0])) {
    return 'must start with a lowercase letter';
  }
  for (const character of name) {
    if (!isLowercaseLetter(character) && !isDigit(character) && character !== '-') {
      return 'may use only lowercase letters, digits and hyphens';
    }
  }
  if (name.endsWith('-')) {
    return 'must end with a letter or digit';
  }
  if (name.includes('--')) {
    return 'cannot have two hyphens in a row';
  }
  return undefined;
}

function isLowercaseLetter(character: string | undefined): boolean {
  return character !== undefined && character >= 'a' && character <= 'z';
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

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
  | { ok: false; reason: 'worker-not-found' }
  | { ok: false; reason: 'delete-failed'; status: number; diagnostic?: string };

/**
 * Delete a named Preview and all its deployments. A Preview that does not exist is reported as
 * `deleted: false`, so a pull-request cleanup job can run more than once. A missing Worker is an
 * error: the name or account most likely points somewhere else.
 */
export async function deleteCloudflarePreview(options: {
  runWrangler: CloudflareCommandRunner;
  workerName: string;
  previewName: string;
  configPath?: string;
}): Promise<CloudflarePreviewDeleteResult> {
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
  // Checked first: "Preview not found" must never read as a missing Worker.
  if (isCompletedCommand(result) && result.errorCode === PREVIEW_NOT_FOUND) {
    return { ok: true, deleted: false };
  }
  if (isWorkerNotFound(result)) {
    return { ok: false, reason: 'worker-not-found' };
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
    ...(isHttpsUrl(previewUrl) ? { previewUrl } : {}),
    ...(isHttpsUrl(deploymentUrl) ? { deploymentUrl } : {}),
  };
}

function isHttpsUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('https://');
}

function optionalUrl(url: unknown): boolean {
  return url === undefined || isHttpsUrl(url);
}
