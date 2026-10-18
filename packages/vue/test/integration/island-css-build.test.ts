import { join } from 'node:path';
import { expect } from 'vite-plus/test';
import { defineIslandCssBuildTest } from '../../../../test/island-css-build.ts';

defineIslandCssBuildTest({
  packageDir: join(import.meta.dirname, '../..'),
  pluginName: 'voidVue',
  files: {
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
    // The layout renders Badge without hydrating it; this page hydrates it.
    'pages/badge.island.vue': `<script setup>
import Badge from '../src/Badge.vue' with { island: 'load' };
</script>
<template><Badge /></template>`,
  },
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
