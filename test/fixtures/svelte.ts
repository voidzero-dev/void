import type { FixtureApp } from '../fixture-app.ts';

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

export const islands: FixtureApp = { framework: 'svelte', name: 'islands', files };
export const mixed: FixtureApp = {
  framework: 'svelte',
  name: 'mixed',
  files: { ...files, 'pages/regular.svelte': '<h1>Regular</h1>' },
};
export const fixtures: Readonly<Record<string, FixtureApp>> = { islands, mixed };
