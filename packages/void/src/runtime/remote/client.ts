import { cfAccessHeaders } from '../../shared/cf-access.ts';

function readableMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  /* eslint-disable no-control-regex -- Strip ANSI sequences before removing remaining control characters. */
  const text = value
    .replaceAll(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, '')
    .replaceAll(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim();
  /* eslint-enable no-control-regex */
  if (!text || /^[{[]/.test(text) || /<\/?[a-z!][^>]*>/i.test(text)) {
    return undefined;
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function isGenericPermissionMessage(message: string): boolean {
  return /^(?:(?:HTTP\s*)?(?:401|403)\s*[:-]?\s*)?(?:forbidden|unauthorized|access denied|permission denied|invalid or expired token)[.!]?$/i.test(
    message,
  );
}

async function proxyError(response: Response): Promise<Error> {
  // Error pages are untrusted and can be large. Read only enough for a diagnostic.
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let remaining = 16_384;
  try {
    while (reader && remaining > 0) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      remaining -= value.byteLength;
    }
    text += decoder.decode();
  } catch {
    // An unreadable body should not hide the HTTP status or recovery guidance.
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }

  let message: string | undefined;
  let error: string | undefined;
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const payload = body as Record<string, unknown>;
      message = readableMessage(payload.message);
      error = readableMessage(payload.error);
    }
  } catch {
    if (!response.headers.get('content-type')?.includes('text/html')) {
      error = readableMessage(text);
    }
  }

  if (message && isGenericPermissionMessage(message)) {
    message = undefined;
  }
  if (!message && error && !isGenericPermissionMessage(error)) {
    message = error;
  }
  if (!message) {
    if (response.status === 401) {
      message =
        'Remote access could not be authenticated. Sign in to the connected platform again, or restart the build to obtain a fresh prerender token.';
    } else if (response.status === 403) {
      message =
        'Remote access could not be authorized. Check the selected platform and project, then ask a project admin or owner to confirm your access. If your access is correct, retry shortly.';
    } else {
      message = error ?? 'The remote service returned an unreadable error. Retry the request.';
    }
  }
  return new Error(`remote: Proxy request failed with ${response.status}: ${message}`);
}

/**
 * HTTP client for the connected platform's remote bindings proxy.
 *
 * Used by ProxyD1Database, ProxyKVNamespace, and ProxyR2Bucket to forward
 * binding operations to the platform proxy during local development.
 */
export class ProxyClient {
  private readonly authHeaders: Record<string, string>;

  constructor(
    private proxyUrl: string,
    token: string,
    private projectId: string,
    env: Record<string, unknown> = {},
  ) {
    this.authHeaders = {
      Authorization: `Bearer ${token}`,
      ...cfAccessHeaders(env, proxyUrl),
    };
  }

  /**
   * Send a JSON POST request to the proxy and return the response.
   * Injects `projectId` into the body and `Authorization` header.
   * Throws on non-OK responses.
   */
  async fetch(path: string, body: Record<string, unknown>): Promise<Response> {
    const res = await globalThis.fetch(`${this.proxyUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.authHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, projectId: this.projectId }),
      redirect: 'manual',
    });
    if (!res.ok) {
      throw await proxyError(res);
    }
    return res;
  }
}
