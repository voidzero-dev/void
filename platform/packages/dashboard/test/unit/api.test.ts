import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getApiErrorMessage, getCurrentUser } from '../../lib/api.ts';

function createContext() {
  return {
    env: { API_URL: 'https://api.test' },
    get: vi.fn((key: string) => (key === 'token' ? 'test-token' : undefined)),
    req: {
      raw: new Request('https://localhost:5173/me'),
      header: vi.fn((key: string) => (key === 'host' ? 'localhost:5173' : undefined)),
    },
  };
}

describe('dashboard API helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prefers the actionable API message over its existing error code', async () => {
    const message = 'Ask a project owner or admin to grant you collaborator access.';
    const response = Response.json({ error: 'forbidden', message }, { status: 403 });

    expect(await getApiErrorMessage(response)).toBe(message);
  });

  it.each([
    { error: 'Sign in again before linking another login method.' },
    { error: 'Sign in again before linking another login method.', message: '  ' },
    { error: 'Sign in again before linking another login method.', message: 'Unauthorized' },
    {
      message: 'Sign in again before linking another login method.',
      error: 'reauthentication_required',
    },
  ])('preserves meaningful existing API explanations: %j', async (body) => {
    expect(await getApiErrorMessage(Response.json(body, { status: 401 }))).toBe(
      'Sign in again before linking another login method.',
    );
  });

  it.each([
    [401, 'Unauthorized', 'Sign in again and retry this action.'],
    [
      403,
      'Forbidden',
      'You do not have permission to perform this action. Check that you are signed in to the correct account.',
    ],
    [404, 'not found', 'This item is unavailable. Refresh the page and try again.'],
    [
      409,
      'Conflict',
      'This action could not be completed because something changed. Refresh the page and try again.',
    ],
    [429, 'Too Many Requests', 'Too many requests. Wait a moment and try again.'],
    [500, 'Internal Server Error', 'The service is temporarily unavailable. Try again shortly.'],
  ])('explains generic %i rejections', async (status, error, expected) => {
    expect(await getApiErrorMessage(Response.json({ error }, { status }))).toBe(expected);
    expect(await getApiErrorMessage(new Response(error, { status }))).toBe(expected);
    expect(await getApiErrorMessage(new Response(null, { status }))).toBe(expected);
  });

  it.each([
    Response.json({ error: { privateDetail: 'secret' } }, { status: 403 }),
    Response.json({ error: 'permission_denied', details: 'secret' }, { status: 403 }),
    Response.json({ message: '<p>secret</p>', error: 'forbidden' }, { status: 403 }),
    Response.json({ message: '{"privateDetail":"secret"}' }, { status: 403 }),
    Response.json(null, { status: 403 }),
    Response.json(['secret'], { status: 403 }),
    Response.json('secret', { status: 403 }),
    new Response('{"privateDetail":"secret"', { status: 403 }),
    new Response('<!DOCTYPE html><title>secret</title>', { status: 403 }),
    new Response('secret', { status: 403, headers: { 'content-type': 'text/html' } }),
    new Response('secret', { status: 403, headers: { 'content-type': 'application/json' } }),
    new Response('Error: secret\n  at privateFile:123', { status: 403 }),
  ])('does not display serialized, malformed or private response bodies %#', async (response) => {
    expect(await getApiErrorMessage(response)).toBe(
      'You do not have permission to perform this action. Check that you are signed in to the correct account.',
    );
  });

  it('preserves useful plain-text errors', async () => {
    expect(await getApiErrorMessage(new Response('Choose a login method.', { status: 400 }))).toBe(
      'Choose a login method.',
    );
  });

  it('returns recovery guidance when the error response cannot be read', async () => {
    const response = new Response(null, { status: 503 });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('stream failed'));
    expect(await getApiErrorMessage(response)).toBe(
      'The service is temporarily unavailable. Try again shortly.',
    );
  });

  it('treats non-JSON /me responses as unauthenticated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('<!DOCTYPE html><html><body>Access required</body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
          status: 200,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCurrentUser(createContext() as never)).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/me',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get('Accept')).toBe('application/json');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected JSON from API'));
  });
});
