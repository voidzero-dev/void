/**
 * Minimal RFC 5322 / 2047 / 2045 MIME builder for the void/email runtime.
 *
 * Scope is intentionally narrow — text/plain, text/html, multipart/alternative,
 * and multipart/mixed for attachments — covering >95% of transactional sends.
 * Inline images use multipart/related when both attachments and html are present.
 */

import { validate as isValidEmailSyntax } from 'email-validator';
import { bytesToBase64 } from '../base64.ts';
import { indexOfControl, threadingId, threadingReferences, trimFws } from './threading.ts';
import type {
  Address,
  Attachment,
  NormalizedAttachment,
  NormalizedEmail,
  SendEmailOptions,
} from './types.ts';

/** Encoded outbound MIME ceiling, separate from the 10 MiB inbound limit. */
export const MAX_MESSAGE_BYTES: number = 5 * 1024 * 1024;

/**
 * Total attachment bytes `normalizeEmail` will materialize: base64 of more
 * than 3/4 of `MAX_MESSAGE_BYTES` cannot fit. Charged before each copy so an
 * oversize set fails with `MIME_ERROR` instead of exhausting the isolate;
 * `buildMime`'s final size check stays authoritative.
 */
const MAX_ATTACHMENT_BYTES_TOTAL: number = Math.floor((MAX_MESSAGE_BYTES * 3) / 4);

/**
 * Cap on raw `to` + `cc` + `bcc` entries, counted before parsing or
 * deduplication so it also bounds the work.
 */
export const MAX_RECIPIENTS: number = 50;

/** Maximum serialized size of app-defined top-level MIME fields. */
const MAX_CUSTOM_HEADER_BYTES: number = 16 * 1024;

/**
 * Pre-parse cap on one address. Nothing over 320 characters (RFC 5321
 * §4.5.3.1) is deliverable; checked before the address is scanned.
 */
export const MAX_ADDRESS_LENGTH: number = 320;

const CRLF = '\r\n';
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const HEADER_NAME = /^[!-9;-~]+$/;

function rejectCRLF(field: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x0d || c === 0x0a || c === 0x00) {
      throw new MimeError('MIME_ERROR', `${field}: must not contain CR, LF, or NUL.`);
    }
  }
}

/**
 * Refuse a control in a value rendered verbatim into a header (an
 * attachment's filename, media type and Content-ID). Names the code point,
 * never the value.
 */
function rejectControls(field: string, value: string): void {
  const i = indexOfControl(value);
  if (i !== -1) {
    const code = value.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    throw new MimeError('MIME_ERROR', `${field} contains a control character (U+${code}).`);
  }
}

/** RFC 2045 §5.1 `tspecials`: what a `token` may not contain besides SPACE and CTLs. */
const TSPECIALS = '()<>@,;:\\"/[]?=';

/** RFC 2045 §5.1 `token` character: printable US-ASCII less SPACE and `tspecials`. */
function isTokenChar(c: number): boolean {
  return c > 0x20 && c < 0x7f && !TSPECIALS.includes(String.fromCharCode(c));
}

/**
 * Refuse a media type that is not RFC 2045 §5.1 `type "/" subtype *(";"
 * parameter)`: it is written verbatim before the builder's `name=`, so an
 * unterminated quote would swallow it. WSP is allowed only around `;`. A
 * `name` parameter or a repeated attribute is refused (RFC 6838 §4.3).
 */
function validateMediaType(field: string, value: string): void {
  const syntax = () =>
    new MimeError(
      'MIME_ERROR',
      `${field} is not a valid media type (RFC 2045 §5.1: type/subtype, then ; attribute=value parameters).`,
    );
  const n = value.length;
  let i = 0;
  /** Advance over a `token`; the number of characters consumed. */
  const token = (): number => {
    const start = i;
    while (i < n && isTokenChar(value.charCodeAt(i))) {
      i++;
    }
    return i - start;
  };
  const wsp = (): void => {
    while (i < n && (value[i] === ' ' || value[i] === '\t')) {
      i++;
    }
  };
  if (token() === 0 || value[i] !== '/') {
    throw syntax();
  }
  i++;
  if (token() === 0) {
    throw syntax();
  }
  const seen = new Set<string>();
  while (i < n) {
    wsp();
    if (value[i] !== ';') {
      throw syntax();
    }
    i++;
    wsp();
    const start = i;
    if (token() === 0 || value[i] !== '=') {
      throw syntax();
    }
    const attribute = value.slice(start, i).toLowerCase();
    i++;
    if (value[i] === '"') {
      i++;
      for (;;) {
        if (i >= n) {
          throw syntax();
        }
        const ch = value[i++];
        if (ch === '"') {
          break;
        }
        if (ch === '\\') {
          if (i >= n) {
            throw syntax();
          }
          i++;
        }
      }
    } else if (token() === 0) {
      throw syntax();
    }
    if (attribute === 'name') {
      throw new MimeError(
        'MIME_ERROR',
        `${field} must not carry a name= parameter; the builder adds name="<filename>" itself.`,
      );
    }
    if (seen.has(attribute)) {
      throw new MimeError(
        'MIME_ERROR',
        `${field} gives the same parameter twice; attribute names are case-insensitive and each may appear once (RFC 6838 §4.3).`,
      );
    }
    seen.add(attribute);
  }
}

/** RFC 5322 §3.2.3 `atext` besides ALPHA and DIGIT. */
const ATEXT_SYMBOLS = "!#$%&'*+-/=?^_`{|}~";

/** RFC 5322 §3.2.3 `atext` character. */
function isAtext(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    ATEXT_SYMBOLS.includes(String.fromCharCode(c))
  );
}

/**
 * Refuse a Content-ID that would not render as an RFC 5322 §3.6.4 `msg-id`
 * of strict `dot-atom-text`. Unlike `msg-id`, the `@` part and the angle
 * brackets are optional: `cid:logo` resolves against `<logo>` (RFC 2392).
 */
function validateContentId(field: string, value: string): void {
  const syntax = () =>
    new MimeError(
      'MIME_ERROR',
      `${field} is not a valid Content-ID (RFC 5322 §3.6.4 msg-id: an identifier of atext, "." and "@", optionally in one pair of angle brackets).`,
    );
  let i = 0;
  let end = value.length;
  if (value[0] === '<') {
    if (end < 2 || value[end - 1] !== '>') {
      throw syntax();
    }
    i = 1;
    end--;
  }
  /** Advance over a `dot-atom-text`; false when there is none, or a dot is misplaced. */
  const dotAtomText = (): boolean => {
    let run = 0; // atext since the last dot
    for (; i < end; i++) {
      const c = value.charCodeAt(i);
      if (isAtext(c)) {
        run++;
      } else if (c === 0x2e /* . */ && run > 0) {
        run = 0;
      } else {
        break;
      }
    }
    return run > 0;
  };
  if (!dotAtomText()) {
    throw syntax();
  }
  if (i < end) {
    if (value[i] !== '@') {
      throw syntax();
    }
    i++;
    if (!dotAtomText()) {
      throw syntax();
    }
  }
  if (i !== end) {
    throw syntax();
  }
}

const COMMON_TYPES: Record<string, string> = {
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  pdf: 'application/pdf',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  ics: 'text/calendar',
  eml: 'message/rfc822',
};

function inferContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return COMMON_TYPES[ext] ?? 'application/octet-stream';
}

export type MimeErrorCode = 'INVALID_FROM' | 'INVALID_TO' | 'MIME_ERROR';

export class MimeError extends Error {
  code: MimeErrorCode;
  constructor(code: MimeErrorCode, message: string) {
    super(message);
    this.name = 'MimeError';
    this.code = code;
  }
}

function fieldErrorCode(field: string): MimeErrorCode {
  if (field === 'from') {
    return 'INVALID_FROM';
  }
  if (field === 'to') {
    return 'INVALID_TO';
  }
  return 'MIME_ERROR';
}

/**
 * Validate one parsed address and optional display name, throwing a
 * `MimeError` for `field`. The address rule is `email-validator`, the one
 * the platform router applies, so a recorded action is never dropped for its
 * shape. The message never echoes the address.
 */
export function validateAddressParts(field: string, email: string, name?: string): void {
  if (email.length > MAX_ADDRESS_LENGTH) {
    throw new MimeError(
      fieldErrorCode(field),
      `${field}: address is ${email.length} characters, over the ${MAX_ADDRESS_LENGTH}-character limit.`,
    );
  }
  if (!isValidEmailSyntax(email)) {
    throw new MimeError(
      fieldErrorCode(field),
      `${field}: address is not a valid email address (ASCII local part and dotted domain, ` +
        `RFC 5322 dot-atom; at most 64 characters before the '@' and 254 in total).`,
    );
  }
  if (name !== undefined) {
    rejectCRLF(`${field} display name`, name);
    // A quoted ASCII name never folds: refuse one too long for its line
    // before `formatAddress` escapes it.
    if (
      ASCII_PRINTABLE.test(name) &&
      RFC5322_SPECIALS.test(name) &&
      name.length + QUOTED_NAME_LINE_OVERHEAD > MAX_LINE_OCTETS
    ) {
      throw new MimeError(
        fieldErrorCode(field),
        `${field}: display name is ${name.length} characters and must be quoted, which cannot be folded, ` +
          `so its line would exceed the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. Shorten it.`,
      );
    }
    // An `@` in a name usually means a mis-parsed `a@x.dev<b@evil.dev>`.
    if (name.includes('@')) {
      throw new MimeError(
        fieldErrorCode(field),
        `${field}: display name '${name}' must not contain '@' (likely a malformed address).`,
      );
    }
  }
}

/**
 * Undo quoted-pairs (`\x` → `x`) in a quoted display name so `formatAddress`
 * escapes it once. A counting pass and an exact buffer, not a global-regex
 * replace, which allocates per match on an unbounded name.
 */
function unquotePairs(text: string): string {
  const first = text.indexOf('\\');
  if (first === -1) {
    return text;
  }
  let pairs = 0;
  for (let i = first; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x5c) {
      pairs++;
      i++;
    }
  }
  // UTF-16 code units: a surrogate pair round-trips exactly.
  const out = new Uint16Array(text.length - pairs);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c === 0x5c) {
      c = text.charCodeAt(++i);
    }
    out[n++] = c;
  }
  return codeUnitsToString(out);
}

/**
 * Parse one address — a bare `email@domain` or `Display Name <email@domain>`
 * — into its parts, throwing a `MimeError` for `field` on anything else.
 * Exported so `void.config.ts` `email.from` is validated by the same rules
 * the runtime applies to `from` at send time.
 */
export function parseAddress(value: Address, field: string): { email: string; name?: string } {
  if (typeof value === 'string') {
    rejectCRLF(`${field} address`, value);
    // `Display Name <email@domain>`, quotes paired or absent. The unquoted
    // name starts and ends on non-whitespace so adjacent quantifiers cannot
    // compete for one whitespace run, which backtracks cubically.
    const quoted = value.match(/^\s*"((?:[^"\\]|\\.)*)"\s*<\s*([^>\s]+)\s*>\s*$/);
    const angle =
      quoted ?? value.match(/^\s*(?:([^"<\s](?:[^"<]*[^"<\s])?)\s*)?<\s*([^>\s]+)\s*>\s*$/);
    if (angle) {
      // Undo quoted-pairs first: the name guard must see what renders.
      const name = (quoted ? unquotePairs(angle[1] ?? '') : angle[1])?.trim();
      const email = angle[2];
      validateAddressParts(field, email, name);
      return name ? { email, name } : { email };
    }
    const trimmed = value.trim();
    validateAddressParts(field, trimmed);
    return { email: trimmed };
  }
  validateAddressParts(field, value.email ?? '', value.name);
  return value.name ? { email: value.email, name: value.name } : { email: value.email };
}

function parseAddresses(
  value: Address | Array<Address>,
  field: string,
): Array<{ email: string; name?: string }> {
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => parseAddress(entry, field));
}

/** Entries in one recipient field, counted the way `parseAddresses` will see them. */
function countRecipients(value: Address | Array<Address> | undefined): number {
  if (!value) {
    return 0;
  }
  return Array.isArray(value) ? value.length : 1;
}

/** Same `exceeds Cloudflare limit of <N> bytes` tail as `buildMime`'s size error. */
function attachmentsTooLargeError(bytes: number): MimeError {
  return new MimeError(
    'MIME_ERROR',
    `email: attachment size ${bytes} bytes exceeds Cloudflare limit of ${MAX_ATTACHMENT_BYTES_TOTAL} bytes.`,
  );
}

/**
 * Size of `content` without materializing it. A string's `length` is a lower
 * bound on its UTF-8 size; an unsupported type reports 0 for `toBytes` to
 * reject.
 */
function declaredSize(content: Attachment['content']): number {
  if (content instanceof Uint8Array) {
    return content.byteLength;
  }
  if (content instanceof ArrayBuffer) {
    return content.byteLength;
  }
  if (typeof Blob !== 'undefined' && content instanceof Blob) {
    return content.size;
  }
  if (typeof content === 'string') {
    return content.length;
  }
  return 0;
}

async function toBytes(content: Attachment['content']): Promise<Uint8Array> {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  if (typeof Blob !== 'undefined' && content instanceof Blob) {
    return new Uint8Array(await content.arrayBuffer());
  }
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  throw new MimeError(
    'MIME_ERROR',
    'attachment content must be string, Uint8Array, ArrayBuffer, or Blob.',
  );
}

async function normalizeAttachment(att: Attachment): Promise<NormalizedAttachment> {
  if (!att.filename) {
    throw new MimeError('MIME_ERROR', 'attachment: missing filename.');
  }
  rejectCRLF('attachment filename', att.filename);
  // A quoted parameter never folds: refuse a filename too long for its line
  // before `quoteParam` escapes it. Bound first, then scan.
  if (att.filename.length + QUOTED_FILENAME_LINE_OVERHEAD > MAX_LINE_OCTETS) {
    throw new MimeError(
      'MIME_ERROR',
      `attachment filename is ${att.filename.length} characters; a quoted \`filename=\` parameter cannot be folded, ` +
        `so its line would exceed the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. Shorten the filename.`,
    );
  }
  rejectControls('attachment filename', att.filename);
  if (att.contentType !== undefined) {
    rejectCRLF('attachment contentType', att.contentType);
    if (att.contentType.length + CONTENT_TYPE_LINE_OVERHEAD > MAX_LINE_OCTETS) {
      throw new MimeError(
        'MIME_ERROR',
        `attachment contentType is ${att.contentType.length} characters; at most ${MAX_LINE_OCTETS - CONTENT_TYPE_LINE_OVERHEAD} fit ` +
          `on the Content-Type line under the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. Shorten it.`,
      );
    }
    rejectControls('attachment contentType', att.contentType);
    validateMediaType('attachment contentType', att.contentType);
  }
  if (att.contentId !== undefined) {
    rejectCRLF('attachment contentId', att.contentId);
    // `Content-ID: <id>` never folds; the builder adds `<>` around a bare id.
    const brackets = att.contentId.startsWith('<') ? 0 : 2;
    if (att.contentId.length + brackets + CONTENT_ID_LINE_OVERHEAD > MAX_LINE_OCTETS) {
      throw new MimeError(
        'MIME_ERROR',
        `attachment contentId is ${att.contentId.length} characters; at most ${MAX_LINE_OCTETS - CONTENT_ID_LINE_OVERHEAD - brackets} fit ` +
          `on the Content-ID line under the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. Shorten it.`,
      );
    }
    rejectControls('attachment contentId', att.contentId);
    validateContentId('attachment contentId', att.contentId);
  }
  // A JS caller can pass any string, and it is interpolated into
  // `Content-Disposition`.
  if (
    att.disposition !== undefined &&
    att.disposition !== 'attachment' &&
    att.disposition !== 'inline'
  ) {
    throw new MimeError('MIME_ERROR', "attachment disposition must be 'attachment' or 'inline'.");
  }
  const bytes = await toBytes(att.content);
  return {
    filename: att.filename,
    contentType: att.contentType ?? inferContentType(att.filename),
    bytes,
    contentId: att.contentId,
    disposition: att.disposition ?? (att.contentId ? 'inline' : 'attachment'),
  };
}

/**
 * Validate inputs and produce a normalized email shape that can be handed to
 * the MIME builder, the dev inbox, or the test harness without re-parsing.
 */
export async function normalizeEmail(opts: {
  from: Address;
  to: Address | Array<Address>;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: Address;
  cc?: Address | Array<Address>;
  bcc?: Address | Array<Address>;
  headers?: Record<string, string>;
  attachments?: Array<Attachment>;
  threading?: SendEmailOptions['threading'];
}): Promise<NormalizedEmail> {
  if (!opts.text && !opts.html) {
    throw new MimeError('MIME_ERROR', "email: at least one of 'text' or 'html' is required.");
  }
  if (opts.subject !== undefined) {
    rejectCRLF('subject', opts.subject);
  }
  if (opts.headers) {
    let headerInputBytes = 0;
    let headerBytes = 0;
    const encoder = new TextEncoder();
    for (const [name, value] of Object.entries(opts.headers)) {
      if (!HEADER_NAME.test(name)) {
        throw new MimeError(
          'MIME_ERROR',
          `headers: '${name}' is not a valid RFC 5322 header name.`,
        );
      }
      // A field name never folds: refuse one too long for any line before it
      // is copied into the rendered message.
      if (name.length + HEADER_NAME_LINE_OVERHEAD > MAX_LINE_OCTETS) {
        throw new MimeError(
          'MIME_ERROR',
          `headers: a header name is ${name.length} characters; a field name cannot be folded, ` +
            `so its line would exceed the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. Shorten the name.`,
        );
      }
      // The character check refuses a huge value before UTF-8 encoding copies it.
      if (headerInputBytes + name.length + value.length + 4 > MAX_CUSTOM_HEADER_BYTES) {
        throw new MimeError('MIME_ERROR', 'email: custom headers exceed the 16 KiB limit.');
      }
      headerInputBytes += name.length + encoder.encode(value).byteLength + 4;
      if (headerInputBytes > MAX_CUSTOM_HEADER_BYTES) {
        throw new MimeError('MIME_ERROR', 'email: custom headers exceed the 16 KiB limit.');
      }
      rejectCRLF(`header '${name}'`, value);
      if (RESERVED_HEADERS.has(name.toLowerCase())) {
        continue;
      }
      // Reject an obviously oversized value before encoding it. This is a
      // lower bound because encoded words and folding only add bytes.
      if (
        headerBytes + name.length + CUSTOM_HEADER_FRAMING_OCTETS + minHeaderValueOctets(value) >
        MAX_CUSTOM_HEADER_BYTES
      ) {
        throw new MimeError('MIME_ERROR', 'email: custom headers exceed the 16 KiB limit.');
      }
      // The proxy's wire-level accounting; `encodeWord` returns ASCII, so
      // length is bytes.
      headerBytes += foldHeader(name, encodeWord(value)).length + CRLF.length;
      if (headerBytes > MAX_CUSTOM_HEADER_BYTES) {
        throw new MimeError('MIME_ERROR', 'email: custom headers exceed the 16 KiB limit.');
      }
    }
  }
  // Before any address is parsed: the count is what bounds the work below.
  const recipientCount =
    countRecipients(opts.to) + countRecipients(opts.cc) + countRecipients(opts.bcc);
  if (recipientCount > MAX_RECIPIENTS) {
    throw new MimeError(
      'INVALID_TO',
      `email: too many recipients (max ${MAX_RECIPIENTS}, got ${recipientCount}) across 'to', 'cc' and 'bcc'.`,
    );
  }
  const from = parseAddress(opts.from, 'from');
  const to = parseAddresses(opts.to, 'to');
  if (to.length === 0) {
    throw new MimeError('INVALID_TO', "email: 'to' must include at least one recipient.");
  }
  const cc = opts.cc ? parseAddresses(opts.cc, 'cc') : [];
  const bcc = opts.bcc ? parseAddresses(opts.bcc, 'bcc') : [];
  const replyTo = opts.replyTo ? parseAddress(opts.replyTo, 'replyTo') : undefined;
  // The count bounds the loop below (zero-byte entries never advance the
  // byte total), but only if the loop walks the array it was read from.
  const attachmentList = opts.attachments ?? [];
  if (!Array.isArray(attachmentList)) {
    throw new MimeError('MIME_ERROR', 'email: attachments must be an array.');
  }
  if (attachmentList.length > MAX_ATTACHMENTS) {
    throw new MimeError(
      'MIME_ERROR',
      `email: too many attachments (max ${MAX_ATTACHMENTS}, got ${attachmentList.length}).`,
    );
  }
  // Sequential so the running total is charged before each copy.
  const attachments: Array<NormalizedAttachment> = [];
  let attachmentBytes = 0;
  for (const att of attachmentList) {
    const declared = declaredSize(att.content);
    if (attachmentBytes + declared > MAX_ATTACHMENT_BYTES_TOTAL) {
      throw attachmentsTooLargeError(attachmentBytes + declared);
    }
    const normalized = await normalizeAttachment(att);
    // Charge the exact length too: a non-ASCII string undercounts itself
    // above, and `declaredSize` reports 0 for a type `toBytes` will reject.
    attachmentBytes += normalized.bytes.byteLength;
    if (attachmentBytes > MAX_ATTACHMENT_BYTES_TOTAL) {
      throw attachmentsTooLargeError(attachmentBytes);
    }
    attachments.push(normalized);
  }
  const threading = normalizeThreading(opts.threading);

  return {
    from,
    to,
    cc,
    bcc,
    replyTo,
    subject: opts.subject ?? '',
    text: opts.text,
    html: opts.html,
    headers: opts.headers ? { ...opts.headers } : {},
    attachments,
    threading,
  };
}

/**
 * `threading` from `sendEmail`, `createEmail` or `replyEmail`. A value that is
 * not a string is a caller error. Thread ids often come from remote mail, so a
 * bad id never fails the email: an `inReplyTo` with a control character or
 * too long for one line is left out, and a `references` chain that cannot be
 * sent falls back to `inReplyTo`.
 */
function normalizeThreading(threading: unknown): NormalizedEmail['threading'] {
  if (threading === undefined) {
    return undefined;
  }
  if (typeof threading !== 'object' || threading === null || Array.isArray(threading)) {
    throw new MimeError('MIME_ERROR', 'threading: must be an object.');
  }
  const { inReplyTo = '', references = '' } = threading as Record<string, unknown>;
  if (typeof inReplyTo !== 'string') {
    throw new MimeError('MIME_ERROR', 'threading.inReplyTo: must be a string.');
  }
  if (typeof references !== 'string') {
    throw new MimeError('MIME_ERROR', 'threading.references: must be a string.');
  }
  const parent = threadingId('In-Reply-To', trimFws(inReplyTo));
  const chain = threadingReferences(references) || parent;
  if (!parent && !chain) {
    return undefined;
  }
  return { ...(parent ? { inReplyTo: parent } : {}), ...(chain ? { references: chain } : {}) };
}

/**
 * RFC 2047 §2: a 75-character encoded-word less `=?UTF-8?B?` and `?=` leaves
 * 63 characters of base64, so 45 source bytes.
 */
const ENCODED_WORD_PAYLOAD_BYTES = 45;

/**
 * RFC 2047 B encoded-words for non-ASCII header text, space-separated so
 * `foldHeader` can fold between them.
 */
function encodeWord(text: string): string {
  if (ASCII_PRINTABLE.test(text)) {
    return text;
  }
  const encoder = new TextEncoder();
  // A code point is at most 4 UTF-8 bytes, so the buffer never needs
  // more than the budget plus one character of overshoot.
  const pending = new Uint8Array(ENCODED_WORD_PAYLOAD_BYTES + 4);
  let length = 0;
  const words: Array<string> = [];
  const flush = () => {
    if (length > 0) {
      words.push(`=?UTF-8?B?${bytesToBase64(pending.subarray(0, length))}?=`);
      length = 0;
    }
  };
  // Code points, so no character is split across words (RFC 2047 §5).
  for (const char of text) {
    const bytes = encoder.encode(char);
    if (length > 0 && length + bytes.length > ENCODED_WORD_PAYLOAD_BYTES) {
      flush();
    }
    pending.set(bytes, length);
    length += bytes.length;
  }
  flush();
  return words.join(' ');
}

/**
 * RFC 5322 §3.2.3 `specials`, in the RFC's order: an ASCII display name with
 * any of them must be quoted (an unquoted `Dr. Smith` is obsolete syntax).
 */
const RFC5322_SPECIALS = /[()<>[\]:;@\\,."]/;

function formatAddress(addr: { email: string; name?: string }): string {
  if (!addr.name) {
    return addr.email;
  }
  // Non-ASCII → RFC 2047 encoded-word.
  if (!ASCII_PRINTABLE.test(addr.name)) {
    return `${encodeWord(addr.name)} <${addr.email}>`;
  }
  // ASCII with any specials → quoted-string.
  if (RFC5322_SPECIALS.test(addr.name)) {
    return `"${quoteParam(addr.name)}" <${addr.email}>`;
  }
  // Plain atom / atom-with-spaces.
  return `${addr.name} <${addr.email}>`;
}

function formatAddressList(addrs: Array<{ email: string; name?: string }>): string {
  return addrs.map(formatAddress).join(', ');
}

/**
 * Soft-fold a header at 76 columns (RFC 2047 §2): at `, ` outside quotes
 * first, then at unquoted whitespace. A token longer than a line keeps its
 * own line, since RFC 5322 folds only at WSP. One pass that keeps only the
 * output; per-token allocation would exhaust the isolate on a large subject.
 */
function foldHeader(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 78) {
    return line;
  }
  const MAX_LINE = 76;
  const lines: Array<string> = [];
  // Pieces of the line being built, joined by the single space each fold
  // point becomes. The first line starts on `Name:`; a continuation starts
  // on the empty string so the join yields its leading space.
  let current: Array<string> = [`${name}:`];
  let lineLen = name.length + 1;
  let chunks = 0;
  const emit = (text: string, comma: boolean) => {
    chunks++;
    const piece = comma ? `${text},` : text;
    if (piece.length > 0 && lineLen + 1 + piece.length > MAX_LINE) {
      lines.push(current.join(' '));
      current = ['', piece];
      lineLen = 1 + piece.length;
    } else {
      current.push(piece);
      lineLen += 1 + piece.length;
    }
  };
  // A token is emitted only once the scanner knows whether it is the last
  // of its part, because that one carries the part's comma. An empty part
  // (`a, , b`) still owes its separator, so it emits an empty chunk rather
  // than losing a comma.
  let tokenStart = -1;
  let heldStart = -1;
  let heldEnd = -1;
  const endToken = (i: number) => {
    if (tokenStart < 0) {
      return;
    }
    if (heldStart >= 0) {
      emit(value.slice(heldStart, heldEnd), false);
    }
    heldStart = tokenStart;
    heldEnd = i;
    tokenStart = -1;
  };
  const endPart = (isLast: boolean) => {
    if (heldStart >= 0) {
      emit(value.slice(heldStart, heldEnd), !isLast);
      heldStart = -1;
    } else {
      emit('', !isLast);
    }
  };
  let inQuotes = false;
  let escape = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escape) {
      escape = false;
      if (tokenStart < 0) {
        tokenStart = i;
      }
      continue;
    }
    if (ch === '\\' && inQuotes) {
      escape = true;
      if (tokenStart < 0) {
        tokenStart = i;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      if (tokenStart < 0) {
        tokenStart = i;
      }
      continue;
    }
    if (!inQuotes && ch === ',' && value[i + 1] === ' ') {
      endToken(i);
      endPart(false);
      i++; // skip the space
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      endToken(i);
      continue;
    }
    if (tokenStart < 0) {
      tokenStart = i;
    }
  }
  endToken(value.length);
  endPart(true);
  // One unbreakable token — a single long Message-ID, say. There is
  // nowhere to fold, and `Name:\r\n <token>` would shorten nothing.
  if (chunks <= 1) {
    return line;
  }
  lines.push(current.join(' '));
  return lines.join(CRLF);
}

/** RFC 5322 §2.1.1: each line MUST be at most 998 octets, excluding CRLF. */
const MAX_LINE_OCTETS = 998;
/** ` filename="` + `"`: the shortest line a quoted filename parameter can fold onto. */
const QUOTED_FILENAME_LINE_OVERHEAD = 12;
/**
 * ` ` + `;`: the shortest line the media type can fold onto as one token
 * (conservative for several parameters).
 */
const CONTENT_TYPE_LINE_OVERHEAD = 2;
/** `Content-ID: `: the id is one token and cannot fold off this line. */
const CONTENT_ID_LINE_OVERHEAD = 'Content-ID: '.length;
/** ` "` + `"`: the shortest line a quoted display name can fold onto. */
const QUOTED_NAME_LINE_OVERHEAD = 3;
/** `:` alone: the shortest line a header name can sit on, its value folded onto the next. */
const HEADER_NAME_LINE_OVERHEAD = 1;

/**
 * First CRLF-delimited line over the octet limit, counted in UTF-8 without
 * allocating. Every line is scanned because part headers live in the body;
 * encoded body content never trips it.
 */
function findOverlongLine(text: string): { index: number; octets: number } | undefined {
  let index = 0;
  let octets = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d && text.charCodeAt(i + 1) === 0x0a) {
      if (octets > MAX_LINE_OCTETS) {
        return { index, octets };
      }
      index++;
      octets = 0;
      i++;
    } else if (c < 0x80) {
      octets += 1;
    } else if (c < 0x800) {
      octets += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        octets += 4; // the pair is one code point
        i++;
      } else {
        octets += 3; // lone surrogate encodes as U+FFFD
      }
    } else {
      octets += 3;
    }
  }
  return octets > MAX_LINE_OCTETS ? { index, octets } : undefined;
}

/** Escape `\` and `"` as quoted-pairs (RFC 5322 §3.2.4), backslash first. */
function quoteParam(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** `<prefix>_<base36 time><16 random hex>`. */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return `${prefix}_${Date.now().toString(36)}${hex}`;
}

function base64Wrapped(bytes: Uint8Array): string {
  const encoded = bytesToBase64(bytes);
  const lines: Array<string> = [];
  for (let i = 0; i < encoded.length; i += 76) {
    lines.push(encoded.slice(i, i + 76));
  }
  return lines.join(CRLF);
}

function quotedPrintable(text: string): string {
  // Encode as UTF-8 bytes then quote per RFC 2045.
  const bytes = new TextEncoder().encode(text);
  // A byte buffer, not `out +=`, whose cons-string nodes cost ~56 bytes per
  // byte. At most 3 bytes per input byte plus a soft break per 73, so it
  // never grows.
  const out = new Uint8Array(Math.ceil(bytes.length * 3 * (76 / 73)) + 8);
  let n = 0;
  let lineLen = 0;
  const HEX = '0123456789ABCDEF';
  const put = (c: number) => {
    out[n++] = c;
  };
  const flush = (c0: number, c1?: number, c2?: number) => {
    const width = c2 !== undefined ? 3 : c1 !== undefined ? 2 : 1;
    if (lineLen + width > 75) {
      put(0x3d);
      put(0x0d);
      put(0x0a);
      lineLen = 0;
    }
    put(c0);
    if (c1 !== undefined) {
      put(c1);
    }
    if (c2 !== undefined) {
      put(c2);
    }
    lineLen += width;
  };
  const quote = (b: number) => flush(0x3d, HEX.charCodeAt(b >> 4), HEX.charCodeAt(b & 0xf));
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0a) {
      put(0x0d);
      put(0x0a);
      lineLen = 0;
      continue;
    }
    if (b === 0x0d) {
      // CR alone or part of CRLF — emit CRLF on the LF side, skip standalone CR.
      if (bytes[i + 1] === 0x0a) {
        continue;
      }
      put(0x0d);
      put(0x0a);
      lineLen = 0;
      continue;
    }
    if (b === 0x20 || b === 0x09) {
      // Defer encoding decision: a space at end-of-line must be quoted.
      const isLast = i === bytes.length - 1 || bytes[i + 1] === 0x0a || bytes[i + 1] === 0x0d;
      if (isLast) {
        quote(b);
      } else {
        flush(b);
      }
      continue;
    }
    if (b === 0x3d || b < 0x20 || b > 0x7e) {
      quote(b);
      continue;
    }
    flush(b);
  }
  return codeUnitsToString(out.subarray(0, n));
}

/** One character per code unit, in 32K chunks to stay under the call-argument limit. */
function codeUnitsToString(units: Uint8Array | Uint16Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < units.length; i += chunk) {
    s += String.fromCharCode(...units.subarray(i, i + chunk));
  }
  return s;
}

/**
 * Whether a body needs quoted-printable: anything outside printable ASCII
 * (a bare CR included) or a line over 990 characters. One pass without
 * allocation.
 */
function needsQuotedPrintable(text: string): boolean {
  let lineLen = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      lineLen = 0;
      continue;
    }
    if (c === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) {
        continue;
      }
      return true;
    }
    if (c < 0x20 || c > 0x7e) {
      return true;
    }
    lineLen++;
    if (lineLen > 990) {
      return true;
    }
  }
  return false;
}

/**
 * `text` with each bare LF widened to CRLF. Called only when every character
 * is one byte, so a counting pass sizes the buffer exactly; a global-regex
 * replace would allocate per line.
 */
function to7bitBody(text: string): string {
  let bare = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a && (i === 0 || text.charCodeAt(i - 1) !== 0x0d)) {
      bare++;
    }
  }
  if (bare === 0) {
    return text;
  }
  const out = new Uint8Array(text.length + bare);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a && (i === 0 || text.charCodeAt(i - 1) !== 0x0d)) {
      out[n++] = 0x0d;
    }
    out[n++] = c;
  }
  return codeUnitsToString(out);
}

/**
 * Lower bound on `text`'s rendered octets, without allocating: ASCII is at
 * least 1 octet and each non-ASCII UTF-8 byte is `=XX`.
 */
function minBodyOctets(text: string): number {
  let octets = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      octets += 1;
    } else if (c < 0x800) {
      octets += 6; // 2 UTF-8 bytes, each `=XX`
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        octets += 12; // 4 UTF-8 bytes for the pair
        i++;
        continue;
      }
      octets += 9; // lone surrogate encodes as U+FFFD, 3 bytes
    } else {
      octets += 9; // 3 UTF-8 bytes
    }
  }
  return octets;
}

/** Octets a base64 body of `n` bytes occupies at 76 columns, excluding CRLF. */
function base64Octets(n: number): number {
  return Math.ceil(n / 3) * 4;
}

interface MimePart {
  headers: Array<[string, string]>;
  body: string;
}

function renderPart(part: MimePart): string {
  const lines = part.headers.map(([k, v]) => foldHeader(k, v));
  return lines.join(CRLF) + CRLF + CRLF + part.body;
}

function buildBodyPart(contentType: string, body: string): MimePart {
  const useQp = needsQuotedPrintable(body);
  return {
    headers: [
      ['Content-Type', `${contentType}; charset=UTF-8`],
      ['Content-Transfer-Encoding', useQp ? 'quoted-printable' : '7bit'],
    ],
    body: useQp ? quotedPrintable(body) : to7bitBody(body),
  };
}

function buildAttachmentPart(att: NormalizedAttachment): MimePart {
  const headers: Array<[string, string]> = [
    ['Content-Type', `${att.contentType}; name="${quoteParam(att.filename)}"`],
    ['Content-Transfer-Encoding', 'base64'],
    ['Content-Disposition', `${att.disposition}; filename="${quoteParam(att.filename)}"`],
  ];
  if (att.contentId) {
    const cid = att.contentId.startsWith('<') ? att.contentId : `<${att.contentId}>`;
    headers.push(['Content-ID', cid]);
  }
  return { headers, body: base64Wrapped(att.bytes) };
}

function makeBoundary(prefix: string): string {
  // 16 random bytes → 24-char base64. Workers + browsers expose crypto.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `=_void_${prefix}_${bytesToBase64(bytes).replace(/[+/=]/g, '')}`;
}

function wrapMultipart(
  type: 'mixed' | 'alternative' | 'related',
  parts: Array<MimePart>,
): MimePart {
  const boundary = makeBoundary(type);
  const headerEntries: Array<[string, string]> = [
    ['Content-Type', `multipart/${type}; boundary="${boundary}"`],
  ];
  const body =
    parts.map((p) => `--${boundary}${CRLF}${renderPart(p)}`).join(CRLF) +
    `${CRLF}--${boundary}--${CRLF}`;
  return { headers: headerEntries, body };
}

const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'reply-to',
  'date',
  'message-id',
  // Threading has one channel, `threading`, which checks each id. replyEmail
  // builds it from the original message; sendEmail takes it from the caller.
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'content-disposition',
]);

/**
 * Lower bound on one rendered header value, without allocating. Printable
 * ASCII counts its non-WSP characters (folding may collapse WSP runs);
 * anything else is B-encoded whole, at least 4/3 of its UTF-8 bytes plus 12
 * octets of framing per 45-byte word.
 */
function minHeaderValueOctets(value: string): number {
  let utf8 = 0;
  let visible = 0;
  let encoded = false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x80) {
      utf8 += 1;
      if (c === 0x20 || c === 0x09) {
        continue;
      }
      if (c < 0x20 || c === 0x7f) {
        encoded = true;
      }
      visible += 1;
    } else {
      encoded = true;
      if (c < 0x800) {
        utf8 += 2;
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
        const d = value.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          utf8 += 4; // the pair is one code point
          i++;
          continue;
        }
        utf8 += 3; // lone surrogate encodes as U+FFFD
      } else {
        utf8 += 3;
      }
    }
  }
  if (!encoded) {
    return visible;
  }
  return Math.floor((utf8 * 4) / 3) + 12 * Math.floor(utf8 / ENCODED_WORD_PAYLOAD_BYTES);
}

/** Lower bound on one rendered address: its display name, plus the address itself verbatim. */
function minAddressOctets(addr: { email: string; name?: string }): number {
  return addr.email.length + (addr.name ? minHeaderValueOctets(addr.name) : 0);
}

/**
 * Lower bound on a value rendered verbatim (threading ids, media type,
 * Content-ID): one octet per non-WSP code unit. `minHeaderValueOctets` would
 * overshoot, since these are raw UTF-8, not encoded-words.
 */
function minVerbatimOctets(value: string): number {
  let octets = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09) {
      octets += 1;
    }
  }
  return octets;
}

/**
 * Framing every attachment part costs with empty values. The random boundary
 * suffix has no provable minimum, so it is not counted.
 */
const ATTACHMENT_PART_MIN_OCTETS: number =
  CRLF.length + // the join between this part and the one before it
  ('--=_void_mixed_'.length + CRLF.length) +
  ('Content-Type: '.length + '; name=""'.length + CRLF.length) +
  ('Content-Transfer-Encoding: base64'.length + CRLF.length) +
  ('Content-Disposition: '.length + '; filename=""'.length + CRLF.length) +
  CRLF.length; // the blank line before the body

/**
 * Cap on the attachment count, checked before any entry is normalized:
 * zero-byte entries never advance the byte total. It is the most parts
 * `buildMime`'s size projection can admit, so it refuses nothing that fits.
 */
export const MAX_ATTACHMENTS: number = Math.floor(
  MAX_MESSAGE_BYTES / (ATTACHMENT_PART_MIN_OCTETS + 2),
);

/** `: ` and the CRLF around a custom header value; exact once the name is counted. */
const CUSTOM_HEADER_FRAMING_OCTETS: number = ': '.length + CRLF.length;

/**
 * Lower bound on every header rendered from caller values. Bcc and reserved
 * custom headers never render, and the fixed framing of Void's own headers
 * is omitted. A custom header's name and framing, and each attachment part's
 * framing and filename (twice), are charged: a message of many empty headers
 * or attachments is all framing.
 */
function minHeaderOctets(email: NormalizedEmail): number {
  let octets = minHeaderValueOctets(email.subject);
  for (const [name, value] of Object.entries(email.headers)) {
    if (!RESERVED_HEADERS.has(name.toLowerCase())) {
      // `HEADER_NAME` admits only ASCII, so `length` is the name's octets.
      octets += name.length + CUSTOM_HEADER_FRAMING_OCTETS + minHeaderValueOctets(value);
    }
  }
  octets += minAddressOctets(email.from);
  for (const addr of email.to) {
    octets += minAddressOctets(addr);
  }
  for (const addr of email.cc) {
    octets += minAddressOctets(addr);
  }
  if (email.replyTo) {
    octets += minAddressOctets(email.replyTo);
  }
  if (email.threading?.inReplyTo) {
    octets += minVerbatimOctets(email.threading.inReplyTo);
  }
  if (email.threading?.references) {
    octets += minVerbatimOctets(email.threading.references);
  }
  for (const att of email.attachments) {
    // The filename is quoted twice and never folds, so whitespace counts too.
    octets += ATTACHMENT_PART_MIN_OCTETS + 2 * att.filename.length;
    octets += minVerbatimOctets(att.contentType);
    if (att.contentId) {
      octets += minVerbatimOctets(att.contentId);
    }
  }
  return octets;
}

function generateMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] ?? 'localhost';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const id = bytesToBase64(bytes).replace(/[+/=]/g, '');
  return `<${id}@${domain}>`;
}

/**
 * Build the raw RFC 5322 message body. Returns the message bytes plus the
 * generated Message-ID header so callers can surface it in the result.
 */
export function buildMime(email: NormalizedEmail): { raw: Uint8Array; messageId: string } {
  // Project the size before rendering, which holds several copies of the
  // message: an oversize body or header must fail with `MIME_ERROR`, not
  // exhaust the isolate. Each term is a lower bound; the final check rules.
  const projected =
    minHeaderOctets(email) +
    (email.text ? minBodyOctets(email.text) : 0) +
    (email.html ? minBodyOctets(email.html) : 0) +
    email.attachments.reduce((sum, a) => sum + base64Octets(a.bytes.byteLength), 0);
  if (projected > MAX_MESSAGE_BYTES) {
    throw new MimeError(
      'MIME_ERROR',
      `email: message is at least ${projected} bytes once encoded, which exceeds Cloudflare limit of ${MAX_MESSAGE_BYTES} bytes.`,
    );
  }

  const messageId = generateMessageId(email.from.email);
  const date = new Date().toUTCString().replace('GMT', '+0000');

  const topHeaders: Array<[string, string]> = [
    ['Date', date],
    ['From', formatAddress(email.from)],
    ['To', formatAddressList(email.to)],
  ];
  if (email.cc.length > 0) {
    topHeaders.push(['Cc', formatAddressList(email.cc)]);
  }
  // Bcc is intentionally omitted from the rendered headers. The CF `send_email`
  // binding fans out one envelope per recipient, but every envelope carries
  // the same raw MIME body — so a `Bcc:` header here would expose the BCC list
  // to every To/Cc recipient. The envelope itself handles BCC delivery.
  if (email.replyTo) {
    topHeaders.push(['Reply-To', formatAddress(email.replyTo)]);
  }
  topHeaders.push(['Subject', encodeWord(email.subject)]);
  topHeaders.push(['Message-ID', messageId]);
  // Reserved against user-supplied `headers` (RESERVED_HEADERS), so these
  // land in the wire MIME only through the checked `email.threading`.
  if (email.threading?.inReplyTo) {
    topHeaders.push(['In-Reply-To', email.threading.inReplyTo]);
  }
  if (email.threading?.references) {
    topHeaders.push(['References', email.threading.references]);
  }
  topHeaders.push(['MIME-Version', '1.0']);

  for (const [name, value] of Object.entries(email.headers)) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    topHeaders.push([name, encodeWord(value)]);
  }

  const textPart = email.text ? buildBodyPart('text/plain', email.text) : undefined;
  const htmlPart = email.html ? buildBodyPart('text/html', email.html) : undefined;

  let bodyPart: MimePart;
  if (textPart && htmlPart) {
    bodyPart = wrapMultipart('alternative', [textPart, htmlPart]);
  } else {
    bodyPart = (textPart ?? htmlPart) as MimePart;
  }

  if (email.attachments.length > 0) {
    const inlineAttachments = email.attachments.filter((a) => a.disposition === 'inline');
    const fileAttachments = email.attachments.filter((a) => a.disposition !== 'inline');

    if (inlineAttachments.length > 0 && htmlPart) {
      // Wrap (alternative or html) with inline attachments via multipart/related.
      bodyPart = wrapMultipart('related', [
        bodyPart,
        ...inlineAttachments.map(buildAttachmentPart),
      ]);
    } else {
      // No inline images — treat all as regular file attachments.
      fileAttachments.push(...inlineAttachments);
    }
    if (fileAttachments.length > 0) {
      bodyPart = wrapMultipart('mixed', [bodyPart, ...fileAttachments.map(buildAttachmentPart)]);
    }
  }

  // Promote the body part's headers into the top-level headers.
  for (const [k, v] of bodyPart.headers) {
    topHeaders.push([k, v]);
  }

  const headerBlock = topHeaders.map(([k, v]) => foldHeader(k, v)).join(CRLF);
  const rawText = headerBlock + CRLF + CRLF + bodyPart.body;
  const raw = new TextEncoder().encode(rawText);

  // RFC 5322 §2.1.1: at most 998 octets per line, and a token without
  // whitespace cannot fold. Checked after rendering, the only place that sees
  // every header path; encoding or truncating would corrupt ids and names.
  const overlong = findOverlongLine(rawText);
  if (overlong !== undefined) {
    throw new MimeError(
      'MIME_ERROR',
      `email: header line ${overlong.index + 1} is ${overlong.octets} octets, over the ${MAX_LINE_OCTETS}-octet limit in RFC 5322 §2.1.1. ` +
        'A value with no whitespace cannot be folded — shorten it, or move it into the body.',
    );
  }

  if (raw.byteLength > MAX_MESSAGE_BYTES) {
    throw new MimeError(
      'MIME_ERROR',
      `email: message size ${raw.byteLength} bytes exceeds Cloudflare limit of ${MAX_MESSAGE_BYTES} bytes.`,
    );
  }

  return { raw, messageId };
}
