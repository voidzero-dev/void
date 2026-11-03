import { claimRelayedReceipt, completeRelayedReceipt } from '../../proxy/src/email-admission.ts';
import {
  routeInbound,
  routeRelayed,
  MAX_INBOUND_BYTES,
  MAX_INBOUND_HEADERS,
} from '../../proxy/src/email-router.ts';
import type { EmailEnvelope } from '../../proxy/src/email-router.ts';
import type { Env as ProxyEnv } from '../../proxy/src/types.ts';

type Env = Omit<ProxyEnv, 'JWT_SECRET'> & {
  PLATFORM_INSTALLATION_ID?: string;
  PLATFORM_VERSION?: string;
  PLATFORM_TRAFFIC_STATE?: string;
  EMAIL_SHARED_ACCOUNT_ID?: string;
  EMAIL_SHARED_ZONE_ID?: string;
  EMAIL_SHARED_INGRESS_NAME?: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_HEADER_BYTES = 128 * 1024;
const MAX_ENVELOPE_HEADER = 320;
const MAX_CONCURRENT_DELIVERIES = 2;
const CONFIRMATION_PATH = '/email/destinations/confirm';
const MAX_CONFIRMATION_TOKEN_LENGTH = 4 * 1024;
const MAX_CONFIRMATION_RESPONSE_BYTES = 32 * 1024;
const CONFIRMATION_DEADLINE_MS = 5_000;
let activeDeliveries = 0;

class MimeHeaderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = 'MimeHeaderError';
  }
}

function isTrafficPaused(env: Env): boolean {
  return env.PLATFORM_TRAFFIC_STATE === 'staging' || env.PLATFORM_TRAFFIC_STATE === 'sandbox-drain';
}

async function withDeliverySlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeDeliveries >= MAX_CONCURRENT_DELIVERIES) {
    throw new Error('email gateway busy');
  }
  activeDeliveries++;
  try {
    return await run();
  } finally {
    activeDeliveries--;
  }
}

async function sign(value: string, secret: string): Promise<string> {
  if (!secret) {
    throw new Error('Email signing key is not configured');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  let binary = '';
  for (const byte of signature) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

type Route = {
  routeId: string;
  routeGeneration: number;
  connectionId: string;
  projectId: string;
  workerName: string;
  deploymentId: string;
  slug: string;
  mailbox?: string;
  alias?: string;
  domain: string;
  addressing: 'shared' | 'custom';
  limits?: Record<string, number>;
};

async function resolveIngress(
  env: Env,
  input: {
    accountId: string;
    zoneId: string;
    ingressName: string;
    from: string;
    to: string;
    secret?: string;
    native?: true;
  },
): Promise<Route | null> {
  const deadline = Date.now() + 5_000;
  const controller = new AbortController();
  const beforeDeadline = async <T>(run: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      controller.abort();
      throw new Error('ingress resolution timeout');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('ingress resolution timeout'));
          }, remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };
  const proof = await sign(
    `email-ingress-v1\n${input.accountId}\n${input.zoneId}\n${input.ingressName}\n${input.to.toLowerCase()}`,
    env.EMAIL_SIGNING_SECRET,
  );
  const response = await beforeDeadline(() =>
    env.API.fetch('https://api/internal/email/resolve-ingress', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-void-internal': proof },
      body: JSON.stringify(input),
      signal: controller.signal,
    }),
  );
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    if (response.status >= 500 || response.status === 429) {
      throw new Error('email routing unavailable');
    }
    return null;
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 4096) {
    void response.body?.cancel().catch(() => {});
    throw new Error('invalid email routing response');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('invalid email routing response');
  }
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await beforeDeadline(() => reader.read());
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > 4096) {
        throw new Error('invalid email routing response');
      }
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = decoder.decode(bytes);
  let route: unknown;
  try {
    route = JSON.parse(text);
  } catch {
    throw new Error('invalid email routing response');
  }
  if (!route || typeof route !== 'object') {
    throw new Error('invalid email routing response');
  }
  const value = route as Partial<Route>;
  if (
    typeof value.routeId !== 'string' ||
    !Number.isSafeInteger(value.routeGeneration) ||
    value.routeGeneration! < 1 ||
    typeof value.projectId !== 'string' ||
    typeof value.connectionId !== 'string' ||
    typeof value.workerName !== 'string' ||
    typeof value.deploymentId !== 'string' ||
    typeof value.slug !== 'string' ||
    (value.mailbox !== undefined && typeof value.mailbox !== 'string') ||
    (value.alias !== undefined && typeof value.alias !== 'string') ||
    typeof value.domain !== 'string' ||
    (value.addressing !== 'shared' && value.addressing !== 'custom')
  ) {
    throw new Error('invalid email routing response');
  }
  return value as Route;
}

async function readMime(
  stream: ReadableStream<Uint8Array> | null,
  declared: number,
): Promise<Uint8Array> {
  if (!stream || !Number.isSafeInteger(declared) || declared < 0 || declared > MAX_INBOUND_BYTES) {
    throw new Error('invalid MIME length');
  }
  const reader = stream.getReader();
  const result = new Uint8Array(declared);
  let size = 0;
  const deadline = Date.now() + 15_000;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('MIME timeout');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('MIME timeout')), remaining);
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > declared || size > MAX_INBOUND_BYTES) {
        throw new Error('MIME too large');
      }
      result.set(chunk.value, size - chunk.value.byteLength);
    }
    if (size !== declared) {
      throw new Error('truncated MIME');
    }
    return result;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
}

function parseHeaders(raw: Uint8Array): Record<string, string> {
  let end = -1;
  for (let i = 0; i < raw.length - 3 && i < MAX_HEADER_BYTES + 4; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    throw new MimeHeaderError(
      'invalid MIME headers',
      raw.byteLength > MAX_HEADER_BYTES ? 413 : 400,
    );
  }
  if (end > MAX_HEADER_BYTES) {
    throw new MimeHeaderError('MIME headers too large', 413);
  }
  const lines = decoder.decode(raw.subarray(0, end)).split('\r\n');
  const headers: Record<string, string> = Object.create(null);
  let current = '';
  let physicalLines = 0;
  for (const line of lines) {
    if (++physicalLines > MAX_INBOUND_HEADERS) {
      throw new MimeHeaderError('too many MIME headers', 413);
    }
    if (/^[ \t]/.test(line)) {
      if (!current) {
        throw new MimeHeaderError('invalid MIME header fold', 400);
      }
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new MimeHeaderError('invalid MIME header', 400);
    }
    const name = line.slice(0, colon).toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
      throw new MimeHeaderError('invalid MIME header name', 400);
    }
    headers[name] = headers[name]
      ? `${headers[name]}, ${line.slice(colon + 1).trim()}`
      : line.slice(colon + 1).trim();
    current = name;
  }
  return headers;
}

async function ingress(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (isTrafficPaused(env)) {
    return new Response(null, { status: 503 });
  }
  if (request.headers.get('content-encoding')) {
    return new Response(null, { status: 415 });
  }
  const accountId = request.headers.get('x-void-email-account') ?? '';
  const zoneId = request.headers.get('x-void-email-zone') ?? '';
  const ingressName = request.headers.get('x-void-email-ingress') ?? '';
  const requestId = request.headers.get('x-void-email-request-id') ?? '';
  const from = request.headers.get('x-void-email-from') ?? '';
  const to = request.headers.get('x-void-email-to') ?? '';
  const authorization = request.headers.get('authorization') ?? '';
  if (
    [accountId, zoneId, ingressName, from, to, authorization].some(
      (value) => !value || value.length > MAX_ENVELOPE_HEADER,
    ) ||
    !authorization.startsWith('Bearer ') ||
    !/^[a-f0-9-]{36}$/.test(requestId)
  ) {
    return new Response(null, { status: 400 });
  }
  const declaredHeader = request.headers.get('content-length');
  if (declaredHeader === null || !/^\d+$/.test(declaredHeader)) {
    return new Response(null, { status: 411 });
  }
  const declared = Number(declaredHeader);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    return new Response(null, { status: 411 });
  }
  if (declared > MAX_INBOUND_BYTES) {
    return new Response(null, { status: 413 });
  }
  let route: Route | null;
  try {
    route = await resolveIngress(env, {
      accountId,
      zoneId,
      ingressName,
      from,
      to,
      secret: authorization.slice(7),
    });
  } catch {
    return new Response(null, { status: 503 });
  }
  if (!route) {
    return new Response(null, { status: 403 });
  }
  let raw: Uint8Array;
  try {
    raw = await readMime(request.body, declared);
  } catch (error) {
    console.error(
      '[email-gateway] ingress failed:',
      error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    );
    return new Response(null, { status: 502 });
  }
  let headers: Record<string, string>;
  try {
    headers = parseHeaders(raw);
  } catch (error) {
    if (error instanceof MimeHeaderError) {
      return new Response(null, { status: error.status });
    }
    throw error;
  }
  try {
    const domain = to.slice(to.lastIndexOf('@') + 1).toLowerCase();
    if (domain !== route.domain) {
      return new Response(null, { status: 403 });
    }
    const envelope: EmailEnvelope = {
      from,
      to,
      raw,
      rawSize: raw.byteLength,
      headers,
      ...(route.addressing === 'custom' ? { viaDomain: domain } : {}),
    };
    let stub: Fetcher;
    try {
      stub = (
        route.limits
          ? env.DISPATCH.get(route.workerName, {}, { limits: route.limits })
          : env.DISPATCH.get(route.workerName)
      ) as Fetcher;
    } catch (error) {
      console.error('[email-gateway] tenant dispatch stub unavailable:', error);
      return new Response(null, { status: 503 });
    }
    const receiptId = await sha256(encoder.encode(JSON.stringify([route.connectionId, requestId])));
    const payloadDigest = await sha256(
      encoder.encode(JSON.stringify([from, to, await sha256(raw)])),
    );
    const identity = {
      receiptId,
      projectId: route.projectId,
      payloadDigest,
      route: {
        routeId: route.routeId,
        routeGeneration: route.routeGeneration,
        connectionId: route.connectionId,
        addressing: route.addressing,
        domain: route.domain,
        projectSlug: route.slug,
      },
    };
    let claim;
    try {
      claim = await claimRelayedReceipt(env, identity);
    } catch (error) {
      if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT') {
        return new Response(null, { status: 409 });
      }
      throw error;
    }
    if (claim.state === 'completed' && typeof claim.reject === 'boolean') {
      return new Response(null, {
        status: claim.reject ? 403 : 204,
        headers: { 'x-void-email-receipt': receiptId },
      });
    }
    if (claim.state !== 'claimed') {
      return new Response(null, { status: 503, headers: { 'x-void-email-receipt': receiptId } });
    }
    const result = await routeRelayed(env, ctx, {
      stub,
      projectId: route.projectId,
      domain,
      envelope,
      authoritative: route,
      receiptId,
    });
    if (result.temporary) {
      return new Response(null, { status: 503 });
    }
    try {
      await completeRelayedReceipt(env, identity, result.reject);
    } catch {
      // The receipt remains unresolved. Never rerun completed tenant work or
      // already-submitted actions just because its final checkpoint was lost.
      console.error('[email-gateway] receipt completion remains unresolved', receiptId);
    }
    return new Response(null, {
      status: result.reject ? 403 : 204,
      headers: { 'x-void-email-receipt': receiptId },
    });
  } catch (error) {
    console.error(
      '[email-gateway] ingress failed:',
      error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    );
    return new Response(null, { status: 502 });
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function probe(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('content-encoding')) {
    void request.body?.cancel().catch(() => {});
    return new Response(null, { status: 400 });
  }
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 1024)) {
    void request.body?.cancel().catch(() => {});
    return new Response(null, { status: 400 });
  }
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ') || authorization.length > MAX_ENVELOPE_HEADER) {
    return new Response(null, { status: 403 });
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return new Response(null, { status: 400 });
  }
  const bytes = new Uint8Array(1024);
  let size = 0;
  const deadline = Date.now() + 5_000;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return new Response(null, { status: 400 });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('probe timeout')), remaining);
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > bytes.byteLength) {
        return new Response(null, { status: 400 });
      }
      bytes.set(chunk.value, size - chunk.value.byteLength);
    }
  } catch {
    return new Response(null, { status: 400 });
  } finally {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
  if (size === 0 || (declared && size !== Number(declared))) {
    return new Response(null, { status: 400 });
  }
  let input: unknown;
  try {
    input = JSON.parse(decoder.decode(bytes.subarray(0, size)));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!input || typeof input !== 'object') {
    return new Response(null, { status: 400 });
  }
  const { accountId, zoneId, ingressName } = input as Record<string, unknown>;
  if (
    [accountId, zoneId, ingressName].some(
      (value) => typeof value !== 'string' || !value || value.length > MAX_ENVELOPE_HEADER,
    )
  ) {
    return new Response(null, { status: 400 });
  }
  const proof = await sign(
    `email-probe-v1\n${accountId}\n${zoneId}\n${ingressName}`,
    env.EMAIL_SIGNING_SECRET,
  );
  const controller = new AbortController();
  const apiDeadline = Date.now() + 5_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      env.API.fetch('https://api/internal/email/probe-ingress', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-void-internal': proof },
        body: JSON.stringify({ accountId, zoneId, ingressName, secret: authorization.slice(7) }),
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort();
            reject(new Error('email probe timeout'));
          },
          Math.max(0, apiDeadline - Date.now()),
        );
      }),
    ]);
    void response.body?.cancel().catch(() => {});
    return new Response(null, { status: response.status === 204 ? 204 : 403 });
  } catch {
    return new Response(null, { status: 503 });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function confirmationResponse(
  body: BodyInit | null,
  status: number,
  contentType?: string | null,
): Response {
  // API response headers are not relayed, so the anti-framing headers are
  // set here; another site must not frame the Confirm button.
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-security-policy': "frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  });
  if (contentType) {
    headers.set('content-type', contentType);
  }
  return new Response(body, { status, headers });
}

async function readConfirmationResponse(
  response: Response,
  deadline: number,
  controller: AbortController,
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CONFIRMATION_RESPONSE_BYTES) {
    throw new Error('confirmation response too large');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return null;
  }
  const result = new Uint8Array(MAX_CONFIRMATION_RESPONSE_BYTES);
  let size = 0;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('confirmation response timeout');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('confirmation response timeout'));
          }, remaining);
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      });
      if (chunk.done) {
        return result.slice(0, size);
      }
      size += chunk.value.byteLength;
      if (size > result.byteLength) {
        throw new Error('confirmation response too large');
      }
      result.set(chunk.value, size - chunk.value.byteLength);
    }
  } finally {
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling after cancellation.
    }
  }
}

async function confirmDestination(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 1 ||
    entries[0]![0] !== 'token' ||
    !entries[0]![1] ||
    entries[0]![1].length > MAX_CONFIRMATION_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(entries[0]![1])
  ) {
    return confirmationResponse(null, 400);
  }
  if (isTrafficPaused(env)) {
    return confirmationResponse(null, 503);
  }

  const deadline = Date.now() + CONFIRMATION_DEADLINE_MS;
  const controller = new AbortController();
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const target = new URL(`https://api${CONFIRMATION_PATH}`);
    target.searchParams.set('token', entries[0]![1]);
    // GET shows the Confirm button and its POST grants consent. Only the
    // method and the token are relayed; the request body is not.
    const serviceRequest = env.API.fetch(target.toString(), {
      method: request.method,
      redirect: 'manual',
      signal: controller.signal,
    });
    void serviceRequest.then(
      (lateResponse) => {
        if (controller.signal.aborted && lateResponse !== response) {
          void lateResponse.body?.cancel().catch(() => {});
        }
      },
      () => {},
    );
    response = await Promise.race([
      serviceRequest,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('confirmation request timeout'));
        }, CONFIRMATION_DEADLINE_MS);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const body = await readConfirmationResponse(response, deadline, controller);
    return confirmationResponse(body, response.status, response.headers.get('content-type'));
  } catch {
    return confirmationResponse(null, 503);
  } finally {
    controller.abort();
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    void response?.body?.cancel().catch(() => {});
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        ok: true,
        installationId: env.PLATFORM_INSTALLATION_ID,
        platformVersion: env.PLATFORM_VERSION,
        emailProtocolVersion: 1,
      });
    }
    if (
      (request.method === 'GET' || request.method === 'POST') &&
      url.pathname === CONFIRMATION_PATH
    ) {
      return confirmDestination(request, env);
    }
    if (request.method !== 'POST') {
      return new Response(null, { status: 404 });
    }
    if (url.pathname === '/email/probe') {
      return probe(request, env);
    }
    if (url.pathname === '/email/ingress') {
      try {
        return await withDeliverySlot(() => ingress(request, env, ctx));
      } catch {
        return new Response(null, { status: 503 });
      }
    }
    return new Response(null, { status: 404 });
  },
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    if (isTrafficPaused(env)) {
      throw new Error('Email gateway temporarily unavailable');
    }
    const accountId = env.EMAIL_SHARED_ACCOUNT_ID;
    const zoneId = env.EMAIL_SHARED_ZONE_ID;
    const ingressName = env.EMAIL_SHARED_INGRESS_NAME;
    if (!accountId || !zoneId || !ingressName) {
      message.setReject('Email routing is not configured');
      return;
    }
    let route: Route | null;
    try {
      route = await resolveIngress(env, {
        accountId,
        zoneId,
        ingressName,
        from: message.from,
        to: message.to,
        native: true,
      });
    } catch {
      throw new Error('Email route temporarily unavailable');
    }
    if (!route) {
      message.setReject('Email route unavailable');
      return;
    }
    await withDeliverySlot(() => routeInbound(message, env, ctx, route));
  },
};
