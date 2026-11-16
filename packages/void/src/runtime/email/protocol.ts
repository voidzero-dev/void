// Generated email handlers import the wire protocol through Void so consumer
// projects do not need a direct dependency on @void/platform.
export {
  EMAIL_PROTOCOL_VERSION,
  encodeEmailActions,
  readEmailEnvelope,
} from '@void/platform/email-protocol';

const RECEIPT_VERIFICATION_DEADLINE_MS = 5_000;
const MAX_RECEIPT_VERIFICATION_BYTES = 2 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

type ReceiptVerificationInput = {
  receipt: string;
  projectId: string;
  deploymentId: string;
  recipient: string;
};

type ReceiptVerifier = {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
};

/**
 * Settle `run()` within `ms`, or reject with `onTimeout()`. `run` is not
 * called when `ms` has already elapsed.
 */
export async function withTimeout<T>(
  ms: number,
  run: () => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  if (ms <= 0) {
    throw onTimeout();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Read a JSON body of at most `maxBytes`, each read bounded by `race`. A
 * declared length must be exact.
 */
export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  race: <T>(run: () => Promise<T>) => Promise<T>,
  { rejectEncoding = false }: { rejectEncoding?: boolean } = {},
): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (
    (rejectEncoding && response.headers.has('content-encoding')) ||
    (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error('email response refused before reading');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('email response is empty');
  }
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  try {
    for (;;) {
      const chunk = await race(() => reader.read());
      if (chunk.done) {
        break;
      }
      if (size + chunk.value.byteLength > maxBytes) {
        throw new Error('email response too large');
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
  } finally {
    // Do not await cancellation: an uncooperative stream may never settle it.
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
  if (declared !== null && size !== Number(declared)) {
    throw new Error('email response length mismatch');
  }
  return JSON.parse(decoder.decode(bytes.subarray(0, size)));
}

/** Validate a gateway receipt without exposing the signing secret to the tenant worker. */
export async function verifyEmailReceiptThroughProxy(
  proxy: ReceiptVerifier,
  projectToken: string,
  input: ReceiptVerificationInput,
): Promise<boolean> {
  const deadline = Date.now() + RECEIPT_VERIFICATION_DEADLINE_MS;
  const beforeDeadline = <T>(run: () => Promise<T>): Promise<T> =>
    withTimeout(deadline - Date.now(), run, () => new Error('email receipt verification timeout'));
  const controller = new AbortController();
  let response: Response | undefined;
  try {
    response = await beforeDeadline(() =>
      proxy.fetch('https://proxy/email/verify-receipt', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-void-internal': projectToken },
        body: JSON.stringify(input),
        signal: controller.signal,
      }),
    );
    if (!response.ok) {
      return false;
    }
    const body = await readBoundedJson(response, MAX_RECEIPT_VERIFICATION_BYTES, beforeDeadline, {
      rejectEncoding: true,
    });
    return (
      !!body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      (body as Record<string, unknown>).valid === true
    );
  } catch {
    return false;
  } finally {
    controller.abort();
    void response?.body?.cancel().catch(() => {});
  }
}
