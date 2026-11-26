import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

/** Fake Workers AI binding (`env.AI`) whose gateway URLs include the gateway id and provider. */
function makeDirectAi(
  opts: { getUrl?: (id: string, provider: string) => Promise<string>; run?: () => unknown } = {},
) {
  const getUrlImpl =
    opts.getUrl ??
    (async (id: string, provider: string) =>
      `https://gateway.ai.cloudflare.com/v1/acct123/${id}/${provider}`);
  const run = vi.fn(async (..._args: Array<unknown>) => (opts.run ? opts.run() : { ok: true }));
  const models = vi.fn(async () => ['@cf/meta/llama']);
  const toMarkdown = vi.fn(async () => []);
  const gateway = vi.fn((id: string) => ({
    getUrl: vi.fn((provider: string) => getUrlImpl(id, provider)),
  }));
  return { AI: { run, gateway, models, toMarkdown }, run, gateway };
}

describe('runtime ai', () => {
  it.each([
    ['direct', 'application/json'],
    ['http', 'application/json'],
    ['service', 'application/json'],
    ['direct', 'text/event-stream'],
    ['http', 'text/event-stream'],
    ['service', 'text/event-stream'],
  ] as const)(
    'cancels provider response streams on the %s transport (%s) without serializing the signal',
    async (transport, contentType) => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');
      const controller = new AbortController();
      const request = vi.fn(
        async (_url: string, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'));
                init.signal?.addEventListener('abort', () => stream.error(init.signal!.reason));
              },
            }),
            { headers: { 'content-type': contentType } },
          ),
      );
      vi.stubGlobal('fetch', request);
      const env =
        transport === 'direct'
          ? { AI: makeDirectAi().AI, __VOID_AI_GATEWAY: 'gateway' }
          : transport === 'service'
            ? {
                __VOID_PROXY: { fetch: request },
                __PROJECT_ID: 'project',
                __VOID_PROXY_TOKEN: 'token',
              }
            : {
                __VOID_TOKEN: 'token',
                __VOID_PROJECT_ID: 'project',
                __VOID_PROXY_URL: 'https://proxy.test',
              };
      await envContext.run({ ...env, OPENAI_API_KEY: 'synthetic-provider-key' }, async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          body: { messages: [] },
          signal: controller.signal,
        });
        const init = request.mock.calls[0][1];
        expect(init.signal).toBe(controller.signal);
        const payload = JSON.parse(init.body as string);
        expect(payload).not.toHaveProperty('signal');
        expect(payload.options).toBeUndefined();
        const reading = response.text();
        controller.abort(new Error('provider request cancelled'));
        await expect(reading).rejects.toThrow('provider request cancelled');
      });
    },
  );

  it('ends a provider SSE stream that fails without a cancellation with a void:error event', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');
    const controller = new AbortController();
    let pulls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(stream) {
                if (pulls++ === 0) {
                  stream.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'));
                } else {
                  stream.error(new Error('upstream reset'));
                }
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );
    const env = {
      AI: makeDirectAi().AI,
      __VOID_AI_GATEWAY: 'gateway',
      OPENAI_API_KEY: 'synthetic-provider-key',
    };
    await envContext.run(env, async () => {
      const response = await ai.provider('openai').fetch('/chat/completions', {
        body: { messages: [], stream: true },
        signal: controller.signal,
      });
      const text = await response.text();
      expect(text).toContain('data: {"a":1}');
      expect(text).toContain('event: void:error');
    });
  });

  it.each(['http', 'service'] as const)(
    'keeps cancellation on the %s transport instead of serializing it as a binding option',
    async (transport) => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');
      const controller = new AbortController();
      const request = vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.signal).toBe(controller.signal);
        expect(JSON.parse(init.body as string).options).toEqual({ returnRawResponse: true });
        return new Response(
          new ReadableStream({
            start(stream) {
              init.signal!.addEventListener('abort', () => stream.error(init.signal!.reason));
            },
          }),
        );
      });
      vi.stubGlobal('fetch', request);
      const env =
        transport === 'service'
          ? {
              __VOID_PROXY: { fetch: request },
              __PROJECT_ID: 'project',
              __VOID_PROXY_TOKEN: 'token',
            }
          : {
              __VOID_TOKEN: 'token',
              __VOID_PROJECT_ID: 'project',
              __VOID_PROXY_URL: 'https://proxy.test',
            };
      await envContext.run(env, async () => {
        const stream = (await ai.run(
          'model',
          { stream: true },
          {
            returnRawResponse: true,
            signal: controller.signal,
          },
        )) as ReadableStream;
        const reader = stream.getReader();
        const reading = reader.read();
        const reason = new Error('Turn cancelled');
        controller.abort(reason);
        const terminal = await reading;
        expect(new TextDecoder().decode(terminal.value)).toContain('event: void:error');
        expect(await reader.read()).toEqual({ done: true, value: undefined });
      });
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it('rejects missing proxy metadata without sending credentials', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await envContext.run({ __VOID_TOKEN: 'token', __VOID_PROJECT_ID: 'project' }, async () => {
      await expect(ai.run('@cf/meta/llama', {})).rejects.toThrow('No connected platform proxy');
    });
    expect(request).not.toHaveBeenCalled();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('explains missing bindings without suggesting Void login for a direct Cloudflare project', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');
    await envContext.run({}, async () => {
      await expect(ai.run('@cf/meta/llama', {})).rejects.toThrow(
        'Configure a Workers AI binding (env.AI) for direct Cloudflare development',
      );
    });
  });

  it('routes Cloudflare provider models through the run endpoint unchanged', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'Hi' } }] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
      },
      async () => {
        const result = await ai.run('google/gemini-2.5-flash', {
          contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        });

        expect(result).toEqual({ choices: [{ message: { content: 'Hi' } }] });
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.test/ai/run');
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer void-token');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'run',
      model: 'google/gemini-2.5-flash',
      inputs: { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] },
      projectId: 'proj_1',
    });
  });

  it('routes provider-native JSON requests through the provider endpoint', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 'chatcmpl_1' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          headers: { 'openai-beta': 'assistants=v2' },
          body: {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello' }],
          },
        });

        expect(await response.json()).toEqual({ id: 'chatcmpl_1' });
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.test/ai/provider');
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer void-token');
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'provider',
      provider: 'openai',
      path: '/chat/completions',
      headers: { 'openai-beta': 'assistants=v2' },
      body: {
        type: 'json',
        value: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello' }],
        },
      },
      providerKey: 'sk-test',
      projectId: 'proj_1',
    });
  });

  it('returns non-2xx provider responses for service-binding proxy requests', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');

    const proxyFetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await envContext.run(
      {
        __VOID_PROXY: { fetch: proxyFetch },
        __PROJECT_ID: 'proj_1',
        __VOID_PROXY_TOKEN: 'proxy-token',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
        });

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: { message: 'Invalid API key' } });
      },
    );

    expect(proxyFetch).toHaveBeenCalledOnce();
    const init = proxyFetch.mock.calls[0][1]!;
    expect(proxyFetch.mock.calls[0][0]).toBe('https://ai-proxy/ai/provider');
    expect(JSON.parse(init.body as string)).toMatchObject({
      action: 'provider',
      provider: 'openai',
      path: '/chat/completions',
      providerKey: 'sk-test',
      projectId: 'proj_1',
      aiToken: 'proxy-token',
    });
  });

  it('supports provider API-key env and header overrides', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        CUSTOM_AI_KEY: 'custom-key',
      },
      async () => {
        await ai
          .provider('custom-provider', {
            apiKeyEnv: 'CUSTOM_AI_KEY',
            apiKeyHeader: 'x-api-key',
            apiKeyPrefix: '',
          })
          .fetch('/v1/respond', { body: 'hello' });
      },
    );

    const init = fetchMock.mock.calls[0][1]!;
    expect(JSON.parse(init.body as string)).toEqual({
      action: 'provider',
      provider: 'custom-provider',
      path: '/v1/respond',
      body: { type: 'text', data: 'hello' },
      providerKey: 'custom-key',
      apiKeyHeader: 'x-api-key',
      apiKeyPrefix: '',
      projectId: 'proj_1',
    });
  });

  it('serializes provider-native multipart bodies', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        const form = new FormData();
        form.set('model', 'gpt-image-1.5');
        form.set('prompt', 'change the background');
        form.set('image', new Blob(['png-bytes'], { type: 'image/png' }), 'source.png');

        await ai.provider('openai').fetch('/images/edits', { body: form });
      },
    );

    const init = fetchMock.mock.calls[0][1]!;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      action: 'provider',
      provider: 'openai',
      path: '/images/edits',
      body: {
        type: 'form',
        entries: [
          { name: 'model', value: 'gpt-image-1.5' },
          { name: 'prompt', value: 'change the background' },
          {
            name: 'image',
            value: {
              __voidFile: true,
              data: 'cG5nLWJ5dGVz',
              name: 'source.png',
              type: 'image/png',
            },
          },
        ],
      },
      providerKey: 'sk-test',
      projectId: 'proj_1',
    });
  });

  it('sends JSON provider bodies unchanged through the proxy', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');

    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
    );
    vi.stubGlobal('fetch', fetchMock);

    const json = {
      model: 'm',
      image: { data: 'aGk=', name: 'a.png', type: 'image/png' },
    };
    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
        OPENAI_API_KEY: 'sk-test',
      },
      async () => {
        await ai.provider('openai').fetch('/images/edits', { body: json });
      },
    );

    const init = fetchMock.mock.calls[0][1]!;
    expect(JSON.parse(init.body as string).body).toEqual({ type: 'json', value: json });
  });

  it('returns blobs for non-JSON run responses', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('png-bytes', {
            headers: { 'content-type': 'image/png' },
          }),
      ),
    );

    await envContext.run(
      {
        __VOID_TOKEN: 'void-token',
        __VOID_PROJECT_ID: 'proj_1',
        __VOID_PROXY_URL: 'https://proxy.test',
      },
      async () => {
        const result = await ai.run('@cf/black-forest-labs/flux-1-schnell' as keyof AiModels, {
          prompt: 'a small robot',
        });

        expect(result).toBeInstanceOf(Blob);
        expect((result as Blob).type).toBe('image/png');
        expect(await (result as Blob).text()).toBe('png-bytes');
      },
    );
  });

  describe('direct AI backend (self-host, env.AI only)', () => {
    it('selects the direct backend when only env.AI is present (ai.run → directAi.run)', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');

      // Any accidental fall-through to the Void proxy would hit fetch — assert it doesn't.
      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          new Response('proxy-should-not-be-used', { status: 500 }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run({ AI: direct.AI }, async () => {
        const result = await ai.run('@cf/meta/llama', { prompt: 'Hi' });
        expect(result).toEqual({ ok: true });
      });

      expect(direct.run).toHaveBeenCalledWith(
        '@cf/meta/llama',
        { prompt: 'Hi' },
        { returnRawResponse: true },
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('selects a custom binding named by the generated runtime variable', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');
      const direct = makeDirectAi();

      await envContext.run({ MY_AI: direct.AI, __VOID_AI_BINDING: 'MY_AI' }, async () => {
        expect(await ai.run('@cf/meta/llama', { prompt: 'Hi' })).toEqual({ ok: true });
      });

      expect(direct.run).toHaveBeenCalledWith(
        '@cf/meta/llama',
        { prompt: 'Hi' },
        { returnRawResponse: true },
      );
    });

    it('provider().fetch hits the user gateway with provider auth and no metering header', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          new Response(JSON.stringify({ id: 'chatcmpl_direct' }), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', OPENAI_API_KEY: 'sk-test' },
        async () => {
          const response = await ai.provider('openai').fetch('/chat/completions', {
            body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
          });
          expect(await response.json()).toEqual({ id: 'chatcmpl_direct' });
        },
      );

      expect(direct.gateway).toHaveBeenCalledWith('my-gw');
      expect(direct.gateway.mock.results[0].value.getUrl).toHaveBeenCalledWith('openai');

      expect(fetchMock).toHaveBeenCalledOnce();
      const url = fetchMock.mock.calls[0][0];
      const init = fetchMock.mock.calls[0][1]!;
      expect(String(url).endsWith('/my-gw/openai/chat/completions')).toBe(true);
      expect(init.method).toBe('POST');

      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('Bearer sk-test');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('cf-aig-metadata-projectId')).toBeNull();
      expect(headers.get('cf-aig-metadata')).toBeNull();
      expect(JSON.parse(init.body as string)).toEqual({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });

    it.each([
      ['anthropic', 'ANTHROPIC_API_KEY', 'x-api-key', 'sk-test', null],
      ['deepgram', 'DEEPGRAM_API_KEY', 'authorization', 'Token sk-test', 'Token sk-test'],
      ['parallel', 'PARALLEL_API_KEY', 'x-api-key', 'sk-test', null],
    ] as const)(
      'sends the provider-native auth header for %s',
      async (provider, keyEnv, header, value, authorization) => {
        vi.resetModules();
        const { envContext } = await import('../../src/runtime/env/raw.ts');
        const { ai } = await import('../../src/runtime/ai/index.ts');

        const fetchMock = vi.fn(
          async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
        );
        vi.stubGlobal('fetch', fetchMock);

        const direct = makeDirectAi();

        await envContext.run(
          { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', [keyEnv]: 'sk-test' },
          async () => {
            await ai.provider(provider).fetch('/v1/test', { body: { input: 'Hi' } });
          },
        );

        expect(direct.gateway.mock.results[0].value.getUrl).toHaveBeenCalledWith(provider);
        const headers = new Headers(fetchMock.mock.calls[0][1]!.headers);
        // `Authorization: Bearer <key>` 401s at the gateway pass-through for these providers.
        expect(headers.get(header)).toBe(value);
        expect(headers.get('authorization')).toBe(authorization);
      },
    );

    it('resolves to 501 when no AI gateway is configured', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run({ AI: direct.AI, OPENAI_API_KEY: 'sk-test' }, async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          body: { model: 'gpt-4o' },
        });
        expect(response.status).toBe(501);
        const body = await response.json<{ error: string }>();
        expect(body.error).toMatch(/gateway/i);
        expect(body.error).toContain('Set `ai.gateway` in void.config.ts.');
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(direct.gateway).not.toHaveBeenCalled();
    });

    it('resolves to 400 naming the missing provider secret', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run({ AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw' }, async () => {
        const response = await ai.provider('openai').fetch('/chat/completions', {
          body: { model: 'gpt-4o' },
        });
        expect(response.status).toBe(400);
        const body = await response.json<{ error: string }>();
        expect(body.error).toContain('OPENAI_API_KEY');
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(direct.gateway).not.toHaveBeenCalled();
    });

    it('resolves to 502 when the gateway getUrl lookup rejects', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi({
        getUrl: async () => {
          throw new Error('gateway 404 not found');
        },
      });

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', OPENAI_API_KEY: 'sk-test' },
        async () => {
          const response = await ai.provider('openai').fetch('/chat/completions', {
            body: { model: 'gpt-4o' },
          });
          expect(response.status).toBe(502);
          const body = await response.json<{ error: string }>();
          expect(body.error).toContain('my-gw');
        },
      );

      expect(direct.gateway).toHaveBeenCalledWith('my-gw');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('resolves to 400 for an unsafe absolute provider path', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', OPENAI_API_KEY: 'sk-test' },
        async () => {
          const response = await ai
            .provider('openai')
            .fetch('https://evil.example.com/v1/chat', { body: { model: 'gpt-4o' } });
          expect(response.status).toBe(400);
          const body = await response.json<{ error: string }>();
          expect(body.error).toMatch(/must be relative/);
        },
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(direct.gateway).not.toHaveBeenCalled();
    });

    it('forwards a direct multipart/form-data body untouched (fetch sets the boundary)', async () => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');

      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response('ok'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const direct = makeDirectAi();

      await envContext.run(
        { AI: direct.AI, __VOID_AI_GATEWAY: 'my-gw', OPENAI_API_KEY: 'sk-test' },
        async () => {
          const form = new FormData();
          form.set('model', 'gpt-image-1.5');
          form.set('prompt', 'change the background');
          form.set('image', new Blob(['png-bytes'], { type: 'image/png' }), 'source.png');

          await ai.provider('openai').fetch('/images/edits', { body: form });
        },
      );

      const init = fetchMock.mock.calls[0][1]!;
      // The self-host path passes FormData straight through — fetch itself sets
      // the multipart content-type + boundary, so we must NOT force content-type
      // and must NOT base64-envelope the parts like the managed proxy does.
      expect(init.body).toBeInstanceOf(FormData);
      expect(new Headers(init.headers).get('content-type')).toBeNull();
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-test');

      const sentForm = init.body as FormData;
      expect(sentForm.get('model')).toBe('gpt-image-1.5');
      expect(sentForm.get('prompt')).toBe('change the background');
      const image = sentForm.get('image');
      expect(image).toBeInstanceOf(Blob);
      expect(await (image as Blob).text()).toBe('png-bytes');
    });
  });
});

describe('AI usage-limit rejections', () => {
  it('preserves ordinary inference failures', async () => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');
    const error = new Error('network failed');
    const direct = makeDirectAi({
      run: () => {
        throw error;
      },
    });
    await envContext.run({ AI: direct.AI }, async () => {
      await expect(ai.run('model', {})).rejects.toBe(error);
    });
  });

  it.each(['run', 'stream'] as const)(
    'returns an unhandled %s limit as HTTP 429',
    async (method) => {
      vi.resetModules();
      const { Hono } = await import('hono');
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');
      const { createHttpRouteHandler } = await import('../../src/runtime/routing/index.ts');
      const { createErrorRenderer } = await import('../../src/runtime/routing/errors.ts');
      const direct = makeDirectAi({
        run: () => Response.json({}, { status: 429, headers: { 'Retry-After': '60' } }),
      });
      const app = new Hono();
      app.onError(createErrorRenderer({ projectRoot: '/project', homeDir: '/home' }).onError);
      app.post(
        '/ai',
        createHttpRouteHandler(async () => ({ POST: () => ai[method]('model', {}) }), 'POST'),
      );
      await envContext.run({ AI: direct.AI }, async () => {
        const response = await app.request('/ai', { method: 'POST' });
        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBeTruthy();
        expect(await response.json()).toMatchObject({
          code: 'usage_limit',
          resource: 'ai',
          reason: 'rate_limit',
        });
      });
    },
  );

  it.each(['run', 'stream', 'image', 'models', 'toMarkdown', 'provider'] as const)(
    'rejects %s quota failures with UsageLimit',
    async (method) => {
      vi.resetModules();
      const { envContext } = await import('../../src/runtime/env/raw.ts');
      const { ai } = await import('../../src/runtime/ai/index.ts');
      const { UsageLimit } = await import('../../src/runtime/limits/index.ts');
      const fetch = vi.fn(async () =>
        Response.json(
          {
            code: 'usage_limit',
            resource: 'ai',
            reason: 'monthly_quota',
            message: 'AI allowance exhausted',
          },
          { status: 429 },
        ),
      );
      await envContext.run(
        {
          __VOID_PROXY: { fetch },
          __PROJECT_ID: 'p',
          __VOID_PROXY_TOKEN: 't',
          OPENAI_API_KEY: 'test',
        },
        async () => {
          const op =
            method === 'provider'
              ? ai.provider('openai').fetch('/chat/completions')
              : method === 'models'
                ? ai.models()
                : method === 'toMarkdown'
                  ? ai.toMarkdown({ name: 'test.txt', blob: new Blob(['text']) })
                  : ai[method]('model', {});
          await expect(op).rejects.toBeInstanceOf(UsageLimit);
          await expect(op).rejects.toMatchObject({
            resource: 'ai',
            reason: 'monthly_quota',
            message: 'AI allowance exhausted',
          });
          expect(fetch).toHaveBeenCalledOnce();
        },
      );
    },
  );
});

it('preserves a quota interruption after streaming has started in a terminal event', async () => {
  vi.resetModules();
  const { envContext } = await import('../../src/runtime/env/raw.ts');
  const { ai } = await import('../../src/runtime/ai/index.ts');
  const { UsageLimit } = await import('../../src/runtime/limits/index.ts');
  const limit = new UsageLimit({ resource: 'ai', reason: 'rate_limit', message: 'Provider limit' });
  const body = new ReadableStream({
    pull(controller) {
      controller.error(limit);
    },
  });
  await envContext.run({ AI: makeDirectAi({ run: () => body }).AI }, async () => {
    const response = await ai.stream('model', {});
    const text = await response.text();
    expect(text).toContain('event: void:limit');
    expect(text).toContain('Provider limit');
    expect(text).toContain('"reason":"rate_limit"');
  });
});

it.each(['run', 'stream', 'image'] as const)(
  'handles native %s quotas before the binding discards the HTTP status',
  async (method) => {
    vi.resetModules();
    const { envContext } = await import('../../src/runtime/env/raw.ts');
    const { ai } = await import('../../src/runtime/ai/index.ts');
    const direct = makeDirectAi({
      run: () =>
        Response.json(
          { errors: [{ code: 3036, message: 'Account limited' }] },
          { status: 429, headers: { 'Retry-After': '60' } },
        ),
    });
    await envContext.run({ AI: direct.AI }, async () => {
      const { UsageLimit } = await import('../../src/runtime/limits/index.ts');
      const result = ai[method]('model', {});
      await expect(result).rejects.toBeInstanceOf(UsageLimit);
      await expect(result).rejects.toMatchObject({
        resource: 'ai',
        reason: 'rate_limit',
        retryAt: expect.any(String),
      });
    });
  },
);

it('decodes native JSON responses and preserves explicitly requested raw responses', async () => {
  vi.resetModules();
  const { envContext } = await import('../../src/runtime/env/raw.ts');
  const { ai } = await import('../../src/runtime/ai/index.ts');
  const direct = makeDirectAi({ run: () => Response.json({ response: 'hello' }) });
  await envContext.run({ AI: direct.AI }, async () => {
    expect(await ai.run('model', {})).toEqual({ response: 'hello' });
    expect(await ai.run('model', {}, { returnRawResponse: true })).toBeInstanceOf(Response);
  });
});
