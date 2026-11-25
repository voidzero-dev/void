import { PLATFORM_DISABLED_KEY } from '@void/platform';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import app from '../../src/index.ts';
import { setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
afterEach(() => vi.unstubAllGlobals());
const installationId = 'team-123456abcdef';
const application = {
  baseDomain: 'test.workers.dev',
  zoneName: '',
  dedicatedZone: false,
  workersDev: { subdomain: 'test', installationId },
};
function bindings() {
  return {
    ...env,
    PLATFORM_APPLICATION: JSON.stringify(application),
    PLATFORM_INSTALLATION_ID: installationId,
    PLATFORM_HEALTH_PROBE_TOKEN: 'test-probe',
    CF_API_TOKEN: 'private-runtime-token',
  };
}
function request(token?: string) {
  return new Request('http://localhost/internal/platform/domain-preflight', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Void-Platform-Probe': token } : {}),
    },
    body: JSON.stringify({ zoneId: 'a'.repeat(32), domain: 'example.com' }),
  });
}
describe('deployed runtime domain preflight', () => {
  it('requires the installation probe credential before touching Cloudflare', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect((await app.fetch(request(), bindings())).status).toBe(404);
    expect((await app.fetch(request('wrong'), bindings())).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses only the live runtime token and can check a disabled installation', async () => {
    await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-runtime-token');
      const body = JSON.parse(String(init?.body));
      expect(body.files).toHaveLength(1);
      expect(body.files[0]).toMatch(/^https:\/\/example.com\/\.well-known\/void-domain-check\//);
      return Response.json({ success: true });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const result = await app.fetch(request('test-probe'), bindings());
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ ok: true, installationId });
    } finally {
      await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
    }
  });
  it('reports a missing permission without returning provider errors or credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ success: false, errors: ['sensitive upstream detail'] }, { status: 403 }),
      ),
    );
    const result = await app.fetch(request('test-probe'), bindings());
    const body = await result.text();
    expect(result.status).toBe(403);
    expect(body).toContain('Cache Purge: Purge');
    expect(body).not.toContain('sensitive');
    expect(body).not.toContain('private-runtime-token');
  });
});
