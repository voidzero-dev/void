import { afterAll, expect, it } from 'vite-plus/test';
import { buildFixture, type BuiltFixture } from '../../../../test/fixture-app.ts';
import { bare, islands } from '../../../../test/fixtures/react.ts';
import { defineIslandCssBuildTest } from '../../../../test/island-css-build.ts';
import { definePrivatePagesBuildTest } from '../../../../test/private-pages-build.ts';

let shared: BuiltFixture | undefined;
const buildIslands = () => (shared ??= buildFixture(islands));
afterAll(() => shared?.cleanup());

defineIslandCssBuildTest({
  build: buildIslands,
  expectedCss: ['.shell{outline-offset:7px}', '{text-indent:9px}', '.badge{word-spacing:5px}'],
  checkBuild(build) {
    // Badge hydrates, so this build also covers the client/server entry boundary.
    expect(build.page('badge.html').html).toContain('<script');
    for (const [file, text] of build.output('ssr')) {
      expect(file).not.toContain('islands-client');
      expect(text.includes('hydrateRoot'), file).toBe(false);
    }
  },
});

it('builds island pages without CSS or JavaScript with no stylesheet, script or client runtime', () => {
  const build = buildFixture(bare);
  try {
    for (const file of ['index.html', 'about.html']) {
      const { html } = build.page(file);
      expect(html, file).toContain('</main>');
      expect(html, file).not.toContain('<link');
      expect(html, file).not.toContain('<script');
    }
    // No page loads the islands entry, so it carries no hydration code.
    for (const [file, text] of build.output('client')) {
      expect(text.includes('hydrateRoot'), file).toBe(false);
    }
  } finally {
    build.cleanup();
  }
}, 120_000);

definePrivatePagesBuildTest({ build: buildIslands });
