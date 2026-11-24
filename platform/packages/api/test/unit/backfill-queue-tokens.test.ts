import { describe, it, expect, vi } from 'vite-plus/test';
import { backfillQueueTokens } from '../../src/admin/backfill-queue-tokens.ts';
import { hmacSignState } from '../../src/auth/hmac.ts';
import type { ProxyTokenLookup } from '../../src/provisioning/cloudflare-api.ts';

function createMockKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string, type?: 'json' | 'text') => {
      const raw = store.get(key);
      if (raw === null || raw === undefined) {
        return null;
      }
      if (type === 'json') {
        return JSON.parse(raw);
      }
      return raw;
    }),
    put: vi.fn(async (key: string, value: string | ArrayBuffer) => {
      store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value));
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) => {
      const all = Array.from(store.keys())
        .filter((k) => !prefix || k.startsWith(prefix))
        .sort();
      const start = cursor ? all.indexOf(cursor) + 1 : 0;
      const page = all.slice(start, start + 2);
      const last = all.indexOf(page.at(-1) ?? '');
      const hasMore = last >= 0 && last < all.length - 1;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: !hasMore,
        ...(hasMore ? { cursor: page.at(-1) } : {}),
      };
    }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

const JWT_SECRET = 'test-jwt-secret';
const ACCOUNT = 'acc_test';
const TOKEN = 'token_test';
const NAMESPACE = 'void-users';

type FetchTokenOptions = {
  fetchToken?: (workerName: string) => Promise<ProxyTokenLookup>;
};

function makeOpts(overrides: FetchTokenOptions = {}) {
  return {
    accountId: ACCOUNT,
    apiToken: TOKEN,
    dispatchNamespace: NAMESPACE,
    jwtSecret: JWT_SECRET,
    fetchToken:
      overrides.fetchToken ??
      (async (workerName: string): Promise<ProxyTokenLookup> => ({
        kind: 'found',
        token: `baked-token-for-${workerName}`,
      })),
  };
}

describe('backfillQueueTokens', () => {
  it('stamps the token fetched from the worker bindings, not a re-derived one', async () => {
    const kv = createMockKV({
      'queue:proj-a-emails': JSON.stringify({
        workerName: 'user-a-dpl_1',
        projectId: 'proj_a',
        queueName: 'emails',
      }),
    });

    const result = await backfillQueueTokens(kv, makeOpts());

    expect(result).toEqual({ scanned: 1, updated: 1, skipped: 0, raced: 0, errored: 0 });
    const patched = JSON.parse(kv.store.get('queue:proj-a-emails')!);
    expect(patched.proxyToken).toBe('baked-token-for-user-a-dpl_1');
  });

  it('falls back to hmacSignState re-derivation when the worker has no baked token', async () => {
    const kv = createMockKV({
      'queue:proj-legacy-emails': JSON.stringify({
        workerName: 'user-legacy',
        projectId: 'proj_legacy',
        queueName: 'emails',
      }),
    });

    const result = await backfillQueueTokens(
      kv,
      makeOpts({ fetchToken: async () => ({ kind: 'missing' }) }),
    );

    expect(result).toEqual({ scanned: 1, updated: 1, skipped: 0, raced: 0, errored: 0 });
    const expected = await hmacSignState('proj_legacy', JWT_SECRET);
    const patched = JSON.parse(kv.store.get('queue:proj-legacy-emails')!);
    expect(patched.proxyToken).toBe(expected);
  });

  it('skips entries that already have a proxyToken', async () => {
    const kv = createMockKV({
      'queue:proj-a-emails': JSON.stringify({
        workerName: 'user-a',
        projectId: 'proj_a',
        queueName: 'emails',
        proxyToken: 'already-set',
      }),
    });

    const result = await backfillQueueTokens(kv, makeOpts());

    expect(result).toEqual({ scanned: 1, updated: 0, skipped: 1, raced: 0, errored: 0 });
    const patched = JSON.parse(kv.store.get('queue:proj-a-emails')!);
    expect(patched.proxyToken).toBe('already-set');
  });

  it('counts entries as `errored` and does not overwrite when the CF binding read fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const original = JSON.stringify({
        workerName: 'user-rate-limited',
        projectId: 'proj_rl',
        queueName: 'emails',
      });
      const kv = createMockKV({ 'queue:proj-rl-emails': original });

      const result = await backfillQueueTokens(
        kv,
        makeOpts({
          fetchToken: async () => ({
            kind: 'error',
            error: new Error('CF 429 rate limit'),
          }),
        }),
      );

      expect(result).toEqual({ scanned: 1, updated: 0, skipped: 0, raced: 0, errored: 1 });
      // Value must be untouched — writing a re-derived token on a transient
      // CF failure would permanently mask the incident as a successful migration.
      expect(kv.store.get('queue:proj-rl-emails')).toBe(original);
      expect(errSpy).toHaveBeenCalled();
      const logged = errSpy.mock.calls
        .flat()
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      expect(logged).toMatch(/CF 429 rate limit/);
      expect(logged).toMatch(/user-rate-limited/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('paginates across multiple KV list pages', async () => {
    const kv = createMockKV({
      'queue:proj-a-q1': JSON.stringify({
        workerName: 'user-a',
        projectId: 'proj_a',
        queueName: 'q1',
      }),
      'queue:proj-a-q2': JSON.stringify({
        workerName: 'user-a',
        projectId: 'proj_a',
        queueName: 'q2',
      }),
      'queue:proj-b-q1': JSON.stringify({
        workerName: 'user-b',
        projectId: 'proj_b',
        queueName: 'q1',
      }),
    });

    const result = await backfillQueueTokens(kv, makeOpts());

    expect(result).toEqual({ scanned: 3, updated: 3, skipped: 0, raced: 0, errored: 0 });
    expect(kv.list).toHaveBeenCalledTimes(2);
  });

  it('does not touch non-queue: keys', async () => {
    const kv = createMockKV({
      'queue:proj-a-q1': JSON.stringify({
        workerName: 'user-a',
        projectId: 'proj_a',
        queueName: 'q1',
      }),
      'proj-a': JSON.stringify({ workerName: 'a' }),
      'domain:example.com': JSON.stringify({ workerName: 'a' }),
    });

    const result = await backfillQueueTokens(kv, makeOpts());

    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(1);
    expect(JSON.parse(kv.store.get('proj-a')!)).toEqual({ workerName: 'a' });
    expect(JSON.parse(kv.store.get('domain:example.com')!)).toEqual({ workerName: 'a' });
  });

  it('skips entries with missing workerName (cannot resolve token)', async () => {
    const kv = createMockKV({
      'queue:bogus': JSON.stringify({ projectId: 'proj_x', queueName: 'emails' }),
    });

    const result = await backfillQueueTokens(kv, makeOpts());

    expect(result).toEqual({ scanned: 1, updated: 0, skipped: 1, raced: 0, errored: 0 });
    expect(JSON.parse(kv.store.get('queue:bogus')!)).toEqual({
      projectId: 'proj_x',
      queueName: 'emails',
    });
  });

  it('detects concurrent writes and skips the put to avoid clobbering', async () => {
    const kv = createMockKV({
      'queue:proj-a-emails': JSON.stringify({
        workerName: 'user-a-dpl_1',
        projectId: 'proj_a',
        queueName: 'emails',
      }),
    });

    // Simulate a concurrent deploy that writes a new entry between our
    // initial read and our final put. The backfill must re-read before
    // writing and skip if the snapshot no longer matches.
    let getCalls = 0;
    const originalGet = kv.get.bind(kv) as (
      key: string,
      type?: 'json' | 'text',
    ) => Promise<string | null>;
    kv.get = vi.fn(async (key: string, type?: 'json' | 'text') => {
      getCalls++;
      if (getCalls === 2 && key === 'queue:proj-a-emails') {
        // Second read (our re-check right before put) sees a mutated value.
        kv.store.set(
          key,
          JSON.stringify({
            workerName: 'user-a-dpl_2',
            projectId: 'proj_a',
            queueName: 'emails',
            proxyToken: 'written-by-concurrent-deploy',
          }),
        );
      }
      return originalGet(key, type);
    }) as unknown as KVNamespace['get'];

    const result = await backfillQueueTokens(kv, makeOpts());

    expect(result).toEqual({ scanned: 1, updated: 0, skipped: 0, raced: 1, errored: 0 });
    // The concurrent writer's value must survive — backfill must not overwrite.
    const patched = JSON.parse(kv.store.get('queue:proj-a-emails')!);
    expect(patched.workerName).toBe('user-a-dpl_2');
    expect(patched.proxyToken).toBe('written-by-concurrent-deploy');
  });
});
