const closing = '<!-- endinject -->';

function replaceAssetBlock(html: string, name: 'css' | 'js', content: string): string {
  const opening = `<!-- inject:${name} -->`;
  const start = html.indexOf(opening);
  const end = html.indexOf(closing, start + opening.length);
  if (start === -1 || end === -1 || html.lastIndexOf(opening) !== start) {
    throw new Error(`Expected one complete ${name} block in the default error page.`);
  }
  return html.slice(0, start) + content + html.slice(end + closing.length);
}

export function inlineErrorPageAssets(html: string, stylesheet: string, script: string): string {
  if (html.split(closing).length !== 3) {
    throw new Error('Expected two endinject markers in the default error page.');
  }
  for (const [name, content] of [
    ['css', `<style>\n${stylesheet}</style>`],
    ['js', `<script>\n${script}</script>`],
  ] as const) {
    html = replaceAssetBlock(html, name, content);
  }
  return html;
}
