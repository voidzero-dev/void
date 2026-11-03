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
