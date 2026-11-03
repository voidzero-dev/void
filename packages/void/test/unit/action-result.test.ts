import { describe, expect, it, vi } from 'vite-plus/test';
import {
  VoidActionError,
  categorizeActionError,
  createActionClient,
  isAbortError,
  submitAction,
  type VoidRouter,
} from '../../src/pages/client.ts';

declare module 'void/routes' {
  interface PageActionMap {
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

  it('throws structurally equivalent boundary action errors', async () => {
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

    await expect(submitAction(router, '/users', { method: 'POST' })).rejects.toBe(error);
  });

  it('detects abort errors', () => {
    expect(isAbortError(new DOMException('Navigation aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('Boom'))).toBe(false);
  });
});

describe('action clients', () => {
  it('uses the adapter completion mode for action calls', async () => {
    const client = createActionClient({ _resolveOnShell: true });
    const visit = vi.fn(async () => ({ props: {} }));
    client.setActionRouter(routerWithVisit(visit));
    await client.action('/__action-test/static');
    expect(visit).toHaveBeenCalledWith('/__action-test/static', {
      method: 'POST',
      data: undefined,
      _resolveOnShell: true,
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
    });
  });

  it('encodes path parameters while preserving named actions and submission options', async () => {
    const client = createActionClient();
    const visit = vi.fn(async () => ({ props: {} }));
    client.setActionRouter(routerWithVisit(visit));

    await client.action('/__action-test/users/:id?save', {
      params: { id: 'a/b?c' },
      method: 'PATCH',
      data: { name: 'Alice' },
    });

    expect(visit).toHaveBeenCalledWith('/__action-test/users/a%2Fb%3Fc?save', {
      method: 'PATCH',
      data: { name: 'Alice' },
    });
  });

  it('preserves validation errors as action results', async () => {
    const client = createActionClient();
    client.setActionRouter(routerWithVisit(vi.fn(async () => ({ errors: { name: 'Required' } }))));

    expect(await client.action('/__action-test/static')).toMatchObject({
      ok: false,
      error: { status: 422, body: { errors: { name: 'Required' } } },
    });
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
