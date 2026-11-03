// Managed delivery uses bounded HTTP envelopes and recorded action responses.
// Native Cloudflare email events use the same proxy, then enact its actions on
// the original message before returning.

import {
  EMAIL_MAX_ACTIONS,
  EMAIL_MAX_INBOUND_BYTES,
  EMAIL_MAX_INBOUND_HEADERS,
  EMAIL_MAX_METADATA_BYTES,
  EMAIL_MAX_REPLY_BYTES,
  EMAIL_MAX_RESPONSE_BYTES,
  type EmailWireAction,
} from '@void/platform/email-protocol';
import type { Email as PostalMimeEmail } from 'postal-mime';
import { base64ToBytes } from '../base64.ts';
import { withTimeout } from '../email-protocol.ts';
import { getRawRuntimeEnv } from '../env-raw.ts';
import {
  buildMime,
  MAX_ADDRESS_LENGTH,
  MimeError,
  normalizeEmail,
  validateAddressParts,
} from './mime.ts';
import { fitsHeaderLine, replyReferences, threadingId } from './threading.ts';
import type { Address, Attachment } from './types.ts';

// SDK limits give handlers early errors. The gateway independently validates
// untrusted tenant responses before admitting any action.
const MAX_ACTIONS = EMAIL_MAX_ACTIONS;
const MAX_ACTION_METADATA_BYTES = EMAIL_MAX_METADATA_BYTES;

/** Bounds on a forward's headers. */
const MAX_FORWARD_HEADERS = 32;
const MAX_FORWARD_HEADER_LENGTH = 1024;

/** Maximum normalized SMTP rejection reason length. */
const MAX_REJECT_REASON_LENGTH = 1000;

/** Inbound admission limits also applied by the handler test harness. */
export const MAX_INBOUND_BYTES: number = EMAIL_MAX_INBOUND_BYTES;
export const MAX_INBOUND_HEADERS: number = EMAIL_MAX_INBOUND_HEADERS;

const MAX_REPLY_BYTES = EMAIL_MAX_REPLY_BYTES;
const EMAIL_STREAM_DEADLINE_MS = 15_000;
const EMAIL_ACTION_TERMINAL_BYTES = 5;
const INBOUND_PROVIDER_DEADLINE_MS = 30_000;
const INBOUND_ACTION_BATCH_DEADLINE_MS = 60_000;
const actionEncoder = new TextEncoder();

function emailActionWireSize(action: EmailAction): number {
  const metadata = actionEncoder.encode(
    JSON.stringify(
      action.type === 'reply' ? { type: action.type, from: action.from, to: action.to } : action,
    ),
  );
  return 5 + metadata.byteLength + (action.type === 'reply' ? 5 + action.raw.byteLength : 0);
}

/** The raw env, or `undefined` outside a worker or SSR request. */
export function tryGetRawRuntimeEnv(): Record<string, unknown> | undefined {
  try {
    return getRawRuntimeEnv();
  } catch {
    return undefined;
  }
}

/** A non-empty string env var. */
export function readEnvString(name: string): string | undefined {
  const raw = tryGetRawRuntimeEnv()?.[name];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

// At most 56 characters, so `<slug>+noreply` fits RFC 5321's 64-octet local part.
const VALID_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/;

/** `__VOID_PROJECT_SLUG` when it can head a sender address. */
export function readProjectSlug(): string | undefined {
  const raw = readEnvString('__VOID_PROJECT_SLUG');
  return raw !== undefined && VALID_SLUG.test(raw) ? raw : undefined;
}

// The relay-lane marker `createMessageProxy` sets from `envelope.viaDomain`;
// undefined for platform-lane, own-account and hand-built messages.
function readRelayDomain(message: ForwardableEmailMessage): string | undefined {
  const raw: unknown = (message as { __voidRelayDomain?: unknown }).__voidRelayDomain;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export interface EmailHandlerInfo {
  /**
   * Captured params from dynamic / tagged route segments. For example, a
   * handler at `email/support+[ticket].ts` invoked for `support+abc-123@…`
   * receives `{ ticket: "abc-123" }`. Empty `{}` for static handlers and
   * `_default`.
   */
  params: Record<string, string>;
}

export type EmailHandler = (
  message: ForwardableEmailMessage,
  env: unknown,
  ctx: ExecutionContext,
  info?: EmailHandlerInfo,
) => void | Promise<void>;

/**
 * Identity helper that types the inbound email handler. Use as the default
 * export of `email/<address>.ts` or `email/_default.ts`.
 */
export function defineEmail(handler: EmailHandler): EmailHandler {
  return handler;
}

export type ParsedEmail = PostalMimeEmail;

export type ParseEmailErrorCode = 'INBOUND_TOO_LARGE' | 'PARSE_FAILED';

/**
 * Typed error thrown by `parseEmail`. Lets handler authors distinguish
 * "too big" from "malformed body" without string-matching error messages.
 */
export class ParseEmailError extends Error {
  readonly code: ParseEmailErrorCode;
  constructor(code: ParseEmailErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ParseEmailError';
    this.code = code;
  }
}

/**
 * Parse a `ForwardableEmailMessage` into structured fields with postal-mime,
 * loaded on first use. A native Cloudflare message's `raw` stream is
 * one-shot, so parse it once.
 */
export async function parseEmail(message: ForwardableEmailMessage): Promise<ParsedEmail> {
  if (message.rawSize > MAX_INBOUND_BYTES) {
    throw new ParseEmailError(
      'INBOUND_TOO_LARGE',
      `parseEmail: message size ${message.rawSize} bytes exceeds maximum of ${MAX_INBOUND_BYTES} bytes.`,
    );
  }
  const { default: PostalMime } = await import('postal-mime');
  const cached = proxyRawCache.get(message);
  try {
    // Inside the try: a native one-shot `raw` stream can fail mid-read.
    const source = cached ? await cached.read() : message.raw;
    return await PostalMime.parse(source);
  } catch (cause) {
    throw new ParseEmailError(
      'PARSE_FAILED',
      `parseEmail: could not parse the message body. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/** Replayable raw bytes of proxy messages; native messages are not in the map. */
interface RawCache {
  read(): Promise<Uint8Array>;
}
const proxyRawCache = new WeakMap<ForwardableEmailMessage, RawCache>();

/** Inbound message decoded from the authenticated gateway request. */
export interface EmailEnvelope {
  from: string;
  to: string;
  /** Decoded header metadata. */
  headers: Record<string, string>;
  /**
   * Raw RFC 5322 bytes. The message proxy caches them for repeated reads.
   */
  raw: ReadableStream<Uint8Array> | Uint8Array;
  rawSize: number;
  /**
   * Exact custom domain selected by the gateway. Custom-domain recipients
   * have no project-slug prefix; replies default to the received address.
   */
  viaDomain?: string;
}

/** Handler intents, validated and admitted by the gateway before delivery. */
export type EmailAction = EmailWireAction;

export interface MessageProxy {
  message: ForwardableEmailMessage;
  getActions(): Array<EmailAction>;
}

export interface CreateMessageProxyOptions {
  /**
   * Project slug the platform prefixes recipients with
   * (`<slug>+<tag>@<domain>`). When set, `message.to` drops the `<slug>+`.
   */
  slug?: string;
}

/** Remove a leading `<slug>+` (case-insensitive) from the local part. */
function stripSlugFromAddress(address: string, slug: string | undefined): string {
  if (!slug) {
    return address;
  }
  const atIdx = address.indexOf('@');
  if (atIdx <= 0) {
    return address;
  }
  const localPart = address.slice(0, atIdx);
  const domain = address.slice(atIdx);
  const slugLower = slug.toLowerCase();
  const prefix = `${slugLower}+`;
  if (localPart.toLowerCase().startsWith(prefix)) {
    return localPart.slice(prefix.length) + domain;
  }
  return address;
}

function replyTooLarge(size: number): MimeError {
  return new MimeError(
    'MIME_ERROR',
    `reply: message size ${size} bytes exceeds Void's sending limit of ${MAX_REPLY_BYTES} bytes.`,
  );
}

function replyBudgetExhausted(size: number): MimeError {
  return new MimeError(
    'MIME_ERROR',
    `reply: serialized actions would use ${size} bytes, over this delivery's ` +
      `${EMAIL_MAX_RESPONSE_BYTES}-byte response budget.`,
  );
}

function queueFull(): MimeError {
  return new MimeError(
    'MIME_ERROR',
    `email: handler queued more than ${MAX_ACTIONS} actions for one message.`,
  );
}

function addressTooLong(field: 'from' | 'to', length: number): MimeError {
  return new MimeError(
    field === 'from' ? 'INVALID_FROM' : 'INVALID_TO',
    `${field} address is ${length} characters, over the ${MAX_ADDRESS_LENGTH}-character limit.`,
  );
}

function invalidForwardHeaders(cause: unknown): MimeError {
  // The detail may echo inbound-derived text, so it is bounded.
  const detail = cause instanceof Error ? cause.message.slice(0, 320) : 'not a valid header set';
  return new MimeError('MIME_ERROR', `forward: invalid header — ${detail}`);
}

/**
 * The router's `forwardHeadersWithinBounds`, as a throw: the router drops the
 * whole action list on a violation, so refuse it at the handler's own call.
 * Counts the record as stored (a `Headers` has already folded duplicates).
 */
function assertForwardHeadersWithinBounds(headers: Record<string, string>): void {
  const names = Object.keys(headers);
  if (names.length > MAX_FORWARD_HEADERS) {
    throw new MimeError(
      'MIME_ERROR',
      `forward: ${names.length} headers, over the ${MAX_FORWARD_HEADERS}-header limit.`,
    );
  }
  for (const name of names) {
    if (name.length > MAX_FORWARD_HEADER_LENGTH) {
      throw new MimeError(
        'MIME_ERROR',
        `forward: header name is ${name.length} characters, over the ${MAX_FORWARD_HEADER_LENGTH}-character limit.`,
      );
    }
    // The router refuses a non-string value, which `new Headers()` would
    // have coerced.
    const value: unknown = headers[name];
    if (typeof value !== 'string') {
      throw new MimeError(
        'MIME_ERROR',
        `forward: header "${name.slice(0, 64)}" value is not a string.`,
      );
    }
    if (value.length > MAX_FORWARD_HEADER_LENGTH) {
      throw new MimeError(
        'MIME_ERROR',
        `forward: header "${name.slice(0, 64)}" value is ${value.length} characters, over the ${MAX_FORWARD_HEADER_LENGTH}-character limit.`,
      );
    }
  }
}

/**
 * The router's reject-reason rule, applied at record time so native replay
 * sends the same string. Normalized rather than refused, since a throw would
 * drop the reject; slice before replace to bound the work.
 */
function normalizeRejectReason(reason: string): string {
  // A JS handler can pass anything; the router treats a non-string as empty.
  const raw = typeof reason === 'string' ? reason : '';
  if (raw.length === 0) {
    return 'rejected by handler';
  }
  return (
    raw
      .slice(0, MAX_REJECT_REASON_LENGTH)
      // eslint-disable-next-line no-control-regex -- C0 controls and DEL are the point
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
  );
}

async function readStreamToBytes(
  stream: ReadableStream<Uint8Array>,
  limit = Infinity,
  // Names the limit that was crossed: one reply's cap or the shared budget.
  onOverflow: (total: number) => MimeError = replyTooLarge,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  const deadline = Date.now() + EMAIL_STREAM_DEADLINE_MS;
  try {
    for (;;) {
      const { value, done } = await withTimeout(
        deadline - Date.now(),
        () => reader.read(),
        () => new MimeError('MIME_ERROR', 'email stream timed out'),
      );
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        throw onOverflow(total);
      }
      chunks.push(value);
    }
  } catch (error) {
    // Do not await cancel: a custom handler stream may never settle it.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Build the message a handler sees from an envelope. `setReject`, `forward`
 * and `reply` record `EmailAction`s instead of dispatching; the caller enacts
 * them after the handler returns. `reply()` takes `{ from, to, raw }`, which
 * `replyEmail()` passes: a native `EmailMessage` has no readable body.
 */
export function createMessageProxy(
  envelope: EmailEnvelope,
  opts: CreateMessageProxyOptions = {},
): MessageProxy {
  const actions: Array<EmailAction> = [];
  const headers = new Headers(envelope.headers);

  // A relayed recipient (on `viaDomain`) carries no `<slug>+` prefix, so a
  // coincidental one on a customer address is never stripped.
  const slug =
    envelope.viaDomain === undefined || envelope.viaDomain === '' ? opts.slug : undefined;

  const userVisibleTo = stripSlugFromAddress(envelope.to, slug);

  // Buffer `raw` once so it can be read repeatedly.
  let cachedRaw: Uint8Array | undefined;
  let bufferingPromise: Promise<Uint8Array> | undefined;
  function readRawOnce(): Promise<Uint8Array> {
    if (cachedRaw) {
      return Promise.resolve(cachedRaw);
    }
    if (bufferingPromise) {
      return bufferingPromise;
    }
    const source = envelope.raw;
    if (source instanceof Uint8Array) {
      cachedRaw = source;
      return Promise.resolve(cachedRaw);
    }
    bufferingPromise = readStreamToBytes(source).then((bytes) => {
      cachedRaw = bytes;
      return bytes;
    });
    return bufferingPromise;
  }

  if (envelope.raw instanceof Uint8Array) {
    cachedRaw = envelope.raw;
  }

  let rejected = false;
  // The gateway counts every metadata/raw frame and the terminal frame, so
  // reserve that terminal here and reject an action before recording it.
  let actionWireBytesUsed = EMAIL_ACTION_TERMINAL_BYTES;
  let pendingReplies = 0;
  let replyRecordingTail: Promise<void> = Promise.resolve();

  function recordAction(action: EmailAction): boolean {
    if (rejected) {
      return false;
    }
    if (actions.length >= MAX_ACTIONS) {
      throw queueFull();
    }
    const nextSize = actionWireBytesUsed + emailActionWireSize(action);
    if (nextSize > EMAIL_MAX_RESPONSE_BYTES) {
      throw replyBudgetExhausted(nextSize);
    }
    actions.push(action);
    actionWireBytesUsed = nextSize;
    return true;
  }

  // `actions` only grows through forward/reply, and `setReject` purges both,
  // so its length is the queue depth.
  function assertQueueHasRoom(): void {
    if (actions.length + pendingReplies >= MAX_ACTIONS) {
      throw queueFull();
    }
  }

  const message = {
    from: envelope.from,
    to: userVisibleTo,
    headers,
    // A fresh stream per access, backed by the buffered bytes.
    get raw(): ReadableStream<Uint8Array> {
      if (cachedRaw) {
        return bytesToReadableStream(cachedRaw);
      }
      const pending = readRawOnce();
      return new ReadableStream({
        async start(controller) {
          const bytes = await pending;
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    rawSize: envelope.rawSize,
    setReject(reason: string) {
      if (rejected) {
        return;
      }
      rejected = true;
      // Reject is terminal and replaces queued deliveries, so it must remain
      // available even when the action queue is full.
      let dropped = 0;
      for (let i = actions.length - 1; i >= 0; i--) {
        const a = actions[i];
        if (a.type === 'forward' || a.type === 'reply') {
          actions.splice(i, 1);
          dropped++;
        }
      }
      if (dropped > 0) {
        console.warn(
          `[void/email] setReject() after ${dropped} forward/reply call(s) — those actions were dropped. ` +
            'CF rejects are terminal: anything queued before setReject() never runs. ' +
            'Move the reject earlier in the handler.',
        );
      }
      const action = { type: 'reject' as const, reason: normalizeRejectReason(reason) };
      actions.push(action);
      actionWireBytesUsed = EMAIL_ACTION_TERMINAL_BYTES + emailActionWireSize(action);
    },
    async forward(to: string, fwdHeaders?: Headers | Record<string, string>) {
      if (rejected) {
        console.warn(
          '[void/email] forward() called after setReject() — ignored. ' +
            'CF rejects are terminal: nothing else runs once setReject fires.',
        );
        return;
      }
      assertQueueHasRoom();
      if (to.length > MAX_ADDRESS_LENGTH) {
        throw addressTooLong('to', to.length);
      }
      validateAddressParts('to', to);
      // `Headers` lowercases names; a plain record keeps the caller's casing.
      let headersObj: Record<string, string> | undefined;
      if (fwdHeaders instanceof Headers) {
        headersObj = Object.fromEntries(fwdHeaders.entries());
      } else if (fwdHeaders) {
        // Validate now so native replay cannot fail after earlier actions fired.
        try {
          void new Headers(fwdHeaders);
        } catch (e) {
          throw invalidForwardHeaders(e);
        }
        headersObj = { ...fwdHeaders };
      }
      if (headersObj) {
        assertForwardHeadersWithinBounds(headersObj);
      }
      const action = {
        type: 'forward' as const,
        to,
        ...(headersObj ? { headers: headersObj } : {}),
      };
      if (new TextEncoder().encode(JSON.stringify(action)).byteLength > MAX_ACTION_METADATA_BYTES) {
        throw new MimeError(
          'MIME_ERROR',
          `forward: action metadata exceeds ${MAX_ACTION_METADATA_BYTES} bytes.`,
        );
      }
      void recordAction(action);
    },
    async reply(reply: { from: string; to: string; raw: ReadableStream<Uint8Array> | Uint8Array }) {
      if (rejected) {
        console.warn(
          '[void/email] reply() called after setReject() — ignored. ' +
            'CF rejects are terminal: nothing else runs once setReject fires.',
        );
        return;
      }
      // Everything cheap first, so a doomed reply never buffers its stream.
      assertQueueHasRoom();
      if (reply.from.length > MAX_ADDRESS_LENGTH) {
        throw addressTooLong('from', reply.from.length);
      }
      if (reply.to.length > MAX_ADDRESS_LENGTH) {
        throw addressTooLong('to', reply.to.length);
      }
      // A hand-built `{ from, to, raw }` bypasses `normalizeEmail`.
      validateAddressParts('from', reply.from);
      validateAddressParts('to', reply.to);
      pendingReplies++;
      const previousReply = replyRecordingTail;
      let releaseReply!: () => void;
      replyRecordingTail = new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
      await previousReply;
      try {
        if (rejected) {
          console.warn(
            '[void/email] reply() completed after setReject() — ignored. ' +
              'CF rejects are terminal: nothing else runs once setReject fires.',
          );
          return;
        }
        // A hand-built reply is not bounded by `buildMime`.
        const metadataOnlyAction = {
          type: 'reply' as const,
          from: reply.from,
          to: reply.to,
          raw: new Uint8Array(),
        };
        const replyFrameBytes = emailActionWireSize(metadataOnlyAction);
        const remaining = EMAIL_MAX_RESPONSE_BYTES - actionWireBytesUsed - replyFrameBytes;
        if (remaining < 0) {
          throw replyBudgetExhausted(EMAIL_MAX_RESPONSE_BYTES - remaining);
        }
        let rawBytes: Uint8Array;
        if (reply.raw instanceof Uint8Array) {
          if (reply.raw.byteLength > MAX_REPLY_BYTES) {
            throw replyTooLarge(reply.raw.byteLength);
          }
          if (reply.raw.byteLength > remaining) {
            throw replyBudgetExhausted(
              actionWireBytesUsed + replyFrameBytes + reply.raw.byteLength,
            );
          }
          rawBytes = reply.raw;
        } else {
          // A native `EmailMessage` has no `raw`: name that rather than fail
          // with a generic handler error.
          const raw: unknown = reply.raw;
          if (
            typeof raw !== 'object' ||
            raw === null ||
            typeof (raw as ReadableStream<Uint8Array>).getReader !== 'function'
          ) {
            throw new MimeError(
              'MIME_ERROR',
              'reply: expected { from, to, raw } with raw as a Uint8Array or ReadableStream. ' +
                'A native EmailMessage cannot be replayed from a Void handler — its body has ' +
                'no public accessor. Use replyEmail() from void/email, or pass the MIME bytes as raw.',
            );
          }
          // Stop at the lower of the per-reply cap and the remaining budget,
          // and name that one.
          const limit = Math.min(MAX_REPLY_BYTES, remaining);
          rawBytes = await readStreamToBytes(reply.raw, limit, (total) =>
            limit === MAX_REPLY_BYTES
              ? replyTooLarge(total)
              : replyBudgetExhausted(actionWireBytesUsed + replyFrameBytes + total),
          );
        }
        if (!recordAction({ type: 'reply', from: reply.from, to: reply.to, raw: rawBytes })) {
          console.warn(
            '[void/email] reply() completed after setReject() — ignored. ' +
              'CF rejects are terminal: nothing else runs once setReject fires.',
          );
        }
      } finally {
        pendingReplies--;
        releaseReply();
      }
    },
  } as unknown as ForwardableEmailMessage;

  // The wire-form recipient, for diagnostics; non-enumerable so it never
  // serializes.
  if (envelope.to !== userVisibleTo) {
    Object.defineProperty(message, '__voidPlatformTo', {
      value: envelope.to,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  // Relay-lane marker: `buildReplyMessage` then defaults `from` to the
  // receiving address on the customer domain.
  if (typeof envelope.viaDomain === 'string' && envelope.viaDomain.length > 0) {
    Object.defineProperty(message, '__voidRelayDomain', {
      value: envelope.viaDomain,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  proxyRawCache.set(message, { read: readRawOnce });

  return { message, getActions: () => [...actions] };
}

export interface ReplyEmailOptions {
  /**
   * On the managed platform (a `__VOID_PROJECT_SLUG` is injected) defaults
   * to `<__VOID_PROJECT_SLUG>+noreply@<__VOID_EMAIL_DOMAIN>`, and THROWS
   * when the domain binding is absent — a reply sender is never guessed.
   *
   * There, an override must stay on your own slug. The platform accepts a
   * reply sender whose local-part before the first `+` equals the slug the
   * message was delivered to; anything else is dropped silently. In
   * particular `message.to` is the STRIPPED address (`<tag>@<domain>`), so
   * passing it here is exactly the shape the platform rejects.
   *
   * Without a slug (your own Cloudflare account, local harnesses) the
   * default is the address the message was delivered to, `message.to` —
   * a real address on your own zone.
   */
  from?: Address;
  /**
   * Defaults to the original `message.from` envelope address. A reply is a
   * single-recipient message — for fan-out, build a fresh `sendEmail()` call.
   */
  to?: Address;
  /**
   * Defaults to `Re: <original-subject>` (no double-prefix). The original is
   * remote-sender controlled, so the default is best-effort: control
   * characters become a space, and a subject over 4096 characters, or an
   * ASCII one too long to fold, falls back to a bare `Re:`. Pass `subject`
   * to control it exactly.
   */
  subject?: string;
  text?: string;
  html?: string;
  /**
   * Custom headers; threading headers (`In-Reply-To`, `References`) are
   * added automatically, best-effort: an inbound id too long for a header
   * line is dropped, and a `References` chain over 8 KiB keeps only its
   * newest ids.
   */
  headers?: Record<string, string>;
  attachments?: Array<Attachment>;
}

/**
 * Longest decoded inbound subject the default reply subject is built from;
 * longer falls back to a bare `Re:`. Real subjects are far shorter, and the
 * bound keeps the control-character replacement cheap.
 */
const MAX_REPLY_SUBJECT_CHARS = 4096;

function prefixReplySubject(original: string): string {
  // Decode first so an encoded `Re:` is detected and the result is encoded
  // once. The subject is remote-controlled and a throw here would reject the
  // whole delivery, so it is best-effort: controls become a space, and an
  // empty, over-long or unfoldable ASCII subject becomes a bare `Re:`. The
  // decoded length is checked before any replace.
  const decoded = decodeRfc2047(original);
  if (decoded.length > MAX_REPLY_SUBJECT_CHARS) {
    return 'Re:';
  }
  const cleaned = decoded
    // eslint-disable-next-line no-control-regex -- C0 controls and DEL are the point
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (!cleaned) {
    return 'Re:';
  }
  const prefixed = /^re:/i.test(cleaned) ? cleaned : `Re: ${cleaned}`;
  // Non-ASCII goes through `encodeWord`, whose words always fold.
  if (/^[\x20-\x7e]*$/.test(prefixed) && !fitsHeaderLine('Subject', prefixed)) {
    return 'Re:';
  }
  return prefixed;
}

/**
 * Minimal RFC 2047 decoder for the reply subject: B and Q encoded-words,
 * unknown charsets read as UTF-8, malformed input returned unchanged.
 */
function decodeRfc2047(value: string): string {
  if (!value.includes('=?')) {
    return value;
  }
  try {
    // `matchAll`, not `replace` with a callback: replace collects every match
    // first, which a subject of tiny encoded-words turns into a heap blowup.
    const parts: Array<string> = [];
    let last = 0;
    for (const m of value.matchAll(/=\?([\w-]+)\?([BbQq])\?([^?]*)\?=(?:\s+(?==\?))?/g)) {
      const [match, charset, enc, payload] = m;
      const bytes =
        enc.toUpperCase() === 'B' ? base64ToBytes(payload) : quotedPrintableDecode(payload);
      // Honor the declared charset; fall back to UTF-8 for a label
      // TextDecoder rejects.
      let decoder: TextDecoder;
      try {
        decoder = new TextDecoder(charset || 'utf-8', { fatal: false });
      } catch {
        decoder = new TextDecoder('utf-8', { fatal: false });
      }
      parts.push(value.slice(last, m.index), decoder.decode(bytes));
      last = m.index + match.length;
    }
    parts.push(value.slice(last));
    return parts.join('');
  } catch {
    return value;
  }
}

function quotedPrintableDecode(qp: string): Uint8Array {
  // RFC 2047 Q-encoding: `_` is a space, `=XX` a hex byte. Each input
  // character yields at most one byte, so a typed array of `qp.length` fits.
  const out = new Uint8Array(qp.length);
  let kept = 0;
  for (let i = 0; i < qp.length; i++) {
    const ch = qp.charCodeAt(i);
    if (ch === 0x5f /* _ */) {
      out[kept++] = 0x20;
    } else if (ch === 0x3d /* = */ && i + 2 < qp.length) {
      // Both must be hex (`parseInt('0G', 16)` is 0); a malformed escape
      // stays literal.
      const hex = qp.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out[kept++] = parseInt(hex, 16);
        i += 2;
      } else {
        out[kept++] = ch;
      }
    } else {
      out[kept++] = ch;
    }
  }
  return out.subarray(0, kept);
}

/**
 * Build the reply MIME for `replyEmail`: `Re:` subject and best-effort
 * `In-Reply-To` / `References` threading from the inbound message.
 */
export async function buildReplyMessage(
  message: ForwardableEmailMessage,
  opts: ReplyEmailOptions,
): Promise<{ from: string; to: string; raw: Uint8Array; subject: string }> {
  const headers = message.headers;
  const originalSubject = headers.get('Subject') ?? '';
  const originalMessageId = headers.get('Message-ID') ?? '';
  const originalReferences = headers.get('References') ?? '';

  // Default `from`: the receiving address on your own zone or a relayed
  // custom domain; `<slug>+noreply@<domain>` on the platform's shared sender,
  // which pins replies to the slug. A domain is never guessed.
  let fromAddr: Address;
  if (opts.from !== undefined) {
    fromAddr = opts.from;
  } else if (readRelayDomain(message) !== undefined) {
    fromAddr = message.to;
  } else {
    const slug = readProjectSlug();
    if (slug) {
      const domain = readEnvString('__VOID_EMAIL_DOMAIN');
      if (!domain) {
        throw new Error(
          "replyEmail: 'from' is required when __VOID_PROJECT_SLUG is set " +
            'but __VOID_EMAIL_DOMAIN is not. Set `from` explicitly, or deploy ' +
            'via Void so the platform-injected __VOID_PROJECT_SLUG and ' +
            '__VOID_EMAIL_DOMAIN can default it to <slug>+noreply@<domain>.',
        );
      }
      fromAddr = `${slug}+noreply@${domain}`;
    } else if (readEnvString('__VOID_PROJECT_SLUG') !== undefined) {
      // A platform slug too long for `<slug>+noreply@`: `message.to` would
      // build a sender the platform drops without telling the handler.
      throw new Error(
        "replyEmail: 'from' is required — this project's slug cannot build a " +
          'default reply sender (`<slug>+noreply@<domain>` must stay within the ' +
          '64-octet local part, so the slug must be at most 56 characters). ' +
          'Set `from` explicitly.',
      );
    } else {
      fromAddr = message.to;
    }
  }
  const toAddr: Address = opts.to ?? message.from;
  const subject = opts.subject ?? prefixReplySubject(originalSubject);

  // Threading rides `threading`, since `headers` reserve these names. Both
  // ids are remote-controlled: drop one that cannot fit a line or holds a
  // control character rather than fail the reply.
  const threading: { inReplyTo?: string; references?: string } = {};
  const messageId = threadingId('In-Reply-To', originalMessageId);
  if (messageId) {
    threading.inReplyTo = messageId;
  }
  const references = replyReferences(originalReferences, messageId);
  if (references) {
    threading.references = references;
  }

  const normalized = await normalizeEmail({
    from: fromAddr,
    to: toAddr,
    subject,
    text: opts.text,
    html: opts.html,
    headers: opts.headers,
    attachments: opts.attachments,
    threading: threading.inReplyTo || threading.references ? threading : undefined,
  });
  const { raw } = buildMime(normalized);
  return {
    from: normalized.from.email,
    to: normalized.to[0].email,
    raw,
    subject,
  };
}

/**
 * Send a threading-aware reply to an inbound message. Builds the reply MIME
 * (correct `In-Reply-To` / `References` / `Subject: Re: …`) and records a
 * reply intent on the message proxy. Delivery follows handler completion and,
 * on the platform, authoritative admission.
 *
 * The threading headers are best-effort, since the inbound values they are
 * built from are remote-sender controlled: an id no header line can carry
 * is dropped, and a `References` chain over 8 KiB keeps only its newest
 * ids. The reply is sent either way.
 */
export async function replyEmail(
  message: ForwardableEmailMessage,
  opts: ReplyEmailOptions,
): Promise<void> {
  const { from, to, raw } = await buildReplyMessage(message, opts);
  await (
    message as unknown as {
      reply(arg: { from: string; to: string; raw: Uint8Array }): Promise<void>;
    }
  ).reply({ from, to, raw });
}

/**
 * Recognize native email operations. This structural check is not an
 * authentication boundary; managed entrypoints require receipt authentication.
 */
export function isForwardableEmailMessage(value: unknown): value is ForwardableEmailMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const m = value as { setReject?: unknown; forward?: unknown; reply?: unknown };
  return (
    typeof m.setReject === 'function' &&
    typeof m.forward === 'function' &&
    typeof m.reply === 'function'
  );
}

/**
 * Replay recorded actions on a native message, in order. The proxy already
 * made `setReject` terminal and validated the rest. `reply` needs a real
 * `EmailMessage`, so `cloudflare:email` loads only when one was recorded.
 */
export async function enactEmailActions(
  message: ForwardableEmailMessage,
  actions: ReadonlyArray<EmailAction>,
): Promise<void> {
  const deadline = Date.now() + INBOUND_ACTION_BATCH_DEADLINE_MS;
  const submit = async (run: () => Promise<unknown>): Promise<unknown> => {
    const remaining = Math.min(INBOUND_PROVIDER_DEADLINE_MS, deadline - Date.now());
    if (remaining <= 0) {
      throw new Error('email action batch deadline elapsed before provider submission');
    }
    return withTimeout(
      remaining,
      run,
      () =>
        new Error('email action provider timed out; outcome unknown, do not retry automatically'),
    );
  };
  for (const action of actions) {
    switch (action.type) {
      case 'reject':
        message.setReject(action.reason);
        break;
      case 'forward':
        await submit(() =>
          message.forward(action.to, action.headers ? new Headers(action.headers) : undefined),
        );
        break;
      case 'reply': {
        const { EmailMessage } = await import('cloudflare:email');
        await submit(() =>
          message.reply(
            new EmailMessage(action.from, action.to, bytesToReadableStream(action.raw)),
          ),
        );
        break;
      }
    }
  }
}
