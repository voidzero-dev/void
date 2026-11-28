import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vite-plus/test';
import { defineIslandCssBuildTest } from '../../../../test/island-css-build.ts';

const packageDir = join(import.meta.dirname, '../..');
const vuePlugin = pathToFileURL(join(packageDir, 'dist/plugin.mjs')).href;
const markdownPlugin = pathToFileURL(join(packageDir, '../md/dist/plugin.mjs')).href;

defineIslandCssBuildTest({
  packageDir,
  pluginName: 'voidVue',
  files: {
    'vite.config.mjs': `import { voidPlugin } from 'void';
import { voidVue } from ${JSON.stringify(vuePlugin)};
import { voidMarkdown } from ${JSON.stringify(markdownPlugin)};
export default { plugins: [voidPlugin(), voidVue({ appSetup: './src/vue-app.ts' }), voidMarkdown()] };
`,
    'src/vue-app.ts': `import type { App } from 'vue';
import './setup.css';
export default function setup(app: App) {
  const state = { missing: false };
  app.provide('setup-state', state);
  return {
    dehydrate() {
      if (state.missing) throw new Error('Static 404 was dehydrated');
      return 'state from Vue setup';
    },
    hydrate(value: typeof state) { Object.assign(state, value); },
  };
}`,
    'pages/_not-found.vue': `<script setup>
import { inject } from 'vue';
const state = inject('setup-state');
if (state) state.missing = true;
</script>
<template><h1>{{ state ? 'Setup ran' : 'Setup missing' }}</h1></template>`,
    'src/setup.css': '.setup-probe { color: rgb(3, 45, 67); }',
    'src/shell.css': '.shell { outline-offset: 7px; }',
    'src/Badge.vue': `<template><b class="badge">Badge</b></template>
<style>.badge { word-spacing: 5px; }</style>`,
    'src/Shell.vue': `<script setup>
import './shell.css';
import Badge from './Badge.vue';
</script>
<template><main class="shell"><p class="note">Note</p><p :class="$style.card">Card</p><Badge /><slot /></main></template>
<style>main { outline-width: 9px; }</style>
<style scoped>.note { outline-width: 11px; }</style>
<style module>.card { text-indent: 9px; }</style>`,
    'pages/layout.vue': `<script setup>
import Shell from '../src/Shell.vue';
</script>
<template><Shell><slot /></Shell></template>`,
    'pages/index.island.vue': '<template><h1>Home</h1></template>',
    'pages/state.vue': '<template><h1>State</h1></template>',
    // The layout renders Badge without hydrating it; this page hydrates it.
    'pages/badge.island.vue': `<script setup>
import Badge from '../src/Badge.vue' with { island: 'load' };
</script>
<template><Badge /></template>`,
  },
  expectedCss: [
    '.setup-probe{color:#032d43}',
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
  checkBuild({ page, root }) {
    expect(page('404.html').html).toContain('<h1>Setup ran</h1>');
    expect(page('state.html').html).toMatch(/id="__VOID_APP_STATE__">[^<]*state from Vue setup/);
    const data = readFileSync(join(root, 'dist/client/_void/pages/state.json'), 'utf8');
    expect(data).not.toContain('state from Vue setup');
  },
});
