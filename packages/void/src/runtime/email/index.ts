// void/email — outbound email. MIME is built here, then sent through the
// first available transport: the `void dev` inbox, the worker's own
// `SEND_EMAIL` binding (`void deploy --platform cloudflare`, one
// `EmailMessage` per recipient), or the Void platform proxy, which enforces
// project policy and quotas.

import { isRecord } from '@void/deploy-core';
import { bytesToBase64 } from './base64.ts';
import { readBoundedJson, withTimeout } from './email-protocol.ts';
import {
  captureMessage,
  DEV_INBOX_ACK_HEADER,
  DEV_INBOX_ACK_VALUE,
  DEV_INBOX_CAPTURE_URL,
  DEV_INBOX_ENV_VAR,
  DEV_INBOX_TOKEN_ENV_VAR,
  DEV_INBOX_TOKEN_HEADER,
  dispatchToSinks,
  hasActiveSink,
  serializeCapturedMessage,
  type CapturedMessage,
} from './email/dev-inbox.ts';
import {
  bytesToReadableStream,
  readEnvString,
  readProjectSlug,
  tryGetRawRuntimeEnv,
} from './email/inbound.ts';
import { buildMime, MimeError, newId, normalizeEmail } from './email/mime.ts';
import type {
  EmailDeliveryState,
  NormalizedEmail,
  SendEmailDelivery,
  SendEmailErrorCode,
  SendEmailError,
  SendEmailOptions,
  SendEmailRecipientResult,
  SendEmailResult,
} from './email/types.ts';

export type {
  Address,
  Attachment,
  EmailDeliveryState,
  NormalizedEmail,
  SendEmailDelivery,
  SendEmailError,
  SendEmailErrorCode,
  SendEmailOptions,
  SendEmailRecipientResult,
  SendEmailResult,
} from './email/types.ts';

export {
  createMessageProxy,
  defineEmail,
  enactEmailActions,
  isForwardableEmailMessage,
  parseEmail,
  ParseEmailError,
  replyEmail,
} from './email/inbound.ts';
export type {
  EmailAction,
  EmailEnvelope,
  EmailHandler,
  EmailHandlerInfo,
  MessageProxy,
  ParsedEmail,
  ParseEmailErrorCode,
  ReplyEmailOptions,
} from './email/inbound.ts';

// `createEmail` throws `MimeError`; export it with the functions that throw it.
export { MimeError } from './email/mime.ts';
export type { MimeErrorCode } from './email/mime.ts';

function makeError(code: SendEmailErrorCode, message: string, cause?: unknown): SendEmailError {
  return cause === undefined ? { code, message } : { code, message, cause };
}

interface ProxyEnv {
  __VOID_PROXY?: { fetch(req: Request | string, init?: RequestInit): Promise<Response> };
  __VOID_PROXY_TOKEN?: string;
  __PROJECT_ID?: string;
}

// The `send_email` binding `void deploy --platform cloudflare` provisions
// (`cli/email-cloudflare.ts` writes the same name into wrangler.jsonc).
const SEND_EMAIL_BINDING_NAME = 'SEND_EMAIL';
const EMAIL_PROVIDER_DEADLINE_MS = 30_000;
const PLATFORM_SEND_DEADLINE_MS = 60_000;

class EmailBindingTimeoutError extends Error {
  constructor() {
    super('email binding outcome unknown after timeout');
    this.name = 'EmailBindingTimeoutError';
  }
}

// The legacy `EmailMessage` overload of `SendEmail.send`. Only `messageId`
// is read, and defensively: some builds have returned nothing.
interface SendEmailBinding {
  send(message: EmailMessage): Promise<{ messageId?: unknown } | undefined | void>;
}

function resolveSendEmailBinding(
  env: Record<string, unknown> | undefined,
): SendEmailBinding | undefined {
  const binding = env?.[SEND_EMAIL_BINDING_NAME];
  if (typeof binding !== 'object' || binding === null) {
    return undefined;
  }
  return typeof (binding as { send?: unknown }).send === 'function'
    ? (binding as SendEmailBinding)
    : undefined;
}

/**
 * Map a `send_email` binding error to a framework code: Email Service `E_*`
 * codes, then the older Email Routing message. Anything else is
 * `OUTCOME_UNKNOWN`: once `send()` started, a rejection does not prove the
 * provider declined the message.
 */
function classifyBindingError(e: unknown): SendEmailError {
  const message = e instanceof Error ? e.message : String(e);
  const code =
    typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : '';
  switch (code) {
    case 'E_RECIPIENT_NOT_ALLOWED':
      return makeError('UNVERIFIED_DESTINATION', message, e);
    case 'E_SENDER_NOT_VERIFIED':
    case 'E_SENDER_DOMAIN_NOT_AVAILABLE':
      return makeError('INVALID_FROM', message, e);
    case 'E_RATE_LIMIT_EXCEEDED':
    case 'E_DAILY_LIMIT_EXCEEDED':
      return makeError('QUOTA_EXCEEDED', message, e);
    default:
      break;
  }
  if (UNVERIFIED_DESTINATION_RE.test(message)) {
    return makeError('UNVERIFIED_DESTINATION', message, e);
  }
  return makeError('OUTCOME_UNKNOWN', message, e);
}

// Anchored to Cloudflare's own phrasing ("destination address … not (yet)
// verified"), with bounded runs so a long preamble or a multi-line stack
// cannot drag an unrelated mention of the address into a false positive.
const UNVERIFIED_DESTINATION_RE =
  /^[^\n]{0,200}destination address[^\n]{0,200}not (?:yet )?verified/i;

/**
 * Send one `EmailMessage` per recipient through the worker's own binding,
 * within one bounded batch, reporting `deliveries` as the proxy does. The
 * stream is rebuilt per send: a `ReadableStream` is one-shot.
 */
async function sendViaBinding(
  binding: SendEmailBinding,
  from: string,
  recipients: ReadonlyArray<string>,
  raw: Uint8Array,
  fallbackId: string,
): Promise<SendEmailResult> {
  let EmailMessage: (typeof import('cloudflare:email'))['EmailMessage'];
  try {
    ({ EmailMessage } = await import('cloudflare:email'));
  } catch (e) {
    return err(
      'UPSTREAM_ERROR',
      `email: SEND_EMAIL is bound but cloudflare:email could not be loaded: ${e instanceof Error ? e.message : String(e)}`,
      e,
    );
  }
  const deliveries: Array<SendEmailRecipientResult> = [];
  const deadline = Date.now() + PLATFORM_SEND_DEADLINE_MS;
  const remaining = () => Math.min(EMAIL_PROVIDER_DEADLINE_MS, deadline - Date.now());
  for (let index = 0; index < recipients.length; index++) {
    const recipient = recipients[index];
    if (remaining() <= 0) {
      for (const unstarted of recipients.slice(index)) {
        deliveries.push({
          recipient: unstarted,
          ok: false,
          state: 'cancelled',
          error: makeError(
            'UPSTREAM_ERROR',
            'email: batch deadline elapsed before provider submission',
          ),
        });
      }
      break;
    }
    try {
      const result = await withTimeout(
        remaining(),
        () => binding.send(new EmailMessage(from, recipient, bytesToReadableStream(raw))),
        () => new EmailBindingTimeoutError(),
      );
      const mid = typeof result?.messageId === 'string' ? result.messageId : '';
      deliveries.push({ recipient, ok: true, messageId: mid || fallbackId });
    } catch (e) {
      const error =
        e instanceof EmailBindingTimeoutError
          ? makeError(
              'OUTCOME_UNKNOWN',
              'email: binding submission timed out; inspect provider logs before retrying',
              e,
            )
          : classifyBindingError(e);
      deliveries.push({
        recipient,
        ok: false,
        ...(error.code === 'OUTCOME_UNKNOWN' ? { state: 'outcome_unknown' as const } : {}),
        error,
      });
    }
  }
  if (deliveries.some((d) => !d.ok)) {
    return { ok: false, deliveries };
  }
  return {
    ok: true,
    ids: deliveries.map((d) => ({
      recipient: d.recipient,
      messageId: (d as { messageId: string }).messageId,
    })),
  };
}

/**
 * Recipients deduplicated by lowercased address: Cloudflare does not
 * collapse duplicate envelopes, and each one costs quota.
 */
function uniqueRecipients(normalized: NormalizedEmail): Array<string> {
  const seen = new Set<string>();
  const recipients: Array<string> = [];
  for (const r of [...normalized.to, ...normalized.cc, ...normalized.bcc]) {
    const lower = r.email.toLowerCase();
    if (seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    recipients.push(lower);
  }
  return recipients;
}

function resolveDefaultFrom(opts: SendEmailOptions): SendEmailOptions {
  const supplied = opts.from;
  // `null` counts as missing: `parseAddress` would throw a TypeError,
  // reported as MIME_ERROR rather than INVALID_FROM.
  const isEmpty =
    supplied === undefined ||
    supplied === null ||
    (typeof supplied === 'string' && supplied.trim() === '') ||
    (typeof supplied === 'object' && supplied !== null && !('email' in supplied));
  if (!isEmpty) {
    return opts;
  }
  // `__VOID_EMAIL_FROM` (`email.from` in void.config.ts) wins over the
  // platform's `<slug>+noreply@<domain>`: it names a sender on purpose.
  const configured = readEnvString('__VOID_EMAIL_FROM');
  if (configured) {
    return { ...opts, from: configured };
  }
  const slug = readProjectSlug();
  const domain = readEnvString('__VOID_EMAIL_DOMAIN');
  if (!slug || !domain) {
    // Drop `null` so the caller reports a clean INVALID_FROM.
    if (supplied === null) {
      const next = { ...opts };
      delete (next as { from?: unknown }).from;
      return next;
    }
    return opts;
  }
  return { ...opts, from: `${slug}+noreply@${domain}` };
}

function err(code: SendEmailErrorCode, message: string, cause?: unknown): SendEmailResult {
  return { ok: false, error: makeError(code, message, cause) };
}

interface ProxySendBody {
  projectId: string;
  /** Project HMAC accepted by the shared proxy authentication middleware. */
  aiToken: string;
  from: string;
  recipients: Array<string>;
  mimeBase64: string;
  requestId: string;
  idempotencyKey?: string;
}

type ProxyResponse = { operationId: unknown } & (
  | { ok: true; ids: Array<unknown> }
  | { ok: false; error: { code: unknown; message: unknown } }
  | { ok: false; deliveries: Array<unknown> }
);

function coerceErrorCode(code: unknown): SendEmailErrorCode {
  const known: Array<SendEmailErrorCode> = [
    'BINDING_MISSING',
    'INVALID_FROM',
    'INVALID_TO',
    'UNVERIFIED_DESTINATION',
    'MIME_ERROR',
    'QUOTA_EXCEEDED',
    'IDEMPOTENCY_CONFLICT',
    'OUTCOME_UNKNOWN',
    'UPSTREAM_ERROR',
  ];
  return known.find((knownCode) => knownCode === code) ?? 'UPSTREAM_ERROR';
}

/**
 * Text of the `{ error, message? }` refusal the proxy's middleware sends
 * ahead of the email handler, preferring the human `message`; `null` for any
 * other shape.
 */
function readProxyRefusal(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (typeof error !== 'string' || error === '') {
    return null;
  }
  return typeof message === 'string' && message !== '' ? message : error;
}

// A malformed response leaves the provider outcome unknown.
function readProxyResponse(value: unknown): ProxyResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  const operationId = value.operationId;
  if (value.ok === true && Array.isArray(value.ids)) {
    return { ok: true, ids: value.ids, operationId };
  }
  if (value.ok !== false) {
    return null;
  }
  if (Array.isArray(value.deliveries)) {
    return { ok: false, deliveries: value.deliveries, operationId };
  }
  const error = value.error;
  if (typeof error === 'object' && error !== null) {
    return {
      ok: false,
      error: {
        code: 'code' in error ? error.code : undefined,
        message: 'message' in error ? error.message : undefined,
      },
      operationId,
    };
  }
  return null;
}

type RecipientListRead<T> = { ok: true; entries: Array<T> } | { ok: false; reason: string };

/**
 * Require exactly one valid outcome per requested recipient, in any order. A
 * missing, duplicate or foreign entry makes the whole result unknown, since
 * trimming it could hide a submission. Diagnostics name entries by index.
 */
function readRecipientList<T>(
  raw: Array<unknown>,
  recipients: ReadonlyArray<string>,
  shape: string,
  readEntry: (entry: Record<string, unknown>, recipient: string) => T | undefined,
): RecipientListRead<T> {
  if (raw.length !== recipients.length) {
    return { ok: false, reason: `expected ${recipients.length} deliveries, got ${raw.length}` };
  }
  const requested = new Set(recipients);
  const seen = new Set<string>();
  const entries: Array<T> = [];
  for (const [i, d] of raw.entries()) {
    const entry = typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : null;
    const recipient = entry?.recipient;
    if (entry === null || typeof recipient !== 'string') {
      return { ok: false, reason: `entry ${i} is not ${shape}` };
    }
    const value = readEntry(entry, recipient);
    if (value === undefined) {
      return { ok: false, reason: `entry ${i} is not ${shape}` };
    }
    if (!requested.has(recipient)) {
      return { ok: false, reason: `entry ${i} names a recipient that was not requested` };
    }
    if (seen.has(recipient)) {
      return { ok: false, reason: `entry ${i} repeats a recipient` };
    }
    seen.add(recipient);
    entries.push(value);
  }
  return { ok: true, entries };
}

/**
 * The `ids` of an `ok: true` response, one accepted outcome per recipient.
 * The framework's Message-ID stands in for an empty provider reference.
 */
function readDeliveryList(
  raw: Array<unknown>,
  recipients: ReadonlyArray<string>,
  fallbackId: string,
): RecipientListRead<SendEmailDelivery> {
  return readRecipientList(
    raw,
    recipients,
    '{ recipient: string, messageId: string }',
    (entry, recipient) =>
      typeof entry.messageId === 'string'
        ? {
            recipient,
            messageId: entry.messageId || fallbackId,
            ...(entry.state === 'provider_accepted' ? { state: 'provider_accepted' as const } : {}),
          }
        : undefined,
  );
}

/**
 * Preserve each recipient's acceptance or error and recorded state. `ok: false`
 * alone does not establish that retrying is safe: submission may be unresolved.
 */
function readFailureDeliveries(
  raw: Array<unknown>,
  recipients: ReadonlyArray<string>,
  fallbackId: string,
): RecipientListRead<SendEmailRecipientResult> {
  return readRecipientList(
    raw,
    recipients,
    '{ recipient: string, ok: true, messageId: string } | { recipient: string, ok: false, error: { message: string } }',
    (entry, recipient) => {
      if (entry.ok === true) {
        return typeof entry.messageId === 'string'
          ? {
              recipient,
              ok: true,
              messageId: entry.messageId || fallbackId,
              ...(entry.state === 'provider_accepted'
                ? { state: 'provider_accepted' as const }
                : {}),
            }
          : undefined;
      }
      if (entry.ok === false) {
        const state = readDeliveryState(entry.state);
        const error = entry.error as { code?: unknown; message?: unknown } | null | undefined;
        return typeof error === 'object' && error !== null && typeof error.message === 'string'
          ? {
              recipient,
              ok: false,
              error: makeError(coerceErrorCode(error.code), error.message),
              ...(state ? { state } : {}),
            }
          : undefined;
      }
      return undefined;
    },
  );
}

function readDeliveryState(value: unknown): EmailDeliveryState | undefined {
  const states: ReadonlyArray<EmailDeliveryState> = [
    'rejected',
    'reserved',
    'attempt_started',
    'provider_accepted',
    'failed',
    'outcome_unknown',
    'cancelled',
  ];
  return states.find((state) => state === value);
}

const MAX_PROXY_RESPONSE_BYTES = 64 * 1024;

async function readResponseAsResult(
  res: Response,
  recipients: ReadonlyArray<string>,
  fallbackId: string,
  beforeDeadline: <T>(run: () => Promise<T>) => Promise<T>,
): Promise<SendEmailResult> {
  let body: unknown;
  try {
    body = await readBoundedJson(res, MAX_PROXY_RESPONSE_BYTES, beforeDeadline);
  } catch {
    return err(
      'OUTCOME_UNKNOWN',
      `email: could not establish the send outcome (status ${res.status}); check email logs or repeat the same idempotency key`,
    );
  }
  const response = readProxyResponse(body);
  if (response === null) {
    // A `{ error, message? }` refusal from the proxy's middleware is
    // well-formed: report its text.
    const refusal = readProxyRefusal(body);
    if (!res.ok && refusal !== null) {
      return err('UPSTREAM_ERROR', `email: proxy returned ${res.status}: ${refusal}`, body);
    }
    return err(
      'OUTCOME_UNKNOWN',
      `email: proxy returned malformed response (status ${res.status})`,
      body,
    );
  }
  const malformedList = (reason: string): SendEmailResult =>
    err(
      'OUTCOME_UNKNOWN',
      `email: proxy returned a malformed delivery list (${reason}); do not retry with a new idempotency key`,
      body,
    );
  const operation =
    typeof response.operationId === 'string' && response.operationId.length <= 128
      ? { operationId: response.operationId }
      : {};
  if (response.ok === true) {
    const list = readDeliveryList(response.ids, recipients, fallbackId);
    return list.ok ? { ok: true, ids: list.entries, ...operation } : malformedList(list.reason);
  }
  if ('deliveries' in response) {
    const list = readFailureDeliveries(response.deliveries, recipients, fallbackId);
    return list.ok
      ? { ok: false, deliveries: list.entries, ...operation }
      : malformedList(list.reason);
  }
  const e = response.error;
  return {
    ...err(
      coerceErrorCode(e.code),
      typeof e.message === 'string' ? e.message : 'email: upstream send failed',
    ),
    ...operation,
  };
}

interface DevInboxFetcher {
  fetch(req: Request | string, init?: RequestInit): Promise<Response>;
}

interface DevInbox {
  fetcher: DevInboxFetcher;
  /**
   * Dev-trigger token. When absent the POST still goes out and the 401 is
   * reported; the inbox is never skipped for a real transport.
   */
  token: string | undefined;
}

/**
 * The loopback into the `void dev` inbox: `DEV_INBOX_ENV_VAR` names the
 * assets binding, which in dev reaches the Vite dev server. Undefined
 * outside dev.
 */
function resolveDevInbox(env: Record<string, unknown> | undefined): DevInbox | undefined {
  const bindingName = env?.[DEV_INBOX_ENV_VAR];
  if (typeof bindingName !== 'string' || bindingName.length === 0) {
    return undefined;
  }
  const binding = env?.[bindingName];
  if (typeof binding !== 'object' || binding === null) {
    return undefined;
  }
  if (typeof (binding as { fetch?: unknown }).fetch !== 'function') {
    return undefined;
  }
  const token = env?.[DEV_INBOX_TOKEN_ENV_VAR];
  return {
    fetcher: binding as DevInboxFetcher,
    token: typeof token === 'string' && token.length > 0 ? token : undefined,
  };
}

// A local loopback answers immediately; this only exists so a wedged dev
// server degrades into an error instead of hanging the user's request.
const DEV_INBOX_TIMEOUT_MS = 5000;

/** Bound on the error text a failed capture echoes from the dev server. */
const DEV_INBOX_ERROR_EXCERPT_CHARS = 200;
const DEV_INBOX_ERROR_EXCERPT_TIMEOUT_MS = 1000;

/**
 * First line of a refusal, so a 401 names the header it wanted. One chunk
 * under its own deadline: a stalled body must not hang `sendEmail`.
 */
async function readErrorExcerpt(res: Response): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = res.body?.getReader();
    if (!reader) {
      return '';
    }
    const first = await Promise.race([
      reader.read().then(({ value }) => value),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), DEV_INBOX_ERROR_EXCERPT_TIMEOUT_MS);
      }),
    ]);
    void reader.cancel().catch(() => {});
    if (!first) {
      return '';
    }
    return new TextDecoder()
      .decode(first)
      .trim()
      .split('\n')[0]
      .slice(0, DEV_INBOX_ERROR_EXCERPT_CHARS);
  } catch {
    return '';
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function postToDevInbox(
  inbox: DevInbox,
  captured: CapturedMessage,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const attempt = Promise.resolve(
      inbox.fetcher.fetch(`http://localhost${DEV_INBOX_CAPTURE_URL}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(inbox.token !== undefined && { [DEV_INBOX_TOKEN_HEADER]: inbox.token }),
        },
        body: serializeCapturedMessage(captured),
      }),
    ).then(
      (res) => ({ kind: 'response' as const, res }),
      (cause: unknown) => ({ kind: 'error' as const, cause }),
    );
    const settled = await Promise.race([
      attempt,
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), DEV_INBOX_TIMEOUT_MS);
      }),
    ]);
    if (settled.kind === 'timeout') {
      return { ok: false, reason: `no response within ${DEV_INBOX_TIMEOUT_MS}ms` };
    }
    if (settled.kind === 'error') {
      const cause = settled.cause;
      return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
    }
    const { res } = settled;
    if (!res.ok) {
      const excerpt = await readErrorExcerpt(res);
      return {
        ok: false,
        reason: `dev server responded ${res.status}${excerpt ? `: ${excerpt}` : ''}`,
      };
    }
    // A 200 alone is not proof: if the assets binding ever stops being a
    // dev-server loopback, a static/SPA response is also a 200.
    if (res.headers.get(DEV_INBOX_ACK_HEADER) !== DEV_INBOX_ACK_VALUE) {
      return { ok: false, reason: 'response did not come from the dev inbox' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** A captured send's result: one id per unique recipient, as a deployed send reports. */
function capturedResult(normalized: NormalizedEmail, captureId: string): SendEmailResult {
  return {
    ok: true,
    ids: uniqueRecipients(normalized).map((recipient) => ({ recipient, messageId: captureId })),
  };
}

/**
 * Send an email via the worker's own `SEND_EMAIL` binding or the Void
 * platform proxy.
 *
 * During `void dev` the message is captured by the local inbox
 * (`/__void/inbox`) and never reaches the proxy; an in-process sink
 * (`void/email/testing`) takes precedence over it.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  if (
    opts.idempotencyKey !== undefined &&
    (typeof opts.idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(opts.idempotencyKey))
  ) {
    return err(
      'MIME_ERROR',
      'email: idempotencyKey must contain 1–128 printable non-space ASCII characters.',
    );
  }
  const resolvedOpts = resolveDefaultFrom(opts);
  if (resolvedOpts.from === undefined) {
    return err(
      'INVALID_FROM',
      "email: 'from' is required. Set it explicitly or deploy via Void so the platform-injected __VOID_PROJECT_SLUG and __VOID_EMAIL_DOMAIN can default it to <slug>+noreply@<domain>.",
    );
  }

  // `from` is now guaranteed defined by the check above; the cast keeps
  // normalizeEmail's stricter signature without widening it.
  const optsWithFrom = resolvedOpts as SendEmailOptions & {
    from: NonNullable<SendEmailOptions['from']>;
  };

  let normalized: NormalizedEmail;
  let raw: Uint8Array;
  let messageId: string;
  try {
    normalized = await normalizeEmail(optsWithFrom);
    ({ raw, messageId } = buildMime(normalized));
  } catch (e) {
    if (e instanceof MimeError) {
      return err(e.code, e.message, e);
    }
    return err('MIME_ERROR', e instanceof Error ? e.message : String(e), e);
  }

  const rawEnv = tryGetRawRuntimeEnv();

  // A sink in this isolate (`createEmailTestHarness`) owns the capture; do
  // not also post it to the dev inbox.
  if (!opts.sendInDev && hasActiveSink()) {
    const captured = captureMessage(normalized, raw, messageId);
    dispatchToSinks(captured);
    return capturedResult(normalized, captured.id);
  }

  // `void dev`: the inbox buffer lives in the Vite dev server's Node process,
  // which this isolate has no shared memory with. Hand the message over.
  const devInbox = opts.sendInDev ? undefined : resolveDevInbox(rawEnv);
  if (devInbox) {
    const captured = captureMessage(normalized, raw, messageId);
    const delivered = await postToDevInbox(devInbox, captured);
    if (delivered.ok) {
      return capturedResult(normalized, captured.id);
    }
    const message = `email: the void dev inbox at ${DEV_INBOX_CAPTURE_URL} is unreachable (${delivered.reason}), so nothing was captured and nothing was sent.`;
    console.warn(`[void/email] ${message}`);
    return err('UPSTREAM_ERROR', message);
  }

  const recipients = uniqueRecipients(normalized);

  // Own-account deploy: the worker holds the binding itself, so there is no
  // proxy hop and no platform quota — Cloudflare's own limits apply.
  const sendBinding = resolveSendEmailBinding(rawEnv);
  if (sendBinding) {
    if (opts.idempotencyKey !== undefined) {
      return err(
        'MIME_ERROR',
        'email: idempotencyKey requires a Void platform; the native Cloudflare binding cannot deduplicate sends.',
      );
    }
    return sendViaBinding(sendBinding, normalized.from.email, recipients, raw, messageId);
  }

  const env = rawEnv as ProxyEnv | undefined;
  const proxy = env?.__VOID_PROXY;
  const projectId = env?.__PROJECT_ID;
  const proxyToken = env?.__VOID_PROXY_TOKEN;
  if (!proxy || !projectId || !proxyToken) {
    return err(
      'BINDING_MISSING',
      'email: neither SEND_EMAIL nor __VOID_PROXY is available, so nothing was sent. Deploy via Void to bind the platform proxy, ' +
        'or set `email.from` in void.config.ts so `void deploy --platform cloudflare` provisions the SEND_EMAIL binding. ' +
        'Under `void dev` messages are captured by the local inbox at /__void/inbox instead — reaching this error there means ' +
        'that path was bypassed by the deprecated `sendInDev: true` (it never delivers) or unavailable ' +
        '(the worker has no assets binding to reach the dev server through).',
    );
  }

  const body: ProxySendBody = {
    projectId,
    aiToken: proxyToken,
    from: normalized.from.email,
    recipients,
    mimeBase64: bytesToBase64(raw),
    requestId: newId('req'),
    ...(opts.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey }),
  };

  const requestBody = JSON.stringify(body);
  const controller = new AbortController();
  const deadline = Date.now() + PLATFORM_SEND_DEADLINE_MS;
  const beforeDeadline = <T>(run: () => Promise<T>): Promise<T> =>
    withTimeout(deadline - Date.now(), run, () => {
      controller.abort();
      return new Error('email platform send timed out');
    });
  let res: Response;
  try {
    res = await beforeDeadline(() =>
      proxy.fetch('https://email-proxy/email/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
        signal: controller.signal,
      }),
    );
  } catch (e) {
    return err(
      'OUTCOME_UNKNOWN',
      `email: send outcome is unknown: ${e instanceof Error ? e.message : String(e)}. Check email logs or repeat the same idempotency key; do not create a new send.`,
      e,
    );
  }
  return readResponseAsResult(res, recipients, messageId, beforeDeadline);
}

/**
 * Build a normalized email + raw MIME for advanced callers who want to feed
 * the message into a custom transport. Throws on invalid input.
 */
export async function createEmail(
  opts: SendEmailOptions,
): Promise<{ email: NormalizedEmail; raw: Uint8Array; messageId: string }> {
  if (opts.from === undefined) {
    throw new MimeError(
      'INVALID_FROM',
      "createEmail: 'from' is required (this entrypoint does not apply __VOID_PROJECT_SLUG defaulting).",
    );
  }
  const email = await normalizeEmail(
    opts as SendEmailOptions & { from: NonNullable<SendEmailOptions['from']> },
  );
  const built = buildMime(email);
  return { email, ...built };
}
