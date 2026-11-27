import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import {
  collectBrowserDiagnostics,
  waitForIslandsHydrated,
} from '../../../../test/browser-helpers.ts';
import {
  createIsolatedPlayground,
  killChild,
  spawnFixtureServer,
  startServer,
} from '../../../../test/integration-helpers.ts';
import type { IsolatedPlayground, StartedServer } from '../../../../test/integration-helpers.ts';
import { launchPagesBrowser } from '../../../../test/pages-browser.ts';

const VALUE = '2026-01-02T00:00:00.000Z';
const APP_STATE_ID = '__VOID_APP_STATE__';
const SETUP_CSS = '.setup-probe { color: rgb(3, 45, 67); }';
const APP_SETUP = `
import './setup.css';
import type { App } from "vue";

export let observedError = "missing error";

export default function setup(app: App) {
  const state = { value: null as Date | null, hydrations: 0, throwOnDehydrate: false };
  app.provide("app-state", state);
  app.config.errorHandler = (error) => { observedError = String(error); };
  return {
    dehydrate() {
      if (state.throwOnDehydrate) throw new Error("Unexpected dehydration");
      return state.value ?? undefined;
    },
    hydrate(value: typeof state.value) {
      state.value = value;
      state.hydrations++;
    },
  };
}
`;
const PAGE = `
<script setup>
import { inject, onMounted, ref } from "vue";
import { Link } from "@void/vue";
const state = inject("app-state");
if (state && import.meta.env.SSR) state.value = new Date("${VALUE}");
const valueAtSetup = state?.value?.toISOString() ?? "missing state";
const hydrations = ref(null);
onMounted(() => { hydrations.value = state?.hydrations ?? -1; });
</script>
<template>
  <h1>App setup</h1>
  <p id="setup-state" :data-hydrations="hydrations">{{ valueAtSetup }}</p>
  <Link id="setup-next" href="/app-setup-next">Next</Link>
</template>
`;

let fixture: IsolatedPlayground;
let server: StartedServer;
let browser: Browser;

beforeAll(async () => {
  const workspace = join(import.meta.dirname, '../../../..');
  fixture = createIsolatedPlayground(workspace, 'playground/vue-pages');
  const pages = join(fixture.root, 'pages');
  const config = join(fixture.root, 'vite.config.ts');
  symlinkSync(
    join(workspace, 'packages/md'),
    join(fixture.root, 'node_modules/@void/md'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const source = readFileSync(config, 'utf8').replace(
    'voidVue()',
    "voidVue({ appSetup: './src/vue-app.ts' }), voidMarkdown()",
  );
  writeFileSync(config, `import { voidMarkdown } from '@void/md/plugin';\n${source}`);
  mkdirSync(join(fixture.root, 'src'), { recursive: true });
  writeFileSync(join(fixture.root, 'src/vue-app.ts'), APP_SETUP);
  writeFileSync(join(fixture.root, 'src/setup.css'), SETUP_CSS);
  writeFileSync(join(pages, 'app-setup.vue'), PAGE);
  writeFileSync(
    join(pages, 'app-setup-next.vue'),
    PAGE.replace('App setup</h1>', 'Next page</h1>'),
  );
  writeFileSync(
    join(pages, 'app-setup-empty.vue'),
    PAGE.replace('state.value = new Date', 'void new Date'),
  );
  mkdirSync(join(pages, 'app-setup-error'));
  writeFileSync(
    join(pages, 'app-setup-error/index.vue'),
    `<script setup>
import { inject } from "vue";
inject("app-state").value = new Date("${VALUE}");
throw new Error("setup error probe");
</script><template><p>Page</p></template>`,
  );
  writeFileSync(
    join(pages, 'app-setup-error/_error.vue'),
    `<script setup>
import { observedError } from "../../src/vue-app.ts";
import { inject } from "vue";
const requestState = inject("app-state").value?.toISOString();
</script>
<template><p id="setup-error">{{ observedError }}</p><p id="setup-error-state">{{ requestState }}</p></template>`,
  );
  writeFileSync(
    join(pages, 'setup-head.vue'),
    `<script setup>
import { inject } from "vue";
inject("app-state").throwOnDehydrate = true;
</script>
<template><p>HEAD probe</p></template>`,
  );
  writeFileSync(
    join(pages, 'setup-static.island.vue'),
    `<script setup>
import { inject } from 'vue';
const state = inject('app-state');
if (state) state.throwOnDehydrate = true;
</script>
<template><p class="setup-probe">Static island page</p></template>`,
  );
  writeFileSync(
    join(pages, 'setup-markdown.md'),
    `<script>
import Island from './_SetupIsland.vue' with { island: 'load' };
</script>

---
title: Markdown app setup
---

<Island />
`,
  );
  mkdirSync(join(pages, 'setup-handler'));
  writeFileSync(
    join(pages, 'setup-handler/index.vue'),
    `<script setup>
throw new Error("handled by Vue");
</script><template><p>Rendered with the Vue handler</p></template>`,
  );
  writeFileSync(
    join(pages, 'setup-handler/missing.vue'),
    `<script setup>
import { HTTPException } from 'hono/http-exception';
throw new HTTPException(404);
</script><template><p>Missing page</p></template>`,
  );
  for (const [route, headers] of [
    ['explicit', {}],
    ['attachment', { 'Content-Disposition': 'attachment' }],
  ] as const) {
    writeFileSync(
      join(pages, `setup-handler/${route}.vue`),
      `<script setup>
import { HTTPException } from 'hono/http-exception';
throw new HTTPException(404, {
  res: new Response("Download", { status: 404, headers: ${JSON.stringify(headers)} }),
});
</script><template><p>Missing page</p></template>`,
    );
  }
  writeFileSync(
    join(pages, 'setup-handler/mounted.vue'),
    `<script setup>
import { onMounted } from 'vue';
onMounted(() => { throw new Error("mounted failure"); });
</script><template><p id="handled-mount">Rendered with the Vue handler</p></template>`,
  );
  writeFileSync(
    join(pages, 'setup-handler/_not-found.vue'),
    '<template><p>Setup page not found</p></template>',
  );
  writeFileSync(
    join(pages, '_SetupIsland.vue'),
    `<script setup>
import { inject } from "vue";
import { useFrontmatter } from '@void/md';
const state = inject("app-state");
const frontmatter = useFrontmatter();
</script>
<template><p id="island-frontmatter">{{ state ? frontmatter.title : "Setup missing" }}</p></template>`,
  );
  server = await startServer((port) => spawnFixtureServer(fixture.root, 'dev', port), 20_000);
  browser = await launchPagesBrowser();
}, 70_000);

afterAll(async () => {
  await browser?.close();
  if (server) {
    await killChild(server.child);
  }
  fixture?.cleanup();
});

it('hydrates the page app with the server state and retains it on navigation', async () => {
  const page = await browser.newPage();
  const diagnostics = collectBrowserDiagnostics(page);
  try {
    const response = await page.goto(`${server.base}/app-setup`);
    expect(response?.status()).toBe(200);
    const html = (await response?.text()) ?? '';
    expect(html).toContain(`<p id="setup-state">${VALUE}</p>`);
    expect(html).toMatch(new RegExp(`id="${APP_STATE_ID}">[^<]+</script>\\s*</body>`));
    expect(await page.locator(`#${APP_STATE_ID}`).textContent()).toContain(VALUE);
    expect(await page.locator('#__VOID_PAGE_DATA__').textContent()).not.toContain(VALUE);
    const state = page.locator('#setup-state[data-hydrations]');
    await state.waitFor();
    expect(await state.textContent(), diagnostics()).toBe(VALUE);
    expect(await state.getAttribute('data-hydrations')).toBe('1');

    await page.locator('#setup-next').click();
    await page.getByRole('heading', { name: 'Next page' }).waitFor();
    expect(await state.textContent()).toBe(VALUE);
    expect(await state.getAttribute('data-hydrations')).toBe('1');
    expect(diagnostics()).not.toContain(`document: GET ${server.base}/app-setup-next`);
    expect(diagnostics()).not.toMatch(/hydration.*mismatch|pageerror:/i);
  } finally {
    await page.context().close();
  }
});

it('creates fresh state on each server request and omits the script when dehydrate returns undefined', async () => {
  const populated = await fetch(`${server.base}/app-setup`);
  expect(await populated.text()).toContain(VALUE);
  const fresh = await fetch(`${server.base}/app-setup-empty`);
  expect(fresh.status).toBe(200);
  const html = await fresh.text();
  expect(html).toContain('<p id="setup-state">missing state</p>');
  expect(html).not.toContain(APP_STATE_ID);
});

it('skips dehydrate for a HEAD request', async () => {
  const url = `${server.base}/setup-head`;
  const get = await fetch(url);
  expect(get.status).toBe(500);
  await get.text();
  const head = await fetch(url, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
});

it('hydrates a Markdown island with setup and page frontmatter', async () => {
  const page = await browser.newPage();
  const diagnostics = collectBrowserDiagnostics(page);
  try {
    const response = await page.goto(`${server.base}/setup-markdown`);
    expect(response?.status(), server.output()).toBe(200);
    expect(await response?.text()).toContain('<p id="island-frontmatter">Markdown app setup</p>');
    await waitForIslandsHydrated(page);
    expect(await page.locator('#island-frontmatter').textContent()).toBe('Markdown app setup');
    expect(diagnostics()).not.toMatch(/hydration.*mismatch|pageerror:/i);
  } finally {
    await page.context().close();
  }
});

it('lets Vue handle ordinary errors with only a not-found boundary', async () => {
  const response = await fetch(`${server.base}/setup-handler`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('<p>Rendered with the Vue handler</p>');
});

it.each(['missing', 'explicit'])('renders the not-found boundary for %s', async (route) => {
  const response = await fetch(`${server.base}/setup-handler/${route}`);
  expect(response.status).toBe(404);
  expect(await response.text()).toContain('<p>Setup page not found</p>');
});

it('preserves the response of a thrown 404 attachment', async () => {
  const response = await fetch(`${server.base}/setup-handler/attachment`);
  expect(response.status).toBe(404);
  expect(response.headers.get('Content-Disposition')).toBe('attachment');
  expect(await response.text()).toBe('Download');
});

it('retains the hydrated page after an app handler handles a mounted error', async () => {
  const page = await browser.newPage();
  try {
    const response = await page.goto(`${server.base}/setup-handler/mounted`);
    expect(response?.status()).toBe(200);
    await page.locator('#app[data-hydrated="true"] #handled-mount').waitFor();
  } finally {
    await page.context().close();
  }
});

it('includes setup styles in the initial HTML of static island pages', async () => {
  const response = await fetch(`${server.base}/setup-static`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain(SETUP_CSS);
});

it('reports a render error to the setup error handler and renders the page boundary', async () => {
  const response = await fetch(`${server.base}/app-setup-error`);
  expect(response.status).toBe(500);
  const html = await response.text();
  expect(html).toContain('<p id="setup-error">Error: setup error probe</p>');
  expect(html).toContain(`<p id="setup-error-state">${VALUE}</p>`);
});
