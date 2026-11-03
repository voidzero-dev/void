/**
 * Public types for the void/email module.
 *
 * The runtime entrypoint (../email.ts) re-exports these so that consumers
 * can import them via `import type { SendEmailOptions } from "void/email"`.
 */

export type Address = string | { email: string; name?: string };

export interface Attachment {
  filename: string;
  content: string | Uint8Array | ArrayBuffer | Blob;
  contentType?: string;
  contentId?: string;
  disposition?: 'attachment' | 'inline';
}

export interface SendEmailOptions {
  /**
   * Sender envelope address. Optional. When omitted, `void dev` and
   * `void deploy --platform cloudflare` use `email.from` from void.config.ts,
   * and a Void platform deploy uses `<project-slug>+noreply@<mail-domain>`.
   * Without either, `sendEmail` returns `INVALID_FROM`; it never falls back
   * to a baked-in domain.
   */
  from?: Address;
  to: Address | Array<Address>;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: Address;
  cc?: Address | Array<Address>;
  bcc?: Address | Array<Address>;
  /** Custom headers. Reserved names such as `From`, `Date` and the threading headers are ignored. */
  headers?: Record<string, string>;
  attachments?: Array<Attachment>;
  /**
   * Threads this email under an earlier message, such as a reply sent from a
   * queue job after the inbound handler returned. `inReplyTo` is the parent's
   * `Message-ID`. `references` lists the thread's ids, oldest first, ending
   * with the parent; it defaults to `inReplyTo`. An id that cannot be sent,
   * such as one with a control character, is left out. If `references`
   * cannot be sent, it falls back to `inReplyTo`. The email still sends.
   */
  threading?: {
    inReplyTo?: string;
    references?: string;
  };
  /**
   * Deduplicates a platform send for 30 days. Reuse the same key and message
   * when checking an uncertain attempt; a changed message is a conflict.
   * Native Cloudflare bindings do not provide this guarantee.
   */
  idempotencyKey?: string;
  /**
   * @deprecated During `void dev` it skips the local inbox, and the send
   * returns `BINDING_MISSING`, so it never delivers there. While a
   * `createEmailTestHarness` sink is active, it skips the sink, and the send
   * uses the `SEND_EMAIL` binding or the platform proxy of the current
   * environment. A deployed app ignores it. Remove it, and deploy the app to
   * test real delivery. Removed in the next major version.
   */
  sendInDev?: boolean;
}

export type SendEmailErrorCode =
  | 'BINDING_MISSING'
  | 'INVALID_FROM'
  | 'INVALID_TO'
  | 'UNVERIFIED_DESTINATION'
  | 'MIME_ERROR'
  | 'QUOTA_EXCEEDED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'OUTCOME_UNKNOWN'
  | 'UPSTREAM_ERROR';

export interface SendEmailError {
  code: SendEmailErrorCode;
  message: string;
  cause?: unknown;
}

/**
 * One successful CF envelope send. The `to`/`cc`/`bcc` fan-out produces one
 * of these per recipient, since the CF `EmailMessage` envelope is
 * single-recipient.
 */
export interface SendEmailDelivery {
  recipient: string;
  messageId: string;
  state?: 'provider_accepted';
}

export type EmailDeliveryState =
  | 'rejected'
  | 'reserved'
  | 'attempt_started'
  | 'provider_accepted'
  | 'failed'
  | 'outcome_unknown'
  | 'cancelled';

/**
 * Per-recipient outcome for a multi-recipient send. `ok: true` carries the
 * CF-issued messageId; `ok: false` carries the error for that specific
 * recipient (e.g. one address is unverified while others succeed).
 */
export type SendEmailRecipientResult =
  | { recipient: string; ok: true; messageId: string; state?: 'provider_accepted' }
  | { recipient: string; ok: false; error: SendEmailError; state?: EmailDeliveryState };

/**
 * Result of `sendEmail`.
 *
 * Three discriminated cases — narrow with `result.ok`, then check whether
 * `'error' in result` (pre-flight failure, no sends attempted) or
 * `'deliveries' in result` (per-recipient failure, some may have succeeded):
 *
 * - `{ ok: true, ids }`            — every envelope succeeded.
 * - `{ ok: false, error }`         — validation or transport failure. An
 *                                     OUTCOME_UNKNOWN may have been submitted;
 *                                     never retry it with a new idempotency key.
 * - `{ ok: false, deliveries }`    — sends were attempted; at least one failed.
 *                                     `deliveries` carries the per-recipient
 *                                     outcome. Provider acceptance does not
 *                                     establish mailbox delivery. Unknown
 *                                     outcomes must not be blindly retried.
 */
export type SendEmailResult =
  | { ok: true; ids: Array<SendEmailDelivery>; operationId?: string }
  | { ok: false; error: SendEmailError; operationId?: string }
  | { ok: false; deliveries: Array<SendEmailRecipientResult>; operationId?: string };

/**
 * Normalized representation produced by validation, consumed by both the
 * MIME builder and the dev inbox.
 */
export interface NormalizedEmail {
  from: { email: string; name?: string };
  to: Array<{ email: string; name?: string }>;
  cc: Array<{ email: string; name?: string }>;
  bcc: Array<{ email: string; name?: string }>;
  replyTo?: { email: string; name?: string };
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
  attachments: Array<NormalizedAttachment>;
  /**
   * `In-Reply-To` / `References` after the ids were checked, from the
   * `threading` option or `replyEmail`. User-supplied `headers` with these
   * names are always dropped (they're in `RESERVED_HEADERS`).
   */
  threading?: {
    inReplyTo?: string;
    references?: string;
  };
}

export interface NormalizedAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  contentId?: string;
  disposition: 'attachment' | 'inline';
}
