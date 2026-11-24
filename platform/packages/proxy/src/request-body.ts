const REQUEST_BODY_DEADLINE_MS = 5000;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024;
const LARGE_JSON_BODY_MAX_BYTES = 8 * 1024 * 1024;

export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 408 | 413,
  ) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

/** File and binary payload routes need more room than control operations. */
export function requestBodyMaxBytes(path: string): number {
  switch (path) {
    case '/ai/run':
    case '/ai/provider':
    case '/ai/toMarkdown':
    case '/kv/put':
    case '/r2/put':
    case '/r2/put-conditional':
      return LARGE_JSON_BODY_MAX_BYTES;
    default:
      return DEFAULT_JSON_BODY_MAX_BYTES;
  }
}

async function beforeDeadline<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new RequestBodyError('request body timeout', 408);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    run(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new RequestBodyError('request body timeout', 408)),
        remaining,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/** Bound public request bodies before JSON parsing or authentication. */
export async function readRequestJson(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    void request.body?.cancel().catch(() => {});
    throw new RequestBodyError('request body too large', 413);
  }
  if (
    request.headers.has('content-encoding') ||
    !request.body ||
    (declaredLength !== null && !/^\d+$/.test(declaredLength))
  ) {
    void request.body?.cancel().catch(() => {});
    throw new RequestBodyError('invalid request body', 400);
  }
  const expectedLength = declaredLength === null ? null : Number(declaredLength);
  const reader = request.body.getReader();
  let bytes = new Uint8Array(Math.min(1024, maxBytes));
  const deadline = Date.now() + REQUEST_BODY_DEADLINE_MS;
  let size = 0;
  try {
    for (;;) {
      const chunk = await beforeDeadline(deadline, () => reader.read());
      if (chunk.done) {
        break;
      }
      const nextSize = size + chunk.value.byteLength;
      if (nextSize > maxBytes) {
        throw new RequestBodyError('request body too large', 413);
      }
      if (nextSize > bytes.byteLength) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(nextSize, bytes.byteLength * 2)));
        grown.set(bytes.subarray(0, size));
        bytes = grown;
      }
      bytes.set(chunk.value, size);
      size = nextSize;
    }
  } finally {
    // An uncooperative stream may never settle cancellation. Start cleanup,
    // but do not let it extend the hard request-body deadline.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size === 0 || (expectedLength !== null && size !== expectedLength)) {
    throw new RequestBodyError('invalid request body length', 400);
  }
  return JSON.parse(decoder.decode(bytes.subarray(0, size)));
}
