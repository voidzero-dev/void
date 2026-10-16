import { describe, expect, it, vi } from 'vite-plus/test';
import {
  hasApiRoutes,
  hasDocumentRoutes,
  resolveAssetConfig,
  resolveAssetRoutingPolicy,
  workerOwnsHtmlRouting,
} from '../../src/asset-routing.ts';
import { createAssetFallback } from '../../src/runtime/routing-worker.ts';

// `not_found_handling: 'none'` → asset binding 404s on unmatched paths,
// worker (run_worker_first) owns HTML responses.
//
// `not_found_handling: 'single-page-application'` → CF shortcuts browser
// navigations to the SPA shell before the worker runs. Acceptable when the
// worker does not need to inspect document navigations.
describe('resolveAssetConfig', () => {
  const NONE = { not_found_handling: 'none' as const, run_worker_first: ['/**'] };
  const SPA = {
    not_found_handling: 'single-page-application' as const,
    run_worker_first: ['/__void', '/__void/*'],
  };
  const SPA_API = {
    not_found_handling: 'single-page-application' as const,
    run_worker_first: ['/api', '/api/*', '/__void', '/__void/*'],
  };

  it('uses none when SSR is enabled', () => {
    expect(
      resolveAssetConfig({
        isSsr: true,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual(NONE);
  });

  it('uses none when pages mode is enabled', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: true,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual(NONE);
  });

  it('keeps SPA handling when the project only has API routes', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasApiRoutes: true,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual(SPA_API);
  });

  it('uses none when the project has document routes', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: true,
        hasMiddleware: false,
      }),
    ).toEqual(NONE);
  });

  it('uses none when the project has document websocket routes', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
        hasWebSockets: true,
      }),
    ).toEqual(NONE);
  });

  it('keeps SPA handling when the project only has API websocket routes', () => {
    const routes = [{ pattern: '/api/chat' }];
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasApiRoutes: hasApiRoutes(routes),
        hasDocumentRoutes: false,
        hasMiddleware: false,
        hasWebSockets: hasDocumentRoutes(routes),
      }),
    ).toEqual(SPA_API);
  });

  it('routes managed auth endpoints through the worker without owning all HTML', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
        authEnabled: true,
      }),
    ).toEqual(SPA_API);
  });

  it('uses none for the common SPA + auth-middleware shape', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: true,
      }),
    ).toEqual(NONE);
  });

  it('uses none when live bindings are enabled', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
        liveEnabled: true,
      }),
    ).toEqual(NONE);
  });

  it('uses single-page-application when no HTML-owning backend code is present', () => {
    expect(
      resolveAssetConfig({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual(SPA);
  });

  it('classifies /api routes separately from document routes', () => {
    const apiRoutes = [
      { pattern: '/api' },
      { pattern: '/api/hello' },
      { pattern: '/api/users/:id' },
    ];
    expect(hasDocumentRoutes(apiRoutes)).toBe(false);
    expect(hasApiRoutes(apiRoutes)).toBe(true);

    expect(hasDocumentRoutes([{ pattern: '/hello' }])).toBe(true);
    expect(hasDocumentRoutes([{ pattern: '/apiish' }])).toBe(true);
    expect(hasApiRoutes([{ pattern: '/hello' }, { pattern: '/apiish' }])).toBe(false);
  });

  it('reports worker-owned HTML routing for document routes', () => {
    const inputs = {
      isSsr: false,
      hasPages: false,
      hasDocumentRoutes: true,
      hasMiddleware: false,
    };
    expect(workerOwnsHtmlRouting(inputs)).toBe(true);
  });

  it('resolves the complete request trigger policy', () => {
    expect(
      resolveAssetRoutingPolicy({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual({
      assetConfig: SPA,
      apiWorkerFirst: false,
      workerFirst: false,
      workerSpaFallback: false,
    });

    expect(
      resolveAssetRoutingPolicy({
        isSsr: false,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: true,
      }),
    ).toEqual({
      assetConfig: NONE,
      apiWorkerFirst: false,
      workerFirst: true,
      workerSpaFallback: true,
    });

    expect(
      resolveAssetRoutingPolicy({
        isSsr: false,
        hasPages: false,
        hasApiRoutes: true,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual({
      assetConfig: SPA_API,
      apiWorkerFirst: true,
      workerFirst: false,
      workerSpaFallback: false,
    });

    expect(
      resolveAssetRoutingPolicy({
        isSsr: true,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
      }),
    ).toEqual({
      assetConfig: NONE,
      apiWorkerFirst: false,
      workerFirst: true,
      workerSpaFallback: false,
    });
  });
});

// `routing.notFound` overrides only `not_found_handling`; worker-first routing stays inferred.
describe('resolveAssetRoutingPolicy — routing.notFound override', () => {
  const SPA_API_WORKER_FIRST = ['/api', '/api/*', '/__void', '/__void/*'];

  const ssgWithApi = {
    isSsr: false,
    hasPages: false,
    hasApiRoutes: true,
    hasDocumentRoutes: false,
    hasMiddleware: false,
  } as const;

  it('leaves the inferred SPA fallback in place when unset', () => {
    expect(resolveAssetRoutingPolicy(ssgWithApi).assetConfig).toEqual({
      not_found_handling: 'single-page-application',
      run_worker_first: SPA_API_WORKER_FIRST,
    });
  });

  it('serves a real 404 page when set to "404-page"', () => {
    expect(resolveAssetRoutingPolicy({ ...ssgWithApi, notFound: '404-page' }).assetConfig).toEqual({
      not_found_handling: '404-page',
      run_worker_first: SPA_API_WORKER_FIRST,
    });
  });

  it('leaves run_worker_first and the request-trigger flags untouched', () => {
    const inferred = resolveAssetRoutingPolicy(ssgWithApi);
    const overridden = resolveAssetRoutingPolicy({ ...ssgWithApi, notFound: '404-page' });
    expect(overridden.assetConfig.run_worker_first).toEqual(inferred.assetConfig.run_worker_first);
    expect(overridden.apiWorkerFirst).toBe(inferred.apiWorkerFirst);
    expect(overridden.workerFirst).toBe(inferred.workerFirst);
    // Asset-first shape: no worker-side shell fallback either way.
    expect(inferred.workerSpaFallback).toBe(false);
    expect(overridden.workerSpaFallback).toBe(false);
  });

  it('applies on the plain-asset branch too (no API routes)', () => {
    const inputs = {
      isSsr: false,
      hasPages: false,
      hasDocumentRoutes: false,
      hasMiddleware: false,
    } as const;
    expect(resolveAssetRoutingPolicy({ ...inputs, notFound: 'none' }).assetConfig).toEqual({
      not_found_handling: 'none',
      run_worker_first: ['/__void', '/__void/*'],
    });
  });

  it('can also override the worker-first branch, which infers "none"', () => {
    const workerFirst = {
      isSsr: false,
      hasPages: true,
      hasDocumentRoutes: false,
      hasMiddleware: false,
    } as const;
    expect(resolveAssetRoutingPolicy(workerFirst).assetConfig.not_found_handling).toBe('none');
    expect(resolveAssetRoutingPolicy({ ...workerFirst, notFound: '404-page' }).assetConfig).toEqual(
      {
        not_found_handling: '404-page',
        run_worker_first: ['/**'],
      },
    );
  });
});

// Worker-first without SSR or pages/: the worker itself serves the SPA shell for unmatched pages.
describe('resolveAssetRoutingPolicy — notFound on the worker-first SPA-fallback shape', () => {
  // middleware/ → workerOwnsHtmlRouting, no pages/, no SSR.
  const ssgWithMiddleware = {
    isSsr: false,
    hasPages: false,
    hasDocumentRoutes: false,
    hasMiddleware: true,
  } as const;

  it('keeps the worker-side shell fallback when notFound is unset', () => {
    const policy = resolveAssetRoutingPolicy(ssgWithMiddleware);
    expect(policy.workerFirst).toBe(true);
    expect(policy.assetConfig.not_found_handling).toBe('none');
    expect(policy.workerSpaFallback).toBe(true);
  });

  it('clears the worker-side shell fallback for notFound: "404-page"', () => {
    const policy = resolveAssetRoutingPolicy({ ...ssgWithMiddleware, notFound: '404-page' });
    expect(policy.assetConfig.not_found_handling).toBe('404-page');
    expect(policy.workerSpaFallback).toBe(false);
    // Which layer sees the request first is still unchanged.
    expect(policy.workerFirst).toBe(true);
    expect(policy.assetConfig.run_worker_first).toEqual(['/**']);
  });

  it('clears it for notFound: "none" too', () => {
    expect(
      resolveAssetRoutingPolicy({ ...ssgWithMiddleware, notFound: 'none' }).workerSpaFallback,
    ).toBe(false);
  });

  it('keeps it for an explicit notFound: "single-page-application"', () => {
    // The override names the shell, so the shell is what it gets.
    expect(
      resolveAssetRoutingPolicy({
        ...ssgWithMiddleware,
        notFound: 'single-page-application',
      }).workerSpaFallback,
    ).toBe(true);
  });

  it('applies to every workerOwnsHtmlRouting trigger, not just middleware', () => {
    for (const trigger of [
      { hasDocumentRoutes: true, hasMiddleware: false },
      { hasDocumentRoutes: false, hasMiddleware: false, hasWebSockets: true },
      { hasDocumentRoutes: false, hasMiddleware: false, liveEnabled: true },
    ]) {
      const base = { isSsr: false, hasPages: false, ...trigger } as const;
      expect(resolveAssetRoutingPolicy(base).workerSpaFallback).toBe(true);
      expect(resolveAssetRoutingPolicy({ ...base, notFound: '404-page' }).workerSpaFallback).toBe(
        false,
      );
    }
  });
});

// Runs createAssetFallback with the resolved policy against a fake asset binding.
describe('generated serveWithAssets — routing.notFound end to end', () => {
  /** Stand-in for CF's asset binding, implementing `not_found_handling`. */
  function makeAssets(handling: string | undefined, opts?: { has404Page?: boolean }) {
    return {
      async fetch(req: Request): Promise<Response> {
        const path = new URL(req.url).pathname;
        if (path === '/index.html') {
          return new Response('<html>SPA SHELL</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        if (handling === 'single-page-application') {
          return new Response('<html>SPA SHELL</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          });
        }
        if (handling === '404-page' && opts?.has404Page !== false) {
          return new Response('<html>GENERATED 404</html>', {
            status: 404,
            headers: { 'content-type': 'text/html' },
          });
        }
        return new Response('', { status: 404 });
      },
    };
  }

  /**
   * Runs the asset fallback and hands back the raw `Response`, so a caller can
   * assert on headers and not just status/body. `path`, `accept` and the worker
   * response default to a browser navigation to an unmatched document path.
   */
  async function serveRaw(
    inputs: Parameters<typeof resolveAssetRoutingPolicy>[0],
    opts?: {
      has404Page?: boolean;
      path?: string;
      /** `null` omits the header entirely. */
      accept?: string | null;
      workerResponse?: () => Response;
    },
  ): Promise<Response> {
    const policy = resolveAssetRoutingPolicy(inputs);
    const handling = policy.assetConfig.not_found_handling;
    const serveWithAssets = createAssetFallback({
      assetsDir: 'assets',
      serveSpaFallback: policy.workerSpaFallback,
      notFound: handling,
    });
    const accept = opts?.accept === undefined ? 'text/html' : opts.accept;
    const request = new Request(`https://app.test${opts?.path ?? '/deep/link'}`, {
      headers: accept === null ? {} : { accept },
    });
    return await serveWithAssets(
      request,
      { ASSETS: makeAssets(handling, opts) },
      opts?.workerResponse?.() ?? new Response('worker 404', { status: 404 }),
    );
  }

  async function serveUnmatched(
    inputs: Parameters<typeof resolveAssetRoutingPolicy>[0],
    opts?: { has404Page?: boolean },
  ): Promise<{ status: number; body: string }> {
    const res = await serveRaw(inputs, opts);
    return { status: res.status, body: await res.text() };
  }

  const ssgWithMiddleware = {
    isSsr: false,
    hasPages: false,
    hasDocumentRoutes: false,
    hasMiddleware: true,
  } as const;

  it('keeps 404s from skipped paths such as the image optimizer endpoint', async () => {
    const policy = resolveAssetRoutingPolicy({
      isSsr: false,
      hasPages: false,
      hasApiRoutes: true,
      hasDocumentRoutes: false,
      hasMiddleware: false,
      imagePath: '/_void/image',
    });
    expect(policy.assetConfig.run_worker_first).toContain('/_void/image');
    const handling = policy.assetConfig.not_found_handling;
    expect(handling).toBe('single-page-application');
    const assets = makeAssets(handling);
    const fetchAsset = vi.spyOn(assets, 'fetch');
    const serveWithAssets = createAssetFallback({
      assetsDir: 'assets',
      serveSpaFallback: policy.workerSpaFallback,
      notFound: handling,
      skipPaths: ['/_void/image'],
    });
    const serve = (path: string, accept: string) =>
      serveWithAssets(
        new Request(`https://app.test${path}`, { headers: { accept } }),
        { ASSETS: assets },
        new Response('upstream 404', { status: 404 }),
      );

    const image = await serve('/_void/image?url=%2Fgone.png&w=64&q=75', 'image/avif,*/*');
    expect(image.status).toBe(404);
    expect(await image.text()).toBe('upstream 404');
    const navigation = await serve('/_void/image?url=%2Fgone.png&w=64&q=75', 'text/html');
    expect(navigation.status).toBe(404);
    expect(fetchAsset).not.toHaveBeenCalled();

    const other = await serve('/deep/link', 'text/html');
    expect(other.status).toBe(200);
    expect(await other.text()).toBe('<html>SPA SHELL</html>');
  });

  it('serves the SPA shell at 200 when notFound is unset (unchanged default)', async () => {
    expect(await serveUnmatched(ssgWithMiddleware)).toEqual({
      status: 200,
      body: '<html>SPA SHELL</html>',
    });
  });

  it('serves the generator 404 page with a 404 status for notFound: "404-page"', async () => {
    expect(await serveUnmatched({ ...ssgWithMiddleware, notFound: '404-page' })).toEqual({
      status: 404,
      body: '<html>GENERATED 404</html>',
    });
  });

  it('keeps the worker response when 404-page finds no 404.html to serve', async () => {
    // A bodyless platform 404 is strictly worse than whatever the worker said.
    expect(
      await serveUnmatched({ ...ssgWithMiddleware, notFound: '404-page' }, { has404Page: false }),
    ).toEqual({ status: 404, body: 'worker 404' });
  });

  it('serves the worker 404 for notFound: "none"', async () => {
    expect(await serveUnmatched({ ...ssgWithMiddleware, notFound: 'none' })).toEqual({
      status: 404,
      body: 'worker 404',
    });
  });

  it('still serves the shell for an explicit notFound: "single-page-application"', async () => {
    expect(
      await serveUnmatched({ ...ssgWithMiddleware, notFound: 'single-page-application' }),
    ).toEqual({ status: 200, body: '<html>SPA SHELL</html>' });
  });

  it('honors 404-page on the SSR shape, which never had a shell fallback', async () => {
    expect(
      await serveUnmatched({
        isSsr: true,
        hasPages: false,
        hasDocumentRoutes: false,
        hasMiddleware: false,
        notFound: '404-page',
      }),
    ).toEqual({ status: 404, body: '<html>GENERATED 404</html>' });
  });

  for (const shape of [
    { label: 'SSR', isSsr: true, hasPages: false },
    { label: 'Pages', isSsr: false, hasPages: true },
  ]) {
    it(`serves the shell at 200 for ${shape.label} + notFound: "single-page-application", with the worker fallback off`, async () => {
      const inputs = {
        isSsr: shape.isSsr,
        hasPages: shape.hasPages,
        hasDocumentRoutes: false,
        hasMiddleware: false,
        notFound: 'single-page-application',
      } as const;
      expect(resolveAssetRoutingPolicy(inputs).workerSpaFallback).toBe(false);
      expect(await serveUnmatched(inputs)).toEqual({
        status: 200,
        body: '<html>SPA SHELL</html>',
      });
    });
  }

  // serveWithAssets sees every worker 404, so a deliberate API 404 must pass through intact.
  describe('an API 404 is not replaced by the HTML 404 page', () => {
    /** A handler deliberately answering 404 with JSON, plus a CORS header. */
    const apiJson404 = () =>
      new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': 'https://client.test',
        },
      });

    async function serveApi(accept: string | null) {
      const res = await serveRaw(
        { ...ssgWithMiddleware, notFound: '404-page' },
        { path: '/api/thing', accept, workerResponse: apiJson404 },
      );
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        cors: res.headers.get('access-control-allow-origin'),
        body: await res.text(),
      };
    }

    it('preserves body, status and content-type for an API client (accept: application/json)', async () => {
      expect(await serveApi('application/json')).toEqual({
        status: 404,
        contentType: 'application/json',
        cors: 'https://client.test',
        body: '{"error":"not found"}',
      });
    });

    it('preserves it for a curl-style accept: */*', async () => {
      // `*/*` does not literally contain `text/html`, and it must not be widened
      // to match: a wildcard is what every non-browser client sends by default.
      expect(await serveApi('*/*')).toEqual({
        status: 404,
        contentType: 'application/json',
        cors: 'https://client.test',
        body: '{"error":"not found"}',
      });
    });

    it('preserves it when the request sends no accept header at all', async () => {
      expect(await serveApi(null)).toEqual({
        status: 404,
        contentType: 'application/json',
        cors: 'https://client.test',
        body: '{"error":"not found"}',
      });
    });

    it('keeps a middleware-set CORS header on an HTML-accepting API 404 too', async () => {
      // Rebuilding the response from the asset would drop it, and a browser
      // `fetch()` would then see a CORS failure instead of a 404. Only the
      // document-navigation shape below is allowed to swap in the 404 page.
      const res = await serveRaw(
        { ...ssgWithMiddleware, notFound: '404-page' },
        { path: '/api/thing', accept: 'application/json, text/plain', workerResponse: apiJson404 },
      );
      expect(res.headers.get('access-control-allow-origin')).toBe('https://client.test');
    });

    // The extension-less document is covered above. Also check `.html`, because
    // VitePress defaults to `cleanUrls: false` and keeps the extension.

    it('still serves the HTML 404 page for a browser navigation to a .html path', async () => {
      const res = await serveRaw(
        { ...ssgWithMiddleware, notFound: '404-page' },
        {
          path: '/guide/missing.html',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      );
      expect({ status: res.status, body: await res.text() }).toEqual({
        status: 404,
        body: '<html>GENERATED 404</html>',
      });
    });
  });
});

describe('resolveAssetRoutingPolicy image optimizer path', () => {
  const base = { isSsr: false, hasPages: false, hasDocumentRoutes: false, hasMiddleware: false };

  it('lists the mounted image path in both SPA worker-first lists', () => {
    expect(resolveAssetConfig({ ...base, imagePath: '/_void/image' })).toEqual({
      not_found_handling: 'single-page-application',
      run_worker_first: ['/__void', '/__void/*', '/_void/image'],
    });
    expect(resolveAssetConfig({ ...base, hasApiRoutes: true, imagePath: '/img' })).toEqual({
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api', '/api/*', '/__void', '/__void/*', '/img'],
    });
  });

  it('leaves worker-first policies unchanged', () => {
    expect(resolveAssetConfig({ ...base, hasPages: true, imagePath: '/_void/image' })).toEqual({
      not_found_handling: 'none',
      run_worker_first: ['/**'],
    });
  });
});
