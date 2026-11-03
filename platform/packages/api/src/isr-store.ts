import type { IsrCacheMetadata } from '@void/isr';

const PREFIX = 'isr-cache/';

export function isrObjectPrefix(projectId: string): string {
  return `${PREFIX}${projectId}/`;
}

export interface IsrStore {
  getWithMetadata<Metadata = IsrCacheMetadata>(
    key: string,
    type?: 'arrayBuffer',
  ): Promise<{
    value: ArrayBuffer | null;
    metadata: Metadata | null;
  }>;
  put(key: string, value: ArrayBuffer, options: { metadata: IsrCacheMetadata }): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

/**
 * R2 is authoritative: an eventually consistent KV read after a purge can
 * otherwise repopulate the edge with deleted HTML for its entire original TTL.
 * Legacy KV participates only in purge/cleanup, never in serving or writing.
 */
export function createIsrStore(bucket: R2Bucket, legacy?: KVNamespace): IsrStore {
  return {
    async getWithMetadata(key) {
      const object = await bucket.get(PREFIX + key);
      if (!object) {
        return { value: null, metadata: null };
      }
      return {
        value: await object.arrayBuffer(),
        metadata: JSON.parse(object.customMetadata?.isr ?? 'null'),
      };
    },
    async put(key, value, { metadata }) {
      await bucket.put(PREFIX + key, value, {
        customMetadata: { isr: JSON.stringify(metadata) },
      });
    },
    async delete(key) {
      await bucket.delete(PREFIX + key);
      try {
        await legacy?.delete(key);
      } catch (error) {
        // Legacy bodies are never served; their cleanup must not block the edge purge.
        console.warn('[api] Legacy ISR KV cleanup failed.', error);
      }
    },
    async has(key) {
      return (await bucket.head(PREFIX + key)) !== null;
    },
    async list({ prefix, cursor, limit }) {
      if (legacy && cursor?.startsWith('kv:')) {
        const page = await legacy.list({ prefix, cursor: cursor.slice(3) || undefined, limit });
        return {
          keys: page.keys,
          list_complete: page.list_complete,
          cursor: page.list_complete ? undefined : `kv:${page.cursor}`,
        };
      }
      const page = await bucket.list({
        prefix: PREFIX + prefix,
        cursor: cursor?.slice(3),
        limit,
      });
      return {
        keys: page.objects.map(({ key }) => ({ name: key.slice(PREFIX.length) })),
        list_complete: !page.truncated && !legacy,
        cursor: page.truncated ? `r2:${page.cursor}` : legacy ? 'kv:' : undefined,
      };
    },
  };
}
