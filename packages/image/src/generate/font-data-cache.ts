const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 128;

/** Downloaded bytes only; renderer registrations have a separate lifetime and budget. */
export class FontDataCache {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, ArrayBuffer>();
  private readonly pending = new Map<string, Promise<ArrayBuffer>>();
  private bytes = 0;

  constructor({
    maxBytes = MAX_BYTES,
    maxEntries = MAX_ENTRIES,
  }: { maxBytes?: number; maxEntries?: number } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
  }

  load(key: string, download: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
    const held = this.entries.get(key);
    if (held) {
      this.entries.delete(key);
      this.entries.set(key, held);
      return Promise.resolve(held);
    }
    const pending = this.pending.get(key);
    if (pending) {
      return pending;
    }
    const loading = Promise.resolve()
      .then(download)
      .then((data) => {
        // Large fonts may still serve the current images without displacing
        // the entire warm cache or remaining in it after those images finish.
        if (data.byteLength <= this.maxBytes && this.maxEntries > 0) {
          this.entries.set(key, data);
          this.bytes += data.byteLength;
          while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value!;
            this.bytes -= this.entries.get(oldest)!.byteLength;
            this.entries.delete(oldest);
          }
        }
        return data;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, loading);
    return loading;
  }
}

// Like Takumi's font CSS cache, keep different fetch implementations separate.
const caches = new WeakMap<typeof fetch, FontDataCache>();

export function cachedFontData(
  key: string,
  download: () => Promise<ArrayBuffer>,
): Promise<ArrayBuffer> {
  const fetch = globalThis.fetch;
  let cache = caches.get(fetch);
  if (!cache) {
    cache = new FontDataCache();
    caches.set(fetch, cache);
  }
  return cache.load(key, download);
}
