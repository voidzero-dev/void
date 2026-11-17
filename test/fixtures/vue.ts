import type { FixtureApp } from '../fixture-app.ts';

export const islands: FixtureApp = {
  framework: 'vue',
  name: 'islands',
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
    'pages/badge.island.vue': `<script setup>
import Badge from '../src/Badge.vue' with { island: 'load' };
</script>
<template><Badge /></template>`,
  },
};

export const fixtures: Readonly<Record<string, FixtureApp>> = { islands };
