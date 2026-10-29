import { describe, expect, it, vi } from 'vite-plus/test';
import { createStaticEdgeHandler } from '../../src/index.ts';

function assets(responses: Record<string, Response>) {
  return {
    fetch: vi.fn(async (request: Request) => {
      const response = responses[new URL(request.url).pathname];
      return response ? response.clone() : new Response(null, { status: 404 });
    }),
  };
}

describe('createStaticEdgeHandler', () => {
  it.each([true, false, undefined])(
    'applies alwaysUseHttps %s before assets',
    async (alwaysUseHttps) => {
      const binding = assets({ '/': new Response('home') });
      const response = await createStaticEdgeHandler({ alwaysUseHttps }).fetch(
        new Request('http://oxc.rs/'),
        { ASSETS: binding },
      );
      expect(response.status).toBe(alwaysUseHttps ? 308 : 200);
      expect(response.headers.get('Location')).toBe(alwaysUseHttps ? 'https://oxc.rs/' : null);
      expect(binding.fetch).toHaveBeenCalledTimes(alwaysUseHttps ? 0 : 1);
    },
  );
  it('answers the deployment readiness probe without touching assets', async () => {
    const binding = assets({});
    const response = await createStaticEdgeHandler({}).fetch(
      new Request('https://example.com/__void/ready'),
      { ASSETS: binding },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it('returns the actual native version from the selected metadata binding without caching', async () => {
    const env = { ASSETS: assets({}), USER_VERSION: { id: 'served-version' } };
    const response = await createStaticEdgeHandler({
      versionMetadataBinding: 'USER_VERSION',
    }).fetch(new Request('https://example.com/__void/ready'), env);
    expect(await response.json()).toEqual({ ready: true, versionId: 'served-version' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('serves assets through the mandatory edge Worker', async () => {
    const binding = assets({ '/': new Response('home') });
    const response = await createStaticEdgeHandler({}).fetch(new Request('https://example.com/'), {
      ASSETS: binding,
    });

    expect(await response.text()).toBe('home');
    expect(binding.fetch).toHaveBeenCalledOnce();
  });

  it('applies pre-asset redirects and preserves the request query', async () => {
    const binding = assets({});
    const response = await createStaticEdgeHandler({
      redirectRules: [{ source: '/old', destination: '/new', status: 308 }],
    }).fetch(new Request('https://example.com/old?from=test'), { ASSETS: binding });

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/new?from=test');
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it('keeps catch-all redirects on the same site when the capture starts with a slash', async () => {
    const binding = assets({});
    const response = await createStaticEdgeHandler({
      redirectRules: [{ source: '/en/*', destination: '/:splat', status: 301 }],
    }).fetch(new Request('https://example.com/en//evil.com'), { ASSETS: binding });

    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/evil.com');
    expect(binding.fetch).not.toHaveBeenCalled();
  });

  it('rewrites before assets and exposes the original URL', async () => {
    const binding = assets({ '/new': new Response('rewritten') });
    const response = await createStaticEdgeHandler({
      redirectRules: [{ source: '/old', destination: '/new', status: 200 }],
    }).fetch(new Request('https://example.com/old?q=1'), { ASSETS: binding });

    expect(await response.text()).toBe('rewritten');
    const request = binding.fetch.mock.calls[0]![0];
    expect(new URL(request.url).pathname).toBe('/new');
    expect(new URL(request.url).search).toBe('?q=1');
    expect(request.headers.get('x-void-original-url')).toBe('https://example.com/old?q=1');
  });

  it('runs fallback rewrites after an asset miss and applies effective-path headers', async () => {
    const binding = assets({ '/404.html': new Response('missing', { status: 404 }) });
    const response = await createStaticEdgeHandler({
      fallbackRules: [{ source: '/*', destination: '/404.html', status: 200 }],
      headerRules: [{ pattern: '/404.html', headers: [['x-void-fallback', '1']] }],
    }).fetch(new Request('https://example.com/nope'), { ASSETS: binding });

    expect(await response.text()).toBe('missing');
    expect(response.headers.get('x-void-fallback')).toBe('1');
    expect(binding.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps host-scoped rules isolated', async () => {
    const binding = assets({ '/old': new Response('original') });
    const handler = createStaticEdgeHandler({
      redirectRules: [
        { source: '/old', destination: '/private', status: 302, host: 'admin.example.com' },
      ],
    });
    const response = await handler.fetch(new Request('https://www.example.com/old'), {
      ASSETS: binding,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('original');
  });

  it('allows cookie header rules on a directly owned Cloudflare hostname', async () => {
    const binding = assets({ '/': new Response('home') });
    const response = await createStaticEdgeHandler({
      headerRules: [
        {
          pattern: '/',
          headers: [
            ['set-cookie', 'theme=dark; Secure; SameSite=Lax'],
            ['clear-site-data', '"cookies", "storage"'],
          ],
        },
      ],
    }).fetch(new Request('https://app.example.com/'), { ASSETS: binding });

    expect(response.headers.get('set-cookie')).toBe('theme=dark; Secure; SameSite=Lax');
    expect(response.headers.get('clear-site-data')).toBe('"cookies", "storage"');
  });
});
