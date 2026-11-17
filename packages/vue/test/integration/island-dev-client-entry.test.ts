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
