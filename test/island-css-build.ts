import { expect, it } from 'vite-plus/test';
import type { BuiltFixture } from './fixture-app.ts';

type IslandCssContract = {
  build: () => BuiltFixture;
  expectedCss: Array<string>;
  check?: (page: { file: string; html: string; css: string }) => void;
  checkBuild?: (build: BuiltFixture) => void;
};

export function countOf(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** The caller owns the immutable build's runtime copy and releases it after its contracts. */
export function defineIslandCssBuildTest(app: IslandCssContract): void {
  it('links the CSS that a layout component imports on island and Markdown pages', () => {
    const build = app.build();
    for (const file of ['index.html', 'about.html']) {
      const { html, css } = build.page(file);
      for (const rule of app.expectedCss) {
        expect(countOf(css, rule), `${file}: ${rule}`).toBe(1);
      }
      expect(html, file).not.toContain('<script');
      app.check?.({ file, html, css });
    }
    // Rolldown keeps each stylesheet module in one chunk, so no rule repeats.
    const clientCss = [...build.output('client')]
      .filter(([file]) => file.endsWith('.css'))
      .map(([, text]) => text)
      .join('\n');
    for (const rule of app.expectedCss) {
      expect(countOf(clientCss, rule), rule).toBe(1);
    }
    app.checkBuild?.(build);
  }, 120_000);
}
