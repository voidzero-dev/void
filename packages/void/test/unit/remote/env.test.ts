import { describe, it, expect, vi } from 'vite-plus/test';
import { ProxyD1Database } from '../../../src/runtime/remote/d1.ts';
import { createRemoteEnv } from '../../../src/runtime/remote/index.ts';
import { ProxyKVNamespace } from '../../../src/runtime/remote/kv.ts';
import { ProxyR2Bucket } from '../../../src/runtime/remote/r2.ts';

const BASE_ENV: Record<string, unknown> = {
  __VOID_PROXY_URL: 'https://proxy.void.cloud',
  __VOID_TOKEN: 'test-token',
  __VOID_PROJECT_ID: 'proj_1',
  __VOID_REMOTE: '1',
};

describe('createRemoteEnv', () => {
  it('does not add bindings that are not in env', () => {
    const env = createRemoteEnv({ ...BASE_ENV });
    expect(env.DB).toBeUndefined();
    expect(env.KV).toBeUndefined();
    expect(env.STORAGE).toBeUndefined();
  });

  it('preserves other env properties', () => {
    const env = createRemoteEnv({ ...BASE_ENV, DB: {}, CUSTOM_VAR: 'hello' });
    expect(env.CUSTOM_VAR).toBe('hello');
    expect(env.__VOID_PROXY_URL).toBe('https://proxy.void.cloud');
  });

  it('replaces all bindings when all are present', async () => {
    const env = createRemoteEnv({
      ...BASE_ENV,
      DB: {},
      KV: {},
      STORAGE: {},
    });
    expect(env.DB).toBeInstanceOf(ProxyD1Database);
    expect(env.KV).toBeInstanceOf(ProxyKVNamespace);
    expect(env.STORAGE).toBeInstanceOf(ProxyR2Bucket);

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => Response.json({ results: [], success: true, meta: {} }));
    globalThis.fetch = fetchMock;
    try {
      await (env.DB as D1Database).prepare('SELECT 1').all();
    } finally {
      globalThis.fetch = originalFetch;
    }
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proxy.void.cloud/d1/query');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(JSON.parse(String(init.body)).projectId).toBe('proj_1');
  });

  it('replaces custom binding names when configured', () => {
    const env = createRemoteEnv(
      {
        ...BASE_ENV,
        myapp_db: {},
        myapp_kv: {},
        myapp_storage: {},
      },
      { d1: 'myapp_db', kv: 'myapp_kv', r2: 'myapp_storage' },
    );

    expect(env.myapp_db).toBeInstanceOf(ProxyD1Database);
    expect(env.myapp_kv).toBeInstanceOf(ProxyKVNamespace);
    expect(env.myapp_storage).toBeInstanceOf(ProxyR2Bucket);
    expect(env.DB).toBeUndefined();
    expect(env.KV).toBeUndefined();
    expect(env.STORAGE).toBeUndefined();
  });
});
