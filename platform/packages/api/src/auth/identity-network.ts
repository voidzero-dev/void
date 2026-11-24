const MAX_RESPONSE_BYTES = 256 * 1024;

/** Public Internet egress only. Private IdPs need a deliberately published HTTPS endpoint. */
export function assertPublicIdentityUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) {
    throw new Error('Identity endpoints must use credential-free HTTPS on the standard port.');
  }
  const host = url.hostname.toLowerCase();
  if (
    !host.includes('.') ||
    host.endsWith('.') ||
    host.includes(':') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
    /^\d+(?:\.\d+){3}$/.test(host)
  ) {
    throw new Error('Identity endpoints must use a public DNS hostname.');
  }
  return url;
}

export async function boundedIdentityResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('The identity provider request failed.');
  }
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('The identity provider response is too large.');
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        length += result.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('The identity provider response is too large.');
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(bytes, { status: response.status, headers: response.headers });
}
