import type { RenderOptions, Renderer, Token } from 'markdown-exit';
import type MarkdownExit from 'markdown-exit';

const EXTERNAL_URL_RE = /^[a-z]+:/i;

const EXTERNAL_ATTRS = {
  target: '_blank',
  rel: 'noreferrer',
};

/**
 * Adds target="_blank" and rel="noreferrer" to external links.
 * Normalizes internal .md links to route paths.
 * Ported from VitePress.
 */
export function linkPlugin(md: MarkdownExit): void {
  md.renderer.rules.link_open = (
    tokens: Array<Token>,
    idx: number,
    mdOptions: RenderOptions,
    _env: unknown,
    self: Renderer,
  ) => {
    const token = tokens[idx];
    const hrefIndex = token.attrIndex('href');
    if (hrefIndex < 0) {
      return self.renderToken(tokens, idx, mdOptions);
    }

    const url = token.attrs?.[hrefIndex]?.[1] ?? '';

    // Skip anchor-only links and header-anchor links
    if (url.startsWith('#') || token.attrGet('class') === 'header-anchor') {
      return self.renderToken(tokens, idx, mdOptions);
    }

    if (EXTERNAL_URL_RE.test(url)) {
      // External link — add target/rel attributes
      for (const [key, val] of Object.entries(EXTERNAL_ATTRS)) {
        token.attrSet(key, val);
      }
    } else {
      // Internal link — normalize .md extension
      let normalized = url;
      if (normalized.endsWith('.md')) {
        normalized = normalized.slice(0, -3);
      } else if (normalized.includes('.md#')) {
        normalized = normalized.replace('.md#', '#');
      }
      if (normalized !== url) {
        token.attrs![hrefIndex][1] = normalized;
      }
    }

    return self.renderToken(tokens, idx, mdOptions);
  };
}
