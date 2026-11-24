import { isRecord } from './validate.ts';

/** Worker-safe wire contract shared by the platform gateway and tenant entry. */
export const EMAIL_PROTOCOL_VERSION = 1;
export const EMAIL_RECEIPT_PATH = '/__void/email/receipt/v1';
export const EMAIL_MAX_ACTIONS: number = 100;
export const EMAIL_MAX_METADATA_BYTES: number = 8 * 1024;
export const EMAIL_MAX_RESPONSE_BYTES: number = 8 * 1024 * 1024;
export const EMAIL_MAX_REPLY_BYTES: number = 5 * 1024 * 1024;
export const EMAIL_MAX_INBOUND_BYTES: number = 10 * 1024 * 1024;
export const EMAIL_MAX_INBOUND_HEADERS: number = 1024;
export const EMAIL_MAX_INBOUND_HEADER_BYTES: number = 128 * 1024;

export type EmailWireAction =
  | { type: 'reject'; reason: string }
  | { type: 'forward'; to: string; headers?: Record<string, string> }
  | { type: 'reply'; from: string; to: string; raw: Uint8Array };

export type EmailReceiptClaims = {
  version: 1;
  receiptId: string;
  projectId: string;
  deploymentId: string;
  recipient: string;
  expiresAt: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function hasStringHeaderValues(
  headers: Record<string, unknown>,
): headers is Record<string, string> {
  return Object.values(headers).every((header) => typeof header === 'string');
}

function assertFlatJson(bytes: Uint8Array, maxDepth: number, maxFields: number): void {
  let depth = 0;
  let fields = 0;
  let quoted = false;
  let escaped = false;
  for (const byte of bytes) {
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (byte === 92) {
        escaped = true;
      } else if (byte === 34) {
        quoted = false;
      }
    } else if (byte === 34) {
      quoted = true;
    } else if (byte === 123 || byte === 91) {
      if (++depth > maxDepth) {
        throw new Error('email metadata too deep');
      }
    } else if (byte === 125 || byte === 93) {
      if (--depth < 0) {
        throw new Error('invalid email metadata');
      }
    } else if (byte === 58 && ++fields > maxFields) {
      throw new Error('too many email metadata fields');
    }
  }
  if (quoted || depth !== 0) {
    throw new Error('invalid email metadata');
  }
}

export type EmailWireEnvelope = {
  from: string;
  to: string;
  headers: Record<string, string>;
  raw: Uint8Array;
  rawSize: number;
  viaDomain?: string;
};

export function encodeEmailEnvelope(envelope: EmailWireEnvelope): Uint8Array {
  const metadata = encoder.encode(
    JSON.stringify({
      from: envelope.from,
      to: envelope.to,
      headers: envelope.headers,
      rawSize: envelope.rawSize,
      ...(envelope.viaDomain ? { viaDomain: envelope.viaDomain } : {}),
    }),
  );
  if (
    metadata.byteLength > EMAIL_MAX_INBOUND_HEADER_BYTES ||
    envelope.raw.byteLength > EMAIL_MAX_INBOUND_BYTES
  ) {
    throw new Error('email envelope too large');
  }
  const bytes = new Uint8Array(4 + metadata.byteLength + envelope.raw.byteLength);
  new DataView(bytes.buffer).setUint32(0, metadata.byteLength);
  bytes.set(metadata, 4);
  bytes.set(envelope.raw, 4 + metadata.byteLength);
  return bytes;
}

export async function readEmailEnvelope(
  stream: ReadableStream<Uint8Array> | null,
  deadlineMs = 15_000,
): Promise<EmailWireEnvelope> {
  if (!stream) {
    throw new Error('missing email envelope');
  }
  const limit = 4 + EMAIL_MAX_INBOUND_HEADER_BYTES + EMAIL_MAX_INBOUND_BYTES;
  const deadline = Date.now() + deadlineMs;
  const { bytes, total } = await withReader(stream, async (reader) => {
    let bytes = new Uint8Array(1024);
    let total = 0;
    for (;;) {
      const chunk = await readBeforeDeadline(reader, deadline, 'email envelope timeout');
      if (chunk.done) {
        return { bytes, total };
      }
      const nextTotal = total + chunk.value.byteLength;
      if (nextTotal > limit) {
        throw new Error('email envelope too large');
      }
      if (nextTotal > bytes.byteLength) {
        let capacity = bytes.byteLength;
        while (capacity < nextTotal) {
          capacity = Math.min(limit, capacity * 2);
        }
        const grown = new Uint8Array(capacity);
        grown.set(bytes.subarray(0, total));
        bytes = grown;
      }
      bytes.set(chunk.value, total);
      total = nextTotal;
    }
  });
  if (total < 4) {
    throw new Error('truncated email envelope');
  }
  const metadataLength = new DataView(bytes.buffer).getUint32(0);
  if (metadataLength > EMAIL_MAX_INBOUND_HEADER_BYTES || total < 4 + metadataLength) {
    throw new Error('invalid email envelope');
  }
  const metadataBytes = bytes.subarray(4, 4 + metadataLength);
  assertFlatJson(metadataBytes, 2, EMAIL_MAX_INBOUND_HEADERS + 8);
  const value: unknown = JSON.parse(decoder.decode(metadataBytes));
  if (!isRecord(value)) {
    throw new Error('invalid email envelope');
  }
  const raw = bytes.subarray(4 + metadataLength, total);
  if (
    raw.byteLength > EMAIL_MAX_INBOUND_BYTES ||
    typeof value.from !== 'string' ||
    value.from.length > 320 ||
    typeof value.to !== 'string' ||
    value.to.length > 320 ||
    typeof value.rawSize !== 'number' ||
    value.rawSize !== raw.byteLength ||
    !isRecord(value.headers) ||
    Object.keys(value.headers).length > EMAIL_MAX_INBOUND_HEADERS ||
    !hasStringHeaderValues(value.headers) ||
    (value.viaDomain !== undefined &&
      (typeof value.viaDomain !== 'string' || value.viaDomain.length > 253))
  ) {
    throw new Error('invalid email envelope');
  }
  return {
    from: value.from,
    to: value.to,
    headers: value.headers,
    raw,
    rawSize: raw.byteLength,
    ...(value.viaDomain ? { viaDomain: value.viaDomain } : {}),
  };
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function unbase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 1024) {
    throw new Error('invalid receipt');
  }
  const binary = atob(
    value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4),
  );
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function receiptKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  if (!secret) {
    throw new Error('Email signing key is not configured');
  }
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

export async function signEmailReceipt(
  claims: EmailReceiptClaims,
  signingSecret: string,
): Promise<string> {
  const payload = encoder.encode(JSON.stringify(claims));
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await receiptKey(signingSecret, 'sign'), payload),
  );
  return `${base64url(payload)}.${base64url(signature)}`;
}

export async function verifyEmailReceipt(
  token: string,
  signingSecret: string,
  expected: Pick<EmailReceiptClaims, 'projectId' | 'deploymentId' | 'recipient'>,
  now: number = Date.now(),
): Promise<EmailReceiptClaims | null> {
  try {
    if (token.length > 1536) {
      return null;
    }
    const parts = token.split('.');
    if (parts.length !== 2) {
      return null;
    }
    const payload = unbase64url(parts[0]);
    const signature = unbase64url(parts[1]);
    if (payload.byteLength > 768 || signature.byteLength !== 32) {
      return null;
    }
    if (
      !(await crypto.subtle.verify(
        'HMAC',
        await receiptKey(signingSecret, 'verify'),
        Uint8Array.from(signature),
        Uint8Array.from(payload),
      ))
    ) {
      return null;
    }
    const value: unknown = JSON.parse(decoder.decode(payload));
    return matchesReceiptClaims(value, expected, now) ? value : null;
  } catch {
    return null;
  }
}

function matchesReceiptClaims(
  value: unknown,
  expected: Pick<EmailReceiptClaims, 'projectId' | 'deploymentId' | 'recipient'>,
  now: number,
): value is EmailReceiptClaims {
  return (
    isRecord(value) &&
    value.version === EMAIL_PROTOCOL_VERSION &&
    typeof value.receiptId === 'string' &&
    /^[a-f0-9-]{16,64}$/.test(value.receiptId) &&
    value.projectId === expected.projectId &&
    value.deploymentId === expected.deploymentId &&
    value.recipient === expected.recipient &&
    typeof value.expiresAt === 'number' &&
    Number.isSafeInteger(value.expiresAt) &&
    !(value.expiresAt < now || value.expiresAt > now + 60_000)
  );
}

function frame(kind: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(5 + payload.byteLength);
  new DataView(bytes.buffer).setUint32(0, payload.byteLength);
  bytes[4] = kind;
  bytes.set(payload, 5);
  return bytes;
}

function encodeEmailActionMetadata(action: EmailWireAction): Uint8Array {
  return encoder.encode(
    JSON.stringify(
      action.type === 'reply' ? { type: action.type, from: action.from, to: action.to } : action,
    ),
  );
}

function emailActionWireSizeFromMetadata(action: EmailWireAction, metadata: Uint8Array): number {
  return 5 + metadata.byteLength + (action.type === 'reply' ? 5 + action.raw.byteLength : 0);
}

export function encodeEmailActions(
  actions: ReadonlyArray<EmailWireAction>,
): ReadableStream<Uint8Array> {
  if (actions.length > EMAIL_MAX_ACTIONS) {
    throw new Error('too many email actions');
  }
  let index = 0;
  let pending: Uint8Array | null = null;
  let total = 0;
  return new ReadableStream({
    pull(controller) {
      if (pending) {
        controller.enqueue(pending);
        pending = null;
        return;
      }
      if (index === actions.length) {
        controller.enqueue(frame(0, new Uint8Array()));
        controller.close();
        return;
      }
      const action = actions[index++];
      const metadata = encodeEmailActionMetadata(action);
      if (metadata.byteLength > EMAIL_MAX_METADATA_BYTES) {
        throw new Error('email action metadata too large');
      }
      if (action.type === 'reply') {
        if (action.raw.byteLength > EMAIL_MAX_REPLY_BYTES) {
          throw new Error('email reply too large');
        }
        pending = frame(2, action.raw);
      }
      total += emailActionWireSizeFromMetadata(action, metadata);
      if (total + 5 > EMAIL_MAX_RESPONSE_BYTES) {
        throw new Error('email actions too large');
      }
      controller.enqueue(frame(1, metadata));
    },
  });
}

/** Read each frame with fixed ceilings before parsing metadata or allocating a reply. */
export async function readEmailActions(
  stream: ReadableStream<Uint8Array>,
  deadlineMs = 15_000,
): Promise<Array<EmailWireAction>> {
  return withReader(stream, async (reader) => {
    const actions: Array<EmailWireAction> = [];
    let stash: Uint8Array = new Uint8Array(0);
    let total = 0;
    const deadline = Date.now() + deadlineMs;
    const readChunk = () => readBeforeDeadline(reader, deadline, 'email response timeout');
    async function exact(length: number): Promise<Uint8Array> {
      const result = new Uint8Array(length);
      let offset = 0;
      while (offset < length) {
        if (stash.byteLength === 0) {
          const chunk = await readChunk();
          if (chunk.done) {
            throw new Error('truncated email response');
          }
          total += chunk.value.byteLength;
          if (total > EMAIL_MAX_RESPONSE_BYTES) {
            throw new Error('email response too large');
          }
          stash = chunk.value;
        }
        const used = Math.min(stash.byteLength, length - offset);
        result.set(stash.subarray(0, used), offset);
        stash = stash.subarray(used);
        offset += used;
      }
      return result;
    }
    for (;;) {
      const head = await exact(5);
      const length = new DataView(head.buffer).getUint32(0);
      const kind = head[4];
      if (kind === 0) {
        if (length !== 0 || stash.byteLength !== 0) {
          throw new Error('invalid email response tail');
        }
        const last = await readChunk();
        if (!last.done) {
          throw new Error('invalid email response tail');
        }
        if (actions.some((action) => action.type === 'reject') && actions.length !== 1) {
          throw new Error('email reject cannot accompany delivery actions');
        }
        return actions;
      }
      if (kind !== 1 || length > EMAIL_MAX_METADATA_BYTES || actions.length >= EMAIL_MAX_ACTIONS) {
        throw new Error('invalid email action frame');
      }
      const metadataBytes = await exact(length);
      assertFlatJson(metadataBytes, 2, 40);
      const action: unknown = JSON.parse(decoder.decode(metadataBytes));
      if (!isRecord(action)) {
        throw new Error('invalid email action');
      }
      if (action.type === 'reply') {
        if (
          typeof action.from !== 'string' ||
          typeof action.to !== 'string' ||
          Object.keys(action).length !== 3
        ) {
          throw new Error('invalid email reply');
        }
        const rawHead = await exact(5);
        const rawLength = new DataView(rawHead.buffer).getUint32(0);
        if (rawHead[4] !== 2 || rawLength > EMAIL_MAX_REPLY_BYTES) {
          throw new Error('invalid email reply frame');
        }
        actions.push({
          type: 'reply',
          from: action.from,
          to: action.to,
          raw: await exact(rawLength),
        });
      } else if (action.type === 'forward') {
        const headers = action.headers;
        if (
          typeof action.to !== 'string' ||
          Object.keys(action).length > 3 ||
          (headers !== undefined && !isRecord(headers))
        ) {
          throw new Error('invalid email forward');
        }
        if (headers && (Object.keys(headers).length > 32 || !hasStringHeaderValues(headers))) {
          throw new Error('invalid email headers');
        }
        actions.push({
          type: 'forward',
          to: action.to,
          ...(headers ? { headers } : {}),
        });
      } else if (action.type === 'reject') {
        if (typeof action.reason !== 'string' || Object.keys(action).length !== 2) {
          throw new Error('invalid email reject');
        }
        actions.push({ type: 'reject', reason: action.reason });
      } else {
        throw new Error('unknown email action');
      }
    }
  });
}

async function readBeforeDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
  timeoutMessage: string,
) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(timeoutMessage);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), remaining);
    }),
  ]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function withReader<T>(
  stream: ReadableStream<Uint8Array>,
  read: (reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<T>,
): Promise<T> {
  const reader = stream.getReader();
  try {
    return await read(reader);
  } catch (error) {
    // Cancellation is cleanup, not part of the protocol deadline. A hostile
    // stream may never settle its underlying cancel algorithm.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A non-standard stream may keep a read pending after cancellation.
    }
  }
}
