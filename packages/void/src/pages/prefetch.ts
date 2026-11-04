const LINK_PREFETCH_STRATEGIES = ['hover', 'click', 'mount', 'visible'] as const;

export type LinkPrefetchStrategy = (typeof LINK_PREFETCH_STRATEGIES)[number];

/** A Link's `prefetch` prop, and the `prefetch.defaultStrategy` of an adapter plugin. */
export type LinkPrefetchValue =
  | boolean
  | LinkPrefetchStrategy
  | ReadonlyArray<LinkPrefetchStrategy>;

export type CacheForResult = {
  stale: number;
  expires: number;
};

export type CacheForInput = number | string | [string, string];

function isLinkPrefetchStrategy(value: unknown): value is LinkPrefetchStrategy {
  return (LINK_PREFETCH_STRATEGIES as ReadonlyArray<unknown>).includes(value);
}

/** Rejects an invalid `prefetch.defaultStrategy` when the plugin is configured. */
export function assertLinkPrefetchValue(
  value: unknown,
  name: string,
): asserts value is LinkPrefetchValue {
  if (typeof value === 'boolean') {
    return;
  }
  const strategies = Array.isArray(value) ? value : [value];
  for (const strategy of strategies) {
    if (!isLinkPrefetchStrategy(strategy)) {
      const allowed = LINK_PREFETCH_STRATEGIES.map((s) => `'${s}'`).join(', ');
      throw new Error(
        `${name}: Invalid prefetch strategy ${JSON.stringify(strategy)}. ` +
          `Use true, false, ${allowed}, or an array of strategies.`,
      );
    }
  }
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function parseUnit(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) {
    throw new Error(
      `prefetch: Invalid cacheFor value '${value}'. Use a number with ms, s, m, h, or d.`,
    );
  }
  return Number(match[1]) * UNITS[match[2]];
}

export function parseCacheFor(value: CacheForInput): CacheForResult {
  if (typeof value === 'number') {
    return { stale: value, expires: value };
  }
  if (Array.isArray(value)) {
    return { stale: parseUnit(value[0]), expires: parseUnit(value[1]) };
  }
  const ms = parseUnit(value);
  return { stale: ms, expires: ms };
}

export type CacheEntry = {
  url: string;
  method: string;
  response: Promise<unknown>;
  staleAt: number;
  expiresAt: number;
  singleUse: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export class PrefetchCache {
  private readonly entries = new Map<string, CacheEntry>();

  private key(url: string, method = 'GET'): string {
    return `${method}:${url}`;
  }

  has(url: string, method = 'GET'): boolean {
    return this.get(url, method) !== null;
  }

  get(url: string, method = 'GET'): CacheEntry | null {
    const entry = this.entries.get(this.key(url, method));
    if (!entry) {
      return null;
    }
    if (Date.now() >= entry.expiresAt && !entry.singleUse) {
      this.entries.delete(this.key(url, method));
      return null;
    }
    return entry;
  }

  isFresh(entry: CacheEntry): boolean {
    return Date.now() < entry.staleAt;
  }

  isUsable(entry: CacheEntry): boolean {
    return Date.now() < entry.expiresAt || entry.singleUse;
  }

  set(url: string, method: string, response: Promise<unknown>, ttl: CacheForResult): void {
    const k = this.key(url, method);
    // Don't overwrite existing entry that is still usable
    const existing = this.entries.get(k);
    if (existing && this.isUsable(existing)) {
      return;
    }

    const now = Date.now();
    const singleUse = ttl.stale === 0 && ttl.expires === 0;
    const entry: CacheEntry = {
      url,
      method,
      response,
      staleAt: now + ttl.stale,
      expiresAt: now + ttl.expires,
      singleUse,
      timer: null,
    };

    if (!singleUse && ttl.expires > 0) {
      entry.timer = setTimeout(() => this.entries.delete(k), ttl.expires);
    }

    this.entries.set(k, entry);
  }

  /** Mark entry as consumed — removes it if singleUse. */
  consume(url: string, method = 'GET'): void {
    const entry = this.entries.get(this.key(url, method));
    if (entry?.singleUse) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      this.entries.delete(this.key(url, method));
    }
  }

  flush(url: string, method = 'GET'): void {
    const k = this.key(url, method);
    const entry = this.entries.get(k);
    if (entry?.timer) {
      clearTimeout(entry.timer);
    }
    this.entries.delete(k);
  }

  flushAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
    }
    this.entries.clear();
  }
}
