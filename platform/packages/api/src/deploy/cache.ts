import { isrCachePrefix } from '@void/isr';
import { R2_CONCURRENCY, uploadPool } from '../concurrency.ts';
import { legacyIsrCachePrefix } from '../isr-legacy-keys.ts';
import type { IsrStore } from '../isr-store.ts';

export async function clearIsrCache(
  cache: Pick<IsrStore, 'list' | 'delete'>,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  // `deploymentId` is required so a bare call cannot fall through to the
  // project-wide prefix and wipe every deployment's ISR namespace.
  //
  // Sweep BOTH the current v3 (host-scoped) namespace AND the legacy v2
  // (hostless) namespace. A deployment created before the v3 rollout can still
  // hold orphaned v2 ISR entries, and ISR KV puts set no `expirationTtl`; once
  // this deployment id is evicted (retention / failed-deploy cleanup), no later
  // active-route revalidation ever names it again, so `clearIsrCache` is the
  // last path that can reap them. Mirrors the legacy-aware purge in
  // `revalidate-core.ts`. The two prefixes are disjoint (`…/isr/v3/…` vs
  // `…/isr/v2/…`), so nothing is listed or deleted twice. Transition-only:
  // drop the v2 sweep once no v2 entries remain in production.
  await deleteIsrKeysByPrefix(cache, isrCachePrefix(projectId, deploymentId));
  await deleteIsrKeysByPrefix(cache, legacyIsrCachePrefix(projectId, deploymentId));
}

async function deleteIsrKeysByPrefix(
  cache: Pick<IsrStore, 'list' | 'delete'>,
  prefix: string,
): Promise<void> {
  let cursor: string | undefined;

  do {
    const listed = await cache.list({ prefix, cursor });
    if (listed.keys.length > 0) {
      await uploadPool(listed.keys, R2_CONCURRENCY, (key) => cache.delete(key.name));
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

// --- ISR prerender helpers ---

/**
 * Pack response headers + body into a single ArrayBuffer.
 * Format: [4 bytes uint32 LE header length][UTF-8 header JSON][raw body]
 */
export function packIsrValue(headers: Record<string, string>, body: ArrayBuffer): ArrayBuffer {
  const headerJson = new TextEncoder().encode(JSON.stringify(headers));
  const buffer = new ArrayBuffer(4 + headerJson.byteLength + body.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.byteLength, true);
  new Uint8Array(buffer, 4, headerJson.byteLength).set(headerJson);
  new Uint8Array(buffer, 4 + headerJson.byteLength).set(new Uint8Array(body));
  return buffer;
}

/**
 * Extract response headers as a plain object, skipping ISR-managed headers.
 */
export function serializePrerenderHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  const skip = new Set(['cache-control', 'x-isr-cache', 'x-void-page-data', 'set-cookie']);

  response.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) {
      result[key] = value;
    }
  });

  return result;
}
