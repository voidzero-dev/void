import { describe, expect, it } from 'vite-plus/test';
import { createCodeHighlighter } from '../../.vitepress/highlight.ts';

const highlight = createCodeHighlighter();

function renderedLines(code: string, lang: string) {
  const html = highlight(code, lang, '');
  const body = html.slice(html.indexOf('<code>') + '<code>'.length, html.indexOf('</code>'));
  return body.split('\n').map((line) => ({
    classes: /^<span class="([^"]*)"/.exec(line)?.[1],
    text: line
      .replaceAll(/<[^>]+>/g, '')
      .replaceAll('&#x3C;', '<')
      .replaceAll('&#x26;', '&'),
  }));
}

describe.each(['jsx', 'tsx'])('docs %s annotation comments', (lang) => {
  it('removes standalone expression braces before counting highlighted lines', () => {
    expect(
      renderedLines(
        '<div>\n  { /* [!code highlight:2] */ }\n  <A />\n  <B />\n  <C />\n</div>',
        lang,
      ),
    ).toEqual([
      { classes: 'line', text: '<div>' },
      { classes: 'line highlighted', text: '  <A />' },
      { classes: 'line highlighted', text: '  <B />' },
      { classes: 'line', text: '  <C />' },
      { classes: 'line', text: '</div>' },
    ]);
  });

  it('removes inline annotation braces while preserving surrounding JSX', () => {
    expect(renderedLines('<div><New /> {/* [!code ++] */}</div>', lang)).toEqual([
      { classes: 'line diff add', text: '<div><New /> </div>' },
    ]);
  });

  it('keeps comment expressions with explanatory text', () => {
    expect(renderedLines('<div>{/* keep this [!code focus] */}</div>', lang)).toEqual([
      { classes: 'line has-focus', text: '<div>{/* keep this */}</div>' },
    ]);
  });

  it('keeps function body braces around annotation comments', () => {
    expect(renderedLines('function f() {/* [!code focus] */}', lang)).toEqual([
      { classes: 'line has-focus', text: 'function f() {}' },
    ]);
  });

  it('keeps annotation text in string literals', () => {
    expect(renderedLines('const text = "{/* [!code highlight] */}";', lang)).toEqual([
      { classes: 'line', text: 'const text = "{/* [!code highlight] */}";' },
    ]);
  });
});
