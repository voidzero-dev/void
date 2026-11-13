import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';

const read = (name: string): string =>
  readFileSync(new URL(`../../src/theme/${name}`, import.meta.url), 'utf8');

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('theme direction', () => {
  it('places heading anchors with logical properties so right-to-left pages mirror them', () => {
    const anchor = rule(read('prose.css'), '.void-md .header-anchor');
    expect(anchor).toContain('float: inline-start;');
    expect(anchor).toContain('margin-inline-start: -0.87em;');
    expect(anchor).toContain('padding-inline-end: 0.23em;');
    expect(anchor).not.toMatch(/float: left|margin-left|padding-right/);
  });

  it('places the copy button at the end of the line in either direction', () => {
    const copy = rule(read('code.css'), ".void-md div[class*='language-'] .copy");
    expect(copy).toContain('inset-inline-end: 0.5em;');
    expect(copy).not.toMatch(/\bright:/);
  });
});
