import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { ProxyClient } from '../../../src/runtime/remote/client.ts';
import { ProxyKVNamespace } from '../../../src/runtime/remote/kv.ts';

function createClient() {
  return new ProxyClient('https://proxy.void.cloud', 'jwt-token', 'proj_1');
}

function mockFetch(response: unknown, contentType = 'application/json') {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(response), {
        headers: { 'content-type': contentType },
      }),
  );
  globalThis.fetch = fetchMock;
  return fetchMock;
}

describe('ProxyKVNamespace', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('get()', () => {
    it('returns string by default', async () => {
      mockFetch('hello world');

      const kv = new ProxyKVNamespace(createClient(), 'KV');
      const value = await kv.get('my-key');

      expect(value).toBe('hello world');

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.key).toBe('my-key');
      expect(body.type).toBe('text');
      expect(body.binding).toBe('KV');
      expect(call[0]).toBe('https://proxy.void.cloud/kv/get');
    });

    it('returns parsed JSON with type=json', async () => {
      mockFetch({ name: 'Alice', age: 30 });

      const kv = new ProxyKVNamespace(createClient(), 'KV');
      const value = await kv.get('user:1', 'json');

      expect(value).toEqual({ name: 'Alice', age: 30 });
    });

    it('returns ArrayBuffer with type=arrayBuffer', async () => {
      // For arrayBuffer type, the proxy returns binary data
      const binaryData = new Uint8Array([1, 2, 3, 4]);
      const fetchMock = vi.fn(
        async () =>
          new Response(binaryData, {
            headers: { 'content-type': 'application/octet-stream' },
          }),
      );
      globalThis.fetch = fetchMock;

      const kv = new ProxyKVNamespace(createClient(), 'KV');
      const value = await kv.get('binary-key', 'arrayBuffer');

      expect(value).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(value as ArrayBuffer)).toEqual(binaryData);
    });

    it('returns null for missing key', async () => {
      mockFetch(null);

      const kv = new ProxyKVNamespace(createClient(), 'KV');
      const value = await kv.get('missing');

      expect(value).toBeNull();
    });

    it('accepts options object with type field', async () => {
      mockFetch({ data: true });

      const kv = new ProxyKVNamespace(createClient(), 'KV');
      await kv.get('key', { type: 'json' });

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.type).toBe('json');
    });
  });

  describe('getWithMetadata()', () => {
    it('returns value and null metadata', async () => {
      mockFetch('hello');

      const kv = new ProxyKVNamespace(createClient(), 'KV');
      const result = await kv.getWithMetadata('key');

      expect(result.value).toBe('hello');
      expect(result.metadata).toBeNull();
      expect(result.cacheStatus).toBeNull();
    });
  });

  describe('put()', () => {
    it('sends value to proxy', async () => {
      mockFetch({ success: true });

      const kv = new ProxyKVNamespace(createClient(), 'KV');
      await kv.put('my-key', 'my-value');

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.key).toBe('my-key');
      expect(body.value).toBe('my-value');
      expect(body.binding).toBe('KV');
      expect(call[0]).toBe('https://proxy.void.cloud/kv/put');
    });

    it('sends expiration options', async () => {
      mockFetch({ success: true });

      const kv = new ProxyKVNamespace(createClient(), 'KV');
      await kv.put('key', 'val', { expiration: 1_700_000_000, expirationTtl: 3600 });

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.expiration).toBe(1_700_000_000);
      expect(body.expiration_ttl).toBe(3600);
    });
  });

  describe('delete()', () => {
    it('sends delete request', async () => {
      mockFetch({ success: true });

      const kv = new ProxyKVNamespace(createClient(), 'KV');
      await kv.delete('my-key');

      const call = (
        globalThis.fetch as typeof globalThis.fetch & {
          mock: { calls: Array<Array<unknown>> };
        }
      ).mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(call[1].body);
      expect(body.key).toBe('my-key');
      expect(body.binding).toBe('KV');
      expect(call[0]).toContain('/kv/delete');
    });
  });

  describe('list()', () => {
    it('returns keys and pagination info', async () => {
      mockFetch({
        keys: [{ name: 'key1' }, { name: 'key2' }],
        list_complete: false,
        cursor: 'next-cursor',
      });

      const kv = new ProxyKVNamespace(createClient(), 'KV');
      const result = await kv.list({ prefix: 'user:', limit: 2 });

      expect(result.keys).toEqual([{ name: 'key1' }, { name: 'key2' }]);
      expect(result.list_complete).toBe(false);
      expect((result as typeof result & { cursor: string | null }).cursor).toBe('next-cursor');

      const call = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(call[1].body));
      expect(body.prefix).toBe('user:');
      expect(body.limit).toBe(2);
      expect(call[0]).toBe('https://proxy.void.cloud/kv/list');
    });

    it('returns complete list when no cursor', async () => {
      mockFetch({
        keys: [{ name: 'key1' }],
        list_complete: true,
        cursor: null,
      });

      const kv = new ProxyKVNamespace(createClient(), 'KV');
      const result = await kv.list();

      expect(result.list_complete).toBe(true);
    });
  });
});
