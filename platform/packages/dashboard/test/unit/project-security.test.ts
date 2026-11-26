import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { actions } from '../../pages/projects/[slug]/security.server.ts';

const API = 'https://api.example.com';
const DASHBOARD = 'https://dashboard.example.com';

type Call = { method: string; path: string; body: unknown };

/** A fake API: answers by path, records every call. */
function stubApi(routes: Record<string, () => Response>) {
  const calls: Array<Call> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ method, path: url.pathname, body });
      const route = routes[`${method} ${url.pathname}`];
      return route ? route() : Response.json({ error: 'not found' }, { status: 404 });
    }),
  );
  return calls;
}

function submit(action: string, fields: Record<string, string>, origin = DASHBOARD) {
  const app = new Hono()
    .use(async (context, next) => {
      context.set('token' as never, 'session-token' as never);
      await next();
    })
    .post('/projects/:slug/security', async (context) => {
      const result = await actions[action as keyof typeof actions](context as never);
      if (result instanceof Response) {
        return result;
      }
      return context.json({ notice: context.get('securityNotice' as never) });
    });
  return app.request(
    `${DASHBOARD}/projects/acme-web/security?${action}`,
    {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ projectId: 'proj_1', ...fields }).toString(),
    },
    { API_URL: API },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('refuses a cross-origin post, a bad id or an unconfirmed bypass without calling the API', async () => {
  const calls = stubApi({});
  const resolve = { finding: 'F-1', reason: 'fixed', comment: 'x', expectedRevision: '1' };
  expect((await submit('resolve', resolve, 'https://evil.example')).status).toBe(403);
  const badFinding = await submit('comment', { finding: '../../me', text: 'x' });
  expect(await badFinding.json()).toMatchObject({ notice: { kind: 'error' } });
  const badProject = await submit('comment', { finding: 'F-1', text: 'x', projectId: 'a/b' });
  expect(await badProject.json()).toMatchObject({ notice: { kind: 'error' } });
  const unconfirmed = await submit('bypass', { reason: 'launch day' });
  expect(await unconfirmed.json()).toMatchObject({ notice: { kind: 'error' } });
  expect(calls).toHaveLength(0);
});

it('resolves through the API with the revision the page read, then redirects', async () => {
  const path = '/projects/proj_1/security/findings/F-1/resolve';
  const calls = stubApi({ [`POST ${path}`]: () => Response.json({ ok: true }) });
  const response = await submit('resolve', {
    finding: 'F-1',
    reason: 'fixed',
    comment: 'patched',
    expectedRevision: '3',
  });
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('/projects/acme-web/security?done=resolved');
  expect(calls).toEqual([
    { method: 'POST', path, body: { reason: 'fixed', comment: 'patched', expectedRevision: 3 } },
  ]);
});
