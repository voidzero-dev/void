import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';

// Mock ofetch before importing the module
vi.mock('ofetch', () => {
  return {
    ofetch: Object.assign(vi.fn(), {
      raw: vi.fn(),
    }),
    FetchError: class FetchError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'FetchError';
      }
    },
  };
});

declare module 'void/routes' {
  interface RouteMap {
    '/api/stream/[...path]': RouteMap['/api/stream/:path{.+}'];
    '/api/chat': {
      POST: { input: { body: { messages: Array<unknown> } }; output: unknown };
    };
    '/api/stream': {
      POST: { input: {}; output: unknown };
    };
    '/api/stream/:path{.+}': {
      POST: { input: { params: { path: string } }; output: unknown };
    };
  }
}

import { ofetch } from 'ofetch';
import { fetchStream } from '../../src/runtime/fetch-stream.ts';
import { UsageLimit } from '../../src/runtime/limits.ts';

function makeSSEStream(chunks: Array<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchStream', () => {
  it.each(['/api/stream/[...path]', '/api/stream/:path{.+}'] as const)(
    'expands catch-all tokens in %s',
    async (path) => {
      vi.mocked(ofetch.raw).mockResolvedValue({ _data: null } as never);
      await fetchStream(path, { params: { path: 'docs/start here' } }).next();
      expect(ofetch.raw).toHaveBeenCalledWith('/api/stream/docs/start%20here', expect.anything());
    },
  );
  it('parses Workers AI JSON SSE format', async () => {
    const stream = makeSSEStream([
      'data: {"response":"Hello"}\n\n',
      'data: {"response":" world"}\n\n',
      'data: [DONE]\n\n',
    ]);

    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: stream,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    const chunks: Array<string> = [];
    for await (const chunk of fetchStream('/api/chat', {
      method: 'POST',
      body: { messages: [] },
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['Hello', ' world']);
  });

  it('parses plain text SSE data', async () => {
    const stream = makeSSEStream(['data: hello\n\n', 'data: world\n\n', 'data: [DONE]\n\n']);

    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: stream,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    const chunks: Array<string> = [];
    for await (const chunk of fetchStream('/api/stream', { method: 'POST' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['hello', 'world']);
  });

  it('handles chunked SSE data split across reads', async () => {
    const stream = makeSSEStream([
      'data: {"respo',
      'nse":"chunk1"}\n\ndata: {"response":"chunk2"}\n\n',
      'data: [DONE]\n\n',
    ]);

    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: stream,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    const chunks: Array<string> = [];
    for await (const chunk of fetchStream('/api/stream', { method: 'POST' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['chunk1', 'chunk2']);
  });

  it('ignores SSE comments (lines starting with :)', async () => {
    const stream = makeSSEStream([
      ': this is a comment\n',
      'data: {"response":"hello"}\n\n',
      'data: [DONE]\n\n',
    ]);

    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: stream,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    const chunks: Array<string> = [];
    for await (const chunk of fetchStream('/api/stream', { method: 'POST' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['hello']);
  });

  it('handles empty body gracefully', async () => {
    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: null,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    const chunks: Array<string> = [];
    for await (const chunk of fetchStream('/api/stream', { method: 'POST' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
  });

  it('passes correct options to ofetch', async () => {
    const stream = makeSSEStream(['data: [DONE]\n\n']);

    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: stream,
      status: 200,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof ofetch.raw>>);

    for await (const _ of fetchStream('/api/chat', {
      method: 'POST',
      body: { messages: [] },
      headers: { 'x-custom': 'value' },
    })) {
      // Consume the generator to exhaust the mocked stream.
    }

    expect(ofetch.raw).toHaveBeenCalledWith('/api/chat', {
      method: 'POST',
      body: { messages: [] },
      query: undefined,
      headers: { 'x-custom': 'value' },
      signal: undefined,
      baseURL: undefined,
      responseType: 'stream',
    });
  });
});

it('rejects a terminal interruption instead of displaying it as generated text', async () => {
  vi.mocked(ofetch.raw).mockResolvedValue({
    _data: makeSSEStream([
      'data: {"response":"partial"}\n\n',
      'event: void:error\ndata: {"message":"Generation was interrupted."}\n\n',
    ]),
  } as never);
  const stream = fetchStream('/api/stream');
  expect(await stream.next()).toMatchObject({ value: 'partial' });
  await expect(stream.next()).rejects.toThrow('Generation was interrupted.');
});

it.each([false, true])(
  'preserves typed terminal limits (unterminated=%s)',
  async (unterminated) => {
    const limit = {
      code: 'usage_limit',
      resource: 'ai',
      reason: 'monthly_quota',
      message: 'Allowance exhausted',
      retryAt: '2099-01-01T00:00:00.000Z',
    };
    vi.mocked(ofetch.raw).mockResolvedValue({
      _data: makeSSEStream([
        'data: {"response":"partial"}\n\n',
        `event: void:limit\ndata: ${JSON.stringify(limit)}${unterminated ? '' : '\n\n'}`,
      ]),
    } as never);
    const stream = fetchStream('/api/stream');
    expect(await stream.next()).toMatchObject({ value: 'partial' });
    const next = stream.next();
    await expect(next).rejects.toBeInstanceOf(UsageLimit);
    await expect(next).rejects.toMatchObject(limit);
  },
);

it('preserves typed HTTP limits before streaming starts', async () => {
  const limit = new UsageLimit({
    resource: 'ai',
    reason: 'rate_limit',
    message: 'Try later',
    retryAt: '2099-01-01T00:00:00.000Z',
  });
  vi.mocked(ofetch.raw).mockRejectedValue(
    Object.assign(new Error('429'), { response: limit.response() }),
  );
  const next = fetchStream('/api/stream').next();
  await expect(next).rejects.toBeInstanceOf(UsageLimit);
  await expect(next).rejects.toMatchObject({ message: 'Try later', retryAt: limit.retryAt });
});

it('preserves ordinary HTTP errors', async () => {
  const error = Object.assign(new Error('network failed'), {
    response: new Response(null, { status: 503 }),
  });
  vi.mocked(ofetch.raw).mockRejectedValue(error);
  await expect(fetchStream('/api/stream').next()).rejects.toBe(error);
});
