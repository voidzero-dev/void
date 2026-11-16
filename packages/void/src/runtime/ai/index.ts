import { cfAccessHeaders } from '../shared/cf-access.ts';
import {
  PROVIDER_KEY_MAP,
  type AiProvider,
  type AiProviderFetchInit,
  type AiProviderOptions,
} from './ai-types.ts';
import { bytesToBase64 } from './base64.ts';
import { getRawRuntimeEnv, type RuntimeEnv } from './env-raw.ts';
import { UsageLimit, limitFromResponse } from './limits.ts';

const VOID_FILE_MARKER = '__voidFile';

// Per-provider auth header/prefix for the self-host direct gateway path. The
// gateway passes provider auth through unchanged, so each entry mirrors the
// provider's documented native auth convention. Providers NOT listed here fall
// back to `Authorization: Bearer <key>` (correct for openai, groq, mistral,
// grok, deepseek, openrouter, perplexity, cohere, cerebras, huggingface,
// replicate). A caller's `apiKeyHeader`/`apiKeyPrefix` override still wins.
const PROVIDER_AUTH_DEFAULTS: Record<string, { header: string; prefix: string }> = {
  'google-ai-studio': { header: 'x-goog-api-key', prefix: '' },
  anthropic: { header: 'x-api-key', prefix: '' },
  elevenlabs: { header: 'xi-api-key', prefix: '' },
  deepgram: { header: 'authorization', prefix: 'Token ' },
  fal: { header: 'authorization', prefix: 'Key ' },
  cartesia: { header: 'x-api-key', prefix: '' },
  baseten: { header: 'authorization', prefix: 'Api-Key ' },
  ideogram: { header: 'Api-Key', prefix: '' },
  parallel: { header: 'x-api-key', prefix: '' },
};

type SerializedFileInput = {
  [VOID_FILE_MARKER]: true;
  data: string;
  name?: string;
  type?: string;
};

type SerializedProviderBody =
  | { type: 'none' }
  | { type: 'json'; value: unknown }
  | { type: 'text'; data: string; contentType?: string }
  | { type: 'base64'; data: string; contentType?: string }
  | { type: 'form'; entries: Array<{ name: string; value: string | SerializedFileInput }> };

type AiBackend = {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
  image(model: string, inputs: unknown, options?: unknown): Promise<Response>;
  providerFetch(
    provider: string,
    path: string,
    init: AiProviderFetchInit | undefined,
    options: AiProviderOptions | undefined,
  ): Promise<Response>;
  models(params?: unknown): Promise<unknown>;
  toMarkdown(items: unknown, options?: unknown): Promise<unknown>;
};

function hasStreamFlag(value: unknown): value is { stream?: boolean } {
  return typeof value === 'object' && value !== null && 'stream' in value;
}

function mediaTypeFromContentType(contentType: string | null): string | null {
  if (!contentType) {
    return null;
  }
  const [mediaType] = contentType.split(';', 1);
  const normalized = mediaType?.trim().toLowerCase();
  return normalized || null;
}

function isJsonMediaType(mediaType: string | null): boolean {
  if (mediaType === 'application/json') {
    return true;
  }
  const slash = mediaType?.indexOf('/') ?? -1;
  return Boolean(mediaType && slash >= 0 && mediaType.slice(slash + 1).endsWith('+json'));
}

async function readProxyResult(response: Response): Promise<unknown> {
  if (isJsonMediaType(mediaTypeFromContentType(response.headers.get('content-type')))) {
    return response.json();
  }
  return response.blob();
}

function hasResponseMethod(value: unknown): value is { response(): Response | Promise<Response> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'response' in value &&
    typeof (value as { response?: unknown }).response === 'function'
  );
}

function isBinaryView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

function copyBinaryView(value: ArrayBufferView): ArrayBuffer {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

function fileNameFromBlob(value: Blob): string | undefined {
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

async function serializeFormData(form: FormData): Promise<SerializedProviderBody> {
  const entries: Array<{ name: string; value: string | SerializedFileInput }> = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      entries.push({ name, value });
      continue;
    }
    entries.push({
      name,
      value: {
        [VOID_FILE_MARKER]: true,
        data: arrayBufferToBase64(await value.arrayBuffer()),
        name: fileNameFromBlob(value) ?? name,
        type: value.type || undefined,
      },
    });
  }
  return { type: 'form', entries };
}

async function serializeProviderBody(body: unknown): Promise<SerializedProviderBody> {
  if (body === undefined || body === null) {
    return { type: 'none' };
  }

  if (typeof body === 'string') {
    return { type: 'text', data: body };
  }

  if (body instanceof URLSearchParams) {
    return {
      type: 'text',
      data: body.toString(),
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }

  if (body instanceof FormData) {
    return serializeFormData(body);
  }

  if (body instanceof Blob) {
    return {
      type: 'base64',
      data: arrayBufferToBase64(await body.arrayBuffer()),
      contentType: body.type || undefined,
    };
  }

  if (body instanceof ArrayBuffer) {
    return { type: 'base64', data: arrayBufferToBase64(body) };
  }

  if (isBinaryView(body)) {
    return { type: 'base64', data: arrayBufferToBase64(copyBinaryView(body)) };
  }

  return { type: 'json', value: body };
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const result: Record<string, string> = {};
  const normalized = new Headers(headers);
  for (const [key, value] of normalized.entries()) {
    result[key] = value;
  }
  return result;
}

async function responseFromResult(result: unknown): Promise<Response> {
  if (result instanceof Response) {
    return result;
  }
  if (hasResponseMethod(result)) {
    return result.response();
  }
  if (result instanceof Blob) {
    return new Response(result, {
      headers: result.type ? { 'content-type': result.type } : undefined,
    });
  }
  if (result instanceof ReadableStream) {
    return new Response(result, { headers: { 'content-type': 'application/octet-stream' } });
  }
  if (result instanceof ArrayBuffer) {
    return new Response(result, { headers: { 'content-type': 'application/octet-stream' } });
  }
  if (isBinaryView(result)) {
    return new Response(copyBinaryView(result), {
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  return Response.json(result);
}

function imageRunOptions(options: unknown): Record<string, unknown> | undefined {
  if (typeof options !== 'object' || options === null) {
    return undefined;
  }

  const { endpoint: _endpoint, ...runOptions } = options as Record<string, unknown>;
  return Object.keys(runOptions).length > 0 ? runOptions : undefined;
}

function resolveProviderKey(
  provider: string,
  runtimeEnv: RuntimeEnv,
  options?: AiProviderOptions,
): string {
  const envVar = options?.apiKeyEnv ?? PROVIDER_KEY_MAP[provider];
  if (!envVar) {
    throw new Error(
      `ai: Unknown provider '${provider}'. Use one of: ${Object.keys(PROVIDER_KEY_MAP).join(', ')}.`,
    );
  }
  const key = runtimeEnv[envVar];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `ai: Missing ${envVar} secret. Add it as a project secret for provider '${provider}'.`,
    );
  }
  return key;
}

function getProxyUrl(runtimeEnv: RuntimeEnv): string {
  const custom = runtimeEnv.__VOID_PROXY_URL;
  if (typeof custom === 'string' && custom.length > 0) {
    return custom.replace(/\/+$/, '') + '/ai';
  }
  throw new Error('ai: No connected platform proxy is available. Run `void connect <url>` first.');
}

function providerAuthDefaults(provider: string): { header: string; prefix: string } {
  return PROVIDER_AUTH_DEFAULTS[provider] ?? { header: 'authorization', prefix: 'Bearer ' };
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

/**
 * Build a real outgoing HTTP body for the user's own AI Gateway (self-host).
 *
 * Unlike `serializeProviderBody`/`providerRequestBody` (which build the proxy
 * envelope decoded on the proxy side), this emits an actual `BodyInit` +
 * content-type for a direct `fetch` to the gateway.
 */
function toDirectBody(body: unknown): { body: BodyInit | undefined; contentType?: string } {
  if (body === undefined || body === null) {
    return { body: undefined };
  }
  if (typeof body === 'string') {
    return { body };
  }
  if (
    body instanceof ReadableStream ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    isBinaryView(body)
  ) {
    return { body: body as BodyInit };
  }
  return { body: JSON.stringify(body), contentType: 'application/json' };
}

function resolveBackend(): AiBackend {
  const runtimeEnv = getRawRuntimeEnv();

  // Priority 1: Service binding (production via Void)
  const proxy = runtimeEnv.__VOID_PROXY as Fetcher | undefined;
  if (proxy) {
    return makeServiceBindingBackend(proxy, runtimeEnv);
  }

  // Priority 2: HTTPS to our proxy (local dev with Void auth)
  const token = runtimeEnv.__VOID_TOKEN;
  const projectId = runtimeEnv.__VOID_PROJECT_ID;
  if (typeof token === 'string' && typeof projectId === 'string') {
    return makeHttpBackend(token, projectId, runtimeEnv);
  }

  // Priority 3: Direct AI binding (user's own CF account). Void's generated
  // wrangler config stamps custom binding names into a private runtime var;
  // default and managed deployments continue to use `AI`.
  const aiBindingName =
    typeof runtimeEnv.__VOID_AI_BINDING === 'string' ? runtimeEnv.__VOID_AI_BINDING : 'AI';
  const directAi = runtimeEnv[aiBindingName] as Ai | undefined;
  if (directAi) {
    return makeDirectBackend(
      directAi,
      runtimeEnv,
      runtimeEnv.__VOID_AI_GATEWAY as string | undefined,
    );
  }

  throw new Error(
    `ai: Not available. Configure a Workers AI binding (env.${aiBindingName}) for direct Cloudflare development or deployment, or connect and link a Void platform.`,
  );
}

function unsupported(method: string): () => never {
  return () => {
    throw new Error(`ai: ai.${method}() is not supported in this environment.`);
  };
}

async function providerRequestBody(
  provider: string,
  path: string,
  init: AiProviderFetchInit | undefined,
  options: AiProviderOptions | undefined,
  runtimeEnv: RuntimeEnv,
): Promise<Record<string, unknown>> {
  return {
    provider,
    path,
    method: init?.method,
    headers: headersToRecord(init?.headers),
    body: await serializeProviderBody(init?.body),
    providerKey: resolveProviderKey(provider, runtimeEnv, options),
    apiKeyHeader: options?.apiKeyHeader,
    apiKeyPrefix: options?.apiKeyPrefix,
  };
}

type ProxySend = (
  action: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal | null,
) => Promise<Response>;

/** Backend for the Void platform proxy, reached by service binding or HTTPS. */
function makeProxyBackend(send: ProxySend, runtimeEnv: RuntimeEnv): AiBackend {
  async function proxyFetch(
    action: string,
    payload: Record<string, unknown>,
    options: { throwOnError?: boolean } = {},
  ): Promise<Response> {
    let signal: AbortSignal | undefined;
    if (typeof payload.options === 'object' && payload.options !== null) {
      // AbortSignal is request-local state, not a serializable binding option.
      const { signal: bindingSignal, ...wireOptions } = payload.options as AiOptions;
      signal = bindingSignal;
      payload = { ...payload, options: wireOptions };
    }
    const res = await send(action, payload, signal);
    const limit = await limitFromResponse(res, 'ai');
    if (limit) {
      throw limit;
    }
    if (options.throwOnError !== false && !res.ok) {
      const text = await res.text();
      throw new Error(`ai: Proxy request failed with ${res.status}: '${text}'.`);
    }
    return res;
  }

  return {
    async run(model, inputs, options) {
      const res = await proxyFetch('run', { model, inputs, options });
      if (hasStreamFlag(inputs) && inputs.stream) {
        return res.body;
      }
      return readProxyResult(res);
    },
    async image(model, inputs, options) {
      return proxyFetch('run', { model, inputs, options: imageRunOptions(options) });
    },
    async providerFetch(provider, path, init, options) {
      return proxyFetch(
        'provider',
        await providerRequestBody(provider, path, init, options, runtimeEnv),
        { throwOnError: false },
      );
    },
    async models(params) {
      const res = await proxyFetch('models', { inputs: params });
      return res.json();
    },
    async toMarkdown(items, options) {
      const res = await proxyFetch('toMarkdown', { inputs: items, options });
      return res.json();
    },
  };
}

function makeServiceBindingBackend(proxy: Fetcher, runtimeEnv: RuntimeEnv): AiBackend {
  return makeProxyBackend(
    (action, payload, signal) =>
      proxy.fetch(`https://ai-proxy/ai/${action}`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action,
          ...payload,
          projectId: runtimeEnv.__PROJECT_ID,
          aiToken: runtimeEnv.__VOID_PROXY_TOKEN,
        }),
      }),
    runtimeEnv,
  );
}

function makeHttpBackend(token: string, projectId: string, runtimeEnv: RuntimeEnv): AiBackend {
  const base = getProxyUrl(runtimeEnv);
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...cfAccessHeaders(runtimeEnv, base),
  };

  return makeProxyBackend(
    (action, payload, signal) =>
      fetch(`${base}/${action}`, {
        method: 'POST',
        signal,
        headers,
        body: JSON.stringify({ action, ...payload, projectId }),
        redirect: 'manual',
      }),
    runtimeEnv,
  );
}

function makeDirectBackend(
  directAi: Ai,
  runtimeEnv: RuntimeEnv,
  gatewayId: string | undefined,
): AiBackend {
  // The binding normally throws an Error containing only a message. Inspect the
  // raw response before its parser discards status and Retry-After metadata.
  // https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/ai-api.ts
  const run = async (model: string, inputs: unknown, options?: unknown): Promise<unknown> => {
    const opts = (options ?? {}) as AiOptions;
    const response = await directAi.run(model, inputs as never, {
      ...opts,
      returnRawResponse: true,
    });
    if (!(response instanceof Response)) {
      return response;
    }
    const limit = await limitFromResponse(response, 'ai');
    if (limit) {
      throw limit;
    }
    if (opts.returnRawResponse || opts.websocket) {
      return response;
    }
    if (!response.ok) {
      throw new Error(`ai: Request failed with ${response.status}: '${await response.text()}'.`);
    }
    return isJsonMediaType(mediaTypeFromContentType(response.headers.get('content-type')))
      ? response.json()
      : response.body;
  };
  return {
    run,
    async image(model, inputs, options) {
      return responseFromResult(await run(model, inputs, imageRunOptions(options)));
    },
    async providerFetch(provider, path, init, options) {
      if (!gatewayId) {
        return Response.json(
          {
            error:
              'ai: ai.provider().fetch() needs an AI Gateway when self-hosting. Set `ai.gateway` in void.config.ts.',
          },
          { status: 501 },
        );
      }
      if (isUnsafeProviderPath(path)) {
        return Response.json(
          { error: `ai: provider path '${path}' must be relative.` },
          { status: 400 },
        );
      }
      let providerKey: string;
      try {
        providerKey = resolveProviderKey(provider, runtimeEnv, options);
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 400 });
      }
      let baseUrl: string;
      try {
        baseUrl = await directAi.gateway(gatewayId).getUrl(provider);
      } catch (e) {
        return Response.json(
          { error: `ai: gateway '${gatewayId}': ${(e as Error).message}` },
          { status: 502 },
        );
      }
      const { body, contentType } = toDirectBody(init?.body);
      const headers = new Headers(init?.headers);
      const defaults = providerAuthDefaults(provider);
      headers.set(
        options?.apiKeyHeader ?? defaults.header,
        `${options?.apiKeyPrefix ?? defaults.prefix}${providerKey}`,
      );
      if (contentType && !headers.has('content-type')) {
        headers.set('content-type', contentType);
      }
      return fetch(gatewayEndpointUrl(baseUrl, path), {
        method: init?.method ?? 'POST',
        headers,
        body,
      });
    },
    models: directAi.models.bind(directAi),
    toMarkdown: directAi.toMarkdown?.bind(directAi) ?? unsupported('toMarkdown'),
  };
}

let _backend: AiBackend | undefined;
function backend(): AiBackend {
  return (_backend ??= resolveBackend());
}

/**
 * Extended AI type with a convenience `stream()` method.
 *
 * `stream()` calls `ai.run()` with `stream: true` and wraps the result
 * in a `Response` with SSE headers — ready to return from a route handler.
 */
export type VoidAi = {
  models(...args: Parameters<Ai['models']>): Promise<Awaited<ReturnType<Ai['models']>>>;
  toMarkdown(
    files: Array<Parameters<Ai['toMarkdown']>[0]>,
    options?: Parameters<Ai['toMarkdown']>[1],
  ): Promise<Array<Awaited<ReturnType<Ai['toMarkdown']>>>>;
  toMarkdown(...args: Parameters<Ai['toMarkdown']>): Promise<Awaited<ReturnType<Ai['toMarkdown']>>>;
  /** Workers AI inference. */
  run<Name extends keyof AiModels>(
    model: Name,
    inputs: AiModels[Name]['inputs'],
    options?: AiOptions,
  ): Promise<AiModels[Name]['postProcessedOutputs']>;

  /** Cloudflare AI Gateway model inference. Accepts Cloudflare model IDs unchanged. */
  run(model: string, inputs: unknown, options?: AiOptions): Promise<unknown>;

  /** Image generation. Returns the proxy response so callers can return or parse it. */
  image<Name extends keyof AiModels>(
    model: Name,
    inputs: AiModels[Name]['inputs'],
    options?: AiOptions,
  ): Promise<Response>;

  /** Cloudflare AI Gateway model inference returned as a Response. */
  image(model: string, inputs: unknown, options?: AiOptions): Promise<Response>;

  /** Provider-native AI Gateway requests using a project secret for the provider API key. */
  provider(
    provider: AiProvider,
    options?: AiProviderOptions,
  ): {
    fetch(path: string, init?: AiProviderFetchInit): Promise<Response>;
  };

  /** Stream Workers AI response as SSE */
  stream<Name extends keyof AiModels>(
    model: Name,
    inputs: Omit<AiModels[Name]['inputs'], 'stream'>,
    options?: AiOptions,
  ): Promise<Response>;

  /** Stream any Cloudflare AI Gateway model response as SSE */
  stream(model: string, inputs: Record<string, unknown>, options?: AiOptions): Promise<Response>;
};

/** Normalize provider 429 responses and binding quota failures before they reach callers. */
async function aiOperation<T>(execute: () => Promise<T>, rawStream = false): Promise<T> {
  let value: T;
  try {
    value = await execute();
    if (value instanceof Response) {
      const limit = await limitFromResponse(value, 'ai');
      if (limit) {
        throw limit;
      }
    }
  } catch (error) {
    throw classifyAiLimit(error) ?? error;
  }
  if (
    value instanceof Response &&
    value.body &&
    value.headers.get('content-type')?.includes('text/event-stream')
  ) {
    return new Response(streamResponse(value.body).body, value) as T;
  }
  if (rawStream && value instanceof ReadableStream) {
    return streamResponse(value).body as T;
  }
  return value;
}

function classifyAiLimit(error: unknown): UsageLimit | null {
  if (error instanceof UsageLimit) {
    return error;
  }
  const e = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  } | null;
  return e && (e.status === 429 || e.statusCode === 429 || e.response?.status === 429)
    ? new UsageLimit({
        resource: 'ai',
        reason: 'rate_limit',
        message: 'AI usage limit exceeded.',
      })
    : null;
}

/** Streaming failures after headers are sent end with an explicit terminal SSE event. */
function streamResponse(body: ReadableStream): Response {
  const reader = body.getReader();
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          const limit = classifyAiLimit(error);
          let data: unknown = { message: 'Generation was interrupted. Please try again.' };
          if (limit) {
            data = await limit.response().json();
          }
          controller.enqueue(
            new TextEncoder().encode(
              `event: ${limit ? 'void:limit' : 'void:error'}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
          controller.close();
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
  );
}

export const ai: VoidAi = new Proxy({} as VoidAi, {
  get(_, prop) {
    if (prop === 'stream') {
      return (model: string, inputs: Record<string, unknown>, options?: unknown) =>
        aiOperation(
          async () =>
            new Response(
              (await backend().run(model, { ...inputs, stream: true }, options)) as ReadableStream,
              { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
            ),
        );
    }
    if (prop === 'provider') {
      return (provider: string, options?: AiProviderOptions) => ({
        fetch: (path: string, init?: AiProviderFetchInit) =>
          aiOperation(() => backend().providerFetch(provider, path, init, options)),
      });
    }
    if (prop === 'run' || prop === 'image' || prop === 'models' || prop === 'toMarkdown') {
      return (...args: [string, unknown, unknown]) =>
        aiOperation(
          () => (backend()[prop] as (...args: Array<unknown>) => Promise<unknown>)(...args),
          prop === 'run' && hasStreamFlag(args[1]) && args[1].stream === true,
        );
    }
    return undefined;
  },
});

export type {
  AiProvider,
  AiProviderFetchInit,
  AiProviderName,
  AiProviderOptions,
  ImageFileInput,
} from './ai-types.ts';
