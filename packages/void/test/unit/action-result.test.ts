import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createActionErrorFromResponse } from '../../src/pages/action-result.ts';
import {
  VoidActionError,
  categorizeActionError,
  createActionClient,
  isAbortError,
  isCallSiteActionError,
  isVoidActionError,
  submitAction,
  type VoidRouter,
} from '../../src/pages/client.ts';

declare module 'void/routes' {
  interface PageActionMap {
    '/__action-test/users/[id]': PageActionMap['/__action-test/users/:id'];
    '/__action-test/static': { body: { name: string } };
    '/__action-test/users/:id': {
      params: { id: string };
      actions: { save: { body: { name: string } } };
    };
  }
}

function routerWithVisit(visit: VoidRouter['visit']): VoidRouter {
  return {
    _hoverDelay: 75,
    get url() {
      return new URL('http://localhost/');
    },
    get path() {
      return '/';
    },
    get query() {
      return new URLSearchParams();
    },
    get params() {
      return {};
    },
    visit,
    refresh: vi.fn(),
    prefetch: vi.fn(),
    flush: vi.fn(),
    flushAll: vi.fn(),
  };
}

function stubLocation(pathname: string, search = '') {
  vi.stubGlobal('window', { location: { pathname, search } });
}

beforeEach(() => stubLocation('/'));
afterEach(() => vi.unstubAllGlobals());

describe('action result handling', () => {
  it('categorizes expected client errors as call-site errors', () => {
    expect(categorizeActionError(400)).toBe('callSite');
    expect(categorizeActionError(404)).toBe('callSite');
    expect(categorizeActionError(409)).toBe('callSite');
    expect(categorizeActionError(422)).toBe('callSite');
    expect(categorizeActionError(429)).toBe('callSite');
  });

  it('categorizes auth and server errors as boundary errors', () => {
    expect(categorizeActionError(401)).toBe('boundary');
    expect(categorizeActionError(403)).toBe('boundary');
    expect(categorizeActionError(500)).toBe('boundary');
    expect(categorizeActionError(503)).toBe('boundary');
  });

  it('turns page validation errors into a call-site action result', async () => {
    const router = routerWithVisit(vi.fn(async () => ({ errors: { name: 'Required' } })));

    const result = await submitAction(router, '/users', { method: 'POST', data: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(422);
      expect(result.error.body).toEqual({ errors: { name: 'Required' } });
    }
  });

  it.each([
    [
      'a VoidActionError',
      new VoidActionError({
        body: 'Missing',
        status: 404,
        statusText: 'Not Found',
        url: '/users/1',
      }),
    ],
    [
      'a structurally equivalent error',
      {
        body: 'Conflict',
        message: 'Action failed with 409 Conflict',
        name: 'VoidActionError',
        status: 409,
        statusText: 'Conflict',
        url: '/users',
      } as VoidActionError,
    ],
  ])('returns call-site action errors instead of throwing them (%s)', async (_label, error) => {
    const router = routerWithVisit(
      vi.fn(async () => {
        throw error;
      }),
    );

    const result = await submitAction(router, error.url, { method: 'POST' });

    expect(result).toEqual({ ok: false, error });
  });

  it.each([undefined, true])(
    'throws structurally equivalent boundary action errors with throwOnError: %s',
    async (throwOnError) => {
      const error = {
        body: 'Boom',
        message: 'Action failed with 500 Internal Server Error',
        name: 'VoidActionError',
        status: 500,
        statusText: 'Internal Server Error',
        url: '/users',
      } as VoidActionError;
      const router = routerWithVisit(
        vi.fn(async () => {
          throw error;
        }),
      );

      await expect(
        submitAction(router, '/users', { method: 'POST' }, { throwOnError }),
      ).rejects.toBe(error);
    },
  );

  it.each([401, 403, 405, 428, 500, 503])(
    'returns HTTP %s inline when throwing is disabled',
    async (status) => {
      const error = new VoidActionError({ body: '', status, statusText: '', url: '/users' });
      const router = routerWithVisit(
        vi.fn(async () => {
          throw error;
        }),
      );

      await expect(
        submitAction(router, '/users', { method: 'POST' }, { throwOnError: false }),
      ).resolves.toEqual({ ok: false, error });
    },
  );

  it.each([new Error('Network failed'), new DOMException('Aborted', 'AbortError')])(
    'still throws non-action errors with throwing disabled ($name)',
    async (error) => {
      const router = routerWithVisit(
        vi.fn(async () => {
          throw error;
        }),
      );
      await expect(
        submitAction(router, '/users', { method: 'POST' }, { throwOnError: false }),
      ).rejects.toBe(error);
    },
  );

  it('recognizes action errors at every status', () => {
    for (const status of [401, 403, 409, 422, 500]) {
      const error = new VoidActionError({ body: '', status, statusText: '', url: '/users' });
      expect(isVoidActionError(error)).toBe(true);
    }
    // Another bundled copy of the class
    expect(isVoidActionError({ name: 'VoidActionError', status: 403 })).toBe(true);
  });

  it('rejects values that are not action errors', () => {
    expect(isVoidActionError(new Error('Boom'))).toBe(false);
    expect(isVoidActionError({ name: 'VoidActionError' })).toBe(false);
    expect(isVoidActionError({ name: 'VoidActionError', status: '403' })).toBe(false);
    expect(isVoidActionError(null)).toBe(false);
    expect(isVoidActionError('VoidActionError')).toBe(false);
  });

  it('recognizes call-site action errors by status', () => {
    const error = (status: number) =>
      new VoidActionError({ body: '', status, statusText: '', url: '/users' });

    expect(isCallSiteActionError(error(409))).toBe(true);
    expect(isCallSiteActionError(error(422))).toBe(true);
    expect(isCallSiteActionError(error(401))).toBe(false);
    expect(isCallSiteActionError(error(403))).toBe(false);
    expect(isCallSiteActionError(error(500))).toBe(false);
    expect(isCallSiteActionError(new Error('Boom'))).toBe(false);
  });

  it('detects abort errors', () => {
    expect(isAbortError(new DOMException('Navigation aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('Boom'))).toBe(false);
  });

  it('leaves the default scroll decision to the router', async () => {
    const visit = vi.fn(async () => ({ props: {} }));
    const router = routerWithVisit(visit);

    await submitAction(router, '/users', {
      method: 'POST',
      data: { name: 'Alice' },
    });

    expect(visit).toHaveBeenCalledWith('/users', {
      method: 'POST',
      data: { name: 'Alice' },
    });
  });

  it('allows explicitly disabling scroll preservation', async () => {
    const visit = vi.fn(async () => ({ props: {} }));
    const router = routerWithVisit(visit);

    await submitAction(router, '/users', {
      method: 'POST',
      preserveScroll: false,
    });

    expect(visit).toHaveBeenCalledWith('/users', {
      preserveScroll: false,
      method: 'POST',
    });
  });
});

describe('action clients', () => {
  it.each([true, false])('forwards preserveScroll: %s from action()', async (preserveScroll) => {
    const client = createActionClient();
    const visit = vi.fn(async () => ({ props: {} }));
    client.setActionRouter(routerWithVisit(visit));

    await client.action('/__action-test/static', { preserveScroll });

    expect(visit).toHaveBeenCalledWith(
      '/__action-test/static',
      expect.objectContaining({ preserveScroll }),
    );
  });

  it('uses the adapter completion mode for action calls', async () => {
    const client = createActionClient({ _resolveOnShell: true });
    const visit = vi.fn(async () => ({ props: {} }));
    client.setActionRouter(routerWithVisit(visit));
    await client.action('/__action-test/static');
    expect(visit).toHaveBeenCalledWith('/__action-test/static', {
      method: 'POST',
      data: undefined,
      _resolveOnShell: true,
      preserveScroll: undefined,
    });
  });

  it('rejects calls before its router is initialized', async () => {
    const client = createActionClient();
    await expect(client.action('/__action-test/static')).rejects.toThrow(
      'action(): called before router initialization.',
    );
  });

  it('keeps adapters isolated and allows replacing an adapter router', async () => {
    const first = createActionClient();
    const second = createActionClient();
    const firstVisit = vi.fn(async () => ({ props: { adapter: 'first' } }));
    const secondVisit = vi.fn(async () => ({ props: { adapter: 'second' } }));
    const replacementVisit = vi.fn(async () => ({ props: { adapter: 'replacement' } }));

    first.setActionRouter(routerWithVisit(firstVisit));
    await expect(second.action('/__action-test/static')).rejects.toThrow('router initialization');
    second.setActionRouter(routerWithVisit(secondVisit));
    await first.action('/__action-test/static');
    await second.action('/__action-test/static');
    first.setActionRouter(routerWithVisit(replacementVisit));
    await first.action('/__action-test/static');

    expect(firstVisit).toHaveBeenCalledTimes(1);
    expect(secondVisit).toHaveBeenCalledTimes(1);
    expect(replacementVisit).toHaveBeenCalledTimes(1);
    expect(firstVisit).toHaveBeenCalledWith('/__action-test/static', {
      method: 'POST',
      data: undefined,
      preserveScroll: undefined,
    });
  });

  it.each(['/__action-test/users/[id]?save', '/__action-test/users/:id?save'] as const)(
    'encodes params and preserves named actions in %s',
    async (url) => {
      const client = createActionClient();
      const visit = vi.fn(async () => ({ props: {} }));
      client.setActionRouter(routerWithVisit(visit));

      await client.action(url, {
        params: { id: 'a/b?c' },
        method: 'PATCH',
        data: { name: 'Alice' },
      });

      expect(visit).toHaveBeenCalledWith('/__action-test/users/a%2Fb%3Fc?save', {
        method: 'PATCH',
        data: { name: 'Alice' },
        preserveScroll: undefined,
      });
    },
  );

  it('preserves validation errors as action results', async () => {
    const client = createActionClient();
    client.setActionRouter(routerWithVisit(vi.fn(async () => ({ errors: { name: 'Required' } }))));

    expect(await client.action('/__action-test/static')).toMatchObject({
      ok: false,
      error: { status: 422, body: { errors: { name: 'Required' } } },
    });
  });
});

describe('the page query', () => {
  it.each([
    ['/items?vote', '/items?vote&page=2&search=foo', 'page=2&search=foo'],
    ['/items', '/items?page=2&search=foo', 'page=2&search=foo'],
    ['/items?', '/items?page=2&search=foo', 'page=2&search=foo'],
    ['/items?vote&page=3', '/items?vote&page=3&search=foo', 'search=foo'],
    ['/items?vote&page=3&search=bar', '/items?vote&page=3&search=bar', undefined],
    ['/items?vote#row-1', '/items?vote&page=2&search=foo#row-1', 'page=2&search=foo'],
    ['/items/1?vote', '/items/1?vote', undefined],
    ['/other?vote', '/other?vote', undefined],
  ])('posts %s from /items?page=2&search=foo to %s', async (url, requested, preserved) => {
    stubLocation('/items', '?page=2&search=foo');
    const visit = vi.fn(async () => ({ props: {} }));

    await submitAction(routerWithVisit(visit), url, { method: 'POST' });

    expect(visit).toHaveBeenCalledWith(requested, {
      method: 'POST',
      ...(preserved === undefined ? {} : { _preservedQuery: preserved }),
    });
  });

  it('keeps encoded parameters as the page sent them', async () => {
    stubLocation('/items', '?q=a+b%26c&&tag=x%20y');
    const visit = vi.fn(async () => ({ props: {} }));

    await submitAction(routerWithVisit(visit), '/items?vote&tag=z', { method: 'POST' });

    expect(visit).toHaveBeenCalledWith('/items?vote&tag=z&q=a+b%26c', {
      method: 'POST',
      _preservedQuery: 'q=a+b%26c',
    });
  });

  it('leaves the URL alone on a page without a query', async () => {
    stubLocation('/items');
    const visit = vi.fn(async () => ({ props: {} }));

    await submitAction(routerWithVisit(visit), '/items?vote', { method: 'POST' });

    expect(visit).toHaveBeenCalledWith('/items?vote', { method: 'POST' });
  });

  it('adds the page query to an action() call on the current page', async () => {
    stubLocation('/__action-test/users/a%2Fb', '?tab=profile');
    const client = createActionClient();
    const visit = vi.fn(async () => ({ props: {} }));
    client.setActionRouter(routerWithVisit(visit));

    await client.action('/__action-test/users/:id?save', { params: { id: 'a/b' } });

    expect(visit).toHaveBeenCalledWith(
      '/__action-test/users/a%2Fb?save&tab=profile',
      expect.objectContaining({ _preservedQuery: 'tab=profile' }),
    );
  });
});

it('exposes the application message and retry deadline for structured quota responses', () => {
  const error = new VoidActionError({
    status: 429,
    statusText: 'Too Many Requests',
    url: '/summary',
    body: {
      code: 'usage_limit',
      resource: 'ai',
      reason: 'monthly_quota',
      message: 'Your draft is still editable.',
      retryAt: '2099-01-01T00:00:00Z',
    },
  });
  expect(error.message).toBe('Your draft is still editable.');
  expect(error.limit?.resource).toBe('ai');
  expect(error.limit?.retryAt).toBe('2099-01-01T00:00:00Z');
});

describe('action error messages', () => {
  function errorFrom(body: BodyInit | null, init: ResponseInit) {
    return createActionErrorFromResponse(new Response(body, init), '/users/1');
  }

  it('uses the message of a thrown HTTPException', async () => {
    const response = new HTTPException(409, { message: 'That note was deleted.' }).getResponse();
    const error = await createActionErrorFromResponse(response, '/notes');
    expect(error.message).toBe('That note was deleted.');
    expect(error.status).toBe(409);
  });

  it.each([
    [403, 'Forbidden', 'Cross-origin page actions are not allowed.'],
    [404, 'Not Found', 'User not found.'],
    [409, 'Conflict', 'That email is already taken.'],
    [422, 'Unprocessable Entity', 'The plan is archived.'],
  ])('uses the plain-text body of a %i as the message', async (status, statusText, text) => {
    const error = await errorFrom(text, { status, statusText });
    expect(error.message).toBe(text);
    expect(error.body).toBe(text);
  });

  it('keeps the status summary for an empty or blank body', async () => {
    expect((await errorFrom(null, { status: 404, statusText: 'Not Found' })).message).toBe(
      'Action failed with 404 Not Found',
    );
    expect((await errorFrom('  ', { status: 404, statusText: 'Not Found' })).message).toBe(
      'Action failed with 404 Not Found',
    );
  });

  it('keeps the status summary for a JSON or HTML body', async () => {
    const json = await errorFrom(JSON.stringify({ error: 'Missing' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' },
    });
    expect(json.message).toBe('Action failed with 404 Not Found');
    expect(json.body).toEqual({ error: 'Missing' });

    const html = await errorFrom('<h1>Request Entity Too Large</h1>', {
      status: 413,
      statusText: 'Payload Too Large',
      headers: { 'content-type': 'text/html' },
    });
    expect(html.message).toBe('Action failed with 413 Payload Too Large');
  });

  it('keeps the status summary for a server error', async () => {
    const error = await errorFrom('relation "users" does not exist', {
      status: 500,
      statusText: 'Internal Server Error',
    });
    expect(error.message).toBe('Action failed with 500 Internal Server Error');
    expect(error.body).toBe('relation "users" does not exist');
  });
});
