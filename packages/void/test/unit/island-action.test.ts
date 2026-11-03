import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { submitIslandAction, VoidActionError } from '../../src/pages/client.ts';

function respondWith(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('submitIslandAction', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('submits JSON with %s', async (method) => {
    const fetchMock = respondWith(new Response(null, { status: 204 }));

    await expect(
      submitIslandAction('/posts?save', method, {
        title: 'Hello',
        tags: ['news'],
        published: false,
      }),
    ).resolves.toEqual({ kind: 'success' });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/posts?save', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: '{"title":"Hello","tags":["news"],"published":false}',
    });
  });

  it('does not parse a successful response body', async () => {
    const response = new Response('not JSON');
    respondWith(response);

    await expect(submitIslandAction('/posts', 'POST', {})).resolves.toEqual({ kind: 'success' });
    expect(response.bodyUsed).toBe(false);
  });

  it.each([200, 422, 500])(
    'handles redirects before status %s and body decoding',
    async (status) => {
      const response = new Response('{invalid JSON', {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: 'https://app.test/posts/1' },
      });
      respondWith(response);

      await expect(submitIslandAction('/posts', 'POST', {})).resolves.toEqual({
        kind: 'redirect',
        url: 'https://app.test/posts/1',
      });
      expect(response.bodyUsed).toBe(false);
    },
  );

  it.each([{ title: 'Required' }, {}])('returns 422 field errors: %j', async (errors) => {
    respondWith(Response.json({ errors }, { status: 422 }));

    await expect(submitIslandAction('/posts', 'POST', {})).resolves.toEqual({
      kind: 'validation',
      errors,
    });
  });

  it.each([null, {}, { errors: null }, { errors: [] }, { errors: 'invalid' }])(
    'keeps 422 responses without a field-error object as action errors: %j',
    async (body) => {
      respondWith(Response.json(body, { status: 422 }));

      const result = await submitIslandAction('/posts', 'POST', {});

      expect(result).toMatchObject({ kind: 'error', error: { status: 422, body } });
    },
  );

  it.each([400, 402, 404, 408, 409, 412, 413, 415, 422, 429, 499])(
    'returns a form-level action error for status %s',
    async (status) => {
      respondWith(new Response('Try again', { status, statusText: 'Action failed' }));

      const result = await submitIslandAction('/posts?save', 'POST', {});

      expect(result).toMatchObject({
        kind: 'error',
        error: { status, statusText: 'Action failed', url: '/posts?save', body: 'Try again' },
      });
      if (result.kind === 'error') {
        expect(result.error).toBeInstanceOf(VoidActionError);
      }
    },
  );

  it('requires status 422 to treat an errors object as field errors', async () => {
    respondWith(Response.json({ errors: { title: 'Conflict' } }, { status: 409 }));

    await expect(submitIslandAction('/posts', 'POST', {})).resolves.toMatchObject({
      kind: 'error',
      error: { status: 409, body: { errors: { title: 'Conflict' } } },
    });
  });

  it.each([302, 401, 403, 405, 418, 428, 500, 501, 502, 503, 504])(
    'throws boundary and unrecognized action errors for status %s',
    async (status) => {
      respondWith(Response.json({ errors: { title: 'Unavailable' } }, { status }));

      const action = submitIslandAction('/posts', 'POST', {});

      await expect(action).rejects.toBeInstanceOf(VoidActionError);
      await expect(action).rejects.toMatchObject({
        status,
        url: '/posts',
        body: { errors: { title: 'Unavailable' } },
      });
    },
  );

  it.each([
    ['application/json; charset=utf-8', '{"message":"Conflict"}', { message: 'Conflict' }],
    ['application/json', '{invalid JSON', null],
    ['text/plain', '', null],
    ['text/plain', 'Conflict', 'Conflict'],
    ['application/problem+json', '{"detail":"Conflict"}', '{"detail":"Conflict"}'],
  ])('decodes an error body with content type %s: %s', async (contentType, body, expected) => {
    respondWith(new Response(body, { status: 409, headers: { 'Content-Type': contentType } }));

    await expect(submitIslandAction('/posts', 'POST', {})).resolves.toMatchObject({
      kind: 'error',
      error: { status: 409, body: expected },
    });
  });

  it('keeps the HTTP error when reading the body fails', async () => {
    const response = new Response('Conflict', { status: 409 });
    await response.text();
    respondWith(response);

    await expect(submitIslandAction('/posts', 'POST', {})).resolves.toMatchObject({
      kind: 'error',
      error: { status: 409, body: null },
    });
  });

  it('preserves structured usage-limit messages and retry metadata', async () => {
    const body = {
      code: 'usage_limit',
      resource: 'ai',
      reason: 'monthly_quota',
      message: 'Your draft is still editable.',
      retryAt: '2099-01-01T00:00:00Z',
    };
    respondWith(Response.json(body, { status: 429 }));

    await expect(submitIslandAction('/posts', 'POST', {})).resolves.toMatchObject({
      kind: 'error',
      error: { status: 429, message: body.message, body, limit: body },
    });
  });

  it('propagates network failures unchanged', async () => {
    const failure = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(failure));

    await expect(submitIslandAction('/posts', 'POST', {})).rejects.toBe(failure);
  });

  it('rejects serialization failures before making a request', async () => {
    const fetchMock = respondWith(new Response());
    const data: Record<string, unknown> = {};
    data.self = data;

    await expect(submitIslandAction('/posts', 'POST', data)).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
