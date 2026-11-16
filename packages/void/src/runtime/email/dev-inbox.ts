/**
 * In-memory email capture for `void dev` and tests. The inbox buffer lives in
 * the Vite dev server's Node process; `sendEmail` runs in workerd, a separate
 * process, so it POSTs each capture to {@link DEV_INBOX_CAPTURE_URL} over the
 * dev assets binding. The sink registry serves only sends in the same
 * isolate, such as `createEmailTestHarness`.
 */

import { base64ToBytes, bytesToBase64 } from '../../shared/base64.ts';
import { MAX_MESSAGE_BYTES, newId } from './mime.ts';
import type { NormalizedEmail, NormalizedAttachment } from './types.ts';

export interface CapturedMessage {
  id: string;
  capturedAt: number;
  raw: Uint8Array;
  messageId: string;
  from: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  cc: Array<{ email: string; name?: string }>;
  bcc: Array<{ email: string; name?: string }>;
  replyTo?: { email: string; name?: string };
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
    contentId?: string;
    disposition: 'attachment' | 'inline';
  }>;
}

export type EmailSink = (message: CapturedMessage) => void;

// ---------------------------------------------------------------------------
// Cross-process capture protocol (workerd -> Vite dev server)
// ---------------------------------------------------------------------------

/** Mount point of the dev inbox on the Vite dev server. */
export const DEV_INBOX_PREFIX: string = '/__void/inbox';
/** Capture endpoint, relative to {@link DEV_INBOX_PREFIX} (connect strips the mount). */
export const DEV_INBOX_CAPTURE_PATH: string = '/_capture';
/** Absolute path the worker POSTs a captured message to. */
export const DEV_INBOX_CAPTURE_URL: string = `${DEV_INBOX_PREFIX}${DEV_INBOX_CAPTURE_PATH}`;

/**
 * Serve-only var naming the binding that loops back to the Vite dev server.
 * Its presence is the dev gate (`shouldInjectEmailDevInboxVar` in index.ts).
 */
export const DEV_INBOX_ENV_VAR: string = '__VOID_EMAIL_DEV_INBOX';

/**
 * Serve-only var carrying the dev-trigger token for the capture POST: the
 * router's token const is not importable from `void/email`.
 */
export const DEV_INBOX_TOKEN_ENV_VAR: string = '__VOID_EMAIL_DEV_INBOX_TOKEN';

/**
 * Every inbox route requires the dev-trigger token, as this header or, for
 * browser links, this query parameter.
 */
export const DEV_INBOX_TOKEN_HEADER: string = 'x-void-dev-trigger';
export const DEV_INBOX_TOKEN_QUERY: string = 'token';

/**
 * Marks a capture response: over the assets binding, a plain 200 could also
 * be a static asset.
 */
export const DEV_INBOX_ACK_HEADER: string = 'x-void-email-inbox';
export const DEV_INBOX_ACK_VALUE: string = 'captured';

/**
 * Capture body cap. 6x covers the base64 MIME plus the JSON copy of every
 * rendered caller string for a max-size message. Strings with no MIME
 * footprint (a bcc name, a reserved header, folded-away whitespace) are not
 * bounded by it, so a message padded with them is still refused.
 */
export const DEV_INBOX_MAX_CAPTURE_BYTES: number = 6 * MAX_MESSAGE_BYTES;

/** Encode a captured message for the worker -> dev-server hop (`raw` as base64). */
export function serializeCapturedMessage(message: CapturedMessage): string {
  return JSON.stringify({ ...message, raw: bytesToBase64(message.raw) });
}

function asAddress(value: unknown): { email: string; name?: string } | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as { email?: unknown; name?: unknown };
  if (typeof v.email !== 'string') {
    return undefined;
  }
  return typeof v.name === 'string' ? { email: v.email, name: v.name } : { email: v.email };
}

function asAddressList(value: unknown): Array<{ email: string; name?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: Array<{ email: string; name?: string }> = [];
  for (const entry of value) {
    const address = asAddress(entry);
    if (!address) {
      return undefined;
    }
    out.push(address);
  }
  return out;
}

/**
 * Decode a capture payload. Returns `undefined` for anything malformed — the
 * endpoint is reachable from the dev server's own origin, so it must reject
 * junk rather than throw inside the middleware.
 */
export function parseCapturedMessage(value: unknown): CapturedMessage | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || typeof v.raw !== 'string') {
    return undefined;
  }
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(v.raw);
  } catch {
    return undefined;
  }
  const from = asAddress(v.from);
  const to = asAddressList(v.to);
  const cc = asAddressList(v.cc);
  const bcc = asAddressList(v.bcc);
  if (!from || !to || !cc || !bcc) {
    return undefined;
  }
  const attachments: CapturedMessage['attachments'] = [];
  if (!Array.isArray(v.attachments)) {
    return undefined;
  }
  for (const entry of v.attachments) {
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const a = entry as Record<string, unknown>;
    attachments.push({
      filename: typeof a.filename === 'string' ? a.filename : '',
      contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
      size: typeof a.size === 'number' ? a.size : 0,
      ...(typeof a.contentId === 'string' && { contentId: a.contentId }),
      disposition: a.disposition === 'inline' ? 'inline' : 'attachment',
    });
  }
  const headers: Record<string, string> = {};
  if (typeof v.headers === 'object' && v.headers !== null) {
    for (const [k, hv] of Object.entries(v.headers as Record<string, unknown>)) {
      if (typeof hv === 'string') {
        headers[k] = hv;
      }
    }
  }
  const replyTo = asAddress(v.replyTo);
  return {
    id: v.id,
    capturedAt: typeof v.capturedAt === 'number' ? v.capturedAt : Date.now(),
    raw,
    messageId: typeof v.messageId === 'string' ? v.messageId : '',
    from,
    to,
    cc,
    bcc,
    ...(replyTo && { replyTo }),
    subject: typeof v.subject === 'string' ? v.subject : '',
    ...(typeof v.text === 'string' && { text: v.text }),
    ...(typeof v.html === 'string' && { html: v.html }),
    headers,
    attachments,
  };
}

const SINK_KEY = '__voidEmailSinks__';
const BUFFER_KEY = '__voidEmailDevBuffer__';
const DEFAULT_BUFFER_LIMIT = 100;

/** Retained-byte budget: 100 messages of up to 5 MiB each would fill the dev server's heap. */
const DEFAULT_BUFFER_BYTES = 64 * 1024 * 1024;

interface DevBuffer {
  /** Running total of {@link messageBytes} over `items`. */
  bytes: number;
  items: Array<CapturedMessage>;
}

interface SinkRegistry {
  sinks: Set<EmailSink>;
}

// Shared across module instances in the dev server's isolate.
const inboxGlobal = globalThis as typeof globalThis & {
  [SINK_KEY]?: SinkRegistry;
  [BUFFER_KEY]?: DevBuffer;
};

function registry(): SinkRegistry {
  let r = inboxGlobal[SINK_KEY];
  if (!r) {
    r = { sinks: new Set() };
    inboxGlobal[SINK_KEY] = r;
  }
  return r;
}

export function registerEmailSink(sink: EmailSink): () => void {
  const r = registry();
  r.sinks.add(sink);
  return () => r.sinks.delete(sink);
}

export function dispatchToSinks(message: CapturedMessage): void {
  for (const sink of registry().sinks) {
    try {
      sink(message);
    } catch (err) {
      // Sinks are best-effort observers — never let one break send, but
      // surface the error so a misbehaving sink is noticed.
      console.warn('[email-dev-inbox] sink error:', err);
    }
  }
}

export function hasActiveSink(): boolean {
  return registry().sinks.size > 0;
}

/** Get or create the shared dev-server ring buffer. */
function getDevBuffer(): DevBuffer {
  let b = inboxGlobal[BUFFER_KEY];
  if (!b) {
    b = { bytes: 0, items: [] };
    inboxGlobal[BUFFER_KEY] = b;
  }
  return b;
}

/** What a retained message costs: the raw MIME plus both decoded bodies. */
function messageBytes(message: CapturedMessage): number {
  return message.raw.byteLength + (message.text?.length ?? 0) + (message.html?.length ?? 0);
}

export function pushToDevBuffer(message: CapturedMessage): void {
  const b = getDevBuffer();
  b.items.push(message);
  b.bytes += messageBytes(message);
  // Oldest-first on either bound. The `items.length > 1` guard keeps the
  // newest message even when it alone blows the budget: a send the developer
  // just made must always be visible in the inbox.
  while (
    b.items.length > DEFAULT_BUFFER_LIMIT ||
    (b.bytes > DEFAULT_BUFFER_BYTES && b.items.length > 1)
  ) {
    const evicted = b.items.shift();
    if (evicted) {
      b.bytes -= messageBytes(evicted);
    }
  }
}

export function listDevMessages(): Array<CapturedMessage> {
  return [...getDevBuffer().items].reverse();
}

export function findDevMessage(id: string): CapturedMessage | undefined {
  return getDevBuffer().items.find((m) => m.id === id);
}

export function clearDevBuffer(): void {
  const b = getDevBuffer();
  b.items.length = 0;
  // Without this the counter goes stale and the buffer silently collapses to a
  // single item on every later push.
  b.bytes = 0;
}

export function captureMessage(
  email: NormalizedEmail,
  raw: Uint8Array,
  messageId: string,
): CapturedMessage {
  return {
    id: newId('dev'),
    capturedAt: Date.now(),
    raw,
    messageId,
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    replyTo: email.replyTo,
    subject: email.subject,
    text: email.text,
    html: email.html,
    headers: { ...email.headers },
    attachments: email.attachments.map((a: NormalizedAttachment) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.bytes.byteLength,
      contentId: a.contentId,
      disposition: a.disposition,
    })),
  };
}
