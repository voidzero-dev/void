import { deriveProxyInternalAuth } from '@voidcloud/api/proxy-token';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { hmacSign } from '../../src/hmac.ts';
import {
  resolveResource,
  clearResolveCache,
  verifyPrerenderAuthority,
  verifyProjectDeployAccess,
} from '../../src/resolve.ts';

const JWT_SECRET = 'test-secret-key';

function createMockApi(resources: Record<string, string>) {
  return {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      const projectId = new URL(url).pathname.split('/').pop()!;
      const body = JSON.parse(init?.body as string);
      const key = `${projectId}:${body.type}:${body.binding}`;
      const cfId = resources[key];
      if (cfId) {
        return Response.json({ cf_id: cfId });
      }
      return Response.json({ error: `unknown binding "${body.binding}"` }, { status: 404 });
    }),
  } as unknown as Fetcher;
}

describe('resolveResource', () => {
  beforeEach(() => {
    clearResolveCache();
  });

  it('returns cf_id for a known resource', async () => {
    const api = createMockApi({ 'proj_000000000001:d1:DB': 'd1-uuid-123' });
    const result = await resolveResource(api, JWT_SECRET, 'proj_000000000001', 'd1', 'DB');
    expect(result).toBe('d1-uuid-123');
  });

  it('throws for an unknown resource', async () => {
    const api = createMockApi({});
    await expect(
      resolveResource(api, JWT_SECRET, 'proj_000000000001', 'kv', 'MISSING'),
    ).rejects.toThrow('Resource resolution failed (404)');
  });

  it('calls API with correct URL and body', async () => {
    const api = createMockApi({ 'proj_000000000042:r2:STORAGE': 'r2-uuid-456' });
    await resolveResource(api, JWT_SECRET, 'proj_000000000042', 'r2', 'STORAGE');

    expect(api.fetch).toHaveBeenCalledWith(
      'https://api/internal/resolve-resource/proj_000000000042',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ type: 'r2', binding: 'STORAGE' }),
      }),
    );
  });

  it('caches resolved resource IDs', async () => {
    const api = createMockApi({ 'proj_000000000001:d1:DB': 'd1-uuid-123' });
    await resolveResource(api, JWT_SECRET, 'proj_000000000001', 'd1', 'DB');
    await resolveResource(api, JWT_SECRET, 'proj_000000000001', 'd1', 'DB');
    await resolveResource(api, JWT_SECRET, 'proj_000000000001', 'd1', 'DB');

    expect((api.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('authenticates with the proxy credential only', async () => {
    const api = createMockApi({ 'proj_000000000001:d1:DB': 'd1-uuid-123' });
    await resolveResource(api, JWT_SECRET, 'proj_000000000001', 'd1', 'DB');

    const [, init] = (api.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-void-proxy-internal']).toBe(
      await deriveProxyInternalAuth(JWT_SECRET, 'resolve-resource', 'proj_000000000001'),
    );
    expect(headers['x-void-internal']).toBeUndefined();
  });
});

describe('verifyPrerenderAuthority', () => {
  it('authenticates with the proxy credential only', async () => {
    const api = { fetch: vi.fn(async () => Response.json({ ok: true })) } as unknown as Fetcher;
    await expect(
      verifyPrerenderAuthority(api, JWT_SECRET, 'proj_000000000001', 'user_1', {
        buildId: 'bld_1',
      }),
    ).resolves.toBe(true);

    const [url, init] = (api.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api/internal/verify-prerender-build/proj_000000000001');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-void-proxy-internal']).toBe(
      await deriveProxyInternalAuth(JWT_SECRET, 'verify-prerender-build', 'proj_000000000001'),
    );
    expect(headers['x-void-internal']).toBeUndefined();
  });
});

describe('verifyProjectDeployAccess', () => {
  it('cryptographically binds the internal check to the actual proxy origin', async () => {
    const api = { fetch: vi.fn(async () => Response.json({ ok: true })) } as unknown as Fetcher;
    await expect(
      verifyProjectDeployAccess(
        api,
        JWT_SECRET,
        'proj_000000000001',
        'user_1',
        'jwt',
        'access',
        'https://proxy.example.com',
      ),
    ).resolves.toBe(true);
    const [, init] = (api.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      userId: 'user_1',
      proxyOrigin: 'https://proxy.example.com',
    });
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-void-internal']).toBe(
      await hmacSign(
        'void-proxy-owner-v2\nproj_000000000001\nhttps://proxy.example.com',
        JWT_SECRET,
      ),
    );
    expect(headers['x-void-proxy-internal']).toBeUndefined();

    const missing = { fetch: vi.fn() } as unknown as Fetcher;
    await expect(
      verifyProjectDeployAccess(
        missing,
        JWT_SECRET,
        'proj_000000000001',
        'user_1',
        'jwt',
        'access',
      ),
    ).resolves.toBe(false);
    expect(missing.fetch).not.toHaveBeenCalled();
  });
});
