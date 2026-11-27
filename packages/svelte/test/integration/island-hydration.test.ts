import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import {
  collectBrowserDiagnostics,
  waitForIslandsHydrated,
} from '../../../../test/browser-helpers.ts';
import { buildIslandApp } from '../../../../test/island-css-build.ts';
import { launchPagesBrowser } from '../../../../test/pages-browser.ts';

const media = 'media:(min-width: 1200px)';
const files = (root: string) => ({
  'src/Probe.svelte': `<script>
  let { label } = $props();
  let value = $state('initial');
  let clicks = $state(0);
</script>
<label>{label}<input bind:value /></label>
<button type="button" onclick={() => clicks++}>{label} clicks: {clicks}</button>`,
  'src/Empty.svelte': `<script>
  import { onMount } from 'svelte';
  onMount(() => { document.documentElement.dataset.emptyIslandMounted = 'true'; });
</script>`,
  'pages/layout.island.svelte': `<script>
  import Probe from '../src/Probe.svelte' with { island: '${media}' };
  import Empty from '../src/Empty.svelte' with { island: '${media}' };
  let { children } = $props();
</script>
<main><Probe label="Layout" /><Empty />{@render children()}</main>`,
  'pages/index.md': `<script>
import Probe from ${JSON.stringify(join(root, 'src/Probe.svelte').replaceAll('\\', '/'))} with { island: '${media}' };
</script>

# Markdown page

<Probe label="Markdown" />
`,
});

it('hydrates the original DOM in Svelte layout and Markdown islands', async () => {
  const build = buildIslandApp({
    packageDir: join(import.meta.dirname, '../..'),
    pluginName: 'voidSvelte',
    files,
  });
  try {
    const assets = build.output('client');
    const browser = await launchPagesBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      page.setDefaultTimeout(10_000);
      const diagnostics = collectBrowserDiagnostics(page);
      const origin = 'http://svelte-islands.test';
      await page.route(origin + '/**', (route) => {
        const file = new URL(route.request().url()).pathname.slice(1) || 'index.html';
        return assets.has(file)
          ? route.fulfill({ path: join(build.root, 'dist/client', file) })
          : route.fulfill({ status: 404 });
      });

      await page.goto(origin);
      expect(await page.locator('[data-island]').count()).toBe(3);
      expect(await page.locator('[data-hydrated="true"]').count()).toBe(0);
      const fields = await Promise.all(
        ['Layout', 'Markdown'].map(async (label) => {
          const input = page.getByRole('textbox', { name: label });
          const original = await input.elementHandle();
          return { label, input, original, typed: 'typed into ' + label };
        }),
      );
      for (const { input, typed } of fields) {
        await input.fill(typed);
      }

      await page.setViewportSize({ width: 1300, height: 600 });
      await waitForIslandsHydrated(page, 3, 10_000);
      await page.locator('html[data-empty-island-mounted="true"]').waitFor();
      for (const { label, input, original, typed } of fields) {
        expect
          .soft(await input.evaluate((node, ssrNode) => node === ssrNode, original), label)
          .toBe(true);
        expect.soft(await input.inputValue(), label).toBe(typed);
        await page.getByRole('button', { name: label + ' clicks: 0' }).click();
        await page.getByRole('button', { name: label + ' clicks: 1' }).waitFor();
      }

      expect(diagnostics()).not.toMatch(/console\.(warning|error)|pageerror:/);
    } finally {
      await browser.close();
    }
  } finally {
    build.cleanup();
  }
}, 120_000);
