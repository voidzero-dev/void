import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { expect, it } from 'vite-plus/test';
import { createPackageFixtureDir } from '../../../../test/integration-helpers.ts';

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
    router: { url: new URL(location.href), push() {}, replace() {}, back() {}, forward() {}, reload() {}, prefetch() {} },
    routeUrl: "/posts/a",
    stores,
  },
});
window.visit = (path) => {
  stores.navigation.set({ state: "loading", location: new URL(path, location.href), method: "GET" });
};
window.navigateToB = () => {
  stores.navigation.set({ state: "idle", location: null, method: null });
  stores.route.set("/posts/b");
  stores.props.set({ title: "Post b" });
  stores.shared.set({});
  stores.params.set({ slug: "b" });
  stores.layouts.set([]);
  stores.page.set(Page);
};
`;

const PAGE = `<script>
  import { useLinkStatus, useParams } from "@void/svelte";
  let { title } = $props();
  const params = useParams();
  const status = useLinkStatus(
    () => params.slug === "a" ? "/posts/a" : "/posts",
    () => ({ activeMatch: params.slug === "a" ? "exact" : "prefix" }),
  );
  $effect(() => {
    (window.activeRuns ??= []).push(status.active);
  });
</script>
<h1 id="title">{title}</h1>
<p id="slug">{params.slug}</p>
<p id="status">{status.current}/{status.active}/{status.pending}</p>
`;

it('useParams and link status getters follow navigation between two params of the same page', async () => {
  const root = createPackageFixtureDir(join(import.meta.dirname, '../..'), '.tmp-use-params-');
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
    expect(await page.textContent('#status')).toBe('true/true/false');

    await page.evaluate(() =>
      (window as unknown as { visit: (path: string) => void }).visit('/posts/a'),
    );
    await page.waitForFunction(
      () => document.getElementById('status')?.textContent === 'true/true/true',
    );

    await page.evaluate(() => (window as unknown as { navigateToB: () => void }).navigateToB());
    await page.waitForFunction(() => document.getElementById('title')?.textContent === 'Post b');
    expect(await page.textContent('#slug')).toBe('b');
    expect(await page.textContent('#status')).toBe('false/true/false');
    // Each field is derived separately, so readers of an unchanged field never rerun.
    expect(
      await page.evaluate(() => (window as unknown as { activeRuns: Array<boolean> }).activeRuns),
    ).toEqual([true]);
  } finally {
    await server.close();
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});
