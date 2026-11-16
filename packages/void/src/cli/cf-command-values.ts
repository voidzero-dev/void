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
    ![...value].some((character) => {
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
 * Decode the Preview record `cf previews deploy` prints as JSON: the stable Preview URL and the
 * URL of this deployment. Earlier provider lines may precede the record, so read the last line that
 * starts a JSON object together with everything after it.
 */
export function readCfPreviewDeployOutput(
  stdout: string,
): CloudflarePreviewUploadResult | undefined {
  const lines = stdout.trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index]!.startsWith('{')) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(lines.slice(index).join('\n'));
    } catch {
      continue;
    }
    if (!isRecord(record)) {
      return undefined;
    }
    const value = record;
    const first = (urls: unknown) =>
      Array.isArray(urls) && typeof urls[0] === 'string' ? urls[0].replace(/\/$/, '') : undefined;
    const previewUrl = first(value.preview_urls);
    const deploymentUrl = first(value.deployment_urls);
    return typeof value.preview_id === 'string' &&
      typeof value.preview_name === 'string' &&
      typeof value.deployment_id === 'string'
      ? {
          previewId: value.preview_id,
          previewName: value.preview_name,
          deploymentId: value.deployment_id,
          ...(previewUrl ? { previewUrl } : {}),
          ...(deploymentUrl ? { deploymentUrl } : {}),
        }
      : undefined;
  }
  return undefined;
}
