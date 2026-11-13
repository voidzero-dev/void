import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { submitIslandAction } from '../../src/pages/island-action.ts';
import { fetchPages } from '../../src/pages/redirect.ts';
import { createRoutingRuntime } from '../../src/runtime/routing.ts';

beforeEach(() => {
  vi.stubGlobal('window', { location: { origin: 'https://app.test', pathname: '/', search: '' } });
});
afterEach(() => vi.unstubAllGlobals());

function server() {
  const app = new Hono();
  app.use(createRoutingRuntime(app, { nodeTarget: true }).contextMiddleware);
  const fetch = vi.fn((url: string, init?: RequestInit) =>
    app.fetch(new Request(new URL(url, 'https://app.test'), init)),
  );
  vi.stubGlobal('fetch', fetch);
  return { app, fetch };
}

it.each([301, 302, 303, 307, 308] as const)(
  'preserves method and body semantics for %s redirects',
  async (status) => {
    const { app } = server();
    app.all('/from', (c) => c.redirect('/to#details', status));
    app.all('/to', async (c) =>
      c.json({
        method: c.req.method,
        body: await c.req.text(),
        type: c.req.header('Content-Type') ?? null,
      }),
    );
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const result = await fetchPages('/from', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: '{"id":42}',
      });
      const get = status === 303 || ((status === 301 || status === 302) && method === 'POST');
      expect(result.redirectedTo).toBe('https://app.test/to#details');
      expect(await result.response.json()).toEqual({
        method: get ? 'GET' : method,
        body: get ? '' : '{"id":42}',
        type: get ? null : 'application/json',
      });
    }
  },
);

it('leaves ordinary redirects intact and preserves cookies for negotiated redirects', async () => {
  const { app } = server();
  app.post(
    '/from',
    () =>
      new Response(null, {
        status: 303,
        headers: [
          ['Location', '/to#details'],
          ['Set-Cookie', 'first=1; Path=/'],
          ['Set-Cookie', 'second=2; Path=/'],
        ],
      }),
  );
  const ordinary = await app.request('/from', { method: 'POST' });
  expect(ordinary.status).toBe(303);
  expect(ordinary.headers.get('Location')).toBe('/to#details');
  expect(ordinary.headers.get('Vary')).toContain('X-VoidPages-Redirect');
  const manual = await app.request('/from', {
    method: 'POST',
    headers: { 'X-VoidPages-Redirect': 'manual' },
  });
  expect(manual.status).toBe(200);
  expect(manual.headers.get('Location')).toBe('/to#details');
  expect(manual.headers.get('X-VoidPages-Redirect')).toBe('303');
  expect(manual.headers.get('Cache-Control')).toBe('no-store');
  expect(manual.headers.getSetCookie()).toEqual(['first=1; Path=/', 'second=2; Path=/']);
});

it.each(['/end', '/end#', '/end#other'])(
  'inherits or replaces the fragment across a redirect chain ending at %s',
  async (destination) => {
    const { app } = server();
    app.get('/from', (c) => c.redirect('/middle#details'));
    app.get('/middle', (c) => c.redirect(destination));
    app.get('/end', (c) => c.json({ ok: true }));
    const result = await fetchPages('/from', { method: 'GET', headers: {} });
    const hash = destination === '/end' ? '#details' : destination.slice(4);
    expect(result.redirectedTo).toBe('https://app.test/end' + hash);
    expect(result.response.status).toBe(200);
  },
);

it('does not send mutation data or credentials to an external redirect', async () => {
  const { app, fetch } = server();
  app.post('/from', (c) => c.redirect('https://external.test/to#details', 307));
  const result = await fetchPages('/from', {
    method: 'POST',
    headers: { Authorization: 'Bearer private' },
    body: 'private',
  });
  expect(result.redirectedTo).toBe('https://external.test/to#details');
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'blob:https://app.test/unsafe'])(
  'rejects unsafe redirect schemes: %s',
  async (destination) => {
    const { app, fetch } = server();
    app.post('/from', (c) => c.redirect(destination));
    await expect(fetchPages('/from', { method: 'POST', headers: {} })).rejects.toThrow(
      'refusing to redirect',
    );
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it('returns island redirects for document navigation without fetching their destination', async () => {
  const { app, fetch } = server();
  app.post('/from', (c) => c.redirect('/to#details'));
  const result = await submitIslandAction('/from', 'POST', {});
  expect(result).toEqual({ kind: 'redirect', url: 'https://app.test/to#details' });
  expect(fetch).toHaveBeenCalledOnce();
});

it('bounds redirect loops', async () => {
  const { app, fetch } = server();
  app.get('/loop', (c) => c.redirect('/loop#details'));
  await expect(fetchPages('/loop', { method: 'GET', headers: {} })).rejects.toThrow(
    'Too many Pages redirects',
  );
  expect(fetch).toHaveBeenCalledTimes(21);
});

it.each([307, 308] as const)(
  'runs an island mutation redirected with %s before document navigation',
  async (status) => {
    const { app } = server();
    const action = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST');
      expect(await request.json()).toEqual({ title: 'Saved' });
      return new Response(null, { status: 204 });
    });
    app.post('/from', (c) => c.redirect('/to#details', status));
    app.post('/to', (c) => action(c.req.raw));
    expect(await submitIslandAction('/from', 'POST', { title: 'Saved' })).toEqual({
      kind: 'redirect',
      url: 'https://app.test/to#details',
    });
    expect(action).toHaveBeenCalledOnce();
  },
);
