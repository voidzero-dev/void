import { isrCachePrefix } from '@void/isr';
import { describe, expect, it } from 'vite-plus/test';
import { legacyIsrCachePrefix } from '../../src/isr-legacy-keys.ts';
import { createIsrStore } from '../../src/isr-store.ts';
import { clearIsrCache } from '../../src/routes/deploy.ts';

// Minimal KV mock: `list({ prefix })` returns seeded keys whose name starts with
// the prefix; `delete(name)` records + removes. Enough to exercise clearIsrCache's
// list/delete loop over each namespace.
function makeKv(keys: Array<string>) {
  const store = new Set(keys);
  const deleted: Array<string> = [];
  const listedPrefixes: Array<string> = [];
  const kv = {
    list: async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
      if (!cursor) {
        listedPrefixes.push(prefix);
      }
      const matching = [...store].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys: matching, list_complete: true, cursor: undefined };
    },
    delete: async (name: string) => {
      store.delete(name);
      deleted.push(name);
    },
  } as unknown as KVNamespace;
  return { kv, deleted, listedPrefixes, store };
}

describe('clearIsrCache', () => {
  it('clears R2 and legacy KV for an evicted deployment while retaining its neighbor', async () => {
    const current = `${isrCachePrefix('p', 'old')}host/page`;
    const retained = `${isrCachePrefix('p', 'retained')}host/page`;
    const { kv, store: legacy } = makeKv([current, retained]);
    const objects = new Set([`isr-cache/${current}`, `isr-cache/${retained}`]);
    const bucket = {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      }),
      delete: async (key: string) => {
        objects.delete(key);
      },
    } as unknown as R2Bucket;
    await clearIsrCache(createIsrStore(bucket, kv), 'p', 'old');
    expect([...objects]).toEqual([`isr-cache/${retained}`]);
    expect([...legacy]).toEqual([retained]);
  });

  it('sweeps BOTH the v3 host-scoped and the legacy v2 hostless namespace for the deployment', async () => {
    const proj = 'proj1';
    const dep = 'dep1';
    const v3a = `${isrCachePrefix(proj, dep)}example.com/about`; // proj1/isr/v3/dep1/example.com/about
    const v3b = `${isrCachePrefix(proj, dep)}app.void.app/`;
    const v2a = `${legacyIsrCachePrefix(proj, dep)}about`; // proj1/isr/v2/dep1/about
    const v2b = `${legacyIsrCachePrefix(proj, dep)}blog/post`;
    // A different deployment's entries (both namespaces) must survive.
    const otherV3 = `${isrCachePrefix(proj, 'dep2')}example.com/x`;
    const otherV2 = `${legacyIsrCachePrefix(proj, 'dep2')}y`;

    const { kv, deleted, store } = makeKv([v3a, v3b, v2a, v2b, otherV3, otherV2]);
    await clearIsrCache(kv, proj, dep);

    // Both namespaces for dep1 are reaped: v2 keys have no expirationTtl and are
    // never re-scanned, so skipping the v2 sweep would leak them forever.
    expect([...deleted].sort()).toEqual([v3a, v3b, v2a, v2b].sort());
    expect(store.has(v2a)).toBe(false);
    expect(store.has(v2b)).toBe(false);
    // Another deployment's entries are untouched (deploymentId-scoped, disjoint).
    expect(store.has(otherV3)).toBe(true);
    expect(store.has(otherV2)).toBe(true);
  });

  it('lists both the v3 and the legacy v2 deployment prefixes', async () => {
    const { kv, listedPrefixes } = makeKv([]);
    await clearIsrCache(kv, 'p', 'd');
    expect(listedPrefixes).toContain(isrCachePrefix('p', 'd')); // p/isr/v3/d/
    expect(listedPrefixes).toContain(legacyIsrCachePrefix('p', 'd')); // p/isr/v2/d/
  });
});
