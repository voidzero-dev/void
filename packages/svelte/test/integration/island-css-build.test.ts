import { afterAll, expect, it } from 'vite-plus/test';
import { buildFixture, type BuiltFixture } from '../../../../test/fixture-app.ts';
import { islands, mixed } from '../../../../test/fixtures/svelte.ts';
import { countOf, defineIslandCssBuildTest } from '../../../../test/island-css-build.ts';

let built: BuiltFixture | undefined;
afterAll(() => built?.cleanup());

defineIslandCssBuildTest({
  build: () => (built ??= buildFixture(islands)),
  expectedCss: ['.shell{outline-offset:7px}', '{text-indent:9px}', '{word-spacing:5px}'],
  check({ file, html, css }) {
    // The style block's rule carries the scope class that the server markup has.
    const start = html.indexOf('<main class="');
    expect(start, file).toBeGreaterThan(-1);
    const classes = html.slice(start + '<main class="'.length, html.indexOf('"', start + 13));
    const scope = classes.split(' ').find((name) => name.startsWith('svelte-'));
    expect(css, file).toContain(`main.${scope}{outline-width:9px}`);
  },
});

it('links component styles once when a regular page also uses the layout', () => {
  const build = buildFixture(mixed);
  try {
    for (const file of ['index.html', 'about.html', 'regular.html']) {
      const { css } = build.page(file);
      expect(countOf(css, '{outline-width:9px}'), file).toBe(1);
    }
  } finally {
    build.cleanup();
  }
}, 120_000);
