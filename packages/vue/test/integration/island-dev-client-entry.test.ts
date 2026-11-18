import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { createServer } from 'vite';
import { expect, it } from 'vite-plus/test';
import { islandsPlugin } from '../../src/plugin-islands.ts';

const COUNTER = `<script setup>
import { ref } from "vue";
const count = ref(0);
</script>
<template><button @click="count++">Count {{ count }}</button></template>
`;

it('adds an island imported after the dev server loaded the islands client entry', async () => {
  const root = mkdtempSync(join(import.meta.dirname, '__tmp_island_dev_client_entry_'));
  const pages = join(root, 'pages');
  mkdirSync(pages);
  mkdirSync(join(root, 'components'));
  writeFileSync(join(root, 'components/Counter.vue'), COUNTER);
  writeFileSync(
    join(pages, 'index.island.vue'),
    `<script setup>
import Counter from "../components/Counter.vue" with { island: "load" };
</script>
<template><Counter /></template>
`,
  );

  const server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, '.vite'),
    logLevel: 'silent',
    plugins: [vue(), ...islandsPlugin(pages)],
    server: { ws: false, watch: null },
  });
  try {
    const { client, ssr } = server.environments;
    const before = await client.transformRequest('virtual:void-islands-client');
    expect(before?.code).toContain('components/Counter');
    expect(before?.code).not.toContain('components/Second');

    cpSync(join(root, 'components/Counter.vue'), join(root, 'components/Second.vue'));
    writeFileSync(
      join(pages, 'index.island.vue'),
      `<script setup>
import Counter from "../components/Counter.vue" with { island: "load" };
import Second from "../components/Second.vue" with { island: "load" };
</script>
<template><Counter /><Second /></template>
`,
    );
    // Rendering the edited page registers the new island.
    await ssr.transformRequest('/pages/index.island.vue');

    const after = await client.transformRequest('virtual:void-islands-client');
    expect(after?.code).toContain('components/Second');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps the islands client entry loading after an island is deleted', async () => {
  const root = mkdtempSync(join(import.meta.dirname, '__tmp_island_dev_deleted_'));
  const pages = join(root, 'pages');
  mkdirSync(pages);
  mkdirSync(join(root, 'components'));
  writeFileSync(join(root, 'components/Counter.vue'), COUNTER);
  writeFileSync(join(root, 'components/Removed.vue'), COUNTER);
  writeFileSync(
    join(pages, 'index.island.vue'),
    `<script setup>
import Counter from "../components/Counter.vue" with { island: "load" };
import Removed from "../components/Removed.vue" with { island: "load" };
</script>
<template><Counter /><Removed /></template>
`,
  );

  const server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, '.vite'),
    logLevel: 'silent',
    plugins: [vue(), ...islandsPlugin(pages)],
    server: { ws: false, watch: null },
  });
  try {
    const { client, ssr } = server.environments;
    await client.transformRequest('virtual:void-islands-client');

    // Remove an island's import and file, then add another island.
    rmSync(join(root, 'components/Removed.vue'));
    cpSync(join(root, 'components/Counter.vue'), join(root, 'components/Added.vue'));
    writeFileSync(
      join(pages, 'index.island.vue'),
      `<script setup>
import Counter from "../components/Counter.vue" with { island: "load" };
import Added from "../components/Added.vue" with { island: "load" };
</script>
<template><Counter /><Added /></template>
`,
    );
    await ssr.transformRequest('/pages/index.island.vue');

    const after = await client.transformRequest('virtual:void-islands-client');
    expect(after?.code).toContain('components/Counter');
    expect(after?.code).toContain('components/Added');
    expect(after?.code).not.toContain('components/Removed');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('loads the islands client on a static island page that gains its first island', async () => {
  const root = mkdtempSync(join(import.meta.dirname, '__tmp_island_dev_first_island_'));
  const pages = join(root, 'pages');
  const page = join(pages, 'index.island.vue');
  mkdirSync(pages);
  mkdirSync(join(root, 'components'));
  writeFileSync(join(root, 'components/Counter.vue'), COUNTER);
  writeFileSync(page, '<template><p>Static</p></template>\n');

  const server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, '.vite'),
    logLevel: 'silent',
    plugins: [vue(), ...islandsPlugin(pages)],
    server: { ws: false, watch: null, port: 0, host: '127.0.0.1' },
  });
  const render = async () => {
    const renderer = (await server.ssrLoadModule('virtual:void-islands-renderer')) as {
      renderIslandPage(
        page: { component: string; props: Record<string, unknown> },
        assetTags: { css: string; preloads: string; body: string },
      ): Promise<string>;
    };
    return renderer.renderIslandPage(
      { component: 'index', props: {} },
      { css: '', preloads: '', body: '<script type="module" src="/islands.js"></script>' },
    );
  };
  try {
    // Listening runs the pages scan.
    await server.listen();
    expect(await render()).not.toContain('/islands.js');

    writeFileSync(
      page,
      `<script setup>
import Counter from "../components/Counter.vue" with { island: "load" };
</script>
<template><Counter /></template>
`,
    );
    // What the dev server's watcher does when the page is saved.
    server.environments.ssr.moduleGraph.onFileChange(page);

    const html = await render();
    expect(html).toContain('data-island="components/Counter"');
    expect(html).toContain('/islands.js');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
