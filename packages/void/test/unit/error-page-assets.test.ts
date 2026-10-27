import { describe, expect, it } from 'vite-plus/test';
import { inlineErrorPageAssets } from '../../src/runtime/error-pages/inline.ts';

const template = `<!doctype html>
<html><head>
<!-- inject:css -->
<!-- Do not add code here. At runtime, the file referenced by the tag below is inlined, replacing this entire block (including this comment). The tag is kept so you can preview this HTML file by opening it directly in a browser. -->
<link
  href = './style.css'
  rel = 'stylesheet'
>
<!-- endinject -->
<!-- inject:js -->
<!-- Do not add code here. At runtime, the file referenced by the tag below is inlined, replacing this entire block (including this comment). The tag is kept so you can preview this HTML file by opening it directly in a browser. -->
<script
  src = './script.js'
>
</script>
<!-- endinject -->
</head><body><h1>404</h1></body></html>`;

describe('error page assets', () => {
  it('inlines formatted asset blocks, removes preview comments and preserves page markup', () => {
    const css = 'body::before { content: "$&"; }';
    const js = 'console.log("$` $& $1");';
    const html = inlineErrorPageAssets(template, css, js);
    expect(html).toContain(`<style>\n${css}</style>`);
    expect(html).toContain(`<script>\n${js}</script>`);
    expect(html).toContain('<h1>404</h1>');
    expect(html).not.toContain('including this comment');
    expect(html).not.toMatch(/<link\b|<script[^>]+src\s*=/);
  });

  it('rejects missing and duplicate asset markers', () => {
    for (const name of ['css', 'js']) {
      const marker = `<!-- inject:${name} -->`;
      expect(() => inlineErrorPageAssets(template.replace(marker, ''), '', '')).toThrow(
        `${name} block`,
      );
      expect(() => inlineErrorPageAssets(template + marker, '', '')).toThrow(`${name} block`);
    }
  });

  it('rejects missing or extra closing markers', () => {
    const marker = '<!-- endinject -->';
    expect(() => inlineErrorPageAssets(template.replace(marker, ''), '', '')).toThrow('endinject');
    expect(() => inlineErrorPageAssets(template + marker, '', '')).toThrow('endinject');
  });
});
