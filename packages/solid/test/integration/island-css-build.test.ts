import { afterAll } from 'vite-plus/test';
import { buildFixture, type BuiltFixture } from '../../../../test/fixture-app.ts';
import { islands } from '../../../../test/fixtures/solid.ts';
import { defineIslandCssBuildTest } from '../../../../test/island-css-build.ts';
import { definePrivatePagesBuildTest } from '../../../../test/private-pages-build.ts';

let shared: BuiltFixture | undefined;
const buildIslands = () => (shared ??= buildFixture(islands));
afterAll(() => shared?.cleanup());

defineIslandCssBuildTest({
  build: buildIslands,
  expectedCss: ['.shell{outline-offset:7px}', '{text-indent:9px}', '.badge{word-spacing:5px}'],
});
definePrivatePagesBuildTest({ build: buildIslands });
