import { expect, vi } from 'vite-plus/test';
import { aiLoggingKey, type PublishedAiLoggingMode } from '../../src/ai-logging-policy.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import type { TestEnv } from './helpers.ts';

const PREFIX = 'ai-logging:';

/** Deletes every AI logging key and cleared marker. */
export async function clearAiLoggingKeys(kv: KVNamespace): Promise<void> {
  for (const prefix of [PREFIX, 'ai-logging-cleared:']) {
    // Deleting while listing shifts later pages, so list the first page until empty.
    for (let page = await kv.list({ prefix }); page.keys.length; page = await kv.list({ prefix })) {
      for (const { name } of page.keys) {
        await kv.delete(name);
      }
    }
  }
}

/** Calls `before(key)` ahead of each `method` call; throw from it to fail that call. */
export function beforeKvWrite(
  kv: KVNamespace,
  method: 'put' | 'delete',
  before: (key: string) => void,
) {
  const original = kv[method].bind(kv) as (...args: Array<unknown>) => unknown;
  return vi.spyOn(kv, method).mockImplementation((async (key: string, ...rest: Array<unknown>) => {
    before(key);
    return original(key, ...rest);
  }) as never);
}

/** Fails writes to AI logging keys only; other keys keep working. */
export function failAiLoggingWrites(
  kv: KVNamespace,
  method: 'put' | 'delete',
  error = new Error('KV unavailable'),
) {
  return beforeKvWrite(kv, method, (key) => {
    if (key.startsWith(PREFIX)) {
      throw error;
    }
  });
}

/** Returns a function that lists the AI logging keys written or deleted since this call. */
export function recordAiLoggingWrites(kv: KVNamespace): () => Array<string> {
  const put = vi.spyOn(kv, 'put');
  const remove = vi.spyOn(kv, 'delete');
  return () =>
    [...put.mock.calls, ...remove.mock.calls]
      .map(([key]) => key)
      .filter((key) => key.startsWith(PREFIX));
}

/** Writes a key the way the platform publishes it. */
export function putAiLoggingKey(
  kv: KVNamespace,
  projectId: string,
  mode: PublishedAiLoggingMode,
  at = 1,
): Promise<void> {
  return kv.put(aiLoggingKey(projectId), mode, { metadata: { mode, at } });
}

/**
 * Hosted Hyperdrive may answer a plain SELECT from a copy up to a minute old, so
 * AI logging inputs must be read through write statements. Returns each statement's verb.
 */
export function expectNoCacheableReads(queries: ReadonlyArray<string>): Array<string> {
  const verbs = queries.map((query) => query.trim().split(' ')[0]!.toLowerCase());
  expect(verbs).not.toContain('select');
  return verbs;
}

/** Calls the operator API: GET without a body, POST with one. */
export function operatorFetch(
  env: TestEnv,
  token: string,
  path: string,
  body?: Record<string, unknown>,
  overrides?: Partial<ApiEnv['Bindings']>,
): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`http://localhost/operator/v1${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      { ...env, ...overrides },
    ),
  );
}
