/** Lease a customer API token from the platform for a custom-domain send. */

import { hmacSign } from './hmac.ts';
import type { Env } from './types.ts';

export type EmailDomainLease = { kind: 'api_token'; token: string; accountId: string };

const LEASE_DEADLINE_MS = 5000;
const MAX_LEASE_RESPONSE_BYTES = 4 * 1024;

/** The bearer value for the send_raw Authorization header. */
export function leaseBearer(lease: EmailDomainLease): string {
  return lease.token;
}

/**
 * Lease a send credential for a registered domain from the api. Returns
 * null on any failure; the caller maps that to a retryable upstream error.
 */
export async function leaseEmailDomainCredential(
  env: Pick<Env, 'API' | 'EMAIL_SIGNING_SECRET'>,
  domain: string,
  projectId: string,
  deadlineMs = LEASE_DEADLINE_MS,
): Promise<EmailDomainLease | null> {
  if (!env.EMAIL_SIGNING_SECRET) {
    return null;
  }
  const controller = new AbortController();
  const deadline = Date.now() + Math.min(deadlineMs, LEASE_DEADLINE_MS);
  const beforeDeadline = async <T>(run: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      controller.abort();
      throw new Error('email credential lease timed out');
    }
    const promise = run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('email credential lease timed out'));
          }, remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  let res: Response;
  try {
    const token = await hmacSign(
      `email-lease-v1\n${projectId}\n${domain.toLowerCase()}`,
      env.EMAIL_SIGNING_SECRET,
    );
    res = await beforeDeadline(() =>
      env.API.fetch('https://api/internal/email/domain-credential', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-void-internal': token,
        },
        body: JSON.stringify({ domain, projectId }),
        signal: controller.signal,
      }),
    );
  } catch {
    return null;
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return null;
  }
  const declared = res.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_LEASE_RESPONSE_BYTES)
  ) {
    void res.body?.cancel().catch(() => {});
    return null;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
  if (!reader) {
    return null;
  }
  const bytes = new Uint8Array(MAX_LEASE_RESPONSE_BYTES);
  let size = 0;
  try {
    for (;;) {
      const chunk = await beforeDeadline(() => reader.read());
      if (chunk.done) {
        break;
      }
      if (size + chunk.value.byteLength > bytes.byteLength) {
        throw new Error('email credential lease response too large');
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    if (declared !== null && size !== Number(declared)) {
      return null;
    }
    const data: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size)),
    );
    return parseLease(data);
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
}

function parseLease(data: unknown): EmailDomainLease | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const kind = (data as { kind?: unknown }).kind;
  const accountId = (data as { accountId?: unknown }).accountId;
  if (typeof accountId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(accountId)) {
    return null;
  }
  if (kind === 'api_token') {
    const token = (data as { token?: unknown }).token;
    return typeof token === 'string' && token.length > 0 ? { kind, token, accountId } : null;
  }
  return null;
}
