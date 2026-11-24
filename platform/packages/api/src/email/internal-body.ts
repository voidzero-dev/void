export class EmailInternalBodyError extends Error {
  constructor(
    readonly status: 400 | 408 | 413,
    message: string,
  ) {
    super(message);
  }
}

/** Read an internal JSON request within a strict byte and time budget. */
export async function readBoundedInternalJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new EmailInternalBodyError(413, 'body too large');
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new EmailInternalBodyError(400, 'invalid body');
  }
  const chunks: Array<Uint8Array> = [];
  let size = 0,
    timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 5000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) {
        throw new EmailInternalBodyError(408, 'body timed out');
      }
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new EmailInternalBodyError(413, 'body too large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (timedOut) {
      throw new EmailInternalBodyError(408, 'body timed out');
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new EmailInternalBodyError(400, 'invalid body');
  }
}
