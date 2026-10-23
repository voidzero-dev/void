import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import app from '../../src/index.ts';
import {
  SHARED_CACHE_POLICY_VERSION,
  isrEdgeCacheKey,
  markSharedCachePolicy,
  packIsrValue,
} from '../../src/isr.ts';

const edgeCacheStore = new Map<string, Response>();

vi.stubGlobal('caches', {
  default: {
    match: async (req: Request) => {
      const res = edgeCacheStore.get(req.url);
      return res ? res.clone() : undefined;
    },
    put: async (req: Request, res: Response) => {
      edgeCacheStore.set(req.url, res.clone());
    },
    delete: async (req: Request) => edgeCacheStore.delete(req.url),
  },
});

beforeEach(() => {
  edgeCacheStore.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

const STUB_BODY = 'Assets have not yet been deployed to this script.\n';

function stubResponse(): Response {
  return new Response(STUB_BODY, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Content-Length': String(STUB_BODY.length),
    },
  });
}

function delayedTextBodyResponse(body: string, delayMs: number): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(bytes);
          controller.close();
        }, delayMs);
      },
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'Content-Length': String(bytes.byteLength),
      },
    },
  );
}

function delayedStubBodyResponse(delayMs: number): Response {
  return delayedTextBodyResponse(STUB_BODY, delayMs);
}

function cachedStubResponse(cacheControl: string): Response {
  const response = stubResponse();
  response.headers.set('Cache-Control', cacheControl);
  markSharedCachePolicy(response.headers);
  return response;
}

function createCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

type Harness = {
  routing: {
    workerName: string;
    projectId: string;
    userId?: string;
    version?: string;
    ssr?: boolean;
    revalidate?: Record<string, number>;
    pages?: Array<{ pattern: string; revalidate: number }>;
    staticDeploymentId?: string;
    assetManifestId?: string;
    assetConfig?: { not_found_handling?: 'none' | 'single-page-application' | '404-page' };
    hashedAssetsPrefix?: string;
    fallbackRules?: Array<{ source: string; destination: string; status: number }>;
  };
  servingManifest?: Record<string, string>;
  staticAssets?: Record<string, { content: ArrayBuffer; ct?: string }>;
  staticAssetsGet?: (
    key: string,
  ) => Promise<{ value: ArrayBuffer | null; metadata: { ct?: string } | null }>;
  manifestGet?: (key: string) => Promise<string | null>;
  isrCacheEntry?: {
    value: ArrayBuffer;
    metadata: { s: number; c: number; t: number; p: typeof SHARED_CACHE_POLICY_VERSION };
  };
  dispatchTimeoutMs?: string;
  workerResponse: Response | ((req: Request) => Response | Promise<Response>);
};

function createEnv(h: Harness): {
  env: Env;
  workerFetch: ReturnType<typeof vi.fn>;
  analyticsWrite: ReturnType<typeof vi.fn>;
  usageSend: ReturnType<typeof vi.fn>;
  isrDelete: ReturnType<typeof vi.fn>;
} {
  const workerFetch = vi.fn(async (req: Request) =>
    typeof h.workerResponse === 'function' ? h.workerResponse(req) : h.workerResponse,
  );
  const analyticsWrite = vi.fn();
  const usageSend = vi.fn(async () => {});
  const isrDelete = vi.fn(async () => {});
  const env = {
    ROUTING: {
      get: async (key: string) => {
        if (key.startsWith('manifest:') && h.manifestGet) {
          return h.manifestGet(key);
        }
        if (
          h.servingManifest &&
          (h.routing.assetManifestId ?? h.routing.staticDeploymentId) ===
            key.replace(/^manifest:/, '')
        ) {
          return JSON.stringify(h.servingManifest);
        }
        if (key.startsWith('manifest:')) {
          return null;
        }
        return JSON.stringify(h.routing);
      },
    },
    DISPATCH: {
      get: () => ({ fetch: workerFetch }),
    },
    STATIC_ASSETS: {
      getWithMetadata: async (key: string) => {
        if (h.staticAssetsGet) {
          return h.staticAssetsGet(key);
        }
        const asset = h.staticAssets?.[key];
        if (!asset) {
          return { value: null, metadata: null };
        }
        return { value: asset.content, metadata: asset.ct ? { ct: asset.ct } : null };
      },
    },
    STATIC_ASSETS_R2: {
      get: async (key: string) =>
        key.startsWith('isr-cache/') && h.isrCacheEntry
          ? {
              arrayBuffer: async () => h.isrCacheEntry!.value,
              customMetadata: { isr: JSON.stringify(h.isrCacheEntry.metadata) },
            }
          : null,
      put: async () => {},
      delete: isrDelete,
    },
    ISR_CACHE: { delete: async () => {} },
    ANALYTICS: { writeDataPoint: analyticsWrite },
    USAGE_QUEUE: { send: usageSend },
    DISPATCH_TIMEOUT_MS: h.dispatchTimeoutMs,
  } as unknown as Env;
  return { env, workerFetch, analyticsWrite, usageSend, isrDelete };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

describe('WfP asset fallback on CF stub', () => {
  it('falls back to mirrored KV asset when worker returns the CF stub', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/logo.png': 'hashxyz' },
      staticAssets: { 'assets/proj_1/hashxyz': { content: PNG_BYTES, ct: 'image/png' } },
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const body = await res.arrayBuffer();
    expect(new Uint8Array(body)).toEqual(new Uint8Array(PNG_BYTES));
  });

  it('returns an attributed 503 instead of caching the stub without a mirror', async () => {
    const { env, analyticsWrite } = createEnv({
      routing: { workerName: 'user-app', projectId: 'proj_1' },
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-storage-error')).toBe('static-asset-missing');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-missing');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('returns an attributed 503 when the serving manifest is missing from KV', async () => {
    const { env, analyticsWrite } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_missing',
      },
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-storage-error')).toBe('static-asset-missing');
    expect(await res.text()).toBe('');
    expect(analyticsWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: expect.arrayContaining(['platform-static-asset-missing']),
      }),
    );
  });

  it('returns an attributed 503 when the path is absent from the serving manifest', async () => {
    const { env, analyticsWrite } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
        assetConfig: { not_found_handling: 'none' },
      },
      servingManifest: { '/other.png': 'hashxyz' },
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-storage-error')).toBe('static-asset-missing');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-missing');
  });

  it('does not cache the CF stub when mirror bytes are missing', async () => {
    const { env, analyticsWrite } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/logo.png': 'hashxyz' },
      staticAssets: {}, // no bytes on hand
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-storage-error')).toBe('static-asset-missing');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-missing');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('returns an attributed 503 when both mirror reads throw', async () => {
    const staticAssetsGet = vi.fn(async () => {
      throw new Error('KV unavailable');
    });
    const { env, analyticsWrite } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/logo.png': 'hashxyz' },
      staticAssetsGet,
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(staticAssetsGet).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-storage-error')).toBe('static-asset-read');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-error');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('bounds stalled mirror reads and never caches the CF stub', async () => {
    vi.useFakeTimers();
    const staticAssetsGet = vi.fn(
      () => new Promise<{ value: ArrayBuffer | null; metadata: { ct?: string } | null }>(() => {}),
    );
    const { env, analyticsWrite } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/logo.png': 'hashxyz' },
      staticAssetsGet,
      dispatchTimeoutMs: '100',
      workerResponse: stubResponse(),
    });

    const responsePromise = app.fetch(
      new Request('https://my-app.void.app/logo.png'),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(100);
    const res = await responsePromise;

    expect(staticAssetsGet).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-timeout')).toBe('static-asset');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-timeout');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('attributes a serving-manifest read error before any asset read', async () => {
    const manifestGet = vi.fn(async () => {
      throw new Error('routing KV unavailable');
    });
    const staticAssetsGet = vi.fn(async () => ({ value: null, metadata: null }));
    const { env, analyticsWrite } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        assetManifestId: 'dep_abc',
      },
      manifestGet,
      staticAssetsGet,
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/logo.png'), env, createCtx());

    expect(manifestGet).toHaveBeenCalledTimes(2);
    expect(staticAssetsGet).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-storage-error')).toBe('static-asset-read');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-error');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('bounds a stalled serving-manifest lookup within the request budget', async () => {
    vi.useFakeTimers();
    const manifestGet = vi.fn(() => new Promise<string | null>(() => {}));
    const staticAssetsGet = vi.fn(async () => ({ value: null, metadata: null }));
    const { env, analyticsWrite } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        assetManifestId: 'dep_abc',
      },
      manifestGet,
      staticAssetsGet,
      dispatchTimeoutMs: '100',
      workerResponse: stubResponse(),
    });

    const responsePromise = app.fetch(
      new Request('https://my-app.void.app/logo.png'),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(100);
    const res = await responsePromise;

    expect(manifestGet).toHaveBeenCalledTimes(2);
    expect(staticAssetsGet).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-timeout')).toBe('static-asset');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-timeout');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('shares one absolute budget between the manifest and mirrored asset reads', async () => {
    vi.useFakeTimers();
    const manifest = JSON.stringify({ '/logo.png': 'hashxyz' });
    const manifestGet = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve(manifest), 75);
        }),
    );
    const staticAssetsGet = vi.fn(
      () => new Promise<{ value: ArrayBuffer | null; metadata: { ct?: string } | null }>(() => {}),
    );
    const { env, analyticsWrite } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        assetManifestId: 'dep_abc',
      },
      manifestGet,
      staticAssetsGet,
      dispatchTimeoutMs: '100',
      workerResponse: stubResponse(),
    });

    const responsePromise = app.fetch(
      new Request('https://my-app.void.app/logo.png'),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(100);
    const res = await responsePromise;

    expect(manifestGet).toHaveBeenCalledTimes(2);
    expect(staticAssetsGet).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-timeout')).toBe('static-asset');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-timeout');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('bounds static-deployment manifest reads with the same failure attribution', async () => {
    vi.useFakeTimers();
    const manifestGet = vi.fn(() => new Promise<string | null>(() => {}));
    const { env, analyticsWrite } = createEnv({
      routing: {
        workerName: 'unused',
        projectId: 'proj_1',
        version: 'v1',
        staticDeploymentId: 'dep_static',
      },
      manifestGet,
      dispatchTimeoutMs: '100',
      workerResponse: new Response('should not run'),
    });

    const responsePromise = app.fetch(
      new Request('https://my-app.void.app/logo.png'),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(100);
    const res = await responsePromise;

    expect(manifestGet).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-timeout')).toBe('static-asset');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-timeout');
  });

  it('bounds a stalled primary WfP hashed-asset fetch', async () => {
    vi.useFakeTimers();
    const { env, workerFetch, analyticsWrite } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        hashedAssetsPrefix: 'assets',
      },
      dispatchTimeoutMs: '100',
      workerResponse: () => new Promise<Response>(() => {}),
    });

    const responsePromise = app.fetch(
      new Request('https://my-app.void.app/assets/app-abc.js'),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(100);
    const res = await responsePromise;

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-timeout')).toBe('static-asset');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-timeout');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('shares one deadline between a delayed WfP hashed-asset fetch and mirror reads', async () => {
    vi.useFakeTimers();
    const manifestGet = vi.fn(() => new Promise<string | null>(() => {}));
    const { env, workerFetch, analyticsWrite } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
        hashedAssetsPrefix: 'assets',
      },
      manifestGet,
      dispatchTimeoutMs: '100',
      workerResponse: () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(stubResponse()), 75);
        }),
    });

    const responsePromise = app.fetch(
      new Request('https://my-app.void.app/assets/app-abc.js'),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(100);
    const res = await responsePromise;

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(manifestGet).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-timeout')).toBe('static-asset');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-timeout');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('shares one deadline between CF stub body confirmation and mirror reads', async () => {
    vi.useFakeTimers();
    const manifestGet = vi.fn(() => new Promise<string | null>(() => {}));
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
        hashedAssetsPrefix: 'assets',
      },
      manifestGet,
      dispatchTimeoutMs: '100',
      workerResponse: () => delayedStubBodyResponse(75),
    });

    const responsePromise = app.fetch(
      new Request('https://my-app.void.app/assets/app-abc.js'),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(100);
    const res = await responsePromise;

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(manifestGet).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-timeout')).toBe('static-asset');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('does not attribute a pre-confirmation text body timeout to platform storage', async () => {
    vi.useFakeTimers();
    const { env, workerFetch, usageSend } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        userId: 'user_1',
        hashedAssetsPrefix: 'assets',
      },
      dispatchTimeoutMs: '100',
      workerResponse: () => delayedTextBodyResponse('ordinary app response', 150),
    });
    const ctx = createCtx();

    const responsePromise = app.fetch(
      new Request('https://my-app.void.app/assets/app-abc.js'),
      env,
      ctx,
    );
    await vi.advanceTimersByTimeAsync(100);
    const res = await responsePromise;
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-timeout')).toBe('dispatch');
    expect(usageSend).toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ status: 503 }) }),
    );
    expect(usageSend.mock.calls[0]?.[0].event).not.toHaveProperty('failureKind');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('shares one deadline between a delayed WfP dispatch and mirror reads', async () => {
    vi.useFakeTimers();
    const manifestGet = vi.fn(() => new Promise<string | null>(() => {}));
    const { env, workerFetch, analyticsWrite } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
      },
      manifestGet,
      dispatchTimeoutMs: '100',
      workerResponse: () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(stubResponse()), 75);
        }),
    });

    const responsePromise = app.fetch(
      new Request('https://my-app.void.app/api/items'),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(100);
    const res = await responsePromise;

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(manifestGet).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-timeout')).toBe('static-asset');
    expect(analyticsWrite.mock.calls[0]?.[0].blobs[5]).toBe('platform-static-asset-timeout');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('bounds a fallback-rule worker fetch within the original dispatch deadline', async () => {
    vi.useFakeTimers();
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      dispatchTimeoutMs: '100',
      workerResponse: (request) =>
        new URL(request.url).pathname === '/index.html'
          ? new Promise<Response>(() => {})
          : new Response('not found', { status: 404 }),
    });

    const responsePromise = app.fetch(
      new Request('https://my-app.void.app/api/items'),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(100);
    const res = await responsePromise;

    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-timeout')).toBe('dispatch');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('bounds an ISR cold-miss worker fetch within the dispatch deadline', async () => {
    vi.useFakeTimers();
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        ssr: true,
        revalidate: { '/page': 60 },
        pages: [{ pattern: '/page', revalidate: 60 }],
      },
      dispatchTimeoutMs: '100',
      workerResponse: () => new Promise<Response>(() => {}),
    });

    const responsePromise = app.fetch(
      new Request('https://my-app.void.app/page'),
      env,
      createCtx(),
    );
    await vi.advanceTimersByTimeAsync(100);
    const res = await responsePromise;

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(503);
    expect(res.headers.get('x-void-timeout')).toBe('dispatch');
    expect(edgeCacheStore.size).toBe(0);
  });

  it('checks the initial ISR cold-miss response before writing shared caches', async () => {
    const html = '<html>mirror</html>';
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        ssr: true,
        revalidate: { '/page': 60 },
        pages: [{ pattern: '/page', revalidate: 60 }],
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/page': 'hashhtml' },
      staticAssets: {
        'assets/proj_1/hashhtml': {
          content: new TextEncoder().encode(html).buffer as ArrayBuffer,
          ct: 'text/html',
        },
      },
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/page'), env, createCtx());

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toBe(html);
    for (const cached of edgeCacheStore.values()) {
      expect(await cached.clone().text()).not.toBe(STUB_BODY);
    }
  });

  it('does not buffer the body for non-matching responses (large JSON API reply)', async () => {
    const largeBody = JSON.stringify({ items: new Array(100).fill({ x: 1 }) });
    const apiResponse = new Response(largeBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(largeBody.length),
      },
    });
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/api/items': 'hashxyz' },
      staticAssets: { 'assets/proj_1/hashxyz': { content: PNG_BYTES, ct: 'image/png' } },
      workerResponse: apiResponse,
    });

    const res = await app.fetch(new Request('https://my-app.void.app/api/items'), env, createCtx());

    // JSON passes through; fallback must NOT be triggered even though the
    // manifest has a matching path and bytes.
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe(largeBody);
  });

  it('does not trigger on small text/plain 200 that is not the stub text', async () => {
    const okBody = 'ok';
    const { env } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/health': 'hashxyz' },
      staticAssets: { 'assets/proj_1/hashxyz': { content: PNG_BYTES, ct: 'image/png' } },
      workerResponse: new Response(okBody, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
          'Content-Length': String(okBody.length),
        },
      }),
    });

    const res = await app.fetch(new Request('https://my-app.void.app/health'), env, createCtx());

    expect(await res.text()).toBe(okBody);
  });

  it('falls back through the hashed-prefix branch when the worker returns a stub', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
        hashedAssetsPrefix: 'assets',
      },
      servingManifest: { '/assets/app-abc.js': 'hashjs' },
      staticAssets: {
        'assets/proj_1/hashjs': {
          content: new TextEncoder().encode('console.log(1)').buffer as ArrayBuffer,
          ct: 'application/javascript',
        },
      },
      workerResponse: stubResponse(),
    });

    const res = await app.fetch(
      new Request('https://my-app.void.app/assets/app-abc.js'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(await res.text()).toBe('console.log(1)');
  });

  it('repairs a pre-existing immutable poison entry without calling the worker', async () => {
    const request = new Request('https://my-app.void.app/assets/app-abc.js');
    const cacheUrl = `${request.url}?_p=proj_1`;
    edgeCacheStore.set(cacheUrl, cachedStubResponse('public, max-age=31536000, immutable'));
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
        hashedAssetsPrefix: 'assets',
      },
      servingManifest: { '/assets/app-abc.js': 'hashjs' },
      staticAssets: {
        'assets/proj_1/hashjs': {
          content: new TextEncoder().encode('console.log(1)').buffer as ArrayBuffer,
          ct: 'application/javascript',
        },
      },
      workerResponse: new Response('should not run'),
    });

    const res = await app.fetch(request, env, createCtx());

    expect(workerFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
    expect(await edgeCacheStore.get(cacheUrl)?.clone().text()).toBe('console.log(1)');
  });

  it('repairs a pre-existing versioned static poison entry', async () => {
    const request = new Request('https://my-app.void.app/logo.png');
    const cacheUrl = new URL(request.url);
    cacheUrl.searchParams.set('_v', 'v1');
    edgeCacheStore.set(
      cacheUrl.toString(),
      cachedStubResponse('public, s-maxage=31536000, max-age=0, must-revalidate'),
    );
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        assetManifestId: 'dep_abc',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      servingManifest: { '/logo.png': 'hashxyz', '/index.html': 'hashhtml' },
      staticAssets: {
        'assets/proj_1/hashxyz': { content: PNG_BYTES, ct: 'image/png' },
        'assets/proj_1/hashhtml': {
          content: new TextEncoder().encode('<html>fallback</html>').buffer as ArrayBuffer,
          ct: 'text/html',
        },
      },
      workerResponse: new Response('should not run'),
    });

    const res = await app.fetch(request, env, createCtx());

    expect(workerFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG_BYTES));
    const repaired = edgeCacheStore.get(cacheUrl.toString());
    expect(repaired?.headers.get('content-type')).toBe('image/png');
  });

  it('repairs a cached fallback rewrite stub from the mirrored destination', async () => {
    const request = new Request('https://my-app.void.app/app/route');
    const cacheUrl = new URL(request.url);
    cacheUrl.searchParams.set('_v', 'v1');
    edgeCacheStore.set(
      cacheUrl.toString(),
      cachedStubResponse('public, s-maxage=31536000, max-age=0, must-revalidate'),
    );
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        assetManifestId: 'dep_abc',
        assetConfig: { not_found_handling: '404-page' },
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      servingManifest: { '/index.html': 'hashhtml', '/404.html': 'hash404' },
      staticAssets: {
        'assets/proj_1/hashhtml': {
          content: new TextEncoder().encode('<html>mirror</html>').buffer as ArrayBuffer,
          ct: 'text/html',
        },
        'assets/proj_1/hash404': {
          content: new TextEncoder().encode('<html>not found</html>').buffer as ArrayBuffer,
          ct: 'text/html',
        },
      },
      workerResponse: new Response('should not run'),
    });
    const ctx = createCtx();

    const res = await app.fetch(request, env, ctx);
    await Promise.all((ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]));

    expect(workerFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toBe('<html>mirror</html>');
    expect(await edgeCacheStore.get(cacheUrl.toString())?.clone().text()).toBe(
      '<html>mirror</html>',
    );
    expect(edgeCacheStore.has('https://my-app.void.app/index.html?_v=v1')).toBe(false);
  });

  it('repairs and purges a pre-existing ISR edge poison entry', async () => {
    const request = new Request('https://my-app.void.app/page');
    const cacheKey = isrEdgeCacheKey(request, '/page', 'v1');
    const cachedStub = cachedStubResponse('public, s-maxage=60, max-age=0, must-revalidate');
    markSharedCachePolicy(cachedStub.headers);
    edgeCacheStore.set(cacheKey.url, cachedStub);
    const html = '<html>mirror</html>';
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        ssr: true,
        revalidate: { '/page': 60 },
        pages: [{ pattern: '/page', revalidate: 60 }],
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/page': 'hashhtml' },
      staticAssets: {
        'assets/proj_1/hashhtml': {
          content: new TextEncoder().encode(html).buffer as ArrayBuffer,
          ct: 'text/html',
        },
      },
      workerResponse: new Response('should not run'),
    });

    const res = await app.fetch(request, env, createCtx());

    expect(workerFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(html);
    expect(edgeCacheStore.has(cacheKey.url)).toBe(false);
  });

  it('repairs and purges a pre-existing ISR storage poison entry', async () => {
    const request = new Request('https://my-app.void.app/page');
    const html = '<html>mirror</html>';
    const stubBytes = new TextEncoder().encode(STUB_BODY);
    const { env, workerFetch, isrDelete } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'v1',
        ssr: true,
        revalidate: { '/page': 60 },
        pages: [{ pattern: '/page', revalidate: 60 }],
        assetManifestId: 'dep_abc',
      },
      servingManifest: { '/page': 'hashhtml' },
      staticAssets: {
        'assets/proj_1/hashhtml': {
          content: new TextEncoder().encode(html).buffer as ArrayBuffer,
          ct: 'text/html',
        },
      },
      isrCacheEntry: {
        value: packIsrValue(
          {
            'content-type': 'text/plain;charset=UTF-8',
            'content-length': String(STUB_BODY.length),
          },
          stubBytes.buffer as ArrayBuffer,
        ),
        metadata: { s: 200, c: Date.now(), t: 60, p: SHARED_CACHE_POLICY_VERSION },
      },
      workerResponse: new Response('should not run'),
    });

    const res = await app.fetch(request, env, createCtx());

    expect(workerFetch).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(html);
    expect(isrDelete).toHaveBeenCalledOnce();
    for (const cached of edgeCacheStore.values()) {
      expect(await cached.clone().text()).not.toBe(STUB_BODY);
    }
  });

  it('checks fallback rewrite responses for the CF asset stub before returning', async () => {
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        assetManifestId: 'dep_abc',
        fallbackRules: [{ source: '/*', destination: '/index.html', status: 200 }],
      },
      servingManifest: { '/index.html': 'hashhtml' },
      staticAssets: {
        'assets/proj_1/hashhtml': {
          content: new TextEncoder().encode('<html>mirror</html>').buffer as ArrayBuffer,
          ct: 'text/html',
        },
      },
      workerResponse: (req) => {
        if (new URL(req.url).pathname === '/index.html') {
          return stubResponse();
        }
        return new Response('not found', { status: 404 });
      },
    });

    const res = await app.fetch(new Request('https://my-app.void.app/app/route'), env, createCtx());

    expect(workerFetch).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toBe('<html>mirror</html>');
  });
});
