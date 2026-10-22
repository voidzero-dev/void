/** Inbound email actions after the gateway resolves an authoritative route. */

import { isReservedEmailSlug } from '@voidcloud/api/reserved-slugs';
import { EmailMessage } from 'cloudflare:email';
import { validate as isValidEmailSyntax } from 'email-validator';
import { dispatchBoundedEmailToTenant } from '../../email-gateway/src/tenant-dispatch.ts';
import {
  admitEmail,
  emailPayloadDigest,
  finishEmailAttempt,
  recordEmailReceipt,
  startEmailAttempt,
} from './email-admission.ts';
import type { ReceiptRouteFence } from './email-admission.ts';
import { leaseBearer, leaseEmailDomainCredential } from './email-lease.ts';
import {
  EMAIL_PROVIDER_DEADLINE_MS,
  createEmailProviderDeadline,
} from './email-provider-deadline.ts';
import {
  bytesToStream,
  classifySendRawRecipient,
  parseSendRawResult,
  readMimeFromAddrSpec,
  readSenderDomain,
  recordInboundDelivery,
  requestSendRaw,
  sanitizeForLog as sanitize,
} from './email.ts';
import type { Env as ProxyEnv } from './types.ts';
type Env = Omit<ProxyEnv, 'JWT_SECRET'>;

/** Render unknown tenant values by kind without coercing large arrays or objects. */
function describeUntrusted(value: unknown, maxLen: number): string {
  switch (typeof value) {
    case 'string':
      return sanitize(value, maxLen);
    case 'number':
    case 'boolean':
    case 'undefined':
      return String(value);
    case 'object':
      return value === null ? 'null' : sanitize(Object.prototype.toString.call(value), 64);
    default:
      // bigint, function, symbol
      return `[${typeof value}]`;
  }
}

export interface AuthoritativeEmailRoute {
  routeId: string;
  routeGeneration: number;
  connectionId: string;
  projectId: string;
  workerName: string;
  deploymentId: string;
  slug: string;
  /** The shared-domain name the recipient used: the slug or the project's email alias. */
  mailbox?: string;
  /** The project's email alias on the shared domain, when it has one. */
  alias?: string;
  addressing: 'shared' | 'custom';
  domain: string;
  limits?: Record<string, number>;
}

/** Shared-domain names a reply or forward may be sent from: the slug and the email alias. */
function mailboxNames(route: AuthoritativeEmailRoute): ReadonlyArray<string> {
  const names = [route.slug, route.alias, route.mailbox]
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.toLowerCase());
  return [...new Set(names)];
}

function receiptRouteFence(route: AuthoritativeEmailRoute): ReceiptRouteFence {
  return {
    routeId: route.routeId,
    routeGeneration: route.routeGeneration,
    connectionId: route.connectionId,
    addressing: route.addressing,
    domain: route.domain,
    projectSlug: route.slug,
  };
}

/** Bounded envelope passed through the gateway's tenant dispatch protocol. */
interface EmailEnvelope {
  from: string;
  to: string;
  headers: Record<string, string>;
  raw: Uint8Array;
  rawSize: number;
  /**
   * The registered custom domain this message arrived on. Its recipient
   * carries no shared-domain project prefix to strip.
   */
  viaDomain?: string;
}

/** Shared with the dedicated gateway. */
export type { EmailEnvelope };

/** Mirrors `void/email`'s EmailAction. */
type EmailAction =
  | { type: 'reject'; reason: string }
  | { type: 'forward'; to: string; headers?: Record<string, string> }
  | { type: 'reply'; from: string; to: string; raw: Uint8Array };

/** Keep buffered messages within the shared proxy isolate budget. */
export const MAX_INBOUND_BYTES = 10 * 1024 * 1024;

/** Bound distinct header names before building the envelope object. */
export const MAX_INBOUND_HEADERS = 1024;
export const MAX_INBOUND_HEADER_BYTES = 128 * 1024;

/** Limit handler rejection text exposed to remote MTAs and logs. */
export const MAX_REJECT_REASON_LENGTH = 1000;

/** Bound tenant action validation work per inbound delivery. */
const MAX_ACTIONS = 100;

/** Maximum action address length before syntax validation. */
const MAX_ACTION_ADDRESS_LENGTH = 320;

/** Bound forward header construction. */
export const MAX_FORWARD_HEADERS = 32;
export const MAX_FORWARD_HEADER_LENGTH = 1024;

/** Limit one reply MIME payload. */
const MAX_REPLY_BYTES = 5 * 1024 * 1024;

/** Limit total reply MIME bytes in one delivery. */
const MAX_REPLY_BYTES_TOTAL = 8 * 1024 * 1024;
const INBOUND_STREAM_DEADLINE_MS = 15_000;

class InboundTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(`inbound message exceeds ${MAX_INBOUND_BYTES} bytes (got ${size})`);
    this.name = 'InboundTooLargeError';
  }
}

class InboundTooManyHeadersError extends Error {
  constructor() {
    super(`inbound message carries more than ${MAX_INBOUND_HEADERS} headers`);
    this.name = 'InboundTooManyHeadersError';
  }
}

class InboundHeadersTooLargeError extends Error {
  constructor() {
    super(`inbound headers exceed ${MAX_INBOUND_HEADER_BYTES} bytes`);
    this.name = 'InboundHeadersTooLargeError';
  }
}

/** Use the same address validator as the framework after a length guard. */
export function isValidEmailAddress(s: unknown): s is string {
  return typeof s === 'string' && s.length <= MAX_ACTION_ADDRESS_LENGTH && isValidEmailSyntax(s);
}

/** Render invalid addresses without coercing untrusted objects. */
function logAddress(value: unknown): string {
  return describeUntrusted(value, MAX_ACTION_ADDRESS_LENGTH);
}

/** Reject oversized or malformed header bags before constructing Headers. */
function forwardHeadersWithinBounds(headers: unknown): headers is Record<string, string> {
  if (typeof headers !== 'object' || headers === null) {
    console.error('[email-router] action list dropped: forward headers is not a plain object');
    return false;
  }
  const proto = Object.getPrototypeOf(headers);
  if (proto !== Object.prototype && proto !== null) {
    console.error('[email-router] action list dropped: forward headers is not a plain object');
    return false;
  }
  // Check the count before reading values or constructing Headers.
  const names = Object.keys(headers);
  if (names.length > MAX_FORWARD_HEADERS) {
    console.error(
      `[email-router] action list dropped: forward has ${names.length} headers (max ${MAX_FORWARD_HEADERS})`,
    );
    return false;
  }
  for (const name of names) {
    const value = (headers as Record<string, unknown>)[name];
    // Headers accepts long names, so cap them explicitly.
    if (name.length > MAX_FORWARD_HEADER_LENGTH) {
      console.error(
        `[email-router] action list dropped: forward header name exceeds ${MAX_FORWARD_HEADER_LENGTH} characters`,
      );
      return false;
    }
    // Reject values that Headers would coerce to strings.
    if (typeof value !== 'string') {
      console.error(
        `[email-router] action list dropped: forward header "${sanitize(name, 64)}" value is not a string`,
      );
      return false;
    }
    if (value.length > MAX_FORWARD_HEADER_LENGTH) {
      console.error(
        `[email-router] action list dropped: forward header "${sanitize(name, 64)}" value exceeds ${MAX_FORWARD_HEADER_LENGTH} characters`,
      );
      return false;
    }
  }
  return true;
}

/** Pin shared-domain reply senders to the receiving project; admission checks ownership. */
interface ReplySenderPin {
  /** Lowercase shared-domain names of the receiving project: its slug and email alias. */
  names: ReadonlyArray<string>;
  domain: string;
  customDomain: boolean;
}

/** Check the envelope shape before authoritative admission checks sender ownership. */
function isPermittedReplySender(from: string, pin: ReplySenderPin): boolean {
  if (!/^[\x21-\x7e]+$/.test(from)) {
    return false;
  }
  const lower = from.toLowerCase();
  const at = lower.indexOf('@');
  if (at <= 0) {
    return false;
  }
  const fromDomain = lower.slice(at + 1);
  if (fromDomain !== pin.domain) {
    return true;
  }
  if (pin.customDomain) {
    return true;
  }
  return pin.names.includes(lower.slice(0, at).split('+')[0]!);
}

interface OutboundGate {
  projectId: string;
  receiptId: string;
  transport: 'native' | 'relay';
}

export async function routeInbound(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
  authoritative: AuthoritativeEmailRoute,
): Promise<void> {
  // The sender domain labels bounces, but is not needed to route inbound mail.
  const label = readSenderDomain(env) ?? 'void email';

  const to = String(message.to ?? '').toLowerCase();
  const local = to.split('@')[0] ?? '';
  // <name>+<tag>, where <name> is the slug or the project's email alias. Split
  // on the first '+'. If there's no '+', the whole local-part is the name and
  // the user worker sees the tag-less address.
  const plus = local.indexOf('+');
  const slug = plus === -1 ? local : local.slice(0, plus);
  const mailbox = (authoritative.mailbox ?? authoritative.slug).toLowerCase();
  // Domain CF pinned when it accepted this message. It is the expected
  // domain for any `reply` sender — see `ReplySenderPin`.
  const atIdx = to.indexOf('@');
  const receivedDomain = atIdx === -1 ? '' : to.slice(atIdx + 1);

  if (!slug) {
    message.setReject(`${label}: missing project slug in recipient`);
    return;
  }

  // Shared platform addresses remain reserved even when a route exists.
  if (authoritative.addressing !== 'custom' && isReservedEmailSlug(slug)) {
    message.setReject(`${label}: "${sanitize(slug, 64)}" is a reserved platform address`);
    return;
  }

  if (
    !authoritative.projectId ||
    !authoritative.workerName ||
    !authoritative.deploymentId ||
    authoritative.domain?.toLowerCase() !== receivedDomain ||
    (authoritative.addressing === 'shared' && mailbox !== slug)
  ) {
    message.setReject(`${label}: authoritative route mismatch`);
    return;
  }
  const workerName = authoritative.workerName;
  const projectId = authoritative.projectId;

  let stub: Fetcher;
  try {
    // Pass the project's dispatch limits, exactly as the HTTP router does in
    // `packages/dispatch`. Without them, anyone who can send mail to a
    // project's address runs that tenant's worker at the namespace default
    // instead of the CPU/sub-request ceiling the project is configured for.
    stub = (
      authoritative.limits
        ? env.DISPATCH.get(workerName, {}, { limits: authoritative.limits })
        : env.DISPATCH.get(workerName)
    ) as Fetcher;
  } catch (e) {
    console.error(`[email-router] DISPATCH.get(${sanitize(workerName, 320)}) failed:`, e);
    throw new Error('email worker temporarily unavailable');
  }

  // Early size guard — `rawSize` is set by CF before the body streams.
  // Reject before buffering so a flood of oversized messages can't OOM the
  // isolate. We still enforce the cap during streaming below in case
  // `rawSize` ever lies.
  if (typeof message.rawSize === 'number' && message.rawSize > MAX_INBOUND_BYTES) {
    message.setReject(`${label}: message too large (max ${MAX_INBOUND_BYTES} bytes)`);
    return;
  }

  // Buffer the body and headers into the bounded tenant envelope.
  let envelope: EmailEnvelope;
  try {
    envelope = await buildEnvelope(message);
    if (authoritative.addressing === 'custom') {
      envelope.viaDomain = receivedDomain;
    }
  } catch (e) {
    if (e instanceof InboundTooLargeError) {
      message.setReject(`${label}: message too large (max ${MAX_INBOUND_BYTES} bytes)`);
      return;
    }
    if (e instanceof InboundTooManyHeadersError) {
      message.setReject(`${label}: too many headers (max ${MAX_INBOUND_HEADERS})`);
      return;
    }
    if (e instanceof InboundHeadersTooLargeError) {
      message.setReject(`${label}: headers too large (max ${MAX_INBOUND_HEADER_BYTES} bytes)`);
      return;
    }
    console.error(`[email-router] failed to read message body for ${sanitize(slug, 64)}:`, e);
    message.setReject(`${label}: could not read inbound message body`);
    return;
  }

  const receiptId = crypto.randomUUID();
  const gate: OutboundGate = { projectId, receiptId, transport: 'native' };

  let actions: Array<EmailAction>;
  try {
    await recordEmailReceipt(
      env,
      receiptId,
      projectId,
      'received',
      receiptRouteFence(authoritative),
    );
  } catch {
    throw new Error('email admission temporarily unavailable');
  }
  try {
    const result = await dispatchBoundedEmailToTenant(stub, env, {
      projectId,
      deploymentId: authoritative.deploymentId,
      envelope,
      receiptId,
    });
    actions = result.actions;
  } catch (e) {
    await recordEmailReceipt(env, receiptId, projectId, 'handler_failed').catch(() => {});
    const msg = e instanceof Error ? e.message.slice(0, 320) : describeUntrusted(e, 320);
    console.error(`[email-router] dispatch to ${sanitize(workerName, 320)} failed:`, msg);
    throw new Error('email handler execution unresolved');
  }

  try {
    await recordEmailReceipt(env, receiptId, projectId, 'handler_completed');
  } catch {
    console.error('[email-router] handler completed but receipt status could not be saved');
    return;
  }

  try {
    await enactActions(env, message, actions, gate, {
      customDomain: authoritative.addressing === 'custom',
      names: mailboxNames(authoritative),
      domain: receivedDomain,
    });
  } catch {
    console.error('[email-router] action execution unresolved', receiptId);
    return;
  }

  // Async log to the metering pipeline. Best-effort. Logged after every
  // dispatch — including reject-only outcomes — so operators have a
  // complete audit trail.
  ctx.waitUntil(logRecv(env, projectId, message, actions));
}

/** The gateway response to a relayed inbound message. */
export interface RelayRouteOutcome {
  reject: boolean;
  temporary?: boolean;
}

/** Dispatch a relayed message using the route resolved by the gateway. */
export async function routeRelayed(
  env: Env,
  ctx: ExecutionContext,
  input: {
    stub: Fetcher;
    projectId: string;
    domain: string;
    envelope: EmailEnvelope;
    authoritative: AuthoritativeEmailRoute;
    receiptId: string;
  },
): Promise<RelayRouteOutcome> {
  const { stub, projectId, domain, envelope, authoritative, receiptId } = input;

  if (
    authoritative.projectId !== projectId ||
    !authoritative.workerName ||
    !authoritative.slug ||
    authoritative.domain?.toLowerCase() !== domain
  ) {
    return { reject: true };
  }
  const slug = authoritative.slug;
  const workerName = authoritative.workerName;

  // Built before dispatch so the dispatch-failure paths can log the
  // delivery against it, exactly as `routeInbound` logs against the real
  // message. The domain + authenticated project id key its REST send path
  // (the customer account's send_raw with the domain's leased credential).
  const relayed = createRelayedMessage(envelope);

  const gate: OutboundGate = {
    projectId,
    receiptId,
    transport: 'relay',
  };

  let actions: Array<EmailAction>;
  try {
    const result = await dispatchBoundedEmailToTenant(stub, env, {
      projectId,
      deploymentId: authoritative.deploymentId,
      envelope,
      receiptId,
    });
    actions = result.actions;
  } catch (e) {
    await recordEmailReceipt(env, receiptId, projectId, 'handler_failed').catch(() => {});
    const msg = e instanceof Error ? e.message.slice(0, 320) : describeUntrusted(e, 320);
    console.error(`[email-relay] dispatch to ${sanitize(workerName, 320)} failed:`, msg);
    ctx.waitUntil(
      logRecv(env, projectId, relayed.message, [{ type: 'reject', reason: 'dispatch-error' }]),
    );
    return { reject: true, temporary: true };
  }

  try {
    await recordEmailReceipt(env, receiptId, projectId, 'handler_completed');
  } catch {
    console.error('[email-relay] handler completed but receipt status could not be saved');
    return { reject: false };
  }

  try {
    await enactActions(env, relayed.message, actions, gate, {
      customDomain: authoritative.addressing === 'custom',
      names: mailboxNames(authoritative),
      domain,
    });
  } catch {
    console.error('[email-relay] action execution unresolved', receiptId);
    return { reject: false };
  }

  // Same audit trail as the platform lane — including reject-only outcomes.
  ctx.waitUntil(logRecv(env, projectId, relayed.message, actions));
  return { reject: relayed.rejectedReason() !== null };
}

/** A message stand-in for relayed delivery; forwarding requires a native event. */
function createRelayedMessage(envelope: EmailEnvelope): {
  message: ForwardableEmailMessage;
  rejectedReason: () => string | null;
} {
  let reason: string | null = null;

  const message = {
    from: envelope.from,
    to: envelope.to,
    rawSize: envelope.rawSize,
    headers: new Headers(envelope.headers),
    raw: bytesToStream(envelope.raw),
    setReject(r: string) {
      reason = r;
    },
    async forward(_to: string, _headers?: Headers) {
      throw new DefinitiveEmailActionError('relayed forward requires a native email event');
    },
  };
  return {
    message: message as unknown as ForwardableEmailMessage,
    rejectedReason: () => reason,
  };
}

// Finish all local work before attempt_started: a missing lease or invalid
// MIME means no provider submission occurred and the reservation can be cancelled.
async function prepareRelayedReply(
  env: Env,
  projectId: string,
  from: string,
  raw: Uint8Array,
  expectedAccountId?: string,
): Promise<(to: string, deadlineMs?: number) => Promise<string | undefined>> {
  const senderDomain = from.slice(from.indexOf('@') + 1).toLowerCase();
  if (senderDomain === readSenderDomain(env)) {
    const binding = env.SEND_EMAIL;
    if (!binding || typeof binding.send !== 'function') {
      throw new Error('shared email binding is unavailable');
    }
    return async (to) => {
      const result = await binding.send(new EmailMessage(from, to, bytesToStream(raw)));
      return result?.messageId;
    };
  }
  const lease = await leaseEmailDomainCredential(env, senderDomain, projectId);
  if (!lease || (expectedAccountId && lease.accountId !== expectedAccountId)) {
    throw new Error('could not lease the domain credential');
  }
  const mimeMessage = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw);
  return async (to, deadlineMs = EMAIL_PROVIDER_DEADLINE_MS) => {
    let response;
    try {
      response = await requestSendRaw(
        {
          accountId: lease.accountId,
          bearer: leaseBearer(lease),
          from,
          recipients: [to],
          mimeMessage,
        },
        deadlineMs,
      );
    } catch {
      throw new Error('email sending request failed');
    }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408) {
        throw new Error('email sending API outcome unknown');
      }
      throw new DefinitiveEmailActionError(`email sending API returned ${response.status}`);
    }
    const data = response.data;
    if (typeof data !== 'object' || data === null || !('success' in data)) {
      throw new Error('email sending API response invalid');
    }
    if (data.success === false) {
      throw new DefinitiveEmailActionError('email sending API refused the message');
    }
    if (data.success !== true) {
      throw new Error('email sending API response invalid');
    }
    const result = parseSendRawResult((data as { result?: unknown }).result);
    if (!result) {
      throw new Error('email sending API response invalid');
    }
    const outcome = classifySendRawRecipient(result, to);
    if (outcome === 'permanent_bounce') {
      throw new DefinitiveEmailActionError('recipient permanently bounced');
    }
    if (outcome === 'suppressed') {
      throw new DefinitiveEmailActionError('recipient is on the suppression list');
    }
    if (outcome === 'outcome_unknown') {
      throw new Error('email sending API did not classify the recipient');
    }
    return result.messageId;
  };
}

async function logRecv(
  env: Env,
  projectId: string | undefined,
  message: ForwardableEmailMessage,
  actions: Array<EmailAction>,
): Promise<void> {
  if (!projectId) {
    console.error(
      `[email-router] cannot log inbound delivery: routing entry has no projectId (to=${sanitize(String(message.to ?? ''), 320)})`,
    );
    return;
  }
  // Guard the raw list the same way `validateActions` does because a tenant
  // response can contain arbitrary values.
  const status = actions.some((a) => a && typeof a === 'object' && a.type === 'reject')
    ? 'rejected'
    : actions.length === 0
      ? 'accepted'
      : 'handled';
  try {
    await recordInboundDelivery(projectId, {
      from: String(message.from ?? ''),
      to: String(message.to ?? ''),
      byteSize: message.rawSize ?? 0,
      status,
    });
  } catch (e) {
    console.error('[email-router] log-recv failed:', e);
  }
}

async function buildEnvelope(message: ForwardableEmailMessage): Promise<EmailEnvelope> {
  // Header COUNT first, before the body is buffered and before any property
  // is defined: the bag is walked once, stops at the cap, and the collected
  // pairs feed `fromEntries` below. See `MAX_INBOUND_HEADERS`.
  const entries: Array<[string, string]> = [];
  let headerBytes = 0;
  const encoder = new TextEncoder();
  for (const entry of message.headers) {
    if (entries.length >= MAX_INBOUND_HEADERS) {
      throw new InboundTooManyHeadersError();
    }
    headerBytes += encoder.encode(entry[0]).byteLength + encoder.encode(entry[1]).byteLength;
    if (headerBytes > MAX_INBOUND_HEADER_BYTES) {
      throw new InboundHeadersTooLargeError();
    }
    entries.push(entry);
  }
  const raw = await readStreamToBytes(message.raw);
  // Plain objects serialize through tenant dispatch; fromEntries also keeps
  // a `__proto__` header as an own data property.
  const headers: Record<string, string> = Object.fromEntries(entries);
  return {
    from: String(message.from ?? ''),
    to: String(message.to ?? ''),
    headers,
    raw,
    rawSize: message.rawSize ?? raw.byteLength,
  };
}

async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  const deadline = Date.now() + INBOUND_STREAM_DEADLINE_MS;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('inbound message stream timed out');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('inbound message stream timed out')),
            remaining,
          );
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_INBOUND_BYTES) {
        throw new InboundTooLargeError(total);
      }
      chunks.push(value);
    }
  } catch (error) {
    // Do not let an uncooperative source extend the read deadline while its
    // cancellation algorithm runs.
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

/**
 * Sanitized + validated action ready for enaction.
 *
 * `forward` / `reply` carry pre-constructed `Headers` objects so the
 * enaction loop can't throw on header construction after another
 * forward/reply already fired. See `validateActions` below for why
 * validation is split from enaction.
 */
type SanitizedAction =
  | { type: 'reject'; reason: string }
  | { type: 'forward'; to: string; headers?: Headers }
  | { type: 'reply'; from: string; to: string; raw: Uint8Array };

class DefinitiveEmailActionError extends Error {}

/**
 * Two-phase action enaction.
 *
 * **Phase A — validation (this fn).** Walk the action array, validate
 * each action shape end-to-end, including header construction (via
 * `new Headers(...)`, which throws on CRLF / NUL / unsafe chars).
 * Build a sanitized list. Any invalid action drops the entire list before
 * side effects fire. The message remains accepted by Cloudflare, while the
 * receipt records that its actions were rejected.
 *
 * **Phase B — enaction (`enactSanitized`).** Walks the validated list,
 * performs side effects. Each forward/reply still has its own
 * runtime try/catch for transient CF errors, but no sync throws
 * happen between sanitized actions, so an early forward/reply
 * succeeding can't leak side effects on a downstream throw.
 *
 * Stops walking at the first `reject` (terminal in CF's runtime).
 */
async function validateActions(
  actions: Array<EmailAction>,
  replySender: ReplySenderPin,
): Promise<Array<SanitizedAction> | null> {
  // Bound validation work before walking tenant actions.
  if (actions.length > MAX_ACTIONS) {
    console.error(
      `[email-router] action list dropped: ${actions.length} actions returned (max ${MAX_ACTIONS})`,
    );
    return null;
  }
  const out: Array<SanitizedAction> = [];
  // Bytes of the replies accepted so far, against `MAX_REPLY_BYTES_TOTAL`.
  let replyBytesUsed = 0;
  for (const action of actions) {
    if (!action || typeof action !== 'object') {
      // Never `String(action)` here: a string is bounded by `sanitize`, but a
      // BigInt's decimal conversion is not — see `describeUntrusted`.
      console.error(`[email-router] dropping non-object action: ${describeUntrusted(action, 320)}`);
      return null;
    }
    if (action.type === 'reject') {
      // CRLF / control chars in the reason would inject into the SMTP DSN
      // we hand back to the remote MTA. `sanitize` truncates, then strips,
      // so a multi-megabyte control-heavy reason never gets a full pass.
      const raw = typeof action.reason === 'string' ? action.reason : '';
      const reason =
        raw.length > 0 ? sanitize(raw, MAX_REJECT_REASON_LENGTH) : 'rejected by handler';
      out.push({ type: 'reject', reason });
      // Reject is terminal — stop validating subsequent actions so they
      // don't appear in tail logs as if they could have fired.
      return out;
    }
    if (action.type === 'forward') {
      if (!isValidEmailAddress(action.to)) {
        console.error(
          `[email-router] forward dropped: invalid "to" address ${logAddress(action.to)}`,
        );
        return null;
      }
      let headers: Headers | undefined;
      if (action.headers) {
        if (!forwardHeadersWithinBounds(action.headers)) {
          return null;
        }
        try {
          headers = new Headers(action.headers);
        } catch (e) {
          // Reject the list before any action can have side effects.
          console.error(
            `[email-router] action list dropped: forward headers invalid:`,
            e instanceof Error ? sanitize(e.message, 320) : sanitize(String(e), 320),
          );
          return null;
        }
      }
      out.push({ type: 'forward', to: action.to, headers });
    } else if (action.type === 'reply') {
      if (!isValidEmailAddress(action.from) || !isValidEmailAddress(action.to)) {
        console.error(
          `[email-router] reply dropped: invalid address (from=${logAddress(action.from)} to=${logAddress(action.to)})`,
        );
        return null;
      }
      // Check who the reply claims to be before asking the API to admit it.
      if (!isPermittedReplySender(action.from, replySender)) {
        console.error(
          `[email-router] reply dropped: sender not owned by project "${sanitize(replySender.names[0] ?? '', 64)}" (from=${logAddress(action.from)})`,
        );
        return null;
      }
      // The envelope is pinned; now pin what the recipient will SEE. The
      // bytes are the tenant's, and `new EmailMessage(from, to, raw)` never
      // compares them with `from`, so a `From:` header naming a sibling
      // project would pass the sender pin above. Same check, same reason,
      // as `/email/send` in `email.ts`; `replyEmail()` always renders the
      // header from the address it records, so only a hand-built reply
      // can fail here.
      if (!(action.raw instanceof Uint8Array)) {
        console.error(
          `[email-router] reply dropped: raw is not a Uint8Array (from=${logAddress(action.from)})`,
        );
        return null;
      }
      // Size before the scan below, which is linear in `raw`. Both bounds
      // mirror the framework's `reply()`; see the constants for why the
      // proxy re-checks them. An overrun rejects the entire action batch.
      const replyBytes = action.raw.byteLength;
      if (replyBytes > MAX_REPLY_BYTES) {
        console.error(
          `[email-router] reply dropped: raw is ${replyBytes} bytes (max ${MAX_REPLY_BYTES}) (from=${logAddress(action.from)})`,
        );
        return null;
      }
      if (replyBytesUsed + replyBytes > MAX_REPLY_BYTES_TOTAL) {
        console.error(
          `[email-router] reply dropped: cumulative reply bytes ${replyBytesUsed + replyBytes} exceed this delivery's budget of ${MAX_REPLY_BYTES_TOTAL} (from=${logAddress(action.from)})`,
        );
        return null;
      }
      const mimeFrom = readMimeFromAddrSpec(action.raw);
      if (!mimeFrom.ok || mimeFrom.addrSpec.toLowerCase() !== action.from.toLowerCase()) {
        console.error(
          `[email-router] reply dropped: MIME From is not the envelope sender (from=${logAddress(action.from)}, ${mimeFrom.ok ? 'header names another address' : mimeFrom.reason})`,
        );
        return null;
      }
      replyBytesUsed += replyBytes;
      out.push({ type: 'reply', from: action.from, to: action.to, raw: action.raw });
    } else {
      // Unknown action type — log so handler authors notice rather than
      // silently doing nothing. The `type` is whatever the tenant put there;
      // `describeUntrusted` renders a string within 320 chars and a typed
      // array, Array, or BigInt by kind, never by contents.
      console.warn(
        `[email-router] dropping unknown action type: ${describeUntrusted((action as { type?: unknown }).type, 320)}`,
      );
      return null;
    }
  }
  return out;
}

/** Validate actions, then ask the API to admit each outbound attempt. */
async function enactActions(
  env: Env,
  message: ForwardableEmailMessage,
  actions: Array<EmailAction>,
  gate: OutboundGate,
  replySender: ReplySenderPin,
): Promise<void> {
  const sanitized = await validateActions(actions, replySender);
  if (sanitized === null) {
    // The handler ran, but none of its invalid actions was enacted.
    await recordEmailReceipt(env, gate.receiptId, gate.projectId, 'actions_rejected').catch(() => {
      console.error('[email-router] could not record rejected actions');
    });
    return;
  }
  await enactSanitized(env, message, sanitized, gate);
}

async function enactSanitized(
  env: Env,
  message: ForwardableEmailMessage,
  actions: Array<SanitizedAction>,
  gate: OutboundGate,
): Promise<void> {
  if (!gate.projectId || !gate.receiptId) {
    console.error(
      '[email-router] action admission unavailable: missing project or receipt identity',
    );
    return;
  }
  const providerDeadline = createEmailProviderDeadline();
  for (const [index, action] of actions.entries()) {
    if (action.type === 'reject') {
      message.setReject(action.reason);
      return;
    }
    if (providerDeadline.expired()) {
      console.error('[email-router] action batch deadline elapsed before admission');
      break;
    }
    const to = action.to.toLowerCase();
    const from = action.type === 'reply' ? action.from : message.to;
    const digest = await emailPayloadDigest(
      action.type,
      from,
      [to],
      action.type === 'reply'
        ? action.raw
        : new TextEncoder().encode(JSON.stringify([...(action.headers?.entries() ?? [])].sort())),
    );
    let admission;
    try {
      admission = await admitEmail(env, {
        projectId: gate.projectId,
        kind: action.type,
        key: `${gate.receiptId}:${index}:${digest.slice(0, 16)}`,
        digest,
        from,
        recipients: [to],
        transport:
          gate.transport === 'relay'
            ? action.type === 'reply' &&
              action.from.slice(action.from.indexOf('@') + 1).toLowerCase() ===
                readSenderDomain(env)
              ? 'binding'
              : 'send_raw'
            : action.type === 'forward'
              ? 'native_forward'
              : 'native_reply',
        receiptId: gate.receiptId,
      });
    } catch (error) {
      console.error(
        '[email-router] action admission unavailable:',
        error instanceof Error ? error.message : 'unknown',
      );
      continue;
    }
    const admitted = admission.recipients.find((r) => r.recipient === to);
    if (admission.replay || admitted?.state !== 'reserved') {
      continue;
    }
    let relayedReply:
      | ((to: string, deadlineMs?: number) => Promise<string | undefined>)
      | undefined;
    if (gate.transport === 'relay' && action.type === 'reply') {
      try {
        relayedReply = await prepareRelayedReply(
          env,
          gate.projectId,
          action.from,
          action.raw,
          admission.accountId,
        );
      } catch {
        await finishEmailAttempt(env, admission.operationId, [to], 'cancelled').catch(() => {
          console.error('[email-router] could not cancel unsubmitted relayed reply');
        });
        console.error('[email-router] relayed reply could not be prepared');
        continue;
      }
    }
    if (providerDeadline.expired()) {
      const cancelled = await cancelUnstartedAction(env, admission.operationId, to);
      console.error(
        cancelled
          ? '[email-router] action batch deadline elapsed; reservation cancelled'
          : '[email-router] action batch deadline elapsed; cancellation unresolved',
      );
      break;
    }
    try {
      await startEmailAttempt(env, admission.operationId, [to]);
    } catch {
      const cancelled = await cancelUnstartedAction(env, admission.operationId, to);
      console.error(
        cancelled
          ? '[email-router] attempt did not start; reservation cancelled'
          : '[email-router] could not confirm attempt status',
      );
      continue;
    }
    try {
      let providerReference: string | undefined;
      if (action.type === 'forward') {
        await providerDeadline.run(() => message.forward(to, action.headers));
      } else {
        if (relayedReply) {
          providerReference = await providerDeadline.run(() =>
            relayedReply!(to, providerDeadline.remainingMs()),
          );
        } else {
          await providerDeadline.run(() =>
            message.reply(new EmailMessage(action.from, to, bytesToStream(action.raw)) as never),
          );
        }
      }
      try {
        await finishEmailAttempt(env, admission.operationId, [to], 'provider_accepted', {
          providerReference,
        });
      } catch {
        console.error('[email-router] provider accepted action but outcome ledger write failed');
      }
    } catch (error) {
      const definitive = error instanceof DefinitiveEmailActionError;
      try {
        await finishEmailAttempt(
          env,
          admission.operationId,
          [to],
          definitive ? 'failed' : 'outcome_unknown',
          {
            errorCode: definitive ? 'UPSTREAM_ERROR' : 'OUTCOME_UNKNOWN',
          },
        );
      } catch {
        /* attempt_started remains visible for operator reconciliation */
      }
      console.error(
        definitive
          ? '[email-router] action provider refused'
          : '[email-router] action provider outcome unknown',
      );
    }
  }
}

/** Cancel only when the API still proves that no provider attempt started. */
async function cancelUnstartedAction(
  env: Env,
  operationId: string,
  recipient: string,
): Promise<boolean> {
  try {
    const result = await finishEmailAttempt(env, operationId, [recipient], 'cancelled');
    return result.recipients.some(
      (row) => row.recipient === recipient && row.state === 'cancelled',
    );
  } catch {
    return false;
  }
}
