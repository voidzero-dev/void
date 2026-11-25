import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { afterEach, expect, it } from 'vite-plus/test';
import { createPackageFixtureDir } from '../../../../test/fixture-dir.ts';
import { islandsPlugin } from '../../src/plugin-islands.ts';

const COUNTER = `<script setup>
import { ref } from "vue";
const count = ref(0);
</script>
<template><button @click="count++">Count {{ count }}</button></template>
`;

function islandPage(names: ReadonlyArray<string>): string {
  const imports = names.map(
    (name) => `import ${name} from "../components/${name}.vue" with { island: "load" };`,
  );
  return `<script setup>\n${imports.join('\n')}\n</script>\n<template>${names.map((name) => `<${name} />`).join('')}</template>\n`;
}

let root = '';
let server: ViteDevServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

/** Writes `pages/index.island.vue` and the given components, then starts a dev server without file watching. */
async function startServer(page: string, components: ReadonlyArray<string>) {
  root = createPackageFixtureDir(join(import.meta.dirname, '../..'), '__tmp_island_dev_');
  const pages = join(root, 'pages');
  mkdirSync(pages);
  mkdirSync(join(root, 'components'));
  for (const name of components) {
    writeFileSync(join(root, `components/${name}.vue`), COUNTER);
  }
  writeFileSync(join(pages, 'index.island.vue'), page);
  server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, '.vite'),
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [vue(), ...islandsPlugin(pages)],
    server: { ws: false, watch: null },
  });
  return { server, page: join(pages, 'index.island.vue') };
}

async function clientEntry(devServer: ViteDevServer): Promise<string> {
  return (await devServer.environments.client.transformRequest('virtual:void-islands-client'))!
    .code;
}

it('adds an island imported after the dev server loaded the islands client entry', async () => {
  const { server, page } = await startServer(islandPage(['Counter']), ['Counter', 'Second']);
  const before = await clientEntry(server);
  expect(before).toContain('components/Counter');
  expect(before).not.toContain('components/Second');

  writeFileSync(page, islandPage(['Counter', 'Second']));
  // Rendering the edited page records the new island.
  await server.environments.ssr.transformRequest('/pages/index.island.vue');

  expect(await clientEntry(server)).toContain('components/Second');
});

it('adds an island imported by a Markdown page after the dev server started', async () => {
  const { server, page } = await startServer(islandPage(['Counter']), ['Counter', 'Note']);
  const md = join(page, '../about.md');
  writeFileSync(md, '# About\n');
  server.watcher.emit('add', md);
  expect(await clientEntry(server)).not.toContain('components/Note');

  writeFileSync(
    md,
    '<script>\nimport Note from "../components/Note.vue" with { island: "load" };\n</script>\n\n# About\n\n<Note />\n',
  );
  server.watcher.emit('change', md);
  expect(await clientEntry(server)).toContain('components/Note');
});

it('drops a deleted island from the client entry and restores it when the file comes back', async () => {
  const { server } = await startServer(islandPage(['Counter', 'Removed']), ['Counter', 'Removed']);
  await server.environments.ssr.transformRequest('/pages/index.island.vue');
  expect(await clientEntry(server)).toContain('components/Removed');

  // A missing import would fail the whole entry, so other islands would not hydrate.
  const removed = join(root, 'components/Removed.vue');
  rmSync(removed);
  server.watcher.emit('unlink', removed);
  const withoutFile = await clientEntry(server);
  expect(withoutFile).toContain('components/Counter');
  expect(withoutFile).not.toContain('components/Removed');

  writeFileSync(removed, COUNTER);
  server.watcher.emit('add', removed);
  expect(await clientEntry(server)).toContain('components/Removed');
});

it('loads the islands client on a static island page that gains its first island', async () => {
  const { server, page } = await startServer('<template><p>Static</p></template>\n', ['Counter']);
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
  // `server.listen()` runs the pages scan, but also starts the dependency optimizer.
  await server.environments.client.pluginContainer.buildStart({});
  expect(await render()).not.toContain('/islands.js');

  writeFileSync(page, islandPage(['Counter']));
  // What the dev server's watcher reports when the page is saved. Vite's own
  // listener invalidates the page asynchronously, so invalidate it here too.
  server.watcher.emit('change', page);
  server.environments.ssr.moduleGraph.onFileChange(page);

  const html = await render();
  expect(html).toContain('data-island="components/Counter"');
  expect(html).toContain('/islands.js');
});
