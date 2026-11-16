import { hostRegistryKey, htmlEdgeKey, isrKey, isrPrefix, jsonEdgeKey } from '@void/isr/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { envContext } from '../../src/runtime/env/raw.ts';
import { revalidate } from '../../src/runtime/isr/index.ts';

const DPL = 'dpl_1';
const HOST = 'app.example.com';

// In-memory KV mock. `pageSize` forces the mock to paginate so revalidate's
// cursor loop (`{ all: true }`) is genuinely exercised with a small key set.
function createKvMock(pageSize = 1000) {
  const store = new Map<string, ArrayBuffer>();
  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });
  // Real KV list is a point-in-time view: snapshot the key set when a new
  // list chain starts (cursor absent) so deletions mid-pagination — as
  // revalidate({ all: true }) does — don't shift the offset and skip keys.
  let snapshot: Array<string> = [];
  const list = vi.fn(async (o: { prefix?: string; cursor?: string } = {}) => {
    const prefix = o.prefix ?? '';
    if (!o.cursor) {
      snapshot = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
    }
    const start = o.cursor ? Number.parseInt(o.cursor, 10) : 0;
    const slice = snapshot.slice(start, start + pageSize);
    const complete = start + pageSize >= snapshot.length;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: complete,
      cursor: complete ? '' : String(start + pageSize),
    };
  });
  const kv = { delete: del, list } as unknown as KVNamespace;
  return { store, kv, delete: del, list };
}

function createEdgeMock() {
  const store = new Map<string, Response>();
  const del = vi.fn(async (key: string | Request) => {
    const k = typeof key === 'string' ? key : (key as Request).url;
    return store.delete(k);
  });
  const cache = { delete: del } as unknown as Cache;
  return { store, cache, delete: del };
}

describe('revalidate — managed (platform proxy)', () => {
  it('forwards { paths } to the proxy /revalidate endpoint', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('ok', { status: 200 }),
    );
    await envContext.run(
      { __VOID_PROXY: { fetch: fetchMock }, __PROJECT_ID: 'proj_1', __VOID_PROXY_TOKEN: 'tok_1' },
      async () => {
        await revalidate({ paths: ['/', '/blog/x'] });
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy/revalidate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: 'proj_1',
      aiToken: 'tok_1',
      paths: ['/', '/blog/x'],
    });
  });

  it('forwards { all: true } to the proxy', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('ok', { status: 200 }),
    );
    await envContext.run(
      { __VOID_PROXY: { fetch: fetchMock }, __PROJECT_ID: 'proj_1', __VOID_PROXY_TOKEN: 'tok_1' },
      async () => {
        await revalidate({ all: true });
      },
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      projectId: 'proj_1',
      aiToken: 'tok_1',
      all: true,
    });
  });

  it('throws when the proxy responds non-ok', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(
      envContext.run(
        { __VOID_PROXY: { fetch: fetchMock }, __PROJECT_ID: 'proj_1', __VOID_PROXY_TOKEN: 'tok_1' },
        async () => {
          await revalidate({ paths: ['/'] });
        },
      ),
    ).rejects.toThrow(/500/);
  });

  it('throws when project id / proxy token bindings are missing', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    await expect(
      envContext.run({ __VOID_PROXY: { fetch: fetchMock } }, async () => {
        await revalidate({ paths: ['/'] });
      }),
    ).rejects.toThrow(/__PROJECT_ID and __VOID_PROXY_TOKEN/);
  });
});

describe('revalidate — self-host (own ISR_CACHE + edge)', () => {
  let edge: ReturnType<typeof createEdgeMock>;

  beforeEach(() => {
    edge = createEdgeMock();
    vi.stubGlobal('caches', { default: edge.cache });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('{ paths } with a request host deletes only the requested entries from KV and both edge variants', async () => {
    const { store, kv, delete: kvDelete } = createKvMock();
    store.set(isrKey(DPL, HOST, '/'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/blog/x'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/keepme'), new ArrayBuffer(4));
    edge.store.set(htmlEdgeKey(HOST, '/', DPL), new Response('x'));
    edge.store.set(jsonEdgeKey(HOST, '/', DPL), new Response('x'));
    edge.store.set(htmlEdgeKey(HOST, '/blog/x', DPL), new Response('x'));
    edge.store.set(jsonEdgeKey(HOST, '/blog/x', DPL), new Response('x'));
    edge.store.set(htmlEdgeKey(HOST, '/keepme', DPL), new Response('x'));
    edge.store.set(jsonEdgeKey(HOST, '/keepme', DPL), new Response('x'));

    await envContext.run(
      { ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL, __VOID_ISR_HOST: HOST },
      async () => {
        await revalidate({ paths: ['/', '/blog/x'] });
      },
    );

    expect(store.has(isrKey(DPL, HOST, '/'))).toBe(false);
    expect(store.has(isrKey(DPL, HOST, '/blog/x'))).toBe(false);
    expect(store.has(isrKey(DPL, HOST, '/keepme'))).toBe(true);

    expect(edge.store.has(htmlEdgeKey(HOST, '/', DPL))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/', DPL))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST, '/blog/x', DPL))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/blog/x', DPL))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST, '/keepme', DPL))).toBe(true);
    expect(edge.store.has(jsonEdgeKey(HOST, '/keepme', DPL))).toBe(true);

    expect(kvDelete).toHaveBeenCalledTimes(2);
    expect(kvDelete.mock.calls.map((c) => c[0])).toEqual([
      isrKey(DPL, HOST, '/'),
      isrKey(DPL, HOST, '/blog/x'),
    ]);

    expect(edge.delete).toHaveBeenCalledTimes(4);
    expect(edge.delete.mock.calls.map((c) => c[0])).toEqual([
      htmlEdgeKey(HOST, '/', DPL),
      jsonEdgeKey(HOST, '/', DPL),
      htmlEdgeKey(HOST, '/blog/x', DPL),
      jsonEdgeKey(HOST, '/blog/x', DPL),
    ]);
  });

  it('{ paths } deletes every allowlisted query variant from KV and edge cache', async () => {
    const { store, kv } = createKvMock();
    const variantA = `https://${HOST}/search?q=a`;
    const variantB = `https://${HOST}/search?q=b`;
    store.set(isrKey(DPL, HOST, '/search', variantA), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/search', variantB), new ArrayBuffer(4));
    edge.store.set(htmlEdgeKey(HOST, '/search', DPL, variantA), new Response('a'));
    edge.store.set(jsonEdgeKey(HOST, '/search', DPL, variantA), new Response('a'));
    edge.store.set(htmlEdgeKey(HOST, '/search', DPL, variantB), new Response('b'));
    edge.store.set(jsonEdgeKey(HOST, '/search', DPL, variantB), new Response('b'));

    await envContext.run(
      { ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL, __VOID_ISR_HOST: HOST },
      async () => revalidate({ paths: ['/search'] }),
    );

    expect(store.has(isrKey(DPL, HOST, '/search', variantA))).toBe(false);
    expect(store.has(isrKey(DPL, HOST, '/search', variantB))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST, '/search', DPL, variantA))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/search', DPL, variantA))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST, '/search', DPL, variantB))).toBe(false);
    expect(edge.store.has(jsonEdgeKey(HOST, '/search', DPL, variantB))).toBe(false);
  });

  it('{ paths } without a request host (cron/queue) purges every registered host', async () => {
    const { store, kv, delete: kvDelete } = createKvMock();
    const HOST_A = 'a.example';
    const HOST_B = 'b.example';
    store.set(isrKey(DPL, HOST_A, '/p'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST_B, '/p'), new ArrayBuffer(4));
    store.set(hostRegistryKey(DPL, HOST_A), new ArrayBuffer(0));
    store.set(hostRegistryKey(DPL, HOST_B), new ArrayBuffer(0));
    edge.store.set(htmlEdgeKey(HOST_A, '/p', DPL), new Response('x'));
    edge.store.set(htmlEdgeKey(HOST_B, '/p', DPL), new Response('x'));

    await envContext.run({ ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL }, async () => {
      await revalidate({ paths: ['/p'] });
    });

    expect(store.has(isrKey(DPL, HOST_A, '/p'))).toBe(false);
    expect(store.has(isrKey(DPL, HOST_B, '/p'))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST_A, '/p', DPL))).toBe(false);
    expect(edge.store.has(htmlEdgeKey(HOST_B, '/p', DPL))).toBe(false);
    expect(kvDelete.mock.calls.map((c) => c[0]).sort()).toEqual(
      [isrKey(DPL, HOST_A, '/p'), isrKey(DPL, HOST_B, '/p')].sort(),
    );
  });

  it('{ paths } without a request host and with an empty registry purges nothing', async () => {
    const { store, kv, delete: kvDelete } = createKvMock();
    store.set(isrKey(DPL, HOST, '/'), new ArrayBuffer(4));

    await envContext.run({ ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL }, async () => {
      await revalidate({ paths: ['/'] });
    });

    expect(store.has(isrKey(DPL, HOST, '/'))).toBe(true);
    expect(kvDelete).not.toHaveBeenCalled();
    expect(edge.delete).not.toHaveBeenCalled();
  });

  // The edge purge fails open, so the KV purge never depends on the Cache API.
  it('purges KV via the registry when the Cache API is unavailable', async () => {
    vi.stubGlobal('caches', {
      get default(): Cache {
        throw new Error('Cache API unavailable');
      },
    });

    const { store, kv, delete: kvDelete } = createKvMock();
    store.set(isrKey(DPL, HOST, '/'), new ArrayBuffer(4));
    store.set(hostRegistryKey(DPL, HOST), new ArrayBuffer(0));

    await expect(
      envContext.run({ ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL }, async () => {
        await revalidate({ paths: ['/'] });
      }),
    ).resolves.toBeUndefined();

    expect(store.has(isrKey(DPL, HOST, '/'))).toBe(false);
    expect(kvDelete).toHaveBeenCalledWith(isrKey(DPL, HOST, '/'));
  });

  it('{ all: true } lists the shared deployment prefix, splits each host, and purges every entry across pages', async () => {
    const { store, kv, list } = createKvMock(2);
    const HOST2 = 'other.example';
    store.set(isrKey(DPL, HOST, '/'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/a'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/b/c'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST2, '/d'), new ArrayBuffer(4));
    store.set(isrKey(DPL, HOST, '/e'), new ArrayBuffer(4));
    store.set(isrKey('other_dpl', HOST, '/x'), new ArrayBuffer(4));

    await envContext.run(
      { ISR_CACHE: kv, __VOID_ISR_DEPLOYMENT_ID: DPL, __VOID_ISR_HOST: HOST },
      async () => {
        await revalidate({ all: true });
      },
    );

    for (const [h, p] of [
      [HOST, '/'],
      [HOST, '/a'],
      [HOST, '/b/c'],
      [HOST2, '/d'],
      [HOST, '/e'],
    ] as const) {
      expect(store.has(isrKey(DPL, h, p))).toBe(false);
    }
    expect(store.has(isrKey('other_dpl', HOST, '/x'))).toBe(true);
    expect(list.mock.calls.length).toBeGreaterThan(1);
    const listPrefix = isrPrefix(DPL);
    for (const [opts] of list.mock.calls) {
      expect((opts as { prefix?: string }).prefix).toBe(listPrefix);
    }
    expect((list.mock.calls[0][0] as { cursor?: string }).cursor).toBeUndefined();
    expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST, '/', DPL));
    expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST, '/b/c', DPL));
    expect(edge.delete).toHaveBeenCalledWith(htmlEdgeKey(HOST2, '/d', DPL));
  });
});

describe('revalidate — unconfigured (silent no-op)', () => {
  beforeEach(() => {
    // An unconfigured worker must not touch the Cache API.
    vi.stubGlobal('caches', undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no-ops when neither proxy nor ISR_CACHE is bound', async () => {
    await expect(
      envContext.run({}, async () => {
        await revalidate({ paths: ['/'] });
      }),
    ).resolves.toBeUndefined();
  });

  it('no-ops when ISR_CACHE is bound but the deployment id is missing', async () => {
    const { store, kv, delete: kvDelete } = createKvMock();
    store.set(isrKey(DPL, HOST, '/'), new ArrayBuffer(4));
    await envContext.run({ ISR_CACHE: kv }, async () => {
      await revalidate({ paths: ['/'] });
    });
    expect(store.has(isrKey(DPL, HOST, '/'))).toBe(true);
    expect(kvDelete).not.toHaveBeenCalled();
  });
});
