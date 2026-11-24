import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { ProxyClient } from '../../../src/runtime/remote/client.ts';

const PROXY_URL = 'https://proxy.void.cloud';
const TOKEN = 'test-jwt-token';
const PROJECT_ID = 'proj_1';

function setFetchMock(factory: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(factory);
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe('ProxyClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('error diagnostics', () => {
    function request() {
      return new ProxyClient(PROXY_URL, TOKEN, PROJECT_ID).fetch('/d1/query', { binding: 'DB' });
    }

    it('prefers server recovery guidance over the machine error and private metadata', async () => {
      setFetchMock(() =>
        Response.json(
          {
            error: 'forbidden',
            message: 'Ask a project admin to confirm your access, then retry.',
            debug: { credential: 'private-data' },
          },
          { status: 403 },
        ),
      );
      await expect(request()).rejects.toThrow(
        'remote: Proxy request failed with 403: Ask a project admin to confirm your access, then retry.',
      );
    });

    it.each([
      [
        401,
        JSON.stringify({ error: 'invalid or expired token' }),
        'Sign in to the connected platform again',
      ],
      [
        403,
        JSON.stringify({ error: 'forbidden', message: '   ' }),
        'Check the selected platform and project',
      ],
      [
        403,
        '<html><body>private access page</body></html>',
        'Check the selected platform and project',
      ],
      [
        403,
        JSON.stringify({ message: '<html>private access page</html>' }),
        'Check the selected platform and project',
      ],
      [
        401,
        JSON.stringify({ message: { private: 'details' } }),
        'Sign in to the connected platform again',
      ],
      [403, '{"unparseable": "private details"', 'Check the selected platform and project'],
      [403, 'Forbidden', 'Check the selected platform and project'],
      [403, JSON.stringify({ message: 'forbidden' }), 'Check the selected platform and project'],
      [
        403,
        JSON.stringify({ message: 'HTTP 403 Forbidden' }),
        'Check the selected platform and project',
      ],
      [403, JSON.stringify({ error: 'Access denied' }), 'Check the selected platform and project'],
    ])('gives safe recovery guidance for status %s and body %s', async (status, body, guidance) => {
      setFetchMock(() => new Response(body, { status }));
      const error = await request().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(guidance);
      expect((error as Error).message).not.toMatch(/private|<html>|\{"/);
    });

    it.each([
      [404, JSON.stringify({ error: 'Binding DB is not deployed' }), 'Binding DB is not deployed'],
      [
        409,
        JSON.stringify({
          error: 'Write result is unknown; check the stored value before retrying',
        }),
        'Write result is unknown; check the stored value before retrying',
      ],
      [
        403,
        JSON.stringify({ error: 'Daily resource budget exceeded' }),
        'Daily resource budget exceeded',
      ],
      [502, 'Upstream database unavailable', 'Upstream database unavailable'],
    ])('preserves meaningful failures for status %s', async (status, body, expected) => {
      setFetchMock(() => new Response(body, { status }));
      await expect(request()).rejects.toThrow(
        `remote: Proxy request failed with ${status}: ${expected}`,
      );
    });

    it('does not dump an HTML server error page', async () => {
      setFetchMock(
        () => new Response('<!doctype html><h1>private gateway trace</h1>', { status: 502 }),
      );
      await expect(request()).rejects.toThrow(
        'remote: Proxy request failed with 502: The remote service returned an unreadable error. Retry the request.',
      );
    });

    it('strips ANSI formatting and hyperlinks from server messages', async () => {
      setFetchMock(() =>
        Response.json(
          {
            message:
              '\u001b[31mAsk an admin\u001b[0m to review \u001b]8;;https://private.example\u0007your access\u001b]8;;\u0007.',
          },
          { status: 403 },
        ),
      );
      await expect(request()).rejects.toThrow(
        'remote: Proxy request failed with 403: Ask an admin to review your access.',
      );
    });

    it('still explains authentication when the error body cannot be read', async () => {
      setFetchMock(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('body transport failed'));
              },
            }),
            { status: 401 },
          ),
      );
      await expect(request()).rejects.toThrow('Sign in to the connected platform again');
    });

    it('bounds diagnostics and cancels oversized error bodies', async () => {
      const cancel = vi.fn();
      setFetchMock(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('x'.repeat(20_000)));
              },
              cancel,
            }),
            { status: 502 },
          ),
      );
      const error = await request().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message.length).toBeLessThan(600);
      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetch()', () => {
    it('sends correct headers and injects projectId into body', async () => {
      const fetchMock = setFetchMock(async () => Response.json({ results: [] }));

      const client = new ProxyClient(PROXY_URL, TOKEN, PROJECT_ID);
      await client.fetch('/d1/query', { binding: 'DB', sql: 'SELECT 1' });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${PROXY_URL}/d1/query`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
          }),
        }),
      );

      const call = fetchMock.mock.calls[0];
      expect(call).toBeDefined();
      const [, init] = call as unknown as [RequestInfo | URL, RequestInit];
      const body = JSON.parse(String(init.body));
      expect(body.projectId).toBe(PROJECT_ID);
      expect(body.binding).toBe('DB');
      expect(body.sql).toBe('SELECT 1');
    });
  });
});
