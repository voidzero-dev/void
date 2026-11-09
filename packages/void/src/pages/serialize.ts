import { stringify, unflatten } from 'devalue';
import { escapeScriptJson } from './script-json.ts';

/**
 * Serialize Pages data without losing supported JavaScript values. The envelope
 * keeps deferred metadata visible to existing ISR caches, which must not cache
 * an initial payload whose deferred groups still need to stream.
 */
export function serializePageData(pageObj: unknown): string {
  const { deferred, deferredKeys } = (pageObj ?? {}) as {
    deferred?: unknown;
    deferredKeys?: unknown;
  };
  const pending = deferred !== undefined || deferredKeys !== undefined;
  return escapeScriptJson(
    `{"__void":"devalue","data":${stringify(pageObj)}${pending ? ',"deferred":true' : ''}}`,
  );
}

/** Decode a parsed Pages payload, also accepting cached pre-devalue JSON. */
export function decodePageData<T = unknown>(value: unknown): T {
  if (
    value &&
    typeof value === 'object' &&
    '__void' in value &&
    value.__void === 'devalue' &&
    'data' in value
  ) {
    return unflatten(value.data as Array<unknown> | number) as T;
  }
  return value as T;
}

export function deserializePageData<T = unknown>(text: string): T {
  return decodePageData<T>(JSON.parse(text));
}

/** Element id of the Markdown page frontmatter that islands read when they hydrate. */
export const ISLAND_FRONTMATTER_ID = '__void_frontmatter';

/**
 * Script tag that carries a Markdown page's frontmatter to its islands, so
 * `useFrontmatter()` returns the same value in the browser as on the server.
 * Empty when the page has no frontmatter.
 */
export function islandFrontmatterScript(frontmatter: Record<string, unknown> | undefined): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return '';
  }
  return `<script type="application/json" id="${ISLAND_FRONTMATTER_ID}">${serializePageData(frontmatter)}</script>`;
}
