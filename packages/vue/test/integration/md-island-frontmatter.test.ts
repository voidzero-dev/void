// The Markdown plugin source needs its ambient module declarations in this package's typecheck.
// eslint-disable-next-line typescript/triple-slash-reference -- env.d.ts has no exports to import.
/// <reference path="../../../md/src/env.d.ts" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from '../../../../test/browser-helpers.ts';
import { openIslandPage, type IslandPageVisit } from '../../../../test/island-page-browser.ts';
import { voidMarkdown } from '../../../md/src/plugin.ts';
import { islandsPlugin } from '../../src/plugin-islands.ts';

const ISLAND_FRONTMATTER_SCRIPT =
  '<script type="application/json" id="__void_frontmatter">{"title":"Hello from frontmatter"}</script>';

it('an island reads the same frontmatter in the browser as on the server', async () => {
  const root = mkdtempSync(join(import.meta.dirname, '__tmp_md_island_frontmatter_'));
  mkdirSync(join(root, 'pages'));
  mkdirSync(join(root, 'components'));
  writeFileSync(
    join(root, 'pages/layout.island.vue'),
    `<script setup>
import Title from "../components/Title.vue" with { island: "load" };
</script>
<template><div><Title /><slot /></div></template>
`,
  );
  writeFileSync(
    join(root, 'components/Title.vue'),
    `<script setup>
import { useFrontmatter } from "@void/md";
const frontmatter = useFrontmatter();
</script>
<template><p id="island-fm">{{ String(frontmatter.title) }}</p></template>
`,
  );
  writeFileSync(
    join(root, 'pages', 'index.md'),
    '---\ntitle: Hello from frontmatter\n---\n\n# Body\n',
  );

  let visit: IslandPageVisit | undefined;
  try {
    visit = await openIslandPage(root, {
      plugins: [
        ...voidMarkdown(),
        vue(),
        { name: 'void-vue:pages' },
        ...islandsPlugin(join(root, 'pages')),
      ],
    });
    expect(visit.html).toContain(ISLAND_FRONTMATTER_SCRIPT);
    await waitForIslandsHydrated(visit.page);
    expect(await visit.page.textContent('#island-fm')).toBe('Hello from frontmatter');
    // A server/browser mismatch makes Vue warn about hydration.
    expect(visit.diagnostics().toLowerCase()).not.toContain('hydrat');
    expect(visit.diagnostics()).not.toContain('pageerror');
  } finally {
    await visit?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('an island that only the Markdown page imports hydrates', async () => {
  const root = mkdtempSync(join(import.meta.dirname, '__tmp_md_page_island_'));
  mkdirSync(join(root, 'pages'));
  mkdirSync(join(root, 'components'));
  writeFileSync(
    join(root, 'components/Title.vue'),
    `<script setup>
import { useFrontmatter } from "@void/md";
const frontmatter = useFrontmatter();
</script>
<template><p id="island-fm">{{ String(frontmatter.title) }}</p></template>
`,
  );
  writeFileSync(
    join(root, 'pages', 'index.md'),
    `<script>
import Title from "../components/Title.vue" with { island: "load" };
</script>

---
title: Hello from frontmatter
---

<Title />
`,
  );

  let visit: IslandPageVisit | undefined;
  try {
    visit = await openIslandPage(root, {
      plugins: [
        ...voidMarkdown(),
        vue(),
        { name: 'void-vue:pages' },
        ...islandsPlugin(join(root, 'pages')),
      ],
    });
    expect(visit.html).toContain(ISLAND_FRONTMATTER_SCRIPT);
    await waitForIslandsHydrated(visit.page);
    expect(await visit.page.textContent('#island-fm')).toBe('Hello from frontmatter');
    expect(visit.diagnostics().toLowerCase()).not.toContain('hydrat');
    expect(visit.diagnostics()).not.toContain('pageerror');
  } finally {
    await visit?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
