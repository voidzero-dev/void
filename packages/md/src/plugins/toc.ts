import type { RuleBlock, StateBlock, Token } from 'markdown-exit';
import type MarkdownExit from 'markdown-exit';
import type { Heading } from '../compile.ts';
import { extractHeadings } from '../metadata.ts';

const TOC_RE = /^\[\[toc\]\]$/i;
const TOC_LEVELS = new Set([2, 3]);

function renderHeaders(headers: ReadonlyArray<Heading>): string {
  if (headers.length === 0) {
    return '';
  }

  let result = '<ul>';
  for (const h of headers) {
    result += `<li><a href="#${h.slug}">${h.text}</a></li>`;
  }
  result += '</ul>';
  return result;
}

/**
 * [[toc]] directive — renders inline table of contents.
 * Ported from VitePress.
 */
export function tocPlugin(md: MarkdownExit): void {
  md.block.ruler.before(
    'heading',
    'toc',
    ((state: StateBlock, startLine: number, _endLine: number, silent: boolean) => {
      const pos = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      const content = state.src.slice(pos, max).trim();

      if (!TOC_RE.test(content)) {
        return false;
      }
      if (silent) {
        return true;
      }

      state.line = startLine + 1;
      const openToken = state.push('toc_open', 'nav', 1);
      openToken.markup = content;
      openToken.attrSet('class', 'table-of-contents');

      const bodyToken = state.push('toc_body', '', 0);
      bodyToken.markup = content;

      const closeToken = state.push('toc_close', 'nav', -1);
      closeToken.markup = content;

      return true;
    }) satisfies RuleBlock,
    { alt: ['paragraph', 'reference', 'blockquote'] },
  );

  md.renderer.rules.toc_body = (tokens: Array<Token>) => {
    const headers = extractHeadings(tokens).filter((heading) => TOC_LEVELS.has(heading.depth));
    return renderHeaders(headers);
  };
}
