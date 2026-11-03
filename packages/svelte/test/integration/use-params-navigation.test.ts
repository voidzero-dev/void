import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { expect, it } from 'vite-plus/test';

// The client entry drives App.svelte through the same stores, in the same order,
// as the generated Svelte pages client does on a Link navigation.
const ENTRY = `
import { mount } from "svelte";
import { writable } from "svelte/store";
import App from "@void/svelte/App.svelte";
import Page from "./Page.svelte";

const stores = {
  page: writable(Page),
  props: writable({ title: "Post a" }),
  layouts: writable([]),
  shared: writable({}),
  params: writable({ slug: "a" }),
  route: writable("/posts/a"),
  navigation: writable({ state: "idle" }),
};
mount(App, {
  target: document.getElementById("app"),
  props: {
    page: Page,
    layouts: [],
    pageProps: { title: "Post a" },
    shared: {},
    params: { slug: "a" },
    router: { push() {}, replace() {}, back() {}, forward() {}, reload() {}, prefetch() {} },
    routeUrl: "/posts/a",
    stores,
  },
});
window.navigateToB = () => {
  stores.props.set({ title: "Post b" });
  stores.shared.set({});
  stores.params.set({ slug: "b" });
  stores.layouts.set([]);
  stores.page.set(Page);
};
`;

const PAGE = `<script>
  import { useParams } from "@void/svelte";
  let { title } = $props();
  const params = useParams();
</script>
<h1 id="title">{title}</h1>
<p id="slug">{params.slug}</p>
`;

it('useParams() follows navigation between two params of the same page', async () => {
  const root = mkdtempSync(join(import.meta.dirname, '.tmp-use-params-'));
  writeFileSync(join(root, 'Page.svelte'), PAGE);
  writeFileSync(join(root, 'entry.js'), ENTRY);
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><div id="app"></div><script type="module" src="/entry.js"></script>',
  );

  const browser = await chromium.launch();
  const server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, '.vite'),
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1' },
    plugins: [svelte()],
  });
  try {
    await server.listen();
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls!.local[0]);
    await page.waitForSelector('#slug');
    expect(await page.textContent('#slug')).toBe('a');

    await page.evaluate(() => (window as unknown as { navigateToB: () => void }).navigateToB());
    await page.waitForFunction(() => document.getElementById('title')?.textContent === 'Post b');
    expect(await page.textContent('#slug')).toBe('b');
  } finally {
    await server.close();
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});
