import type { CloudflarePreviewUploadResult } from '@void/deploy-cloudflare';
import { isRecord } from '@void/deploy-core';
// Leave room for a 64 MiB Worker, base64 expansion, and JSON metadata.
export const CF_VERSION_SOURCE_MAX_OUTPUT_BYTES: number = 128 * 1024 * 1024;

/** Accept a cf positional only when it cannot be read as a flag or carry control characters. */
export function safePositional(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('-') &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

/** Accept only Cloudflare's hex-segment D1 Time Travel bookmarks; Void prints them as commands to copy. */
export function isD1Bookmark(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]+(?:-[0-9a-f]+)+$/i.test(value);
}

/**
 * Read the version ID and URLs that cf prints after a prebuilt upload: on stdout before
 * cf 1.0.0-beta.21, and on stderr since.
 */
export function readCfUploadOutput(result: {
  stdout: string;
  stderr: string;
}): Record<'versionId' | 'previewUrl' | 'workersDevUrl', string | undefined> {
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    versionId: output.match(/(?:Worker|Current) Version ID:\s*([0-9a-f]{8}-[0-9a-f-]{27})/i)?.[1],
    previewUrl: output.match(/Version Preview(?: Alias)? URL:\s*(https:\/\/\S+)/i)?.[1],
    workersDevUrl: output.match(/(https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/[^\s]*)?)/i)?.[1],
  };
}

/**
 * Map the Preview record `cf previews deploy` prints as JSON on stdout to the stable Preview URL
 * and the URL of this deployment. Anything unreadable gives undefined, so the deploy fails closed.
 */
export function readCfPreviewDeployOutput(
  data: unknown,
): CloudflarePreviewUploadResult | undefined {
  if (
    !isRecord(data) ||
    typeof data.preview_id !== 'string' ||
    typeof data.preview_name !== 'string' ||
    typeof data.deployment_id !== 'string'
  ) {
    return undefined;
  }
  const previewUrl = firstUrl(data.preview_urls);
  const deploymentUrl = firstUrl(data.deployment_urls);
  return {
    previewId: data.preview_id,
    previewName: data.preview_name,
    deploymentId: data.deployment_id,
    ...(previewUrl ? { previewUrl } : {}),
    ...(deploymentUrl ? { deploymentUrl } : {}),
  };
}

/** The first URL of a cf URL list, without a trailing slash. */
function firstUrl(urls: unknown): string | undefined {
  const url: unknown = Array.isArray(urls) ? urls[0] : undefined;
  if (typeof url !== 'string') {
    return undefined;
  }
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
