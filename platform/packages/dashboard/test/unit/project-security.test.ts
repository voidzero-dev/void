import { Hono } from 'hono';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { actions, head, loader } from '../../pages/projects/[slug]/security.server.ts';
import type { Props } from '../../pages/projects/[slug]/security.server.ts';
import ProjectSecurityPage from '../../pages/projects/[slug]/security.tsx';
import { loader as projectsLoader } from '../../pages/projects/index.server.ts';

const API = 'https://api.example.com';
const DASHBOARD = 'https://dashboard.example.com';

type Call = { method: string; path: string; body: unknown; auth: string | null };

/** A fake API: answers by path, records every call. */
function stubApi(routes: Record<string, (call: Call) => Response>) {
  const calls: Array<Call> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      const call: Call = {
        method: init?.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        auth: headers.get('Authorization'),
      };
      calls.push(call);
      const route = routes[`${call.method} ${url.pathname}`];
      return route ? route(call) : Response.json({ error: 'not found' }, { status: 404 });
    }),
  );
  return calls;
}

function app() {
  return new Hono()
    .use(async (context, next) => {
      context.set('token' as never, 'session-token' as never);
      await next();
    })
    .get('/projects', async (context) => context.json(await projectsLoader(context as never)))
    .get('/projects/:slug/security', async (context) =>
      context.json(await loader(context as never)),
    )
    .post('/projects/:slug/security', async (context) => {
      const name = new URL(context.req.url).search.slice(1) as keyof typeof actions;
      const result = await actions[name](context as never);
      if (result instanceof Response) {
        return result;
      }
      // No response: the page renders again; the notice is what it would show.
      return context.json({ rerender: true, notice: context.get('securityNotice' as never) });
    });
}

function page(slug = 'acme-web', search = '') {
  return app().request(`${DASHBOARD}/projects/${slug}/security${search}`, undefined, {
    API_URL: API,
  });
}

function submit(action: string, fields: Record<string, string>, origin = DASHBOARD) {
  return app().request(
    `${DASHBOARD}/projects/acme-web/security?${action}`,
    {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ projectId: 'proj_1', ...fields }).toString(),
    },
    { API_URL: API },
  );
}

const projectsList =
  (role = 'owner') =>
  () =>
    Response.json([
      { id: 'proj_1', slug: 'acme-web', role },
      { id: 'proj_2', slug: 'other', role: 'reader' },
    ]);

const status = {
  policy: {
    mode: 'all',
    applies: true,
    reason: 'the platform scans all projects',
    publicGate: false,
  },
  urgent: { count: 1, counts: { critical: 1, high: 0 } },
  model: { id: '@cf/zai-org/glm-5.3', requested: '@cf/zai-org/glm-5.3', pendingDefault: null },
  budget: null,
  publicRequest: null,
  modelChoices: {
    defaultModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    saved: '@cf/zai-org/glm-5.3',
    defaultNotice: null,
    noticeVersion: 1,
    choices: [],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('projects page', () => {
  it('lists the member projects with their roles', async () => {
    const calls = stubApi({ 'GET /projects': projectsList() });
    const response = await app().request(`${DASHBOARD}/projects`, undefined, { API_URL: API });
    expect(await response.json()).toEqual({
      projects: [
        { slug: 'acme-web', role: 'owner' },
        { slug: 'other', role: 'reader' },
      ],
    });
    expect(calls[0]).toMatchObject({ path: '/projects', auth: 'Bearer session-token' });
  });

  it('shows the API reason when the list cannot load', async () => {
    stubApi({
      'GET /projects': () =>
        Response.json({ error: 'x', message: 'Your account is suspended.' }, { status: 403 }),
    });
    const response = await app().request(`${DASHBOARD}/projects`, undefined, { API_URL: API });
    expect(await response.json()).toEqual({ projects: [], error: 'Your account is suspended.' });
  });
});

describe('project security page', () => {
  it('loads status, open and resolved findings and scans through the typed routes', async () => {
    const calls = stubApi({
      'GET /projects': projectsList(),
      'GET /projects/proj_1/security': () => Response.json(status),
      'GET /projects/proj_1/security/findings': (call) =>
        Response.json({
          findings: call.path.includes('state=open')
            ? [{ id: 'F-1', state: 'open', urgent: true, revision: 1 }]
            : [{ id: 'F-2', state: 'resolved' }],
          nextCursor: null,
        }),
      'GET /projects/proj_1/security/scans': () =>
        Response.json({ scans: [{ id: 'ss_1', status: 'succeeded' }], nextCursor: null }),
    });
    const props = await (await page()).json<Record<string, unknown>>();
    expect(props).toMatchObject({
      slug: 'acme-web',
      project: { id: 'proj_1', role: 'owner' },
      status: { urgent: { count: 1 } },
      open: [{ id: 'F-1' }],
      resolved: [{ id: 'F-2' }],
      scans: [{ id: 'ss_1' }],
      notice: null,
    });
    expect(calls.map((call) => call.path).sort()).toEqual([
      '/projects',
      '/projects/proj_1/security',
      '/projects/proj_1/security/findings?state=open&limit=100',
      '/projects/proj_1/security/findings?state=resolved&limit=100',
      '/projects/proj_1/security/scans',
    ]);
    expect(head({} as never, props as never)?.title).toBe('acme-web · Security');
  });

  it('asks a reader for no scans, and shows a done line from the redirect', async () => {
    const calls = stubApi({
      'GET /projects': projectsList('reader'),
      'GET /projects/proj_1/security': () => Response.json(status),
      'GET /projects/proj_1/security/findings': () =>
        Response.json({ findings: [], nextCursor: null }),
    });
    const props = await (await page('acme-web', '?done=resolved')).json<Record<string, unknown>>();
    expect(props).toMatchObject({
      scans: null,
      notice: { kind: 'ok', text: 'Finding resolved.' },
    });
    expect(calls.some((call) => call.path.includes('/scans'))).toBe(false);
  });

  it('says nothing about a project the user is not a member of', async () => {
    const calls = stubApi({ 'GET /projects': projectsList() });
    const props = await (await page('secret-project')).json<Record<string, unknown>>();
    expect(props).toMatchObject({ project: null, status: null, notice: null });
    expect(calls).toHaveLength(1);
  });

  it('shows an error line when the API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timed out')));
    const props = await (await page()).json<Record<string, unknown>>();
    expect(props).toMatchObject({ project: null, notice: { kind: 'error' } });
  });
});

describe('project security forms', () => {
  it('refuses a post from another origin without calling the API', async () => {
    const calls = stubApi({});
    const response = await submit(
      'resolve',
      { finding: 'F-1', reason: 'fixed', comment: 'x', expectedRevision: '1' },
      'https://evil.example',
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('This request could not be verified.');
    expect(calls).toHaveLength(0);
  });

  it('resolves through the API with the revision the page read, then redirects', async () => {
    const calls = stubApi({
      'POST /projects/proj_1/security/findings/F-1/resolve': () => Response.json({ ok: true }),
    });
    const response = await submit('resolve', {
      finding: 'F-1',
      reason: 'fixed',
      comment: 'patched',
      expectedRevision: '3',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/projects/acme-web/security?done=resolved');
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/projects/proj_1/security/findings/F-1/resolve',
        body: { reason: 'fixed', comment: 'patched', expectedRevision: 3 },
        auth: 'Bearer session-token',
      },
    ]);
  });

  it('keeps the reader on the page with the API reason when it refuses', async () => {
    stubApi({
      'POST /projects/proj_1/security/findings/F-1/resolve': () =>
        Response.json(
          {
            error: 'finding changed',
            message: 'F-1 changed while you were working on it: resolved (fixed).',
          },
          { status: 409 },
        ),
    });
    const response = await submit('resolve', {
      finding: 'F-1',
      reason: 'fixed',
      comment: 'x',
      expectedRevision: '1',
    });
    expect(await response.json()).toEqual({
      rerender: true,
      notice: {
        kind: 'error',
        text: 'F-1 changed while you were working on it: resolved (fixed).',
      },
    });
  });

  it('refuses a bad finding id or project id without calling the API', async () => {
    const calls = stubApi({});
    const badFinding = await submit('comment', { finding: '../../me', text: 'x' });
    expect(await badFinding.json()).toMatchObject({ notice: { kind: 'error' } });
    const badProject = await submit('comment', { finding: 'F-1', text: 'x', projectId: 'a/b' });
    expect(await badProject.json()).toMatchObject({ notice: { kind: 'error' } });
    expect(calls).toHaveLength(0);
  });

  it('comments, sets the model with the notice version, and sets or clears the budget', async () => {
    const ok = () => Response.json({ ok: true });
    const calls = stubApi({
      'POST /projects/proj_1/security/findings/F-2/comments': ok,
      'PUT /projects/proj_1/security/model': ok,
      'PUT /projects/proj_1/security/budget': ok,
    });
    expect((await submit('comment', { finding: 'F-2', text: 'on it' })).status).toBe(303);
    expect(
      (
        await submit('model', {
          model: 'openai/gpt-6.1-terra',
          acceptProviderNotice: '1',
          noticeVersion: '1',
        })
      ).status,
    ).toBe(303);
    expect((await submit('model', { model: '' })).status).toBe(303);
    expect((await submit('budget', { usd: '$12.50' })).status).toBe(303);
    expect((await submit('budget', { usd: '' })).status).toBe(303);
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ['POST', '/projects/proj_1/security/findings/F-2/comments', { text: 'on it' }],
      [
        'PUT',
        '/projects/proj_1/security/model',
        { model: 'openai/gpt-6.1-terra', acceptProviderNoticeVersion: 1 },
      ],
      ['PUT', '/projects/proj_1/security/model', { model: null }],
      ['PUT', '/projects/proj_1/security/budget', { monthlyUsd: 12.5 }],
      ['PUT', '/projects/proj_1/security/budget', { monthlyUsd: null }],
    ]);

    const bad = await submit('budget', { usd: 'lots' });
    expect(await bad.json()).toMatchObject({
      notice: { kind: 'error', text: expect.stringContaining('Enter a dollar amount') },
    });
    expect(calls).toHaveLength(5);
  });

  it('bypasses only with the confirm box ticked', async () => {
    const calls = stubApi({
      'POST /projects/proj_1/zero-trust/public-request/bypass': () => Response.json({ ok: true }),
    });
    const unconfirmed = await submit('bypass', { reason: 'launch day' });
    expect(await unconfirmed.json()).toMatchObject({
      notice: { kind: 'error', text: expect.stringContaining('Tick the box') },
    });
    expect(calls).toHaveLength(0);
    const done = await submit('bypass', { reason: 'launch day', confirm: '1' });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/projects/acme-web/security?done=bypassed');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/projects/proj_1/zero-trust/public-request/bypass',
      body: { reason: 'launch day' },
    });
  });

  it('says a bypass may still go through when the API does not answer in time', async () => {
    stubApi({
      'POST /projects/proj_1/zero-trust/public-request/bypass': () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    });
    const late = await submit('bypass', { reason: 'launch day', confirm: '1' });
    expect(await late.json()).toMatchObject({
      notice: { kind: 'error', text: expect.stringContaining('may still go through') },
    });
  });
});

describe('project security page markup', () => {
  function render(role: 'owner' | 'collaborator' | 'reader', extra: Partial<Props> = {}) {
    const props = {
      slug: 'acme-web',
      project: { id: 'proj_1', role },
      status: {
        ...status,
        counts: { open: { critical: 1, high: 0, medium: 0, low: 0, informational: 0 }, leads: 0 },
        lastScan: null,
        lastSuccessfulScan: null,
      },
      open: [
        role === 'reader'
          ? { id: 'F-1', severity: 'critical', state: 'open' }
          : {
              id: 'F-1',
              severity: 'critical',
              state: 'open',
              urgent: true,
              revision: 2,
              title: '<b>SQL</b> injection',
              file: 'src/a.ts',
              line: 4,
              evidence: '</pre><script>x</script>',
            },
      ],
      resolved: [],
      scans: null,
      notice: null,
      ...extra,
    } as unknown as Props;
    return renderToStaticMarkup(createElement(ProjectSecurityPage, props));
  }

  it('gives each role only the forms it may use, as escaped text', () => {
    const owner = render('owner');
    expect(owner).toContain('action="?resolve"');
    expect(owner).toContain('name="expectedRevision" value="2"');
    expect(owner).toContain('action="?comment"');
    expect(owner).toContain('action="?model"');
    expect(owner).toContain('&lt;b&gt;SQL&lt;/b&gt; injection');
    expect(owner).not.toContain('<script>x');

    const collaborator = render('collaborator');
    expect(collaborator).toContain('action="?comment"');
    expect(collaborator).not.toContain('action="?resolve"');
    expect(collaborator).not.toContain('action="?model"');
    expect(collaborator).toContain('A project admin or owner can resolve these.');

    const reader = render('reader');
    expect(reader).not.toContain('<form');
    expect(reader).toContain('F-1');
    // The resolve line is for collaborators, as on the API page (spec §13.2).
    expect(reader).not.toContain('A project admin or owner can resolve these.');
  });

  it('selects the saved model, not the one in use, and shows the notice it asks to accept', () => {
    const select = (html: string) => html.slice(html.indexOf('<select name="model"'));
    const withChoices = (modelChoices: object, model: object = status.model) =>
      render('owner', { status: { ...status, model, modelChoices } as never });
    const choices = {
      ...status.modelChoices,
      choices: [{ id: '@cf/zai-org/glm-5.3', provider: 'Workers AI', badges: [], notice: null }],
    };
    // Named the default model by name: that choice is kept, not shown as "Platform default".
    const named = withChoices(
      { ...choices, saved: choices.defaultModel },
      { ...status.model, requested: choices.defaultModel },
    );
    expect(select(named)).toContain(`<option value="${choices.defaultModel}" selected="">`);
    const following = withChoices({ ...choices, saved: null });
    expect(select(following)).toContain('<option value="" selected="">');
    expect(select(following)).not.toContain('name="acceptProviderNotice"');

    // A third-party default waiting for its notice, its host not in the choices.
    const pending = withChoices(
      {
        ...choices,
        defaultModel: 'openai/gpt-6.1-terra',
        saved: null,
        defaultNotice: { provider: 'OpenAI', notice: ['Code is sent to OpenAI.'] },
      },
      { ...status.model, pendingDefault: 'openai/gpt-6.1-terra' },
    );
    expect(pending).toContain('Provider notice: OpenAI');
    expect(pending).toContain('Code is sent to OpenAI.');
    expect(pending).toContain('name="acceptProviderNotice"');
  });

  it('offers a bypass only for a request held without a result and nothing urgent', () => {
    const held = {
      ...status,
      urgent: { count: 0, counts: { critical: 0, high: 0 } },
      counts: { open: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 }, leads: 0 },
      lastScan: null,
      lastSuccessfulScan: null,
      publicRequest: { state: 'held_no_result', blockers: { count: 0, ids: [] } },
    };
    const page = render('owner', { open: [], status: held as never });
    expect(page).toContain('action="?bypass"');
    const findings = render('owner', {
      open: [],
      status: {
        ...held,
        publicRequest: { state: 'held_findings', blockers: { count: 1, ids: ['F-1'] } },
      } as never,
    });
    expect(findings).not.toContain('action="?bypass"');
  });
});
