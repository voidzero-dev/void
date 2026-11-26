import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { action, head, loader } from '../../pages/account.server.ts';

const app = new Hono().post('/account', async (context) => {
  const response = await action(context as never);
  if (!(response instanceof Response)) {
    throw new Error('Expected the account action to return a Response');
  }
  return response;
});

const accountPage = new Hono().get('/account', async (context) =>
  context.json(await loader(context as never)),
);

function submit(origin = 'https://dashboard.example.com') {
  return app.request(
    'https://dashboard.example.com/account',
    {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'connectionId=company',
    },
    { API_URL: 'https://api.example.com' },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('account linking error responses', () => {
  it('uses the discovered platform name for the account title', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ displayName: 'Example Platform' })),
    );
    const response = await accountPage.request('https://dashboard.example.com/account', undefined, {
      API_URL: 'https://api.example.com',
    });
    const props = await response.json<{ platformName: string; methods: [] }>();
    expect(props.platformName).toBe('Example Platform');
    expect(head({} as never, props)?.title).toBe('Login methods · Example Platform · Void');
  });

  it('keeps the account page available when discovery times out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('API request timed out')));

    const response = await accountPage.request('https://dashboard.example.com/account', undefined, {
      API_URL: 'https://api.example.com',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      methods: [],
      error: 'Login methods are unavailable. Try again shortly.',
    });
  });

  it('gives a retry action when a linking request cannot reach the API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('API request timed out')));

    const response = await submit();

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(
      'The service is temporarily unavailable. Try again shortly.',
    );
  });

  it('renders the API recovery message while preserving its rejection status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          {
            error: 'reauthentication_required',
            message: 'Sign in again before linking another login method.',
          },
          { status: 401 },
        ),
      ),
    );

    const response = await submit();
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('Sign in again before linking another login method.');
  });

  it('renders helpful permission guidance for an older API with no message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'forbidden' }, { status: 403 })),
    );

    const response = await submit();
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Check that you are signed in to the correct account.');
  });

  it('handles an upstream HTML rejection without displaying it or throwing a parsing error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>private upstream detail</html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );

    const response = await submit();
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      'The service is temporarily unavailable. Try again shortly.',
    );
  });

  it('gives a recovery action for a rejected origin without contacting the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await submit('https://attacker.example.com');
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(
      'This request could not be verified. Refresh the account page and try again.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats an incomplete success response as a linking failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );

    const response = await submit();
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('Sign in to your existing account again and retry.');
  });

  it('still redirects successful linking requests to the review flow', async () => {
    const url = 'https://api.example.com/auth/link?test=example';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ url })),
    );

    const response = await submit();
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(url);
  });
});
