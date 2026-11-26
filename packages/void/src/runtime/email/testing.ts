/**
 * Test harnesses for void/email.
 *
 *   createEmailTestHarness    — captures outbound `sendEmail` calls.
 *   createInboundTestHarness  — delivers a synthesized message through your
 *                                inbound route table and captures any
 *                                replies / forwards / rejects.
 *
 *   import { createEmailTestHarness } from "void/email/testing";
 *   const harness = createEmailTestHarness();
 *   await sendEmail({ from: "a@x.dev", to: "b@y.dev", subject: "hi", text: "yo" });
 *   expect(harness.messages[0].subject).toBe("hi");
 *   harness.dispose();
 *
 *   import { createInboundTestHarness } from "void/email/testing";
 *   const inbound = createInboundTestHarness({
 *     routes: { "support+[ticket]": supportHandler, _default: catchAll },
 *   });
 *   const result = await inbound.deliver({
 *     from: "user@example.com",
 *     // The WIRE address: `<slug>+<tag>@<domain>`, as the platform delivers
 *     // it. The harness strips `<slug>+` before matching, so passing the
 *     // user-facing "support+abc-1@app.dev" would read `support` as the slug.
 *     to: "myslug+support+abc-1@app.dev",
 *     subject: "help",
 *     text: "thanks",
 *   });
 *   expect(result.handler).toBe("support+[ticket]");
 *   expect(result.params).toEqual({ ticket: "abc-1" });
 */

import { compareEmailRoutes, compileEmailPattern } from '../../shared/email-pattern.ts';
import type { CompiledEmailPattern } from '../../shared/email-pattern.ts';
import { registerEmailSink } from './dev-inbox.ts';
import type { CapturedMessage } from './dev-inbox.ts';
import { createMessageProxy, MAX_INBOUND_BYTES, MAX_INBOUND_HEADERS } from './inbound.ts';
import type { EmailAction, EmailHandler, EmailHandlerInfo } from './inbound.ts';
import { buildMime, normalizeEmail } from './mime.ts';

export interface EmailTestHarness {
  /** Messages captured since the harness was created (or since the last clear). */
  readonly messages: ReadonlyArray<CapturedMessage>;
  /** Discard captured messages. */
  clear(): void;
  /** Stop intercepting sends. After dispose, real binding sends resume. */
  dispose(): void;
}

export function createEmailTestHarness(): EmailTestHarness {
  const messages: Array<CapturedMessage> = [];
  const unregister = registerEmailSink((m) => {
    messages.push(m);
  });
  return {
    get messages() {
      return messages;
    },
    clear() {
      messages.length = 0;
    },
    dispose() {
      unregister();
      messages.length = 0;
    },
  };
}

export type { CapturedMessage } from './dev-inbox.ts';

// ---------------------------------------------------------------------------
// Inbound test harness
// ---------------------------------------------------------------------------

export interface InboundDeliverOptions {
  from: string;
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  /** Override the constructed MIME body. Bytes preferred; strings encoded as UTF-8. */
  raw?: string | Uint8Array;
}

export interface InboundReplyCapture {
  from: string;
  to: string;
  raw: Uint8Array;
}

export interface InboundForwardCapture {
  to: string;
  headers?: Headers;
}

export interface InboundDeliveryResult {
  /** Which handler key matched. `undefined` if the message was not handled. */
  handler?: string;
  params: Record<string, string>;
}

export interface InboundTestHarness {
  readonly replies: ReadonlyArray<InboundReplyCapture>;
  readonly forwards: ReadonlyArray<InboundForwardCapture>;
  readonly rejects: ReadonlyArray<string>;
  readonly deliveries: ReadonlyArray<InboundDeliveryResult>;
  deliver(opts: InboundDeliverOptions): Promise<InboundDeliveryResult>;
  clear(): void;
}

export interface InboundTestHarnessOptions {
  /**
   * Address pattern → handler. Pattern syntax matches the file-based
   * convention: `support`, `support+[ticket]`, `[user]`, `[user]+[tag]`.
   * Reserved key: `_default` (fallback handler, mirrors email/_default.ts).
   */
  routes: Record<string, EmailHandler>;
  /** Forwarded as the second arg to handlers. Defaults to `{}`. */
  env?: unknown;
  /**
   * Project slug used to strip the platform-injected `<slug>+` prefix from
   * `message.to` before handlers see it (mirrors production: the dispatched
   * `message.to` is `<tag>@<domain>`, never `<slug>+<tag>@<domain>`). When
   * omitted, the harness infers the slug from each delivery's recipient
   * (everything before the first `+` in the local-part) so existing tests
   * with synthetic `slug+tag@domain` recipients keep working without
   * configuration.
   *
   * `null` means NO platform prefix at all — a worker deployed on your own
   * Cloudflare account (`void deploy --platform cloudflare`) receives the
   * address the handler author wrote, and the dispatcher matches the full
   * local part: `support@mail.acme.com` reaches `support`, and
   * `support+T-42@mail.acme.com` reaches `support+[ticket]` with `T-42`.
   */
  slug?: string | null;
}

interface CompiledRoute {
  /** The route key as written; named `address` so the route sorts through `compareEmailRoutes`. */
  address: string;
  pattern: CompiledEmailPattern;
  handler: EmailHandler;
}

function compileRoutes(routes: Record<string, EmailHandler>) {
  const compiled: Array<CompiledRoute> = [];
  let defaultHandler: EmailHandler | undefined;
  for (const [key, handler] of Object.entries(routes)) {
    if (key === '_default') {
      defaultHandler = handler;
      continue;
    }
    const pattern = compileEmailPattern(key);
    if (!pattern) {
      throw new Error(
        `createInboundTestHarness: route key ${JSON.stringify(key)} is not a valid email pattern. Use shapes like "support", "support+[ticket]", "[user]", "[user]+[tag]", or the reserved key "_default".`,
      );
    }
    compiled.push({ address: key, pattern, handler });
  }
  // The scanner's own comparator (`router/email.ts`), so the harness cannot
  // drift from the order the generated dispatcher tries patterns in.
  compiled.sort(compareEmailRoutes);
  return { compiled, defaultHandler };
}

async function buildSyntheticRaw(opts: InboundDeliverOptions): Promise<Uint8Array> {
  if (opts.raw !== undefined) {
    return typeof opts.raw === 'string' ? new TextEncoder().encode(opts.raw) : opts.raw;
  }
  // Default: a minimal text/plain message so handlers calling parseEmail()
  // see the expected from/to/subject/body. normalizeEmail requires either
  // text or html — synthesize a placeholder body when neither is supplied.
  const text = opts.text ?? (opts.html ? undefined : '(empty)');
  const normalized = await normalizeEmail({
    from: opts.from,
    to: opts.to,
    subject: opts.subject ?? '',
    text,
    html: opts.html,
    headers: opts.headers,
  });
  return buildMime(normalized).raw;
}

/** The router's `InboundTooManyHeadersError` (`email-router.ts`). */
class InboundTooManyHeadersError extends Error {}

/**
 * Unfolded headers of a raw message, up to the first blank line. Unparsable
 * lines are skipped so malformed fixtures still reach the handler. Like the
 * router's `buildEnvelope`, refuses more than `maxDistinct` distinct
 * case-insensitive names before materializing more.
 */
function parseHeaderBlock(raw: Uint8Array, maxDistinct: number): Headers {
  const headers = new Headers();
  const text = new TextDecoder().decode(raw);
  const end = text.indexOf('\r\n\r\n');
  const block = end === -1 ? text : text.slice(0, end);
  let distinct = 0;
  let current = '';
  const commit = () => {
    const colon = current.indexOf(':');
    if (colon > 0) {
      const name = current.slice(0, colon).trim();
      let known: boolean;
      try {
        known = headers.has(name);
      } catch {
        // Not a name a Headers object accepts — skip it.
        current = '';
        return;
      }
      if (!known && distinct >= maxDistinct) {
        throw new InboundTooManyHeadersError();
      }
      try {
        headers.set(name, current.slice(colon + 1).trim());
        if (!known) {
          distinct++;
        }
      } catch {
        // Not a value a Headers object accepts — skip it.
      }
    }
    current = '';
  };
  // Line by line, not `split`, so lines past the cap are never materialized.
  for (let pos = 0; pos <= block.length;) {
    const nl = block.indexOf('\r\n', pos);
    const line = nl === -1 ? block.slice(pos) : block.slice(pos, nl);
    pos = nl === -1 ? block.length + 1 : nl + 2;
    if (line === '') {
      break;
    }
    if (/^[ \t]/.test(line) && current !== '') {
      current += ` ${line.trim()}`;
      continue;
    }
    commit();
    current = line;
  }
  commit();
  return headers;
}

export function createInboundTestHarness(opts: InboundTestHarnessOptions): InboundTestHarness {
  const { compiled, defaultHandler } = compileRoutes(opts.routes);
  const env = opts.env ?? {};

  const replies: Array<InboundReplyCapture> = [];
  const forwards: Array<InboundForwardCapture> = [];
  const rejects: Array<string> = [];
  const deliveries: Array<InboundDeliveryResult> = [];

  async function deliver(input: InboundDeliverOptions): Promise<InboundDeliveryResult> {
    const raw = await buildSyntheticRaw(input);

    // Mirrors the router's admission (`routeInbound` in `email-router.ts`):
    // size, then distinct-header count, each a reject before any handler
    // runs, prefixed with the zone (the recipient's domain). Own-account
    // (`slug: null`) has no router. Headers come from the bytes, as
    // production copies the wire headers.
    let headers: Headers;
    if (opts.slug === null) {
      headers = parseHeaderBlock(raw, Infinity);
    } else {
      const at = input.to.indexOf('@');
      const label = at === -1 ? 'void email' : input.to.slice(at + 1).toLowerCase() || 'void email';
      if (raw.byteLength > MAX_INBOUND_BYTES) {
        return refuse(`${label}: message too large (max ${MAX_INBOUND_BYTES} bytes)`);
      }
      try {
        headers = parseHeaderBlock(raw, MAX_INBOUND_HEADERS);
      } catch (e) {
        if (e instanceof InboundTooManyHeadersError) {
          return refuse(`${label}: too many headers (max ${MAX_INBOUND_HEADERS})`);
        }
        throw e;
      }
    }
    // The caller's own headers win, applied after admission: they are not on
    // the wire.
    for (const [k, v] of new Headers(input.headers ?? {})) {
      headers.set(k, v);
    }
    // Subject is not re-set from `input.subject`: the bytes carry the RFC
    // 2047-encoded form production hands the handler.
    if (!headers.has('Subject') && input.subject) {
      headers.set('Subject', input.subject);
    }
    if (!headers.has('From')) {
      headers.set('From', input.from);
    }
    if (!headers.has('To')) {
      headers.set('To', input.to);
    }

    const slug = (() => {
      if (opts.slug === null) {
        return undefined;
      }
      if (opts.slug) {
        return opts.slug;
      }
      const local = input.to.split('@')[0] ?? '';
      const plus = local.indexOf('+');
      return plus === -1 ? undefined : local.slice(0, plus);
    })();

    // Production's own proxy, built as the generated `email()` entry builds
    // it, so every proxy check throws here as it does after deploy.
    const { message, getActions } = createMessageProxy(
      {
        from: input.from,
        to: input.to,
        headers: Object.fromEntries(headers),
        raw,
        rawSize: raw.byteLength,
      },
      { slug },
    );

    // oxlint-disable-next-line quality/no-chained-type-assertions -- This test harness implements only the context hooks used during email dispatch.
    const ctx = {
      waitUntil() {
        // no-op
      },
      passThroughOnException() {
        // no-op
      },
    } as unknown as ExecutionContext;

    // Case is preserved and patterns match with `i`, as the generated
    // dispatcher does, so captured params keep their case. On the platform a
    // recipient without `+` has no tag, so only `_default` can take it.
    const fullLocal = input.to.split('@')[0] ?? '';
    const plus = fullLocal.indexOf('+');
    const local = opts.slug === null ? fullLocal : plus === -1 ? '' : fullLocal.slice(plus + 1);

    async function dispatch(): Promise<InboundDeliveryResult> {
      for (const route of compiled) {
        const re = new RegExp(route.pattern.regexSource, 'i');
        const m = re.exec(local);
        if (!m) {
          continue;
        }
        const params: Record<string, string> = {};
        for (let i = 0; i < route.pattern.paramNames.length; i++) {
          params[route.pattern.paramNames[i]] = m[i + 1];
        }
        const info: EmailHandlerInfo = { params };
        await route.handler(message, env, ctx, info);
        return { handler: route.address, params };
      }
      if (defaultHandler) {
        const info: EmailHandlerInfo = { params: {} };
        await defaultHandler(message, env, ctx, info);
        return { handler: '_default', params: {} };
      }
      // No match and no `_default`: the dispatcher (`router/compile.ts`)
      // rejects with this exact reason, built from the wire recipient.
      message.setReject(
        `no handler matched recipient "${input.to}" — add email/_default.ts to handle unmatched mail`,
      );
      return { handler: undefined, params: {} };
    }

    const result = await dispatch();
    // Recorded after the handler returns: a throwing handler enacts nothing.
    record(getActions());
    deliveries.push(result);
    return result;
  }

  // An admission refusal, recorded the way a handler's own `setReject` is:
  // the queue is that one reject, and the delivery is unhandled.
  function refuse(reason: string): InboundDeliveryResult {
    record([{ type: 'reject', reason }]);
    const result: InboundDeliveryResult = { handler: undefined, params: {} };
    deliveries.push(result);
    return result;
  }

  // The proxy already made `setReject` terminal, so the queue is what the
  // router would enact.
  function record(actions: ReadonlyArray<EmailAction>): void {
    for (const action of actions) {
      switch (action.type) {
        case 'reject':
          rejects.push(action.reason);
          break;
        case 'forward':
          forwards.push({
            to: action.to,
            ...(action.headers ? { headers: new Headers(action.headers) } : {}),
          });
          break;
        case 'reply':
          replies.push({ from: action.from, to: action.to, raw: action.raw });
          break;
      }
    }
  }

  return {
    get replies() {
      return replies;
    },
    get forwards() {
      return forwards;
    },
    get rejects() {
      return rejects;
    },
    get deliveries() {
      return deliveries;
    },
    deliver,
    clear() {
      replies.length = 0;
      forwards.length = 0;
      rejects.length = 0;
      deliveries.length = 0;
    },
  };
}
