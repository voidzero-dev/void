import { escapeScriptJson } from './script-json.ts';

/**
 * Escape JSON for embedding inside an inline `<script type="application/json">`
 * tag. Replaces `<`, `>`, `&`, U+2028, U+2029 with their `\uXXXX` JSON escape
 * sequences so the script tag cannot be closed early and the payload survives
 * `JSON.parse` on hydration.
 */
export function serializePageData(pageObj: unknown): string {
  return escapeScriptJson(JSON.stringify(pageObj));
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
