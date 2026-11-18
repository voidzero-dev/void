import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { sanitizeTerminalLogText } from './terminal-log-text.ts';

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function strings(value: unknown): Array<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Array<string> = [];
  for (const item of value) {
    const text = typeof item === 'string' ? item : object(item).message;
    if (typeof text === 'string' && text) {
      out.push(text);
    }
  }
  return out;
}

/**
 * A failed ingest reports the SQL error in `errors` (and progress in
 * `messages`) with `status: 'error'`; `error` is set only when the import
 * itself was refused. Show all of them, as wrangler does.
 */
function importFailureDetail(state: Json): string {
  const errors = strings(state.errors);
  if (typeof state.error === 'string' && state.error) {
    errors.unshift(state.error);
  }
  const lines = [...errors, ...strings(state.messages)];
  return lines.length > 0 ? sanitizeTerminalLogText(lines.join('\n')) : 'Unknown import error.';
}

/** Upload SQL separately from process arguments and wait for D1 to finish ingesting it. */
export async function importD1SqlFile({
  endpoint,
  headers,
  file,
}: {
  endpoint: string;
  headers: Record<string, string>;
  file: string;
}): Promise<void> {
  const signal = AbortSignal.timeout(10 * 60_000);
  const blob = await openAsBlob(file);
  const hash = createHash('md5');
  for await (const chunk of blob.stream()) {
    hash.update(chunk);
  }
  const etag = hash.digest('hex');

  async function request(body: Json): Promise<Json> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
    const data = object(await response.json());
    if (!response.ok || data.success !== true) {
      const errors = Array.isArray(data.errors) ? data.errors : [];
      const detail = errors
        .map((error) => String(object(error).message ?? ''))
        .filter(Boolean)
        .join('; ');
      throw new Error(
        `D1 import failed (HTTP ${response.status})${detail ? ': ' + sanitizeTerminalLogText(detail) : '.'}`,
      );
    }
    const state = object(data.result);
    if (state.status === 'error' || state.success === false) {
      throw new Error(`D1 import failed: ${importFailureDetail(state)}`);
    }
    return state;
  }

  const initialized = await request({ action: 'init', etag });
  let state = initialized;
  if (!initialized.at_bookmark) {
    if (
      typeof initialized.filename !== 'string' ||
      !initialized.filename ||
      typeof initialized.upload_url !== 'string'
    ) {
      throw new Error('Cloudflare returned an invalid D1 import upload.');
    }
    let uploadUrl: URL;
    try {
      uploadUrl = new URL(initialized.upload_url);
    } catch {
      throw new Error('Cloudflare returned an invalid D1 import upload URL.');
    }
    const localApi = new URL(endpoint);
    if (
      uploadUrl.protocol !== 'https:' &&
      !(
        uploadUrl.protocol === 'http:' &&
        localApi.protocol === 'http:' &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(uploadUrl.hostname) &&
        uploadUrl.hostname === localApi.hostname
      )
    ) {
      throw new Error('Cloudflare returned an insecure D1 import upload URL.');
    }
    // The presigned URL authorizes this request; never forward the account's credentials.
    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      body: blob,
      redirect: 'error',
      signal,
    });
    await upload.body?.cancel();
    if (!upload.ok || upload.headers.get('etag')?.replaceAll('"', '') !== etag) {
      throw new Error(`D1 import upload failed verification (HTTP ${upload.status}).`);
    }
    state = await request({ action: 'ingest', etag, filename: initialized.filename });
  }

  for (;;) {
    if (state.status === 'complete' && state.success === true) {
      return;
    }
    if (typeof state.at_bookmark !== 'string' || !state.at_bookmark) {
      throw new Error('Cloudflare returned an invalid D1 import status.');
    }
    await setTimeout(1000, undefined, { signal });
    state = await request({ action: 'poll', current_bookmark: state.at_bookmark });
  }
}
