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

function extractLang(info: string): string {
  return (
    /^[a-zA-Z0-9-_]+/
      .exec(info)?.[0]
      .replace(/-vue$/, '')
      .replace(/^vue-html$/, 'template')
      .replace(/^ansi$/, '') || ''
  );
}

/**
 * Copies the code next to a clicked copy button, without removed diff lines
 * and without the empty last line that Shiki adds.
 * Markdown pages are island pages and always load as full documents, so this
 * classic inline script runs once per page load and adds one delegated
 * listener. The body must not contain `<`, so neither island tag matching nor
 * the HTML parser sees a tag in it.
 */
export const CODE_COPY_SCRIPT: string =
  '<script>window.__voidMdCopy||(window.__voidMdCopy=1,document.addEventListener("click",e=>{' +
  'const b=e.target instanceof Element&&e.target.closest("div[class*=\'language-\']>button.copy"),' +
  'p=b&&b.parentElement.querySelector("pre");' +
  'if(!p||!navigator.clipboard)return;' +
  'const t=Array.from(p.querySelectorAll(".line:not(.diff.remove)"),l=>l.textContent);' +
  't[t.length-1]===""&&t.pop();' +
  'navigator.clipboard.writeText(t.join("\\n")).then(()=>{b.classList.add("copied");' +
  'setTimeout(()=>b.classList.remove("copied"),2e3)},()=>{})}))</script>';

/**
 * Wraps fenced code blocks with a language label and copy button.
 * Sets `env.codeCopy` so the page gets {@link CODE_COPY_SCRIPT}.
 * `copyLabel` sets the copy button's title (default `Copy Code`).
 * Ported from VitePress.
 */
export function preWrapperPlugin(md: MarkdownExit, options?: { copyLabel?: string }): void {
  const copyLabel = md.utils.escapeHtml(options?.copyLabel ?? 'Copy Code');
  const fence = md.renderer.rules.fence as FenceRender;
  md.renderer.rules.fence = async (...args: Parameters<FenceRender>) => {
    const [tokens, idx, , env] = args;
    env.codeCopy = true;
    const token = tokens[idx];
    // Strip title bracket notation before rendering
    token.info = token.info.replace(/\[.*\]/, '');
    // Handle active class for code-group
    const active = / active( |$)/.test(token.info) ? ' active' : '';
    token.info = token.info.replace(/ active$/, '').replace(/ active /, ' ');
    const lang = extractLang(token.info);
    const highlighted = await fence(...args);
    return (
      `<div class="language-${lang}${active}">` +
      `<button title="${copyLabel}" class="copy"></button>` +
      `<span class="lang">${lang}</span>` +
      highlighted +
      `</div>`
    );
  };
}
