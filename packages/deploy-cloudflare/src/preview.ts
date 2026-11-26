import { isRecord } from '@void/deploy-core';
import { commandDiagnosticFields } from './diagnostics.ts';
import { isCleanCommandExit, isCompletedCommand, isWorkerNotFound } from './execute.ts';
import type { CloudflareCommandRunner } from './execute.ts';
import type { CloudflarePreviewUploadResult } from './operations.ts';

/** A DNS label, such as a workers.dev Preview host, holds at most 63 characters. */
export const CLOUDFLARE_HOST_LABEL_MAX = 63;
/** Cloudflare's "Preview not found" API error. */
const PREVIEW_NOT_FOUND = 10_025;

/**
 * Return why `name` cannot name a Preview, or undefined when it can. Cloudflare uses the name
 * unchanged as the start of a hostname label, so the URL Void prints is the one CI expects.
 */
export function cloudflarePreviewNameProblem(name: string): string | undefined {
  if (name.length === 0 || name.length > CLOUDFLARE_HOST_LABEL_MAX) {
    return `must be 1 to ${CLOUDFLARE_HOST_LABEL_MAX} characters`;
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

/** Root config keys a static Preview keeps. Bindings, vars, migrations and triggers are dropped. */
const PREVIEW_CONFIG_KEYS = [
  'name',
  'account_id',
  'compliance_region',
  'compatibility_date',
  'compatibility_flags',
  'assets',
  'observability',
  'version_metadata',
];

/**
 * The config a static site Preview is staged from. cf sends every binding in the Build Output to
 * the Preview, so this copies only an allow-list: a binding kind added later never reaches it.
 */
export function previewStaticWorkerConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    PREVIEW_CONFIG_KEYS.flatMap((key) => (config[key] === undefined ? [] : [[key, config[key]]])),
  );
}

export type CloudflarePreviewDeployResult =
  | {
      ok: true;
      previewId: string;
      deploymentId: string;
      /** The stable URL that always serves this Preview's latest deployment. */
      previewUrl: string;
      /** The URL of this deployment only. */
      deploymentUrl: string | null;
    }
  | { ok: false; reason: 'worker-not-found' | 'uploader-changed' | 'output-invalid' }
  | {
      ok: false;
      reason: 'worker-check-failed' | 'deploy-failed';
      status: number;
      diagnostic?: string;
    }
  /** Cloudflare created the deployment but returned no Preview URL: `preview_urls` is off. */
  | { ok: false; reason: 'preview-urls-disabled'; deploymentId: string };

/**
 * Create or update a named Workers Preview from the prepared output. It reads the Worker's
 * deployment status first, because cf would create a missing Worker without asking. Production
 * versions, deployments, traffic and triggers are not changed, and no migration, provisioning or
 * secret operation runs.
 */
export async function deployCloudflarePreview(options: {
  runWrangler: CloudflareCommandRunner;
  workerName: string;
  previewName: string;
  verifyUploader: () => boolean;
  configPath?: string;
}): Promise<CloudflarePreviewDeployResult> {
  const target = {
    workerName: options.workerName,
    ...(options.configPath ? { configPath: options.configPath } : {}),
  };
  const status = await options.runWrangler(
    { type: 'deployments.status', ...target },
    { capture: true },
  );
  if (isWorkerNotFound(status)) {
    return { ok: false, reason: 'worker-not-found' };
  }
  if (!isCleanCommandExit(status)) {
    return {
      ok: false,
      reason: 'worker-check-failed',
      status: status.status,
      ...commandDiagnosticFields(status),
    };
  }
  if (!options.verifyUploader()) {
    return { ok: false, reason: 'uploader-changed' };
  }
  const result = await options.runWrangler(
    { type: 'previews.deploy', previewName: options.previewName, ...target },
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
    return { ok: false, reason: 'preview-urls-disabled', deploymentId: uploaded.deploymentId };
  }
  return {
    ok: true,
    previewId: uploaded.previewId,
    deploymentId: uploaded.deploymentId,
    previewUrl: uploaded.previewUrl,
    deploymentUrl: uploaded.deploymentUrl ?? null,
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
