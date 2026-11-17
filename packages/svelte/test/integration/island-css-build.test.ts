import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import {
  buildIslandApp,
  countOf,
  defineIslandCssBuildTest,
} from '../../../../test/island-css-build.ts';

const packageDir = join(import.meta.dirname, '../..');
const files = {
  'src/shell.css': '.shell { outline-offset: 7px; }',
  'src/card.module.css': '.card { text-indent: 9px; }',
  'src/Badge.svelte': '<b class="badge">Badge</b>\n<style>.badge { word-spacing: 5px; }</style>',
  'src/Shell.svelte': `<script>
  import './shell.css';
  import styles from './card.module.css';
  import Badge from './Badge.svelte';
  let { children } = $props();
</script>
<main class="shell {styles.card}"><Badge />{@render children()}</main>
<style>main { outline-width: 9px; }</style>`,
  'pages/layout.svelte': `<script>
  import Shell from '../src/Shell.svelte';
  let { children } = $props();
</script>
<Shell>{@render children()}</Shell>`,
  'pages/index.island.svelte': '<h1>Home</h1>',
  // The layout renders Badge without hydrating it; this page hydrates it.
  'pages/badge.island.svelte': `<script>
  import Badge from '../src/Badge.svelte' with { island: 'load' };
</script>
<Badge />`,
};

defineIslandCssBuildTest({
  packageDir,
  pluginName: 'voidSvelte',
  files,
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
  const build = buildIslandApp({
    packageDir,
    pluginName: 'voidSvelte',
    files: { ...files, 'pages/regular.svelte': '<h1>Regular</h1>' },
  });
  try {
    for (const file of ['index.html', 'about.html', 'regular.html']) {
      const { css } = build.page(file);
      expect(countOf(css, '{outline-width:9px}'), file).toBe(1);
    }
  } finally {
    build.cleanup();
  }
}, 120_000);
