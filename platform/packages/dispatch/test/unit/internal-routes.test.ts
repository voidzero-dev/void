import { describe, expect, it, vi } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import app from '../../src/index.ts';
import { PLATFORM_DISABLED_KEY } from '../../src/platform-lifecycle.ts';

vi.stubGlobal('caches', {
  default: {
    match: async () => undefined,
    put: async () => {},
    delete: async () => false,
  },
});

function createCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function createEnv(
  disabled = false,
  selfHosted = false,
  healthProbeToken?: string,
  trafficState?: string,
): Env {
  const workerFetch = vi.fn(async () => new Response('worker'));
  return {
    ROUTING: {
      get: vi.fn(async (key: string) =>
        key === PLATFORM_DISABLED_KEY
          ? disabled
            ? 'disabled'
            : null
          : JSON.stringify({ workerName: 'user-app', projectId: 'proj_1' }),
      ),
    },
    DISPATCH: {
      get: vi.fn(() => ({ fetch: workerFetch })),
    },
    ISR_CACHE: {
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async () => {},
      delete: async () => {},
    },
    ANALYTICS: {
      writeDataPoint: vi.fn(),
    },
    ...(selfHosted ? { PLATFORM_INSTALLATION_ID: 'installation-id' } : {}),
    ...(healthProbeToken ? { PLATFORM_HEALTH_PROBE_TOKEN: healthProbeToken } : {}),
    ...(trafficState ? { PLATFORM_TRAFFIC_STATE: trafficState } : {}),
  } as unknown as Env;
}

describe('HTTPS redirects', () => {
  it.each([
    ['oxc.rs', 'GET'],
    ['rolldown.rs', 'HEAD'],
    ['my-app.void.app', 'POST'],
  ])('redirects HTTP %s requests with method %s before routing', async (hostname, method) => {
    const env = createEnv();
    const request = new Request(`http://${hostname}/docs/a%2Fb?search=a%2Fb&tag=1&tag=2`, {
      method,
      ...(method === 'POST' ? { body: 'payload' } : {}),
    });
    const response = await app.fetch(request, env, createCtx());

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe(
      `https://${hostname}/docs/a%2Fb?search=a%2Fb&tag=1&tag=2`,
    );
    expect(request.bodyUsed).toBe(false);
    expect(env.ROUTING.get).not.toHaveBeenCalled();
    expect(env.DISPATCH.get).not.toHaveBeenCalled();
  });

  it('serves HTTPS without a redirect even with an HTTP forwarding header', async () => {
    const response = await app.fetch(
      new Request('https://oxc.rs/', { headers: { 'X-Forwarded-Proto': 'http' } }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Location')).toBeNull();
  });

  it.each(['localhost', 'my-app.localhost', '127.0.0.1', '[::1]'])(
    'serves local HTTP on %s without a redirect',
    async (hostname) => {
      const response = await app.fetch(
        new Request(`http://${hostname}:8787/`),
        createEnv(),
        createCtx(),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    },
  );

  it('preserves HTTP installer health probes while public traffic is disabled', async () => {
    const response = await app.fetch(
      new Request('http://test.void.app/health', {
        headers: { 'X-Void-Platform-Probe': 'probe-token' },
      }),
      createEnv(true, true, 'probe-token'),
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('preserves the legacy HTTP admin health probe', async () => {
    const response = await app.fetch(
      new Request('http://test.void.app/health', {
        headers: { 'X-Health-Check': 'void-admin' },
      }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe('internal route blocking', () => {
  it('rejects every request while the platform is disabled', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/normal-path'),
      createEnv(true, true),
      createCtx(),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each(['staging', 'sandbox-drain'])(
    'fails closed in %s even when routing KV is missing the disabled value',
    async (trafficState) => {
      const response = await app.fetch(
        new Request('https://my-app.void.app/normal-path'),
        createEnv(false, true, undefined, trafficState),
        createCtx(),
      );
      expect(response.status).toBe(503);
    },
  );

  it('admits the installer health check during sandbox drain maintenance', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/health', {
        headers: { 'X-Void-Platform-Probe': 'probe-token' },
      }),
      createEnv(false, true, 'probe-token', 'sandbox-drain'),
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('admits installer health checks while public traffic is disabled', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/health', {
        headers: { 'X-Void-Platform-Probe': 'probe-token' },
      }),
      createEnv(true, true, 'probe-token'),
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('rejects the legacy public installer header while disabled', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/health', {
        headers: { 'X-Health-Check': 'void-admin' },
      }),
      createEnv(true, true, 'probe-token'),
      createCtx(),
    );
    expect(response.status).toBe(503);
  });

  it('preserves the legacy Void Cloud admin health probe', async () => {
    const response = await app.fetch(
      new Request('https://test.void.app/health', {
        headers: { 'X-Health-Check': 'void-admin' },
      }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('does not add a lifecycle routing read for hosted Void Cloud', async () => {
    const env = createEnv();
    const response = await app.fetch(
      new Request('https://my-app.void.app/normal-path'),
      env,
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(env.ROUTING.get).toHaveBeenCalledTimes(1);
  });

  it('blocks POST /__void/migrate with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__void/migrate', { method: 'POST' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it('blocks GET /__void/ready with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__void/ready', { method: 'GET' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it('blocks /__void/scheduled with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__void/scheduled', { method: 'POST' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it('blocks /__void/queue with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__void/queue', { method: 'POST' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  // Legacy: old SDK versions register these top-level paths.
  // TODO: remove these blocks once all deployed workers use /__void/* paths. See #88
  it('blocks /__scheduled (legacy compat) with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__scheduled', { method: 'POST' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it('blocks /__queue (legacy compat) with 404', async () => {
    const response = await app.fetch(
      new Request('https://my-app.void.app/__queue', { method: 'POST' }),
      createEnv(),
      createCtx(),
    );
    expect(response.status).toBe(404);
  });

  it('does not block /__nuxt_content paths (framework assets)', async () => {
    const env = createEnv();
    const response = await app.fetch(
      new Request('https://my-app.void.app/__nuxt_content/articles/query'),
      env,
      createCtx(),
    );
    expect(response.status).not.toBe(404);
    expect(await response.text()).toContain('worker');
  });

  it('does not block /__og-image__ paths (framework assets)', async () => {
    const env = createEnv();
    const response = await app.fetch(
      new Request('https://my-app.void.app/__og-image__/static/og.png'),
      env,
      createCtx(),
    );
    expect(response.status).not.toBe(404);
    expect(await response.text()).toContain('worker');
  });

  it('does not block normal paths', async () => {
    const env = createEnv();
    const response = await app.fetch(
      new Request('https://my-app.void.app/normal-path'),
      env,
      createCtx(),
    );
    expect(response.status).not.toBe(404);
    expect(await response.text()).toContain('worker');
  });
});

// Zero Trust leaves `/health` on the health hostname outside Cloudflare Access.
// A project created before its slug was reserved may still own the hostname, so
// dispatch routes every other path there like any other hostname.
describe('platform health hostname', () => {
  const healthHost = 'https://void-platform-health.void.app';

  function createHealthHostEnv(route: Record<string, unknown> | null): Env {
    const env = createEnv(false, true, 'probe-token');
    env.ROUTING.get = vi.fn(async (key: string) =>
      key === 'void-platform-health' && route ? JSON.stringify(route) : null,
    ) as unknown as Env['ROUTING']['get'];
    return env;
  }

  it('serves an existing project with the reserved slug', async () => {
    const env = createHealthHostEnv({ workerName: 'user-app', projectId: 'proj_1' });
    for (const path of ['/', '/about', '/api/health']) {
      const response = await app.fetch(new Request(`${healthHost}${path}`), env, createCtx());
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('worker');
    }
  });

  it('never routes the Access exception path to that project', async () => {
    const env = createHealthHostEnv({ workerName: 'user-app', projectId: 'proj_1' });
    // A URL exactly as the client sent it, before the runtime normalizes it.
    const sent = (url: string) => {
      const request = new Request(`${healthHost}/`);
      Object.defineProperty(request, 'url', { value: url });
      return request;
    };
    for (const request of [
      new Request(`${healthHost}/health`),
      new Request(`${healthHost}/health`, { headers: { 'X-Void-Platform-Probe': 'wrong-token' } }),
      new Request(`${healthHost}/health`, { method: 'POST', body: '{}' }),
      new Request(`${healthHost}/health?probe=1`),
      new Request(`${healthHost}/health/`),
      new Request(`${healthHost}/health/nested/page`),
      new Request(`${healthHost}/healthz`),
      new Request(`${healthHost}/HEALTH`),
      new Request(`${healthHost}/%68ealth`),
      new Request(`${healthHost}//health`),
      new Request(`${healthHost}/x/../health`),
      sent(`${healthHost}/health/../about`),
      sent(`${healthHost}\\health`),
    ]) {
      const response = await app.fetch(request, env, createCtx());
      expect(response.status, request.url).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(env.ROUTING.get).not.toHaveBeenCalled();
    expect(env.DISPATCH.get).not.toHaveBeenCalled();
  });

  it('routes the health path on every other hostname', async () => {
    const env = createEnv(false, true, 'probe-token');
    const response = await app.fetch(
      new Request('https://my-app.void.app/health'),
      env,
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('worker');
  });

  it('requires an Access assertion when that project is protected', async () => {
    const env = createHealthHostEnv({
      workerName: 'user-app',
      projectId: 'proj_1',
      zeroTrust: {
        teamDomain: 'https://company.cloudflareaccess.com',
        audiences: [{ hostname: '*.void.app', audience: 'project-audience' }],
      },
    });
    for (const path of ['/', '/about']) {
      const response = await app.fetch(new Request(`${healthHost}${path}`), env, createCtx());
      expect(response.status).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(env.DISPATCH.get).not.toHaveBeenCalled();
  });

  it('answers the health probe before routing', async () => {
    const env = createHealthHostEnv({ workerName: 'user-app', projectId: 'proj_1' });
    const response = await app.fetch(
      new Request(`${healthHost}/health`, {
        headers: { 'X-Void-Platform-Probe': 'probe-token' },
      }),
      env,
      createCtx(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(env.ROUTING.get).not.toHaveBeenCalled();
    expect(env.DISPATCH.get).not.toHaveBeenCalled();
  });

  it('returns the normal not found response without a project', async () => {
    const env = createHealthHostEnv(null);
    const response = await app.fetch(new Request(`${healthHost}/`), env, createCtx());
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(env.DISPATCH.get).not.toHaveBeenCalled();
  });
});
