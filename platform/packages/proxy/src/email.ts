import { EmailMessage } from 'cloudflare:email';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { asString } from './body.ts';
import {
  admitEmail,
  emailPayloadDigest,
  finishEmailAttempt,
  startEmailAttempt,
  type Admission,
} from './email-admission.ts';
import { leaseBearer, leaseEmailDomainCredential } from './email-lease.ts';
import {
  EMAIL_PROVIDER_DEADLINE_MS,
  EmailProviderTimeoutError,
  createEmailProviderDeadline,
  type EmailProviderDeadline,
} from './email-provider-deadline.ts';
import type { Env, ProxyEnv } from './types.ts';

const app = new Hono<ProxyEnv>();
// The SDK aborts at 60s. Body/auth can precede this handler, and final ledger
// writes need time after provider work stops.
const EMAIL_SEND_DEADLINE_MS = 50_000;
const EMAIL_SEND_FINALIZATION_MARGIN_MS = 5_000;

/**
 * Cap inbound MIME bytes well below CF's ~10 MB base64-inflated ceiling. The
 * framework enforces the same cap client-side; this is the proxy-side belt to
 * the framework's suspenders.
 */
export const MAX_MIME_BYTES = 5 * 1024 * 1024;
const MAX_CUSTOM_HEADER_BYTES = 16 * 1024;
const BUILTIN_MIME_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'reply-to',
  'date',
  'message-id',
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'content-disposition',
]);

/** Bound only app-defined top-level fields, including folded continuation lines. */
function customMimeHeaderBytesWithinLimit(raw: Uint8Array): boolean {
  let used = 0;
  let custom = false;
  for (let start = 0; start < raw.byteLength;) {
    let end = start;
    while (end < raw.byteLength && raw[end] !== 10) {
      end++;
    }
    const lineEnd = end > start && raw[end - 1] === 13 ? end - 1 : end;
    if (lineEnd === start) {
      return true;
    }
    if (raw[start] !== 32 && raw[start] !== 9) {
      let colon = start;
      while (colon < lineEnd && raw[colon] !== 58) {
        colon++;
      }
      const name = new TextDecoder().decode(raw.subarray(start, colon)).toLowerCase();
      custom = colon < lineEnd && !BUILTIN_MIME_HEADERS.has(name);
    }
    if (custom) {
      used += lineEnd - start + 2;
      if (used > MAX_CUSTOM_HEADER_BYTES) {
        return false;
      }
    }
    start = end + 1;
  }
  return true;
}

/** Bound the raw list before normalization allocates one copy and Set entry per recipient. */
const MAX_RECIPIENTS = 50;

/**
 * Bound each address before normalization copies it. RFC 5321 caps a
 * forward-path at 256 octets, so 320 characters leaves room for validation.
 */
const MAX_RECIPIENT_LENGTH = 320;

/**
 * Cap the envelope sender for the same reason. It is one string, so there
 * is no list amplifier, but `from.toLowerCase()` below copies it whole
 * (measured: V8 returns a fresh full-size string even when nothing
 * changed), and a sender the strict regex accepts — an unbounded `+tag`
 * is one — is then echoed verbatim into the MIME `From:` refusal and
 * serialized into the response. Check it before those copies. The limit
 * matches `MAX_RECIPIENT_LENGTH`.
 */
const MAX_SENDER_LENGTH = 320;

/**
 * The platform mail domain for this environment. It is configured as the
 * `EMAIL_SENDER_DOMAIN` var and mirrored into deployed user workers as the
 * `__VOID_EMAIL_DOMAIN` plain-text binding so the framework builds its default
 * `from` against the same zone.
 *
 * There is deliberately NO baked-in default. A staging proxy that fell back
 * to `mail.void.cloud` would accept a `from` on the production zone, and the
 * production sender regex would reject every legitimate staging sender — the
 * exact reason the domain stopped being a constant. Missing configuration
 * fails the send CLOSED.
 */
export function readSenderDomain(env: Pick<Env, 'EMAIL_SENDER_DOMAIN'>): string | null {
  const raw = env.EMAIL_SENDER_DOMAIN;
  if (typeof raw !== 'string') {
    return null;
  }
  const domain = raw.trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/** Regex metacharacters, escaped before a config value is interpolated. */
const RE_METACHARS_RE = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(RE_METACHARS_RE, '\\$&');
}

/**
 * Memoized per-domain sender regexes. Keyed by the configured
 * `EMAIL_SENDER_DOMAIN`, which is worker configuration and not user input,
 * so the map holds exactly one entry per isolate in practice.
 */
const strictFromCache = new Map<string, RegExp>();

/**
 * Strict shape for the outbound `from` envelope address. The slug+domain
 * pinning logic below splits on `+` and the first `@`, but those splits do
 * NOT reject CR/LF, quotes, angle brackets, or display-name forms. Without
 * this regex, a `from` like `slug+x\r\nX-Header: y@<domain>` would pass slug
 * pinning and then reach `new EmailMessage(from, ...)`, opening an SMTP
 * header injection primitive against the shared sender. The regex pins the
 * entire string to: lowercase ASCII local-part, zero or more `+<safe-tag>`
 * segments (constrained to RFC-5321 dot-atom-text + `=` and `/`), then exactly
 * `@<EMAIL_SENDER_DOMAIN>`. Display names, encoded-words, and angle brackets
 * are intentionally not supported — the framework doesn't emit them for a
 * default `from`, and explicit user-supplied names are already disallowed by
 * the slug pin.
 *
 * The `+tag` class is a positive class rather than `[^@\s]+` so even
 * non-printable ASCII (NUL, BEL, DEL, …) can't ride into `EmailMessage`.
 *
 * The domain is escaped before interpolation so a misconfigured value can
 * never widen the pattern (an unescaped `.` would match any character).
 */
function strictFromRe(domain: string): RegExp {
  const cached = strictFromCache.get(domain);
  if (cached) {
    return cached;
  }
  const re = new RegExp(`^[a-z0-9._-]+(?:\\+[a-z0-9._=/-]+)*@${escapeRegExp(domain)}$`);
  strictFromCache.set(domain, re);
  return re;
}

/**
 * Strip CR/LF/NUL/control chars before logging or surfacing to remote MTAs.
 *
 * Built via new RegExp so oxlint's no-control-regex rule (which fires
 * on even Unicode-escaped control refs in regex literals) does not
 * reject the pattern. Behavior is identical to a literal regex.
 *
 * Slice FIRST, then replace: a global replace materializes one part per
 * match, so a multi-megabyte control-heavy input could exceed the 128 MB
 * isolate heap. The result is at most `maxLen` chars and may be shorter — a
 * control run inside the window collapses to one space and nothing is
 * refilled from beyond it — which loses nothing on a log line.
 */
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g');
export function sanitizeForLog(value: string, maxLen = 200): string {
  return value.slice(0, maxLen).replace(CONTROL_CHARS_RE, ' ');
}

/**
 * Cap the caller-supplied log correlation id. The framework sends
 * `req_<base36 time><16 hex>` (`newId('req')` in `void/email`), but a
 * hand-built tenant worker can send any string the request body carries,
 * and the only consumer is the `[email-log]` line — one per delivery, so up
 * to `MAX_RECIPIENTS` copies of it per request — in the shared proxy log
 * stream. It is diagnostic, so it is bounded and sanitized ONCE at intake
 * rather than refused with a 400: a missing or non-string id already logs as
 * `unknown` instead of failing the send, and a truncated id is no less
 * useful to correlate on. The control-char strip is what stops a `\n` in
 * the id from forging a second `[email-log]` line under another project's
 * id. 128 leaves room for a UUID or a prefixed id without inviting anything
 * longer.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Wrap a Uint8Array as a single-chunk ReadableStream. CF's EmailMessage
 * constructor accepts `string | ReadableStream`; passing a Uint8Array
 * directly is a TS error. Streaming a single chunk avoids decoding to
 * UTF-8 (which would corrupt non-text MIME parts that happen to be
 * stored in their decoded form).
 */
export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * The addr-spec named by the message-level `From:` header, or why there is
 * no single one to name.
 *
 * `/send` pins the ENVELOPE sender (`from`) to the calling project's slug,
 * but the bytes a recipient's mail client shows as the sender are the MIME
 * `From:` header inside `mimeBase64`, and a tenant worker holding its own
 * project HMAC can post any bytes it likes there. Cloudflare's local
 * `send_email` simulator (miniflare `send_email.worker.ts`) throws
 * `From: header does not match mail from` for exactly this, and its author
 * says the messages mirror production — but nothing in the public docs
 * promises it, the same simulator takes the LAST of several `From:` headers
 * and the FIRST mailbox of a list, and the proxy is the platform's tenancy
 * boundary. So the proxy checks itself: exactly one `From:` header, holding
 * exactly one mailbox, whose addr-spec is the authorized envelope sender.
 *
 * Scope is deliberately narrow. The display name (a quoted-string or RFC
 * 2047 encoded-words before `<…>`) is NOT inspected — closing display-name
 * spoofing would need a real RFC 5322 scanner tracking `buildMime` forever,
 * and stays handed back. The structural specials outside quotes
 * (`, ; : ( ) [ ] \` and a bare `@` before `<`) are refused only because
 * each one would make "which mailbox is this" ambiguous — a list, a group,
 * a comment or a phrase that reads as an address — and `buildMime` never
 * emits any of them unquoted. `Sender:`, `Reply-To:` and `Resent-From:` are
 * not pinned: no client presents them as the author, and a reply sent to a
 * sibling project's inbound address is something anyone can do without the
 * proxy.
 *
 * Every line of the header block is visited so a `From:` cannot hide
 * behind an unrelated header, and continuation lines (leading WSP) are
 * unfolded onto the header they extend. The scan stops at the first empty
 * line — a `From:` inside a MIME part's own headers is that part's, not the
 * message's — or at the end of `raw`, which `MAX_MIME_BYTES` already
 * bounds. The work is one linear pass over bytes that are already in
 * memory; only the `From:` value is ever decoded to a string, and the
 * tokenizer below is a single pass with no backtracking, so a display
 * name of any length (which `buildMime` allows) costs what it weighs.
 *
 * "What it weighs" has to mean BYTES, not lines. The scan keeps nothing
 * per line — only the byte offsets of the one `From:` it found — because
 * `MAX_MIME_BYTES` bounds bytes and a folded header can hold one line per
 * three of them (` \r\n`): 3.5 million continuations fit in 10 MiB, and
 * retaining even a small view per continuation would exceed the 128 MB
 * isolate that every tenant's AI/D1/KV/R2 traffic shares. The value is
 * unfolded with ONE copy of the header's byte range, and no copy at all
 * when it did not fold.
 *
 * Header names are matched the way lenient parsers (postal-mime, which
 * miniflare uses) match them — bytes before the first `:` with trailing
 * WSP trimmed, case-insensitively — so `From :` counts as a second `From:`
 * rather than slipping past as an unknown header. A bare CR inside a line
 * fails the scan: `buildMime` rejects CR/LF in every value, and a parser
 * that splits on LF alone would read the bytes after it as part of the
 * same header.
 */
export type MimeFrom =
  | { ok: true; addrSpec: string }
  | { ok: false; reason: 'missing' | 'multiple' | 'malformed' };

const LF = 0x0a;
const CR = 0x0d;
const SP = 0x20;
const HTAB = 0x09;
const COLON = 0x3a;
const FROM_NAME = [0x66, 0x72, 0x6f, 0x6d]; // "from"

/**
 * Where the value of the header line `raw[start, end)` begins if the line
 * is named `From` — the byte after its first `:` — or -1 if it is not.
 * The name is the bytes before that colon with trailing WSP trimmed,
 * compared case-insensitively; since it has to be exactly `from`, the
 * colon is looked for only across the WSP run that may follow those four
 * bytes, so the check reads at most the name and never searches the line.
 */
function fromValueStart(raw: Uint8Array, start: number, end: number): number {
  if (end - start <= FROM_NAME.length) {
    return -1;
  }
  for (let i = 0; i < FROM_NAME.length; i++) {
    // ASCII case fold: `A`..`Z` → `a`..`z`. Non-letters fold to themselves.
    if ((raw[start + i] | 0x20) !== FROM_NAME[i]) {
      return -1;
    }
  }
  let colon = start + FROM_NAME.length;
  while (colon < end && (raw[colon] === SP || raw[colon] === HTAB)) {
    colon++;
  }
  return colon < end && raw[colon] === COLON ? colon + 1 : -1;
}

/** Operator-readable detail for each way the pin can fail to find a sender. */
const MIME_FROM_REFUSALS: Record<Extract<MimeFrom, { ok: false }>['reason'], string> = {
  missing: 'the message has no From header',
  multiple: 'the message has more than one From header',
  malformed: 'the From header must hold a single mailbox',
};

export function readMimeFromAddrSpec(raw: Uint8Array): MimeFrom {
  const n = raw.byteLength;
  // The `From:` header as offsets into `raw`: its value starts after the
  // colon and ends where the content of its last line ends. `folded` says
  // whether a continuation line extended it, `inFrom` whether the line
  // being visited may.
  let fromCount = 0;
  let valueStart = -1;
  let valueEnd = -1;
  let folded = false;
  let inFrom = false;
  // The next CR at or after `lineStart`. Searched for lazily, each search
  // starting past the previous hit, so finding the bare CR that fails the
  // scan stays linear across a block of CR-less lines.
  let nextCr = raw.indexOf(CR);
  let lineStart = 0;
  while (lineStart < n) {
    const lf = raw.indexOf(LF, lineStart);
    const lineEnd = lf === -1 ? n : lf;
    let contentEnd = lineEnd;
    if (contentEnd > lineStart && raw[contentEnd - 1] === CR) {
      contentEnd--;
    }
    if (contentEnd === lineStart) {
      break; // empty line: end of the header block
    }
    if (nextCr !== -1 && nextCr < lineStart) {
      nextCr = raw.indexOf(CR, lineStart);
    }
    if (nextCr !== -1 && nextCr < contentEnd) {
      return { ok: false, reason: 'malformed' };
    }
    if (raw[lineStart] === SP || raw[lineStart] === HTAB) {
      if (inFrom) {
        valueEnd = contentEnd;
        folded = true;
      }
    } else {
      const start = fromValueStart(raw, lineStart, contentEnd);
      inFrom = start !== -1;
      if (inFrom) {
        fromCount++;
        valueStart = start;
        valueEnd = contentEnd;
        folded = false;
      }
    }
    lineStart = lf === -1 ? n : lf + 1;
  }
  if (fromCount === 0) {
    return { ok: false, reason: 'missing' };
  }
  if (fromCount > 1) {
    return { ok: false, reason: 'multiple' };
  }
  // Unfold (RFC 5322 §2.2.3): the value is the header's byte range with
  // its line breaks removed, each continuation keeping its leading WSP.
  // Every CR still inside the range ends a line — the scan refused any
  // other — so dropping CR and LF is the whole job, done in place on one
  // copy of the range. A header that did not fold needs no copy.
  let value = raw.subarray(valueStart, valueEnd);
  if (folded) {
    value = raw.slice(valueStart, valueEnd);
    let kept = 0;
    for (let i = 0; i < value.length; i++) {
      const byte = value[i];
      if (byte !== CR && byte !== LF) {
        value[kept++] = byte;
      }
    }
    value = value.subarray(0, kept);
  }
  const addrSpec = singleMailboxAddrSpec(new TextDecoder().decode(value));
  return addrSpec === null ? { ok: false, reason: 'malformed' } : { ok: true, addrSpec };
}

/**
 * The addr-spec of a header value that holds exactly one mailbox — either a
 * bare `addr-spec` or `[phrase] <addr-spec>` — or `null` when the value is
 * anything else. One pass; quoted-strings (with `\` escapes) are skipped
 * whole, and their contents are never interpreted.
 */
function singleMailboxAddrSpec(value: string): string | null {
  let inQuotes = false;
  let escaped = false;
  let lt = -1;
  let gt = -1;
  let firstAt = -1;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuotes) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inQuotes = false;
      }
      continue;
    }
    switch (ch) {
      case '"':
        // A quoted-string belongs to the phrase, which ends at `<`.
        if (lt !== -1) {
          return null;
        }
        inQuotes = true;
        break;
      case '<':
        if (lt !== -1) {
          return null;
        }
        lt = i;
        break;
      case '>':
        if (lt === -1 || gt !== -1) {
          return null;
        }
        gt = i;
        break;
      case '@':
        if (firstAt === -1) {
          firstAt = i;
        }
        break;
      case ',':
      case ';':
      case ':':
      case '(':
      case ')':
      case '[':
      case ']':
      case '\\':
        return null;
      default:
        break;
    }
  }
  if (inQuotes) {
    return null;
  }
  let addrSpec: string;
  if (lt === -1) {
    addrSpec = value.trim();
  } else {
    // `<` present: it needs its `>`, nothing but WSP may follow, and the
    // phrase before it must not read as an address of its own.
    if (gt === -1 || value.slice(gt + 1).trim().length !== 0) {
      return null;
    }
    if (firstAt !== -1 && firstAt < lt) {
      return null;
    }
    addrSpec = value.slice(lt + 1, gt);
  }
  // One printable-ASCII token. Rules out an empty `<>`, WSP inside the
  // brackets, and a code point that only LOOKS like the sender before the
  // caller lower-cases it for the compare.
  return /^[\x21-\x7e]+$/.test(addrSpec) ? addrSpec : null;
}

/**
 * Outbound email send. The framework runtime POSTs:
 *
 *   {
 *     projectId, aiToken,           // auth (validated by middleware)
 *     from,                          // envelope sender (on an Email Sending or Email Routing zone)
 *     recipients: string[],          // unique normalized recipient addresses
 *     mimeBase64,                    // raw MIME, base64-encoded
 *     requestId                      // for logs and default operation identity
 *   }
 *
 * The proxy validates and normalizes the request, routes custom senders to
 * `send_raw`, and otherwise asks the API to admit each recipient before using
 * the platform `send_email` binding.
 *
 * The user worker does not have a `send_email` binding.
 */
app.post('/send', async (context) => {
  const sendDeadline = createEmailProviderDeadline(EMAIL_SEND_DEADLINE_MS);
  const projectId = context.get('projectId');
  const body = context.get('body');

  const from = asString(body.from);
  const mimeBase64 = asString(body.mimeBase64);
  // Bounded and sanitized here, once, so `logSend` never interpolates the
  // raw value; see `MAX_REQUEST_ID_LENGTH`.
  const requestIdRaw = asString(body.requestId);
  const requestId =
    requestIdRaw === null ? 'unknown' : sanitizeForLog(requestIdRaw, MAX_REQUEST_ID_LENGTH);
  const callerKey = asString(body.idempotencyKey);
  if (
    callerKey !== null &&
    (callerKey.length === 0 || callerKey.length > 128 || !/^[\x20-\x7e]+$/.test(callerKey))
  ) {
    return context.json(
      { ok: false, error: { code: 'INVALID_TO', message: 'invalid idempotency key' } },
      400,
    );
  }
  const operationKey =
    callerKey ??
    (requestIdRaw && requestIdRaw.length <= 128 && /^[\x20-\x7e]+$/.test(requestIdRaw)
      ? requestIdRaw
      : crypto.randomUUID());
  const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : null;

  if (!from || !mimeBase64 || !recipientsRaw) {
    return context.json(
      { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'invalid body' } },
      400,
    );
  }

  // Bound the list before the normalization loop below allocates per entry.
  // Answered with the same 413 the MIME size guard uses — the framework
  // dispatches on `error.code`, not the status, and INVALID_TO is already
  // its code for an unusable recipient set.
  if (recipientsRaw.length > MAX_RECIPIENTS) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'INVALID_TO',
          message: `too many recipients (max ${MAX_RECIPIENTS}, got ${recipientsRaw.length})`,
        },
      },
      413,
    );
  }

  // Bound the sender before anything copies it — the lowercase, the strict
  // regex and the refusal that echoes it all sit below. Same 413 as the
  // recipient bound; INVALID_FROM is the framework's code for an unusable
  // sender. The address is deliberately not echoed back.
  if (from.length > MAX_SENDER_LENGTH) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'INVALID_FROM',
          message: `sender exceeds ${MAX_SENDER_LENGTH} characters`,
        },
      },
      413,
    );
  }

  // Fail closed on missing sender configuration before admission.
  const senderDomain = readSenderDomain(context.env);
  if (!senderDomain) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'email sender domain is not configured',
        },
      },
      502,
    );
  }

  // Recipients must be unique strings; the framework already dedups but we
  // re-validate so a buggy client cannot create duplicate attempts or logs.
  const recipients: Array<string> = [];
  const seen = new Set<string>();
  for (const r of recipientsRaw) {
    if (typeof r !== 'string') {
      continue;
    }
    // Before `.trim().toLowerCase()` — that call is the allocation.
    // The address is deliberately not echoed back.
    if (r.length > MAX_RECIPIENT_LENGTH) {
      return context.json(
        {
          ok: false,
          error: {
            code: 'INVALID_TO',
            message: `recipient exceeds ${MAX_RECIPIENT_LENGTH} characters`,
          },
        },
        413,
      );
    }
    const lower = r.trim().toLowerCase();
    if (!lower || seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    recipients.push(lower);
  }
  if (recipients.length === 0) {
    return context.json(
      { ok: false, error: { code: 'INVALID_TO', message: 'no recipients' } },
      200,
    );
  }

  // Pre-decode size guard — base64 expands ~4/3, so a base64 string longer
  // than `MAX_MIME_BYTES * 4 / 3 + 4` (the +4 absorbs padding rounding)
  // can't possibly decode to anything within the limit. Reject before
  // allocating a 75 MB Uint8Array for what we'd reject anyway. Defends
  // against adversarial OOM via outsized payloads.
  if (mimeBase64.length > Math.ceil((MAX_MIME_BYTES * 4) / 3) + 4) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'MIME_ERROR',
          message: `mime exceeds ${MAX_MIME_BYTES} bytes (base64 length ${mimeBase64.length})`,
        },
      },
      413,
    );
  }

  let raw: Uint8Array;
  try {
    raw = base64Decode(mimeBase64);
  } catch {
    return context.json(
      { ok: false, error: { code: 'MIME_ERROR', message: 'invalid base64 mime' } },
      400,
    );
  }
  // Defense-in-depth: the pre-decode check is conservative (uses base64
  // length), so a small over-by-one slip past it would still trip here.
  if (raw.byteLength > MAX_MIME_BYTES) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'MIME_ERROR',
          message: `mime exceeds ${MAX_MIME_BYTES} bytes (got ${raw.byteLength})`,
        },
      },
      413,
    );
  }
  if (!customMimeHeaderBytesWithinLimit(raw)) {
    return context.json(
      {
        ok: false,
        error: { code: 'MIME_ERROR', message: 'custom headers exceed the 16 KiB limit' },
      },
      413,
    );
  }

  // A sender outside the shared platform domain uses the custom-domain path.
  const fromAt = from.indexOf('@');
  const fromDomain = fromAt === -1 ? '' : from.slice(fromAt + 1).toLowerCase();
  if (fromDomain !== '' && fromDomain !== senderDomain) {
    return sendViaCustomDomain(
      context,
      projectId,
      from,
      fromDomain,
      senderDomain,
      recipients,
      raw,
      requestId,
      operationKey,
      sendDeadline,
    );
  }

  // Custom-domain sends use send_raw and do not depend on this binding.
  // Check the platform binding before shared-domain admission starts.
  const sendBinding = context.env.SEND_EMAIL;
  if (typeof sendBinding?.send !== 'function') {
    return context.json(
      {
        ok: false,
        error: {
          code: 'UPSTREAM_ERROR',
          message: 'email sending is not configured',
        },
      },
      502,
    );
  }

  // Sender ownership is checked against PostgreSQL by the admission service.
  const expectedSlug = from.split('@')[0]?.split('+')[0] ?? '';
  // Lowercase once for the strict regex + slug compare; the regex anchors
  // the whole string and intentionally rejects CR/LF, quotes, brackets,
  // and display-name forms before we touch EmailMessage.
  // The envelope is forwarded verbatim, so validation has to run on bytes that
  // cannot change under case folding. U+212A KELVIN SIGN lowercases to 'k' and
  // U+0130 to 'i', so a non-ASCII `from` can satisfy a lowercased regex and
  // still reach the shared envelope sender intact. Refuse it before that.
  if (!/^[\x21-\x7e]+$/.test(from)) {
    return context.json(
      {
        ok: false,
        error: { code: 'INVALID_FROM', message: 'from address must be printable ASCII' },
      },
      403,
    );
  }
  const fromLower = from.toLowerCase();
  if (!strictFromRe(senderDomain).test(fromLower)) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'INVALID_FROM',
          message: `from address must be <${expectedSlug}>[+tag]@${senderDomain}`,
        },
      },
      200,
    );
  }
  const fromLocal = fromLower.slice(0, fromLower.indexOf('@'));
  const localPrefix = fromLocal.split('+')[0] ?? '';
  if (localPrefix !== expectedSlug.toLowerCase()) {
    return context.json(
      {
        ok: false,
        error: {
          code: 'INVALID_FROM',
          message: `from address must be <${expectedSlug}>[+tag]@${senderDomain}`,
        },
      },
      200,
    );
  }

  // The envelope is pinned; now pin what the recipient will actually SEE.
  // A mismatch here is a request the framework never produces — `buildMime`
  // renders `From:` from the same `from.email` it posts as the envelope — so
  // it is refused outright rather than reported per recipient. Runs before
  // the admission call for the same reason as the slug pin. The refusal may
  // echo `from`: it is at most `MAX_SENDER_LENGTH` printable-ASCII bytes by
  // now.
  const mimeFromRefusal = refuseMimeFromMismatch(context, raw, from);
  if (mimeFromRefusal) {
    return mimeFromRefusal;
  }

  // The API transaction is authoritative for project state, sender identity,
  // recipient consent, suspension, and attempt quotas.
  const admitted = await admitDirectSend(context, sendDeadline, {
    projectId,
    operationKey,
    from,
    recipients,
    raw,
    transport: 'binding',
  });
  if (admitted instanceof Response) {
    return admitted;
  }
  const { admission, deliveries } = admitted;
  const allowed = admission.recipients
    .filter((r) => r.state === 'reserved')
    .map((r) => r.recipient);
  // Send fan-out. CF's `send_email` binding takes one recipient per
  // EmailMessage — we already split by recipient above.
  for (let index = 0; index < allowed.length; index++) {
    const r = allowed[index];
    if (sendDeadline.expired(EMAIL_SEND_FINALIZATION_MARGIN_MS)) {
      const unstarted = allowed.slice(index);
      const cancelled = await cancelUnstartedRecipients(
        context.env,
        admission.operationId,
        unstarted,
        sendDeadline.remainingMs(),
      );
      for (const recipient of unstarted) {
        deliveries.push({
          recipient,
          ok: false,
          state: cancelled ? 'cancelled' : 'outcome_unknown',
          error: cancelled
            ? {
                code: 'UPSTREAM_ERROR',
                message: 'email batch deadline elapsed before provider submission',
              }
            : { code: 'OUTCOME_UNKNOWN', message: 'could not cancel unstarted email attempt' },
        });
      }
      break;
    }
    try {
      await startEmailAttempt(
        context.env,
        admission.operationId,
        [r],
        sendDeadline.remainingMs(EMAIL_SEND_FINALIZATION_MARGIN_MS),
      );
    } catch {
      const cancelled = await cancelUnstartedRecipients(
        context.env,
        admission.operationId,
        [r],
        sendDeadline.remainingMs(),
      );
      deliveries.push({
        recipient: r,
        ok: false,
        state: cancelled ? 'cancelled' : 'outcome_unknown',
        error: cancelled
          ? {
              code: 'UPSTREAM_ERROR',
              message: 'email attempt did not start; reservation cancelled',
            }
          : { code: 'OUTCOME_UNKNOWN', message: 'could not confirm email attempt status' },
      });
      continue;
    }
    try {
      // EmailMessage accepts string | ReadableStream — wrap our buffered
      // bytes as a single-chunk stream. We can't reuse one stream across
      // recipients because streams are one-shot, so build per send.
      const msg = new EmailMessage(from, r, bytesToStream(raw));
      // Some CF builds don't return the messageId; we surface "" rather
      // than crash and let the framework decide whether to fall back.
      const result = await sendDeadline.run(
        () => sendBinding.send(msg),
        EMAIL_SEND_FINALIZATION_MARGIN_MS,
      );
      const providerReference = typeof result?.messageId === 'string' ? result.messageId : '';
      try {
        await finishEmailAttempt(
          context.env,
          admission.operationId,
          [r],
          'provider_accepted',
          { providerReference },
          sendDeadline.remainingMs(),
        );
      } catch {
        deliveries.push({
          recipient: r,
          ok: false,
          state: 'outcome_unknown',
          error: {
            code: 'OUTCOME_UNKNOWN',
            message: 'provider accepted email but outcome could not be recorded',
          },
        });
        continue;
      }
      deliveries.push({
        recipient: r,
        ok: true,
        state: 'provider_accepted',
        messageId: providerReference,
      });
    } catch {
      try {
        await finishEmailAttempt(
          context.env,
          admission.operationId,
          [r],
          'outcome_unknown',
          { errorCode: 'OUTCOME_UNKNOWN' },
          sendDeadline.remainingMs(),
        );
      } catch {
        /* persisted attempt_started remains unresolved */
      }
      deliveries.push({
        recipient: r,
        ok: false,
        state: 'outcome_unknown',
        error: {
          code: 'OUTCOME_UNKNOWN',
          message: 'provider outcome unknown; inspect email logs before retrying',
        },
      });
    }
  }

  logSend(projectId, requestId, deliveries);

  // Return each outcome; an unknown provider result must be inspected before retry.
  const anyFailed = deliveries.some((d) => !d.ok);
  if (anyFailed) {
    return context.json({ ok: false, operationId: admission.operationId, deliveries }, 200);
  }
  return context.json({
    ok: true,
    operationId: admission.operationId,
    ids: deliveries.map((d) => ({
      recipient: d.recipient,
      messageId: (d as { messageId: string }).messageId,
      state: 'provider_accepted',
    })),
  });
});

// -----------------------------------------------------------------------------
// Custom sender domains.
// -----------------------------------------------------------------------------

/**
 * The Email Sending REST `send_raw` result. snake_case — the REST schema
 * names the id `message_id`, unlike the `send_email` binding's camelCase
 * `messageId`. Cloudflare returns every recipient in
 * exactly one required list: `delivered` and `queued` are accepted;
 * `permanent_bounces` and `suppressed_recipients` are permanent failures.
 */
export interface SendRawResult {
  delivered?: unknown;
  message_id?: unknown;
  permanent_bounces?: unknown;
  queued?: unknown;
  suppressed_recipients?: unknown;
}

export interface ParsedSendRawResult {
  delivered: ReadonlySet<string>;
  messageId: string;
  permanentBounces: ReadonlySet<string>;
  queued: ReadonlySet<string>;
  suppressedRecipients: ReadonlySet<string>;
}

export type SendRawRecipientOutcome =
  | 'provider_accepted'
  | 'permanent_bounce'
  | 'suppressed'
  | 'outcome_unknown';

type SendRawHttpResponse = { ok: true; data: unknown } | { ok: false; status: number };

const MAX_SEND_RAW_RESPONSE_BYTES = 64 * 1024;

/** Submit once and read the provider response within one absolute deadline. */
export async function requestSendRaw(
  input: {
    accountId: string;
    bearer: string;
    from: string;
    recipients: Array<string>;
    mimeMessage: string;
  },
  deadlineMs = EMAIL_PROVIDER_DEADLINE_MS,
): Promise<SendRawHttpResponse> {
  const controller = new AbortController();
  const deadline = Date.now() + Math.min(EMAIL_PROVIDER_DEADLINE_MS, deadlineMs);
  const requestBody = JSON.stringify({
    from: input.from,
    recipients: input.recipients,
    mime_message: input.mimeMessage,
  });
  const beforeDeadline = async <T>(run: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      controller.abort();
      throw new Error('email sending request timed out');
    }
    const promise = run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('email sending request timed out'));
          }, remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };
  const response = await beforeDeadline(() =>
    fetch(
      `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/email/sending/send_raw`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.bearer}`,
          'content-type': 'application/json',
        },
        body: requestBody,
        signal: controller.signal,
      },
    ),
  );
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    return { ok: false, status: response.status };
  }
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_SEND_RAW_RESPONSE_BYTES)
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error('email sending API response too large');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('email sending API response unreadable');
  }
  const bytes = new Uint8Array(MAX_SEND_RAW_RESPONSE_BYTES);
  let size = 0;
  try {
    for (;;) {
      const chunk = await beforeDeadline(() => reader.read());
      if (chunk.done) {
        break;
      }
      if (size + chunk.value.byteLength > bytes.byteLength) {
        throw new Error('email sending API response too large');
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    if (declared !== null && size !== Number(declared)) {
      throw new Error('email sending API response length mismatch');
    }
    return {
      ok: true,
      data: JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size)),
      ) as unknown,
    };
  } finally {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
}

/** Read one required send_raw address list without discarding schema violations. */
function readSendRawAddressList(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return null;
    }
    out.add(entry.toLowerCase());
  }
  return out;
}

/**
 * Parse the documented send_raw result shape. Every recipient is classified by
 * exactly one of four required lists; accepting a partial response would turn
 * missing provider evidence into a false success.
 */
export function parseSendRawResult(value: unknown): ParsedSendRawResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const result = value as SendRawResult;
  const delivered = readSendRawAddressList(result.delivered);
  const permanentBounces = readSendRawAddressList(result.permanent_bounces);
  const queued = readSendRawAddressList(result.queued);
  const suppressedRecipients = readSendRawAddressList(result.suppressed_recipients);
  if (
    !delivered ||
    !permanentBounces ||
    !queued ||
    !suppressedRecipients ||
    typeof result.message_id !== 'string' ||
    result.message_id === ''
  ) {
    return null;
  }
  return {
    delivered,
    messageId: result.message_id,
    permanentBounces,
    queued,
    suppressedRecipients,
  };
}

/** Require exactly one provider classification for the requested recipient. */
export function classifySendRawRecipient(
  result: ParsedSendRawResult,
  recipient: string,
): SendRawRecipientOutcome {
  const target = recipient.toLowerCase();
  const classifications = [
    result.delivered.has(target),
    result.queued.has(target),
    result.permanentBounces.has(target),
    result.suppressedRecipients.has(target),
  ];
  if (classifications.filter(Boolean).length !== 1) {
    return 'outcome_unknown';
  }
  if (classifications[0] || classifications[1]) {
    return 'provider_accepted';
  }
  return classifications[2] ? 'permanent_bounce' : 'suppressed';
}

/** Send through the customer's Cloudflare account after project-bound admission. */
async function sendViaCustomDomain(
  context: Context<ProxyEnv>,
  projectId: string,
  from: string,
  fromDomain: string,
  senderDomain: string,
  recipients: Array<string>,
  raw: Uint8Array,
  requestId: string,
  operationKey: string,
  sendDeadline: EmailProviderDeadline,
): Promise<Response> {
  // The envelope is forwarded verbatim to the customer's account, so the
  // printable-ASCII guard runs here for the same reason as on the shared
  // path (case folding must not change the bytes downstream sees).
  if (!/^[\x21-\x7e]+$/.test(from)) {
    return context.json(
      {
        ok: false,
        error: { code: 'INVALID_FROM', message: 'from address must be printable ASCII' },
      },
      403,
    );
  }

  // The MIME From address must match the envelope sender before admission.
  const mimeFromRefusal = refuseMimeFromMismatch(context, raw, from);
  if (mimeFromRefusal) {
    return mimeFromRefusal;
  }

  // send_raw carries the MIME as a JSON string. Decode FATALLY: the
  // framework's builder emits 7-bit-clean MIME, and a body that is not
  // valid UTF-8 would be silently altered by a lenient decode — refuse it
  // instead. Local validation runs before admission.
  let mimeMessage: string;
  try {
    mimeMessage = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw);
  } catch {
    return context.json(
      { ok: false, error: { code: 'MIME_ERROR', message: 'mime must be valid UTF-8' } },
      400,
    );
  }

  const admitted = await admitDirectSend(context, sendDeadline, {
    projectId,
    operationKey,
    from,
    recipients,
    raw,
    transport: 'send_raw',
  });
  if (admitted instanceof Response) {
    return admitted;
  }
  const { admission, deliveries } = admitted;
  recipients = admission.recipients.filter((r) => r.state === 'reserved').map((r) => r.recipient);
  if (recipients.length === 0) {
    return emailActionResponse(context, admission.operationId, deliveries);
  }
  // A duplicate must return its durable outcome even if the credential was
  // subsequently revoked. Fresh attempts lease only after admission, then
  // cancel reservations if there can be no provider submission.
  const lease = await leaseEmailDomainCredential(
    context.env,
    fromDomain,
    projectId,
    sendDeadline.remainingMs(EMAIL_SEND_FINALIZATION_MARGIN_MS),
  );
  if (!lease) {
    await finishEmailAttempt(
      context.env,
      admission.operationId,
      recipients,
      'cancelled',
      {},
      sendDeadline.remainingMs(),
    ).catch(() => {});
    return context.json(
      {
        ok: false,
        operationId: admission.operationId,
        error: { code: 'UPSTREAM_ERROR', message: 'could not lease the domain credential' },
      },
      502,
    );
  }
  if (admission.accountId !== lease.accountId) {
    await finishEmailAttempt(
      context.env,
      admission.operationId,
      recipients,
      'cancelled',
      {},
      sendDeadline.remainingMs(),
    ).catch(() => {});
    return context.json(
      {
        ok: false,
        operationId: admission.operationId,
        error: { code: 'UPSTREAM_ERROR', message: 'email domain changed during admission' },
      },
      503,
    );
  }
  try {
    await startEmailAttempt(
      context.env,
      admission.operationId,
      recipients,
      sendDeadline.remainingMs(EMAIL_SEND_FINALIZATION_MARGIN_MS),
    );
  } catch {
    const cancelled = await cancelUnstartedRecipients(
      context.env,
      admission.operationId,
      recipients,
      sendDeadline.remainingMs(),
    );
    for (const recipient of recipients) {
      deliveries.push({
        recipient,
        ok: false,
        state: cancelled ? 'cancelled' : 'outcome_unknown',
        error: cancelled
          ? {
              code: 'UPSTREAM_ERROR',
              message: 'email attempt did not start; reservation cancelled',
            }
          : { code: 'OUTCOME_UNKNOWN', message: 'could not confirm email attempt status' },
      });
    }
    return emailActionResponse(context, admission.operationId, deliveries);
  }

  // One REST call carries every recipient — unlike the platform binding's
  // one EmailMessage per recipient. The response's message id is shared by
  // the whole list.
  let failure: { code: string; message: string } | null = null;
  let failureState: 'failed' | 'outcome_unknown' = 'failed';
  let sendRawResult: ParsedSendRawResult | null = null;
  let providerResponse: SendRawHttpResponse | null = null;
  try {
    providerResponse = await requestSendRaw(
      {
        accountId: lease.accountId,
        bearer: leaseBearer(lease),
        from,
        recipients,
        mimeMessage,
      },
      sendDeadline.remainingMs(EMAIL_SEND_FINALIZATION_MARGIN_MS),
    );
  } catch {
    failure = { code: 'UPSTREAM_ERROR', message: 'email sending request failed' };
    failureState = 'outcome_unknown';
  }
  if (providerResponse) {
    if (!providerResponse.ok) {
      // A fresh credential is leased for every attempt. Provider error
      // bodies are not echoed or logged.
      failure = {
        code: providerResponse.status === 429 ? 'QUOTA_EXCEEDED' : 'UPSTREAM_ERROR',
        message: `email sending API returned ${providerResponse.status}`,
      };
      failureState =
        providerResponse.status >= 500 || providerResponse.status === 408
          ? 'outcome_unknown'
          : 'failed';
    } else {
      const data = providerResponse.data;
      const success =
        typeof data === 'object' && data !== null
          ? (data as { success?: unknown }).success
          : undefined;
      if (success === false) {
        failure = { code: 'UPSTREAM_ERROR', message: 'email sending API refused the message' };
      } else if (success !== true) {
        failure = { code: 'OUTCOME_UNKNOWN', message: 'email sending API response invalid' };
        failureState = 'outcome_unknown';
      } else {
        sendRawResult = parseSendRawResult((data as { result?: unknown }).result);
        if (!sendRawResult) {
          failure = { code: 'OUTCOME_UNKNOWN', message: 'email sending API response invalid' };
          failureState = 'outcome_unknown';
        }
      }
    }
  }

  for (const r of recipients) {
    if (failure) {
      deliveries.push({ recipient: r, ok: false, state: failureState, error: failure });
      continue;
    }
    const outcome = classifySendRawRecipient(sendRawResult!, r);
    if (outcome === 'permanent_bounce') {
      deliveries.push({
        recipient: r,
        ok: false,
        state: 'failed',
        error: {
          code: 'UNVERIFIED_DESTINATION',
          message: `recipient '${r}' permanently bounced`,
        },
      });
    } else if (outcome === 'suppressed') {
      deliveries.push({
        recipient: r,
        ok: false,
        state: 'failed',
        error: {
          code: 'UNVERIFIED_DESTINATION',
          message: `recipient '${r}' is on the suppression list`,
        },
      });
    } else if (outcome === 'outcome_unknown') {
      deliveries.push({
        recipient: r,
        ok: false,
        state: 'outcome_unknown',
        error: {
          code: 'OUTCOME_UNKNOWN',
          message: 'email sending API did not classify the recipient',
        },
      });
    } else {
      deliveries.push({
        recipient: r,
        ok: true,
        state: 'provider_accepted',
        messageId: sendRawResult!.messageId,
      });
    }
  }

  for (const delivery of deliveries.filter((d) =>
    admission.recipients.some((r) => r.recipient === d.recipient && r.state === 'reserved'),
  )) {
    try {
      await finishEmailAttempt(
        context.env,
        admission.operationId,
        [delivery.recipient],
        delivery.ok
          ? 'provider_accepted'
          : delivery.state === 'outcome_unknown'
            ? 'outcome_unknown'
            : 'failed',
        {
          providerReference: delivery.messageId,
          errorCode: delivery.ok
            ? undefined
            : delivery.state === 'outcome_unknown'
              ? 'OUTCOME_UNKNOWN'
              : (failure?.code ?? delivery.error?.code),
        },
        sendDeadline.remainingMs(),
      );
      delivery.state = delivery.ok
        ? 'provider_accepted'
        : delivery.state === 'outcome_unknown'
          ? 'outcome_unknown'
          : 'failed';
      if (delivery.state === 'outcome_unknown' && !delivery.ok) {
        delivery.error = {
          code: 'OUTCOME_UNKNOWN',
          message: 'provider outcome unknown; inspect email logs before retrying',
        };
      }
    } catch {
      delivery.ok = false;
      delivery.state = 'outcome_unknown';
      delivery.error = {
        code: 'OUTCOME_UNKNOWN',
        message: 'provider outcome could not be recorded',
      };
    }
  }
  logSend(projectId, requestId, deliveries);

  // Same mid-batch contract as the shared path: any per-recipient failure
  // (bounce, suppression, or a whole-call failure) answers ok:false with
  // the complete per-recipient evidence needed for a safe retry decision.
  if (deliveries.some((d) => !d.ok)) {
    return context.json({ ok: false, operationId: admission.operationId, deliveries }, 200);
  }
  return context.json({
    ok: true,
    operationId: admission.operationId,
    ids: deliveries.map((d) => ({
      recipient: d.recipient,
      messageId: (d as { messageId: string }).messageId,
      state: 'provider_accepted' as const,
    })),
  });
}

// -----------------------------------------------------------------------------
// Inbound delivery log — kept here because it's invoked from email-router.ts
// inside the same worker (bypasses HTTP/auth).
// -----------------------------------------------------------------------------

/**
 * Inbound delivery log. Inlined here rather than via service binding because
 * the email-router lives in this same worker; routing through env.API would 404.
 */
export async function recordInboundDelivery(
  projectId: string,
  info: { from: string; to: string; byteSize: number; status: string },
): Promise<void> {
  console.log(
    `[email-recv] ${projectId} ${sanitizeForLog(info.from, 320)} -> ${sanitizeForLog(info.to, 320)} ${info.status} (${info.byteSize}B) @${Date.now()}`,
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface RecipientResult {
  recipient: string;
  ok: boolean;
  state?: string;
  messageId?: string;
  error?: { code: string; message: string };
}

/** Refuse a message whose MIME `From:` is not exactly the envelope sender. */
function refuseMimeFromMismatch(
  context: Context<ProxyEnv>,
  raw: Uint8Array,
  from: string,
): Response | null {
  const mimeFrom = readMimeFromAddrSpec(raw);
  if (mimeFrom.ok && mimeFrom.addrSpec.toLowerCase() === from.toLowerCase()) {
    return null;
  }
  const detail = mimeFrom.ok
    ? 'the From header address does not match the envelope sender'
    : MIME_FROM_REFUSALS[mimeFrom.reason];
  return context.json(
    {
      ok: false,
      error: {
        code: 'INVALID_FROM',
        message: `mime From must be the envelope sender ${from}: ${detail}`,
      },
    },
    403,
  );
}

/**
 * Admit a direct send. Rows that already have an outcome become deliveries;
 * a replay answers immediately with the recorded outcome.
 */
async function admitDirectSend(
  context: Context<ProxyEnv>,
  sendDeadline: EmailProviderDeadline,
  input: {
    projectId: string;
    operationKey: string;
    from: string;
    recipients: Array<string>;
    raw: Uint8Array;
    transport: 'binding' | 'send_raw';
  },
): Promise<Response | { admission: Admission; deliveries: Array<RecipientResult> }> {
  const { projectId, operationKey, from, recipients, raw, transport } = input;
  let admission;
  try {
    admission = await admitEmail(
      context.env,
      {
        projectId,
        kind: 'direct',
        key: operationKey,
        digest: await emailPayloadDigest('direct', from, recipients, raw),
        from,
        recipients,
        transport,
      },
      sendDeadline.remainingMs(EMAIL_SEND_FINALIZATION_MARGIN_MS),
    );
  } catch (error) {
    const conflict = error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT';
    return context.json(
      {
        ok: false,
        error: {
          code: conflict ? 'IDEMPOTENCY_CONFLICT' : 'UPSTREAM_ERROR',
          message: conflict
            ? 'idempotency key has different content'
            : 'email admission unavailable',
        },
      },
      conflict ? 409 : 503,
    );
  }
  const deliveries: Array<RecipientResult> = admission.recipients
    .filter((r) => r.state !== 'reserved')
    .map((r) => ({
      recipient: r.recipient,
      ok: r.state === 'provider_accepted',
      state: r.state,
      messageId: r.providerReference ?? undefined,
      error:
        r.state === 'provider_accepted'
          ? undefined
          : {
              code:
                r.errorCode ??
                (r.state === 'outcome_unknown' || r.state === 'attempt_started'
                  ? 'OUTCOME_UNKNOWN'
                  : r.state === 'cancelled'
                    ? 'UPSTREAM_ERROR'
                    : 'UNVERIFIED_DESTINATION'),
              message:
                r.state === 'outcome_unknown' || r.state === 'attempt_started'
                  ? 'provider outcome unknown; inspect email logs before retrying'
                  : r.state === 'cancelled'
                    ? 'email attempt was cancelled before provider submission'
                    : 'recipient was not admitted',
            },
    }));
  if (admission.replay) {
    for (const row of admission.recipients.filter((r) => r.state === 'reserved')) {
      deliveries.push({
        recipient: row.recipient,
        ok: false,
        state: 'reserved',
        error: {
          code: 'OUTCOME_UNKNOWN',
          message: 'email action remains reserved; inspect email logs before retrying',
        },
      });
    }
    return emailActionResponse(context, admission.operationId, deliveries);
  }
  return { admission, deliveries };
}

/**
 * A failed start response is ambiguous: its transaction may or may not have
 * committed. Cancellation is the safe discriminator because the API accepts
 * it only from `reserved`; a committed `attempt_started` transition conflicts.
 */
async function cancelUnstartedRecipients(
  env: Pick<Env, 'API' | 'EMAIL_SIGNING_SECRET'>,
  operationId: string,
  recipients: Array<string>,
  deadlineMs?: number,
): Promise<boolean> {
  try {
    const result = await finishEmailAttempt(
      env,
      operationId,
      recipients,
      'cancelled',
      {},
      deadlineMs,
    );
    return recipients.every((recipient) =>
      result.recipients.some((row) => row.recipient === recipient && row.state === 'cancelled'),
    );
  } catch {
    return false;
  }
}

function emailActionResponse(
  context: Context<ProxyEnv>,
  operationId: string,
  deliveries: Array<RecipientResult>,
) {
  if (deliveries.length === 0) {
    return context.json(
      {
        ok: false,
        operationId,
        error: { code: 'OUTCOME_UNKNOWN', message: 'email action remains reserved' },
      },
      200,
    );
  }
  if (deliveries.some((d) => !d.ok)) {
    return context.json({ ok: false, operationId, deliveries }, 200);
  }
  return context.json(
    {
      ok: true,
      operationId,
      ids: deliveries.map((d) => ({
        recipient: d.recipient,
        messageId: d.messageId ?? '',
        state: d.state,
      })),
    },
    200,
  );
}

function logSend(projectId: string, requestId: string, deliveries: Array<RecipientResult>): void {
  for (const d of deliveries) {
    const status = d.ok ? 'sent' : (d.error?.code ?? 'unknown_error');
    const id = d.messageId ?? '';
    console.log(
      `[email-log] ${projectId} ${requestId} ${sanitizeForLog(d.recipient, 320)} ${status} ${id} @${Date.now()}`,
    );
  }
}

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export { app as email };
