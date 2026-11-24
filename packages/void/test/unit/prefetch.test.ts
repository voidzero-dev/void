import { describe, expect, it } from 'vite-plus/test';
import { parseCacheFor, PrefetchCache } from '../../src/pages/prefetch.ts';

describe('parseCacheFor', () => {
  it('passes numbers through as milliseconds', () => {
    expect(parseCacheFor(5000)).toEqual({ stale: 5000, expires: 5000 });
  });

  it('passes 0 through as zero', () => {
    expect(parseCacheFor(0)).toEqual({ stale: 0, expires: 0 });
  });

  it('parses ms suffix', () => {
    expect(parseCacheFor('500ms')).toEqual({ stale: 500, expires: 500 });
  });

  it('parses s suffix', () => {
    expect(parseCacheFor('30s')).toEqual({ stale: 30_000, expires: 30_000 });
  });

  it('parses m suffix', () => {
    expect(parseCacheFor('2m')).toEqual({ stale: 120_000, expires: 120_000 });
  });

  it('parses h suffix', () => {
    expect(parseCacheFor('1h')).toEqual({ stale: 3_600_000, expires: 3_600_000 });
  });

  it('parses d suffix', () => {
    expect(parseCacheFor('1d')).toEqual({ stale: 86_400_000, expires: 86_400_000 });
  });

  it('parses SWR tuple [stale, expires]', () => {
    expect(parseCacheFor(['30s', '1m'])).toEqual({ stale: 30_000, expires: 60_000 });
  });

  it('throws on invalid string', () => {
    expect(() => parseCacheFor('invalid')).toThrow('Invalid');
  });
});

describe('PrefetchCache', () => {
  it('get returns null for missing entry', () => {
    const cache = new PrefetchCache();
    expect(cache.get('http://example.com/api/users')).toBeNull();
  });

  it('set then get returns the entry', () => {
    const cache = new PrefetchCache();
    const response = Promise.resolve({ users: [] });
    cache.set('http://example.com/api/users', 'GET', response, { stale: 5000, expires: 10_000 });
    const entry = cache.get('http://example.com/api/users');
    expect(entry).not.toBeNull();
    expect(entry!.url).toBe('http://example.com/api/users');
    expect(entry!.method).toBe('GET');
    expect(entry!.response).toBe(response);
  });

  it('singleUse is true when stale=0 and expires=0', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', 'GET', Promise.resolve({}), {
      stale: 0,
      expires: 0,
    });
    const entry = cache.get('http://example.com/api/data');
    expect(entry).not.toBeNull();
    expect(entry!.singleUse).toBe(true);
  });

  it('consume removes singleUse entries', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', 'GET', Promise.resolve({}), {
      stale: 0,
      expires: 0,
    });
    expect(cache.get('http://example.com/api/data')).not.toBeNull();
    cache.consume('http://example.com/api/data');
    expect(cache.get('http://example.com/api/data')).toBeNull();
  });

  it('consume keeps non-singleUse entries', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', 'GET', Promise.resolve({}), {
      stale: 5000,
      expires: 10_000,
    });
    cache.consume('http://example.com/api/data');
    expect(cache.get('http://example.com/api/data')).not.toBeNull();
  });

  it('flush removes the specific entry', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/a', 'GET', Promise.resolve({}), {
      stale: 5000,
      expires: 10_000,
    });
    cache.set('http://example.com/api/b', 'GET', Promise.resolve({}), {
      stale: 5000,
      expires: 10_000,
    });
    cache.flush('http://example.com/api/a');
    expect(cache.get('http://example.com/api/a')).toBeNull();
    expect(cache.get('http://example.com/api/b')).not.toBeNull();
  });

  it('flushAll clears all entries', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/a', 'GET', Promise.resolve({}), {
      stale: 5000,
      expires: 10_000,
    });
    cache.set('http://example.com/api/b', 'GET', Promise.resolve({}), {
      stale: 5000,
      expires: 10_000,
    });
    cache.flushAll();
    expect(cache.get('http://example.com/api/a')).toBeNull();
    expect(cache.get('http://example.com/api/b')).toBeNull();
  });

  it('isFresh returns true when Date.now() < staleAt', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', 'GET', Promise.resolve({}), {
      stale: 10_000,
      expires: 20_000,
    });
    const entry = cache.get('http://example.com/api/data')!;
    expect(cache.isFresh(entry)).toBe(true);
  });

  it('isUsable returns true when Date.now() < expiresAt', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', 'GET', Promise.resolve({}), {
      stale: 5000,
      expires: 10_000,
    });
    const entry = cache.get('http://example.com/api/data')!;
    expect(cache.isUsable(entry)).toBe(true);
  });

  it('expired entries are not returned by get', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', 'GET', Promise.resolve({}), {
      stale: 10_000,
      expires: 10_000,
    });
    const entry = cache.get('http://example.com/api/data')!;
    (entry as { expiresAt: number }).expiresAt = Date.now() - 1;
    expect(cache.get('http://example.com/api/data')).toBeNull();
  });

  it('has returns true for existing entry and false for missing', () => {
    const cache = new PrefetchCache();
    cache.set('http://example.com/api/data', 'GET', Promise.resolve({}), {
      stale: 5000,
      expires: 10_000,
    });
    expect(cache.has('http://example.com/api/data')).toBe(true);
    expect(cache.has('http://example.com/api/other')).toBe(false);
  });

  it('duplicate set for the same key is a no-op while entry is usable', () => {
    const cache = new PrefetchCache();
    const first = Promise.resolve({ version: 1 });
    const second = Promise.resolve({ version: 2 });
    cache.set('http://example.com/api/data', 'GET', first, {
      stale: 5000,
      expires: 10_000,
    });
    cache.set('http://example.com/api/data', 'GET', second, {
      stale: 5000,
      expires: 10_000,
    });
    const entry = cache.get('http://example.com/api/data')!;
    expect(entry.response).toBe(first);
  });
});
