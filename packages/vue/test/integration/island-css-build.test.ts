import { afterAll, expect } from 'vite-plus/test';
import { buildFixture, type BuiltFixture } from '../../../../test/fixture-app.ts';
import { islands } from '../../../../test/fixtures/vue.ts';
import { defineIslandCssBuildTest } from '../../../../test/island-css-build.ts';

let built: BuiltFixture | undefined;
afterAll(() => built?.cleanup());

defineIslandCssBuildTest({
  build: () => (built ??= buildFixture(islands)),
  expectedCss: [
    '.shell{outline-offset:7px}',
    'main{outline-width:9px}',
    '{text-indent:9px}',
    '.badge{word-spacing:5px}',
  ],
  check({ file, html, css }) {
    // The scoped rule carries the attribute that the server markup has.
    const start = html.indexOf('data-v-');
    expect(start, file).toBeGreaterThan(-1);
    const scope = html.slice(start, html.indexOf('>', start)).split(' ')[0];
    expect(css, file).toContain(`.note[${scope}]{outline-width:11px}`);
  },
});
