import { describe, expect, it, vi } from 'vite-plus/test';
import { createIsrStore } from '../../src/isr-store.ts';

describe('managed ISR storage', () => {
  it('reads the authoritative R2 body and metadata without consulting stale KV', async () => {
    const value = new TextEncoder().encode('fresh HTML').buffer;
    const metadata = { s: 200, c: 1_000, t: 600, p: 3 } as const;
    const get = vi.fn(async () => ({
      arrayBuffer: async () => value,
      customMetadata: { isr: JSON.stringify(metadata) },
    }));
    const legacyGet = vi.fn();
    const store = createIsrStore(
      { get } as unknown as R2Bucket,
      { getWithMetadata: legacyGet } as unknown as KVNamespace,
    );
    expect(await store.getWithMetadata('project/isr/v3/deploy/host/path')).toEqual({
      value,
      metadata,
    });
    expect(get).toHaveBeenCalledWith('isr-cache/project/isr/v3/deploy/host/path');
    get.mockResolvedValueOnce(null!);
    expect(await store.getWithMetadata('project/isr/v3/deploy/host/path')).toEqual({
      value: null,
      metadata: null,
    });
    expect(legacyGet).not.toHaveBeenCalled();
  });

  it('writes only R2 and removes both R2 and the legacy KV entry', async () => {
    const put = vi.fn(async () => ({}));
    const remove = vi.fn(async () => {});
    const legacyPut = vi.fn();
    const legacyDelete = vi.fn(async () => {});
    const store = createIsrStore(
      { put, delete: remove } as unknown as R2Bucket,
      { put: legacyPut, delete: legacyDelete } as unknown as KVNamespace,
    );
    const body = new ArrayBuffer(4);
    const metadata = { s: 200, c: 1_000, t: 600, p: 3 } as const;
    await store.put('key', body, { metadata });
    expect(put).toHaveBeenCalledWith('isr-cache/key', body, {
      customMetadata: { isr: JSON.stringify(metadata) },
    });
    expect(legacyPut).not.toHaveBeenCalled();
    await store.delete('key');
    expect(remove).toHaveBeenCalledWith('isr-cache/key');
    expect(legacyDelete).toHaveBeenCalledWith('key');
  });

  it('propagates authoritative R2 deletion failures before attempting legacy cleanup', async () => {
    const failure = new Error('R2 unavailable');
    const remove = vi.fn().mockRejectedValue(failure);
    const legacyDelete = vi.fn();
    const store = createIsrStore(
      { delete: remove } as unknown as R2Bucket,
      { delete: legacyDelete } as unknown as KVNamespace,
    );

    await expect(store.delete('key')).rejects.toBe(failure);
    expect(legacyDelete).not.toHaveBeenCalled();
  });

  it('visits empty nonfinal R2 pages before all legacy KV pages', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ objects: [], truncated: true, cursor: 'next-r2' })
      .mockResolvedValueOnce({
        objects: [{ key: 'isr-cache/p/isr/v3/d/h/new' }],
        truncated: false,
      });
    const legacyList = vi
      .fn()
      .mockResolvedValueOnce({
        keys: [{ name: 'p/isr/v3/d/h/old' }],
        list_complete: false,
        cursor: 'next-kv',
      })
      .mockResolvedValueOnce({ keys: [{ name: 'p/isr/v3/d/h/last' }], list_complete: true });
    const store = createIsrStore(
      { list } as unknown as R2Bucket,
      { list: legacyList } as unknown as KVNamespace,
    );
    const keys: Array<string> = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ prefix: 'p/isr/', cursor, limit: 2 });
      keys.push(...page.keys.map(({ name }) => name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    expect(keys).toEqual(['p/isr/v3/d/h/new', 'p/isr/v3/d/h/old', 'p/isr/v3/d/h/last']);
    expect(list.mock.calls).toEqual([
      [{ prefix: 'isr-cache/p/isr/', cursor: undefined, limit: 2 }],
      [{ prefix: 'isr-cache/p/isr/', cursor: 'next-r2', limit: 2 }],
    ]);
    expect(legacyList.mock.calls).toEqual([
      [{ prefix: 'p/isr/', cursor: undefined, limit: 2 }],
      [{ prefix: 'p/isr/', cursor: 'next-kv', limit: 2 }],
    ]);
  });

  it('finishes the R2-only list without adding a legacy scan', async () => {
    const list = vi.fn(async () => ({ objects: [], truncated: false }));
    expect(await createIsrStore({ list } as unknown as R2Bucket).list({ prefix: 'p/' })).toEqual({
      keys: [],
      list_complete: true,
      cursor: undefined,
    });
  });
});
