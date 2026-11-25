import { isRecord } from '@void/deploy-core';
import type { EmailActionRecipient, EmailAdmissionResult } from '@voidcloud/api/email-admission';
import { hmacSign } from './hmac.ts';
import type { Env } from './types.ts';

export type ActionRecipient = EmailActionRecipient;
export type Admission = EmailAdmissionResult;

function isRecipient(value: unknown): value is ActionRecipient {
  return (
    isRecord(value) &&
    typeof value.recipient === 'string' &&
    (value.state === 'rejected' ||
      value.state === 'reserved' ||
      value.state === 'attempt_started' ||
      value.state === 'provider_accepted' ||
      value.state === 'failed' ||
      value.state === 'outcome_unknown' ||
      value.state === 'cancelled') &&
    (typeof value.errorCode === 'string' || value.errorCode === null) &&
    (typeof value.providerReference === 'string' || value.providerReference === null)
  );
}

type RecipientResponse = { recipients: Array<ActionRecipient> };

function hasRecipients(value: unknown): value is RecipientResponse {
  return isRecord(value) && Array.isArray(value.recipients) && value.recipients.every(isRecipient);
}

function isAdmission(value: unknown): value is Admission {
  return (
    isRecord(value) &&
    typeof value.operationId === 'string' &&
    typeof value.replay === 'boolean' &&
    (value.accountId === undefined || typeof value.accountId === 'string') &&
    hasRecipients(value)
  );
}

type ReceiptClaim = { state: 'claimed' | 'in_progress' | 'completed'; reject?: boolean };

function isReceiptClaim(value: unknown): value is ReceiptClaim {
  return (
    isRecord(value) &&
    (value.state === 'claimed' || value.state === 'in_progress' || value.state === 'completed') &&
    (value.reject === undefined || typeof value.reject === 'boolean')
  );
}

function isAcknowledged(value: unknown): value is { ok: true } {
  return isRecord(value) && value.ok === true;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMAIL_DEFAULT_DEADLINE_MS = 5000;
const EMAIL_ACTION_DEADLINE_MS = 15_000;
const EMAIL_ADMISSION_DEADLINE_MS = 15_000;
const MAX_ADMISSION_RESPONSE_BYTES = 65_536;

async function sign(data: string, secret: string): Promise<string> {
  if (!secret) {
    throw new Error('Email signing key is not configured');
  }
  return hmacSign(data, secret);
}

async function call<T>(
  env: Pick<Env, 'API' | 'EMAIL_SIGNING_SECRET'>,
  path: string,
  body: unknown,
  isResult: (value: unknown) => value is T,
  deadlineMs = EMAIL_DEFAULT_DEADLINE_MS,
): Promise<T> {
  const controller = new AbortController();
  const deadline = Date.now() + deadlineMs;
  const beforeDeadline = async <U>(run: () => Promise<U>): Promise<U> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      controller.abort();
      throw new Error('EMAIL_ADMISSION_TIMEOUT');
    }
    const promise = run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('EMAIL_ADMISSION_TIMEOUT'));
          }, remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };
  const raw = JSON.stringify(body);
  const proof = await sign(raw, env.EMAIL_SIGNING_SECRET);
  const response = await beforeDeadline(() =>
    env.API.fetch(`https://api/internal/email/actions${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-void-internal': proof,
      },
      body: raw,
      signal: controller.signal,
    }),
  );
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 409) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
    throw new Error(`EMAIL_ADMISSION_${response.status}`);
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (!reader) {
    throw new Error('EMAIL_ADMISSION_EMPTY_RESPONSE');
  }
  const bytes = new Uint8Array(MAX_ADMISSION_RESPONSE_BYTES);
  let size = 0;
  try {
    for (;;) {
      const chunk = await beforeDeadline(() => reader.read());
      if (chunk.done) {
        break;
      }
      if (size + chunk.value.byteLength > bytes.length) {
        throw new Error('EMAIL_ADMISSION_RESPONSE_TOO_LARGE');
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    const result: unknown = JSON.parse(decoder.decode(bytes.subarray(0, size)));
    if (!isResult(result)) {
      throw new Error('EMAIL_ADMISSION_INVALID_RESPONSE');
    }
    return result;
  } finally {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
}

export type RelayedReceiptIdentity = {
  receiptId: string;
  projectId: string;
  payloadDigest: string;
  route?: ReceiptRouteFence;
};

export type ReceiptRouteFence = {
  routeId: string;
  routeGeneration: number;
  connectionId: string;
  addressing: 'shared' | 'custom';
  domain: string;
  projectSlug: string;
};

export function claimRelayedReceipt(
  env: Pick<Env, 'API' | 'EMAIL_SIGNING_SECRET'>,
  identity: RelayedReceiptIdentity,
): Promise<ReceiptClaim> {
  return call(env, '/receipts/claim', identity, isReceiptClaim);
}

export function completeRelayedReceipt(
  env: Pick<Env, 'API' | 'EMAIL_SIGNING_SECRET'>,
  identity: RelayedReceiptIdentity,
  reject: boolean,
): Promise<{ ok: true }> {
  return call(
    env,
    '/receipts/complete',
    {
      receiptId: identity.receiptId,
      projectId: identity.projectId,
      payloadDigest: identity.payloadDigest,
      reject,
    },
    isAcknowledged,
  );
}

/** Only generated, transport-irrelevant MIME fields are normalized. Body text stays byte-sensitive. */
export function canonicalizeVoidMime(raw: Uint8Array): Uint8Array {
  if (findCrlfCrlf(raw) === -1) {
    return raw;
  }
  const boundaries = new Map<string, string>();
  const output: Array<Uint8Array> = [];
  let outputBytes = 0;
  let copyStart = 0;
  let changed = false;
  let inHeaders = true;
  let topHeaders = true;

  const append = (bytes: Uint8Array): void => {
    if (bytes.byteLength === 0) {
      return;
    }
    output.push(bytes);
    outputBytes += bytes.byteLength;
  };
  const replace = (start: number, end: number, replacement: Uint8Array): void => {
    append(raw.subarray(copyStart, start));
    append(replacement);
    copyStart = end;
    changed = true;
  };

  let lineStart = 0;
  while (lineStart < raw.byteLength) {
    const lineEnd = findCrlf(raw, lineStart);
    const nextLine = lineEnd === raw.byteLength ? raw.byteLength : lineEnd + 2;
    if (inHeaders) {
      if (lineEnd === lineStart) {
        inHeaders = false;
        topHeaders = false;
      } else if (
        topHeaders &&
        (asciiPrefixEquals(raw, lineStart, lineEnd, 'Date: ') ||
          asciiPrefixEquals(raw, lineStart, lineEnd, 'Message-ID: '))
      ) {
        // Remove the generated field and its CRLF. The next header (or the
        // terminating empty line) remains byte-for-byte unchanged.
        replace(lineStart, nextLine, new Uint8Array());
      } else if (isMultipartContentType(raw, lineStart, lineEnd)) {
        let headerEnd = lineEnd;
        let afterHeader = nextLine;
        let line = decoder.decode(raw.subarray(lineStart, headerEnd));
        // The SDK folds longer multipart boundary parameters onto continuation lines.
        // Folding whitespace is SP or HTAB only; other leading characters stay significant.
        while (raw[afterHeader] === 32 || raw[afterHeader] === 9) {
          headerEnd = findCrlf(raw, afterHeader);
          line += ` ${decoder.decode(raw.subarray(afterHeader, headerEnd)).replace(/^[ \t]+/, '')}`;
          afterHeader = headerEnd === raw.byteLength ? raw.byteLength : headerEnd + 2;
        }
        const normalized = line.replaceAll(
          /boundary="(=_void_(?:mixed|alternative|related)_[A-Za-z0-9_-]+)"/g,
          (_, token: string) => {
            let marker = boundaries.get(token);
            if (!marker) {
              marker = `<void-boundary-${boundaries.size}>`;
              boundaries.set(token, marker);
            }
            return `boundary="${marker}"`;
          },
        );
        if (normalized !== line) {
          replace(lineStart, headerEnd, encoder.encode(normalized));
        }
        lineStart = afterHeader;
        continue;
      }
    } else if (raw[lineStart] === 45 && raw[lineStart + 1] === 45) {
      const tokenStart = lineStart + 2;
      const token = isBoundaryToken(raw, tokenStart, lineEnd)
        ? decoder.decode(raw.subarray(tokenStart, lineEnd))
        : undefined;
      const openingMarker = token === undefined ? undefined : boundaries.get(token);
      if (openingMarker !== undefined) {
        replace(lineStart, lineEnd, encoder.encode(`--${openingMarker}`));
        inHeaders = true;
      } else if (
        lineEnd - tokenStart >= 2 &&
        raw[lineEnd - 2] === 45 &&
        raw[lineEnd - 1] === 45 &&
        isBoundaryToken(raw, tokenStart, lineEnd - 2)
      ) {
        const closingToken = decoder.decode(raw.subarray(tokenStart, lineEnd - 2));
        const closingMarker = boundaries.get(closingToken);
        if (closingMarker !== undefined) {
          replace(lineStart, lineEnd, encoder.encode(`--${closingMarker}--`));
        }
      }
    }
    lineStart = nextLine;
  }

  if (!changed) {
    return raw;
  }
  append(raw.subarray(copyStart));
  const normalized = new Uint8Array(outputBytes);
  let offset = 0;
  for (const chunk of output) {
    normalized.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return normalized;
}

function findCrlfCrlf(raw: Uint8Array): number {
  for (let i = 0; i + 3 < raw.byteLength; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function findCrlf(raw: Uint8Array, start: number): number {
  let cursor = start;
  while (cursor < raw.byteLength) {
    const cr = raw.indexOf(13, cursor);
    if (cr === -1) {
      return raw.byteLength;
    }
    if (raw[cr + 1] === 10) {
      return cr;
    }
    cursor = cr + 1;
  }
  return raw.byteLength;
}

function asciiPrefixEquals(raw: Uint8Array, start: number, end: number, expected: string): boolean {
  if (end - start < expected.length) {
    return false;
  }
  for (let i = 0; i < expected.length; i++) {
    const actual = raw[start + i];
    const wanted = expected.charCodeAt(i);
    if ((actual >= 65 && actual <= 90 ? actual + 32 : actual) !== (wanted | 32)) {
      return false;
    }
  }
  return true;
}

function isMultipartContentType(raw: Uint8Array, start: number, end: number): boolean {
  const field = 'Content-Type:';
  if (!asciiPrefixEquals(raw, start, end, field)) {
    return false;
  }
  let cursor = start + field.length;
  while (
    cursor < end &&
    (raw[cursor] === 32 || raw[cursor] === 9 || raw[cursor] === 11 || raw[cursor] === 12)
  ) {
    cursor++;
  }
  return asciiPrefixEquals(raw, cursor, end, 'multipart/');
}

function isBoundaryToken(raw: Uint8Array, start: number, end: number): boolean {
  if (end <= start) {
    return false;
  }
  for (let i = start; i < end; i++) {
    const byte = raw[i];
    if (
      !(
        (byte >= 65 && byte <= 90) ||
        (byte >= 97 && byte <= 122) ||
        (byte >= 48 && byte <= 57) ||
        byte === 95 ||
        byte === 45 ||
        byte === 61
      )
    ) {
      return false;
    }
  }
  return true;
}

export async function emailPayloadDigest(
  kind: string,
  from: string,
  recipients: Array<string>,
  raw: Uint8Array,
): Promise<string> {
  const canonical = canonicalizeVoidMime(raw);
  const prefix = encoder.encode(
    JSON.stringify({
      kind,
      from: from.toLowerCase(),
      recipients: [...new Set(recipients.map((r) => r.toLowerCase()))].sort(),
    }),
  );
  const input = new Uint8Array(prefix.length + 1 + canonical.length);
  input.set(prefix);
  input[prefix.length] = 0;
  input.set(canonical, prefix.length + 1);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', input))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function admitEmail(
  env: Pick<Env, 'API' | 'EMAIL_SIGNING_SECRET'>,
  body: {
    projectId: string;
    kind: 'direct' | 'forward' | 'reply';
    key: string;
    digest: string;
    from: string;
    recipients: Array<string>;
    transport: 'binding' | 'send_raw' | 'native_forward' | 'native_reply';
    receiptId?: string;
  },
  deadlineMs = EMAIL_ADMISSION_DEADLINE_MS,
): Promise<Admission> {
  return call(env, '/admit', body, isAdmission, Math.min(deadlineMs, EMAIL_ADMISSION_DEADLINE_MS));
}

export function startEmailAttempt(
  env: Pick<Env, 'API' | 'EMAIL_SIGNING_SECRET'>,
  operationId: string,
  recipients: Array<string>,
  deadlineMs = EMAIL_ACTION_DEADLINE_MS,
): Promise<RecipientResponse> {
  return call(
    env,
    `/${encodeURIComponent(operationId)}/start`,
    { recipients },
    hasRecipients,
    Math.min(deadlineMs, EMAIL_ACTION_DEADLINE_MS),
  );
}

export function finishEmailAttempt(
  env: Pick<Env, 'API' | 'EMAIL_SIGNING_SECRET'>,
  operationId: string,
  recipients: Array<string>,
  state: 'provider_accepted' | 'failed' | 'outcome_unknown' | 'cancelled',
  details: { providerReference?: string; errorCode?: string } = {},
  deadlineMs = EMAIL_ACTION_DEADLINE_MS,
): Promise<RecipientResponse> {
  return call(
    env,
    `/${encodeURIComponent(operationId)}/finish`,
    { recipients, state, ...details },
    hasRecipients,
    Math.min(deadlineMs, EMAIL_ACTION_DEADLINE_MS),
  );
}

export function recordEmailReceipt(
  env: Pick<Env, 'API' | 'EMAIL_SIGNING_SECRET'>,
  receiptId: string,
  projectId: string,
  status: string,
  route?: ReceiptRouteFence,
): Promise<{ ok: true }> {
  return call(
    env,
    '/receipts',
    { receiptId, projectId, status, ...(route ? { route } : {}) },
    isAcknowledged,
  );
}
