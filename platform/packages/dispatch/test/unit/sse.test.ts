import { isEventStreamResponse } from '@void/isr/runtime';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Env } from '../../src/env.ts';
import app from '../../src/index.ts';
import { createMockExecutionContext as createCtx } from '../execution-context.ts';

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

function createEnv(options: {
  routing: {
    workerName: string;
    projectId: string;
    ssr?: boolean;
    revalidate?: number | Record<string, number>;
    version?: string;
    assetManifestId?: string;
    fallbackRules?: Array<{ source: string; destination: string; status: number; host?: string }>;
  };
  workerFetchImpl: (request: Request) => Promise<Response> | Response;
}): {
  env: Env;
  workerFetch: ReturnType<typeof vi.fn>;
  analyticsWrites: Array<unknown>;
  isrWrites: Array<string>;
} {
  const analyticsWrites: Array<unknown> = [];
  const isrWrites: Array<string> = [];
  const workerFetch = vi.fn(options.workerFetchImpl);
  const env = {
    ROUTING: {
      get: async (key: string) => {
        if (key.startsWith('manifest:')) {
          return JSON.stringify({ '/events': 'hash' });
        }
        return JSON.stringify(options.routing);
      },
    },
    DISPATCH: {
      get: () => ({ fetch: workerFetch }),
    },
    STATIC_ASSETS: {
      getWithMetadata: async () => ({ value: null, metadata: null }),
    },
    STATIC_ASSETS_R2: { get: async () => null },
    ISR_CACHE: {
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async (key: string) => isrWrites.push(key),
      delete: async () => {},
      list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    },
    ANALYTICS: {
      writeDataPoint: (data: unknown) => analyticsWrites.push(data),
    },
    USAGE_QUEUE: { send: async () => {} },
  } as unknown as Env;

  return { env, workerFetch, analyticsWrites, isrWrites };
}

function sseResponse(body = 'data: hello\n\n', init?: HeadersInit): Response {
  const headers = new Headers(init);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  }
  if (!headers.has('Content-Length')) {
    headers.set('Content-Length', '999');
  }
  return new Response(body, {
    status: 200,
    headers,
  });
}

describe('SSE dispatch passthrough', () => {
  it('classifies text/event-stream by content-type', () => {
    expect(isEventStreamResponse(sseResponse())).toBe(true);
    expect(
      isEventStreamResponse(new Response('ok', { headers: { 'Content-Type': 'text/plain' } })),
    ).toBe(false);
  });

  it('passes SSE worker responses through without fallback body probing or edge caching', async () => {
    const workerResponse = sseResponse();
    const cloneSpy = vi.spyOn(workerResponse, 'clone');
    const textSpy = vi.spyOn(workerResponse, 'text');
    const { env, workerFetch, analyticsWrites } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        version: 'dep_1',
        assetManifestId: 'dep_1',
        fallbackRules: [{ source: '/events', destination: '/fallback', status: 200 }],
      },
      workerFetchImpl: () => workerResponse,
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/events'),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await response.text()).toBe('data: hello\n\n');
    expect(cloneSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
    expect(edgeCacheStore.size).toBe(0);
    expect((analyticsWrites[0] as { doubles: Array<number> }).doubles[1]).toBe(0);
  });

  it('does not write ISR cache for SSE responses', async () => {
    const { env, isrWrites } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        version: 'dep_1',
      },
      workerFetchImpl: () => sseResponse('data: live\n\n', { 'x-revalidate': '60' }),
    });

    const response = await app.fetch(new Request('https://my-app.void.app/live'), env, createCtx());

    expect(await response.text()).toBe('data: live\n\n');
    expect(isrWrites).toEqual([]);
  });

  it('bypasses ISR cache reads for EventSource requests', async () => {
    edgeCacheStore.set(
      'https://my-app.void.app/live?__void_isr=dep_1',
      new Response('<!doctype html><p>cached html</p>', {
        headers: { 'Content-Type': 'text/html', 'x-isr-cache': 'HIT' },
      }),
    );
    const { env, workerFetch } = createEnv({
      routing: {
        workerName: 'user-app',
        projectId: 'proj_1',
        ssr: true,
        revalidate: 60,
        version: 'dep_1',
      },
      workerFetchImpl: () => sseResponse('data: live\n\n'),
    });

    const response = await app.fetch(
      new Request('https://my-app.void.app/live', {
        headers: { Accept: 'text/event-stream' },
      }),
      env,
      createCtx(),
    );

    expect(workerFetch).toHaveBeenCalledOnce();
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await response.text()).toBe('data: live\n\n');
  });
});
