import { describe, expect, it, vi } from 'vite-plus/test';
import { FontDataCache } from '../../src/font-data-cache.ts';

describe('downloaded font data cache', () => {
  it('shares an in-flight download and retains its bytes', async () => {
    const cache = new FontDataCache();
    const bytes = new ArrayBuffer(4);
    let finish!: (data: ArrayBuffer) => void;
    const download = vi.fn(() => new Promise<ArrayBuffer>((resolve) => (finish = resolve)));
    const first = cache.load('font', download);
    const second = cache.load('font', download);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(download).toHaveBeenCalledOnce();
    finish(bytes);
    expect(await first).toBe(bytes);
    expect(await second).toBe(bytes);
    expect(await cache.load('font', download)).toBe(bytes);
    expect(download).toHaveBeenCalledOnce();
  });

  it.each(['reject', 'throw'] as const)(
    'retries after a download fails with %s',
    async (failure) => {
      const cache = new FontDataCache();
      const error = new Error('download failed');
      const bytes = new ArrayBuffer(4);
      const download = vi
        .fn<() => Promise<ArrayBuffer>>()
        .mockImplementationOnce(() => {
          if (failure === 'throw') {
            throw error;
          }
          return Promise.reject(error);
        })
        .mockResolvedValue(bytes);
      const first = cache.load('font', download);
      const second = cache.load('font', download);
      expect(second).toBe(first);
      await expect(first).rejects.toBe(error);
      await expect(second).rejects.toBe(error);
      expect(await cache.load('font', download)).toBe(bytes);
      expect(download).toHaveBeenCalledTimes(2);
    },
  );

  it('evicts the least recently used entry at the entry limit', async () => {
    const cache = new FontDataCache({ maxBytes: 100, maxEntries: 2 });
    const a = vi.fn(async () => new ArrayBuffer(1));
    const b = vi.fn(async () => new ArrayBuffer(1));
    const c = vi.fn(async () => new ArrayBuffer(1));
    await cache.load('a', a);
    await cache.load('b', b);
    await cache.load('a', a);
    await cache.load('c', c);
    await cache.load('a', a);
    expect(a).toHaveBeenCalledOnce();
    await cache.load('b', b);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('evicts enough entries to stay within the byte limit', async () => {
    const cache = new FontDataCache({ maxBytes: 6, maxEntries: 10 });
    const a = vi.fn(async () => new ArrayBuffer(2));
    const b = vi.fn(async () => new ArrayBuffer(2));
    const c = vi.fn(async () => new ArrayBuffer(5));
    await cache.load('a', a);
    await cache.load('b', b);
    const bytes = await cache.load('c', c);
    expect(await cache.load('c', c)).toBe(bytes);
    expect(c).toHaveBeenCalledOnce();
    await cache.load('a', a);
    await cache.load('b', b);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('shares oversized downloads without retaining them or evicting warm entries', async () => {
    const cache = new FontDataCache({ maxBytes: 4, maxEntries: 2 });
    const warm = vi.fn(async () => new ArrayBuffer(4));
    const large = vi.fn(async () => new ArrayBuffer(5));
    await cache.load('warm', warm);
    const first = cache.load('large', large);
    const second = cache.load('large', large);
    expect(second).toBe(first);
    expect(await first).toBe(await second);
    await cache.load('warm', warm);
    expect(warm).toHaveBeenCalledOnce();
    await cache.load('large', large);
    expect(large).toHaveBeenCalledTimes(2);
  });

  it('applies the byte limit to downloads finishing concurrently', async () => {
    const cache = new FontDataCache({ maxBytes: 4, maxEntries: 10 });
    const a = vi.fn(async () => new ArrayBuffer(3));
    const b = vi.fn(async () => new ArrayBuffer(3));
    await Promise.all([cache.load('a', a), cache.load('b', b)]);
    await cache.load('b', b);
    expect(b).toHaveBeenCalledOnce();
    await cache.load('a', a);
    expect(a).toHaveBeenCalledTimes(2);
  });
});
