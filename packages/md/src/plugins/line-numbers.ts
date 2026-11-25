import type MarkdownExit from 'markdown-exit';
import type { RenderOptions, Renderer, Token } from 'markdown-exit';

type MarkdownEnv = { [key: string]: unknown };
type FenceRender = (
  tokens: ReadonlyArray<Token>,
  idx: number,
  options: RenderOptions,
  env: MarkdownEnv,
  self: Renderer,
) => string | Promise<string>;

/**
 * Adds a line number gutter to code blocks that opt in with `:line-numbers`.
 * `{=N}` sets the start line.
 * Ported from VitePress.
 */
export function lineNumberPlugin(md: MarkdownExit): void {
  const fence = md.renderer.rules.fence as FenceRender;
  md.renderer.rules.fence = async (...args: Parameters<FenceRender>) => {
    const rawCode = await fence(...args);
    const [tokens, idx] = args;
    const info = tokens[idx].info;

    if (!/:line-numbers\b/.test(info)) {
      return rawCode;
    }

    let startLineNumber = 1;
    const matchStart = info.match(/=(\d+)/);
    if (matchStart?.[1]) {
      startLineNumber = Number.parseInt(matchStart[1]);
    }

    const code = rawCode.slice(rawCode.indexOf('<code>'), rawCode.indexOf('</code>'));
    const lines = code.split('\n');
    const lineNumbersCode = [...Array<undefined>(lines.length)]
      .map(
        (_, lineOffset) => `<span class="line-number">${lineOffset + startLineNumber}</span><br>`,
      )
      .join('');
    const lineNumbersWrapper = `<div class="line-numbers-wrapper" aria-hidden="true">${lineNumbersCode}</div>`;

    return rawCode
      .replace(/<\/div>$/, `${lineNumbersWrapper}</div>`)
      .replace(/"(language-[^"]*?)"/, '"$1 line-numbers-mode"');
  };
}
