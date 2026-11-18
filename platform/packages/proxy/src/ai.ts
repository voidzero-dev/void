import { isRecord } from '@void/deploy-core';
import type { AiLoggingMode } from '@void/platform/ai-logging';
import { deriveAiUsageTag } from '@voidcloud/api/proxy-token';
import { Hono } from 'hono';
import { applyAiLoggingHeaders, bindingAiLogging, readAiLoggingMode } from './ai-logging.ts';
import { asRecord, asString } from './body.ts';
import type { ProxyEnv } from './types.ts';

const DEFAULT_GATEWAY_ID = 'void';
const PROVIDER_AUTH_DEFAULTS: Record<string, { header: string; prefix: string }> = {
  'google-ai-studio': { header: 'x-goog-api-key', prefix: '' },
};
const VOID_FILE_MARKER = '__voidFile';

type SerializedFileInput = Readonly<{
  [VOID_FILE_MARKER]: true;
  data: string;
  name?: string;
  type?: string;
}>;

type SerializedProviderBody = Readonly<
  | { type: 'none' }
  | { type: 'json'; value: unknown }
  | { type: 'text'; data: string; contentType?: string }
  | { type: 'base64'; data: string; contentType?: string }
  | { type: 'form'; entries: Array<{ name: string; value: string | SerializedFileInput }> }
>;

class BadRequestError extends Error {}

const ai = new Hono<ProxyEnv>();

function hasStreamFlag(value: unknown): value is { stream?: boolean } {
  return typeof value === 'object' && value !== null && 'stream' in value;
}

function isBinaryView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

function isSerializedFileInput(value: unknown): value is SerializedFileInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[VOID_FILE_MARKER] === true &&
    typeof (value as Record<string, unknown>).data === 'string' &&
    ((value as Record<string, unknown>).name === undefined ||
      typeof (value as Record<string, unknown>).name === 'string') &&
    ((value as Record<string, unknown>).type === undefined ||
      typeof (value as Record<string, unknown>).type === 'string')
  );
}

function base64ToBytes(base64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new BadRequestError('invalid file data');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function gatewayEndpointUrl(baseUrl: string, endpoint: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  return `${normalizedBase}/${normalizedEndpoint}`;
}

function isUnsafeProviderPath(path: string): boolean {
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(path) || path.includes('\\')) {
    return true;
  }

  const pathname = path.split(/[?#]/, 1)[0] ?? '';
  for (const segment of pathname.split('/')) {
    try {
      if (decodeURIComponent(segment) === '..') {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}

function providerBody(value: unknown): SerializedProviderBody {
  const record = asRecord(value);
  const type = asString(record.type);
  if (
    type === 'none' ||
    type === 'json' ||
    type === 'text' ||
    type === 'base64' ||
    type === 'form'
  ) {
    return record as SerializedProviderBody;
  }
  return { type: 'none' };
}

function appendSerializedFormValue(
  form: FormData,
  name: string,
  value: string | SerializedFileInput,
): void {
  if (isSerializedFileInput(value)) {
    const blob = new Blob([base64ToBytes(value.data)], {
      type: value.type ?? 'application/octet-stream',
    });
    form.append(name, blob, value.name ?? name);
    return;
  }
  form.append(name, value);
}

function providerRequestBody(body: SerializedProviderBody): {
  body?: BodyInit;
  contentType?: string;
} {
  if (body.type === 'none') {
    return {};
  }

  if (body.type === 'json') {
    return { body: JSON.stringify(body.value), contentType: 'application/json' };
  }

  if (body.type === 'text') {
    return { body: body.data, contentType: body.contentType };
  }

  if (body.type === 'base64') {
    return {
      body: base64ToBytes(body.data).buffer as ArrayBuffer,
      contentType: body.contentType,
    };
  }

  const form = new FormData();
  for (const entry of body.entries) {
    appendSerializedFormValue(form, entry.name, entry.value);
  }
  return { body: form };
}

function headersFromRecord(value: unknown): Headers {
  const headers = new Headers();
  for (const [key, headerValue] of Object.entries(asRecord(value))) {
    if (typeof headerValue === 'string') {
      headers.set(key, headerValue);
    }
  }
  return headers;
}

function providerAuthDefaults(provider: string): { header: string; prefix: string } {
  return PROVIDER_AUTH_DEFAULTS[provider] ?? { header: 'authorization', prefix: 'Bearer ' };
}

// AI usage is counted from the platform gateway's analytics by their
// `projectId` metadata, which holds the signed project tag from
// `deriveAiUsageTag`, so the platform owns the gateway id, its metadata and
// logging policy. Cloudflare saves only the first five metadata entries, and
// integer-like keys always sort first, so caller metadata could push the
// project out. Applications cannot override an operator's logging decision.
const PLATFORM_GATEWAY_KEYS = new Set(['id', 'metadata', 'collectLog', 'collectLogPayload']);
// `cf-aig-*` request headers set the same metadata, logging and cost.
const GATEWAY_CONTROL_HEADER = /^cf-aig-/i;
// Provider-native calls keep the gateway headers that only shape their own
// request: cache, timeout, retry and the trace id. A caller cache key is kept
// inside its project; every other `cf-aig-*` header is dropped.
const PROVIDER_GATEWAY_HEADERS = new Set([
  'cf-aig-cache-ttl',
  'cf-aig-skip-cache',
  'cf-aig-request-timeout',
  'cf-aig-max-attempts',
  'cf-aig-retry-delay',
  'cf-aig-backoff',
  'cf-aig-event-id',
]);
const CACHE_KEY_HEADER = 'cf-aig-cache-key';

/** A caller cache key only hits inside its own project. */
function projectCacheKey(projectId: string, cacheKey: string): string {
  return `${projectId}:${cacheKey}`;
}

function withoutKeys(
  record: Record<string, unknown>,
  drop: (key: string) => boolean,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !drop(key)));
}

/** Options for an AI binding call that goes through the project-tagged platform gateway. */
function gatewayOptions(
  value: unknown,
  projectId: string,
  usageTag: string,
  gatewayId: string,
  loggingMode: AiLoggingMode,
): Record<string, unknown> {
  // JSON cannot carry cancellation state. Never pass a serialized signal to
  // a native binding, including when an older SDK still sends the field.
  const options = withoutKeys(asRecord(value), (key) => key === 'signal');
  const gateway = withoutKeys(asRecord(options.gateway), (key) => PLATFORM_GATEWAY_KEYS.has(key));
  if (typeof gateway.cacheKey === 'string') {
    gateway.cacheKey = projectCacheKey(projectId, gateway.cacheKey);
  }

  const logging = bindingAiLogging(loggingMode);
  const result: Record<string, unknown> = {
    ...options,
    gateway: {
      ...gateway,
      id: gatewayId,
      metadata: { projectId: usageTag },
      ...(logging ? { collectLog: logging.collectLog } : {}),
    },
  };
  if ('extraHeaders' in options || logging) {
    const headers = withoutKeys(asRecord(options.extraHeaders), (key) =>
      GATEWAY_CONTROL_HEADER.test(key),
    );
    if (logging) {
      headers['cf-aig-collect-log-payload'] = String(logging.payload);
    }
    result.extraHeaders = headers;
  }
  if ('sessionOptions' in options) {
    const session = { ...asRecord(options.sessionOptions) };
    if ('extraHeaders' in session) {
      session.extraHeaders = withoutKeys(asRecord(session.extraHeaders), (key) =>
        GATEWAY_CONTROL_HEADER.test(key),
      );
    }
    result.sessionOptions = session;
  }
  return result;
}

function applyProviderHeaders({
  headers,
  provider,
  providerKey,
  projectId,
  apiKeyHeader,
  apiKeyPrefix,
  contentType,
}: {
  headers: Headers;
  provider: string;
  providerKey: string;
  projectId: string;
  apiKeyHeader?: string | null;
  apiKeyPrefix?: string | null;
  contentType?: string;
}): Headers {
  const defaults = providerAuthDefaults(provider);
  const keyHeader = apiKeyHeader ?? defaults.header;
  const keyPrefix = apiKeyPrefix ?? defaults.prefix;

  headers.set(keyHeader, `${keyPrefix}${providerKey}`);
  // Provider-native calls bill to the app's own provider key, so they carry
  // no usage tag and do not count toward the platform AI allowance. Caller
  // gateway headers are filtered after the key header is set, so neither they
  // nor a caller-chosen key header name can set gateway metadata, logging,
  // cost or billing, or use a cache key outside the project.
  const callerGatewayHeaders = [...headers.keys()].filter(
    (name) => GATEWAY_CONTROL_HEADER.test(name) && !PROVIDER_GATEWAY_HEADERS.has(name),
  );
  for (const name of callerGatewayHeaders) {
    const value = headers.get(name);
    if (name === CACHE_KEY_HEADER && value !== null) {
      headers.set(name, projectCacheKey(projectId, value));
    } else {
      headers.delete(name);
    }
  }
  if (contentType && !headers.has('content-type')) {
    headers.set('content-type', contentType);
  }
  return headers;
}

function headersForContentType(contentType: string | null | undefined): HeadersInit | undefined {
  return contentType ? { 'content-type': contentType } : undefined;
}

function filteredResponseHeaders(response: Response): Headers {
  const headers = new Headers();
  const contentType = response.headers.get('content-type');
  const cacheControl = response.headers.get('cache-control');
  if (contentType) {
    headers.set('content-type', contentType);
  }
  if (cacheControl) {
    headers.set('cache-control', cacheControl);
  }
  return headers;
}

function responseFromThrown(value: unknown): Response | null {
  if (value instanceof Response) {
    return value;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (value.response instanceof Response) {
    return value.response;
  }

  return responseFromThrown(value.cause);
}

function statusFromThrown(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }

  const status = value.status ?? value.statusCode;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
    return status;
  }

  return statusFromThrown(value.cause);
}

function messageFromThrown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  return String(value);
}

function hasResponseMethod(value: unknown): value is { response(): Response | Promise<Response> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'response' in value &&
    typeof (value as { response?: unknown }).response === 'function'
  );
}

async function responseFromAiResult(result: unknown, streamAsSse: boolean): Promise<Response> {
  if (result instanceof Response) {
    return result;
  }

  if (hasResponseMethod(result)) {
    return result.response();
  }

  if (result instanceof ReadableStream) {
    return new Response(result, {
      headers: streamAsSse
        ? {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          }
        : { 'content-type': 'application/octet-stream' },
    });
  }

  if (result instanceof Blob) {
    return new Response(result, { headers: headersForContentType(result.type) });
  }

  if (result instanceof ArrayBuffer || isBinaryView(result)) {
    return new Response(result, { headers: { 'content-type': 'application/octet-stream' } });
  }

  return Response.json(result);
}

async function responseFromAiError(err: unknown): Promise<Response> {
  const response = responseFromThrown(err);
  if (response) {
    return responseFromGateway(response, false);
  }

  const status = statusFromThrown(err) ?? 502;
  return Response.json({ error: messageFromThrown(err) }, { status });
}

async function responseFromGateway(response: Response, streamAsSse: boolean): Promise<Response> {
  if (streamAsSse && response.body) {
    return new Response(response.body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      },
    });
  }

  return new Response(response.body, {
    status: response.status,
    headers: filteredResponseHeaders(response),
  });
}

ai.post('/run', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const model = asString(body.model);

  if (!model) {
    return context.json({ error: 'model required' }, 400);
  }

  const logging = await readAiLoggingMode(context);
  if (!logging.ok) {
    return logging.response;
  }
  const options = gatewayOptions(
    body.options,
    projectId,
    await deriveAiUsageTag(context.env.JWT_SECRET, projectId),
    context.env.AI_GATEWAY_ID ?? DEFAULT_GATEWAY_ID,
    logging.mode,
  );

  try {
    const result = await context.env.AI.run(model, body.inputs, {
      ...options,
      signal: context.req.raw.signal,
    });
    return responseFromAiResult(result, hasStreamFlag(body.inputs) && body.inputs.stream === true);
  } catch (err) {
    const message = messageFromThrown(err);
    console.error('AI inference error:', message);
    return responseFromAiError(err);
  }
});

ai.post('/provider', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const provider = asString(body.provider);
  const path = asString(body.path);
  const method = asString(body.method) ?? 'POST';
  const providerKey = asString(body.providerKey);
  const apiKeyHeader = asString(body.apiKeyHeader);
  const apiKeyPrefix = asString(body.apiKeyPrefix);

  if (!provider) {
    return context.json({ error: 'provider required' }, 400);
  }
  if (!path) {
    return context.json({ error: 'path required' }, 400);
  }
  if (!providerKey) {
    return context.json({ error: 'providerKey required' }, 400);
  }
  if (isUnsafeProviderPath(path)) {
    return context.json({ error: 'path must be relative' }, 400);
  }

  try {
    // Decode the body first so a malformed file is a 400 that never reads the policy.
    const requestBody = providerRequestBody(providerBody(body.body));
    const logging = await readAiLoggingMode(context);
    if (!logging.ok) {
      return logging.response;
    }
    const gateway = context.env.AI.gateway(context.env.AI_GATEWAY_ID ?? DEFAULT_GATEWAY_ID);
    const baseUrl = await gateway.getUrl(provider);
    const headers = applyProviderHeaders({
      headers: headersFromRecord(body.headers),
      provider,
      providerKey,
      projectId,
      apiKeyHeader,
      apiKeyPrefix,
      contentType: requestBody.contentType,
    });
    applyAiLoggingHeaders(headers, logging.mode);
    const response = await fetch(gatewayEndpointUrl(baseUrl, path), {
      method,
      headers,
      body: requestBody.body,
    });

    if (!response.ok) {
      const text = await response.text();
      let error: string;
      try {
        const json = JSON.parse(text);
        error = json.error?.message ?? text;
      } catch {
        error = text;
      }
      return context.json({ error }, response.status as 400);
    }

    return responseFromGateway(response, false);
  } catch (err) {
    if (err instanceof BadRequestError) {
      return context.json({ error: err.message }, 400);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('AI Gateway error:', message);
    return context.json({ error: 'gateway error' }, 502);
  }
});

ai.post('/models', async (context) => {
  const body = context.get('body');
  try {
    const result = await context.env.AI.models(body.inputs);
    return context.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('AI inference error:', message);
    return context.json({ error: 'inference error' }, 502);
  }
});

ai.post('/toMarkdown', async (context) => {
  const body = context.get('body');
  const projectId = context.get('projectId');
  const logging = await readAiLoggingMode(context);
  if (!logging.ok) {
    return logging.response;
  }
  const options = gatewayOptions(
    body.options,
    projectId,
    await deriveAiUsageTag(context.env.JWT_SECRET, projectId),
    context.env.AI_GATEWAY_ID ?? DEFAULT_GATEWAY_ID,
    logging.mode,
  );
  try {
    const result = await context.env.AI.toMarkdown(body.inputs, options);
    return context.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('AI inference error:', message);
    return context.json({ error: 'inference error' }, 502);
  }
});

export { ai };
