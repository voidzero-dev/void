import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { createKV, type KVClient } from '../../src/runtime/kv/index.ts';

function createMockKVNamespace() {
  const ns = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  };
  return ns as unknown as KVNamespace & typeof ns;
}

describe('createKV', () => {
  it.each([
    '123',
    'null',
    'true',
    'false',
    '9007199254740993',
    '{"value":1}',
    '[1,2]',
    '"quoted"',
    '',
    'plain text',
  ])('round-trips string %j through clients, maps, and metadata reads', async (value) => {
    const store = new Map<string, { value: string; metadata: unknown }>();
    const namespace = {
      async get(key: string) {
        return store.get(key)?.value ?? null;
      },
      async getWithMetadata(key: string) {
        return store.get(key) ?? { value: null, metadata: null };
      },
      async put(key: string, stored: string, options?: KVNamespacePutOptions) {
        store.set(key, { value: stored, metadata: options?.metadata ?? null });
      },
    } as unknown as KVNamespace;
    const client = createKV(namespace);
    for (const kv of [client, client.map<string>('strings')]) {
      await kv.put('key', value, { metadata: { source: 'test' } });
      expect(await kv.get('key')).toBe(value);
      expect(await kv.getWithMetadata('key')).toEqual({ value, metadata: { source: 'test' } });
    }
  });

  let mockNS: ReturnType<typeof createMockKVNamespace>;
  let kv: KVClient;

  beforeEach(() => {
    mockNS = createMockKVNamespace();
    kv = createKV(mockNS as unknown as KVNamespace);
  });

  describe('get', () => {
    it('returns parsed JSON value', async () => {
      mockNS.get.mockResolvedValue(JSON.stringify({ name: 'Alice' }));
      const result = await kv.get<{ name: string }>('user:1');
      expect(mockNS.get).toHaveBeenCalledWith('user:1');
      expect(result).toEqual({ name: 'Alice' });
    });

    it('returns null for missing key', async () => {
      mockNS.get.mockResolvedValue(null);
      const result = await kv.get('missing');
      expect(result).toBeNull();
    });

    it('returns raw string for non-JSON value', async () => {
      mockNS.get.mockResolvedValue('plain text');
      const result = await kv.get('key');
      expect(result).toBe('plain text');
    });
  });

  describe('put', () => {
    it('stores JSON-stringified objects', async () => {
      await kv.put('user:1', { name: 'Alice' });
      expect(mockNS.put).toHaveBeenCalledWith('user:1', '{"name":"Alice"}', {});
    });

    it('passes ttl option as expirationTtl', async () => {
      await kv.put('key', 'val', { ttl: 3600 });
      expect(mockNS.put).toHaveBeenCalledWith('key', '"val"', { expirationTtl: 3600 });
    });

    it('passes expiration option', async () => {
      await kv.put('key', 'val', { expiration: 1_700_000_000 });
      expect(mockNS.put).toHaveBeenCalledWith('key', '"val"', { expiration: 1_700_000_000 });
    });
  });

  describe('delete', () => {
    it('deletes a key', async () => {
      await kv.delete('user:1');
      expect(mockNS.delete).toHaveBeenCalledWith('user:1');
    });
  });

  describe('list', () => {
    it('returns keys list', async () => {
      mockNS.list.mockResolvedValue({
        keys: [{ name: 'user:1' }, { name: 'user:2' }],
        list_complete: true,
      });
      const result = await kv.list({ prefix: 'user:' });
      expect(mockNS.list).toHaveBeenCalledWith({
        prefix: 'user:',
        limit: undefined,
        cursor: undefined,
      });
      expect(result.keys).toEqual([{ name: 'user:1' }, { name: 'user:2' }]);
      expect(result.list_complete).toBe(true);
    });

    it('passes limit and cursor', async () => {
      mockNS.list.mockResolvedValue({ keys: [], list_complete: false, cursor: 'abc' });
      const result = await kv.list({ limit: 10, cursor: 'xyz' });
      expect(mockNS.list).toHaveBeenCalledWith({
        prefix: undefined,
        limit: 10,
        cursor: 'xyz',
      });
      expect(result.list_complete).toBe(false);
      expect(result.cursor).toBe('abc');
    });
  });

  describe('getWithMetadata', () => {
    it('returns parsed value and metadata', async () => {
      mockNS.getWithMetadata.mockResolvedValue({
        value: JSON.stringify({ name: 'Alice' }),
        metadata: { role: 'admin' },
      });
      const result = await kv.getWithMetadata<{ name: string }, { role: string }>('user:1');
      expect(result.value).toEqual({ name: 'Alice' });
      expect(result.metadata).toEqual({ role: 'admin' });
    });

    it('returns null value and null metadata for missing key', async () => {
      mockNS.getWithMetadata.mockResolvedValue({ value: null, metadata: null });
      const result = await kv.getWithMetadata('missing');
      expect(result.value).toBeNull();
      expect(result.metadata).toBeNull();
    });
  });

  describe('map', () => {
    it('prefixes keys on get', async () => {
      mockNS.get.mockResolvedValue(JSON.stringify({ token: 'abc' }));
      const sessions = kv.map<{ token: string }>('sessions');
      const result = await sessions.get('xyz');
      expect(mockNS.get).toHaveBeenCalledWith('sessions:xyz');
      expect(result).toEqual({ token: 'abc' });
    });

    it('prefixes keys on put', async () => {
      const sessions = kv.map<{ token: string }>('sessions');
      await sessions.put('xyz', { token: 'abc' }, { ttl: 3600 });
      expect(mockNS.put).toHaveBeenCalledWith('sessions:xyz', '{"token":"abc"}', {
        expirationTtl: 3600,
      });
    });

    it('prefixes keys on delete', async () => {
      const sessions = kv.map('sessions');
      await sessions.delete('xyz');
      expect(mockNS.delete).toHaveBeenCalledWith('sessions:xyz');
    });

    it('lists with prefix and strips prefix from key names', async () => {
      mockNS.list.mockResolvedValue({
        keys: [{ name: 'sessions:abc' }, { name: 'sessions:def' }],
        list_complete: true,
      });
      const sessions = kv.map('sessions');
      const result = await sessions.list();
      expect(mockNS.list).toHaveBeenCalledWith({
        prefix: 'sessions:',
        limit: undefined,
        cursor: undefined,
      });
      expect(result.keys).toEqual([{ name: 'abc' }, { name: 'def' }]);
      expect(result.list_complete).toBe(true);
    });

    it('getWithMetadata with prefix', async () => {
      mockNS.getWithMetadata.mockResolvedValue({
        value: JSON.stringify({ token: 'abc' }),
        metadata: { ip: '1.2.3.4' },
      });
      const sessions = kv.map<{ token: string }>('sessions');
      const result = await sessions.getWithMetadata<{ ip: string }>('xyz');
      expect(mockNS.getWithMetadata).toHaveBeenCalledWith('sessions:xyz');
      expect(result.value).toEqual({ token: 'abc' });
      expect(result.metadata).toEqual({ ip: '1.2.3.4' });
    });
  });
});
