import { isrEdgeCacheUrlForToken, splitIsrCacheKey } from '@void/isr';
import {
  denormalizeIsrPath,
  isrKey,
  isrPrefix,
  isrVariantPrefix,
  listIsrHosts,
} from '@void/isr/runtime';
import type { RouteUrl } from 'void/routes';
import { getRawRuntimeEnv } from './env-raw.ts';

export type RevalidateOptions = {
  /** Paths to purge. Checked against the app's routes when `routing.typedRoutes` is on. */
  paths?: Array<RouteUrl>;
  all?: boolean;
};

/**
 * Revalidate ISR-cached pages on demand.
 *
 * On managed Void, calls the platform proxy via service binding which forwards
 * to the API for R2 deletion + edge cache purge. On self-host, purges this
 * worker's own ISR_CACHE (KV) entries plus the caches.default edge variants.
 * When neither is configured (e.g. local dev with no ISR), this is a no-op.
 *
 * @example
 * ```ts
 * import { revalidate } from "void/isr";
 *
 * // Revalidate specific paths
 * await revalidate({ paths: ["/", "/blog/hello"] });
 *
 * // Revalidate all ISR pages
 * await revalidate({ all: true });
 * ```
 */
export async function revalidate(options: RevalidateOptions): Promise<void> {
  const rawEnv = getRawRuntimeEnv();
  const proxy = rawEnv.__VOID_PROXY as Fetcher | undefined;
  if (!proxy) {
    const kv = rawEnv.ISR_CACHE as KVNamespace | undefined;
    const id = rawEnv.__VOID_ISR_DEPLOYMENT_ID as string | undefined;
    if (!kv || !id) {
      return;
    }
    const requestHost = rawEnv.__VOID_ISR_HOST as string | undefined;
    const purgeKey = async (
      host: string,
      path: string,
      key: string,
      variantToken: string | null,
    ): Promise<void> => {
      await kv.delete(key);
      try {
        // The DOM lib that the pages client modules reference declares
        // CacheStorage without `.default`, shadowing the Workers type here.
        const cache = (caches as unknown as { default: Cache }).default;
        await cache.delete(isrEdgeCacheUrlForToken(host, path, id, 'html', variantToken));
        await cache.delete(isrEdgeCacheUrlForToken(host, path, id, 'json', variantToken));
      } catch {
        // Best effort: a degraded Cache API must not fail the KV purge.
      }
    };
    const purgePath = async (host: string, path: string): Promise<void> => {
      await purgeKey(host, path, isrKey(id, host, path), null);
      let cursor: string | undefined;
      do {
        const list = await kv.list({ prefix: isrVariantPrefix(id, host, path), cursor });
        for (const key of list.keys) {
          const { variantToken } = splitIsrCacheKey(key.name);
          await purgeKey(host, path, key.name, variantToken);
        }
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
    };
    if (options.all) {
      // Scan KV keys instead of the host registry so hosts that were never
      // registered are purged too.
      const prefix = isrPrefix(id);
      let cursor: string | undefined;
      do {
        const list = await kv.list({ prefix, cursor });
        for (const key of list.keys) {
          const tail = key.name.slice(prefix.length);
          const slash = tail.indexOf('/');
          if (slash < 0) {
            continue;
          }
          const host = tail.slice(0, slash);
          const { normalizedPath, variantToken } = splitIsrCacheKey(tail.slice(slash + 1));
          const path = denormalizeIsrPath(normalizedPath);
          await purgeKey(host, path, key.name, variantToken);
        }
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
    } else {
      const paths = options.paths ?? [];
      if (paths.length === 0) {
        return;
      }
      // No request host is guaranteed here (cron / queue handlers stamp the id
      // without a host), so enumerate every registered host, union the request
      // host when present. An empty host set is a silent no-op.
      const hosts = new Set(await listIsrHosts(kv, id));
      if (requestHost) {
        hosts.add(requestHost);
      }
      for (const host of hosts) {
        for (const path of paths) {
          await purgePath(host, path);
        }
      }
    }
    return;
  }

  const projectId = rawEnv.__PROJECT_ID as string | undefined;
  const token = rawEnv.__VOID_PROXY_TOKEN as string | undefined;

  if (!projectId || !token) {
    throw new Error('isr: Revalidation requires __PROJECT_ID and __VOID_PROXY_TOKEN bindings.');
  }

  const response = await proxy.fetch('https://proxy/revalidate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, aiToken: token, ...options }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`isr: Revalidation failed with ${response.status}: '${text}'.`);
  }
}
