import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  killChild,
  spawnPlaygroundServer,
  startServer,
} from '../../../../test/integration-helpers.ts';
import { launchPagesBrowser } from '../../../../test/pages-browser.ts';

const root = resolve(import.meta.dirname, '../../../..');
for (const mode of ['dev', 'preview'] as const) {
  describe(`view ${mode}`, () => {
    let server: Awaited<ReturnType<typeof startServer>>;
    let browser: Browser;
    beforeAll(async () => {
      if (mode === 'preview') {
        execSync('vp run --filter ./playground/view build', {
          cwd: root,
          stdio: 'pipe',
          timeout: 60_000,
        });
      }
      server = await startServer(
        (port) =>
          mode === 'dev'
            ? spawnPlaygroundServer(root, 'view', 'dev', port)
            : spawn(process.execPath, ['dist/ssr/index.js'], {
                cwd: resolve(root, 'playground/view'),
                env: { ...process.env, PORT: String(port) },
                stdio: ['ignore', 'pipe', 'pipe'],
              }),
        30_000,
      );
      browser = await launchPagesBrowser();
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
      if (server) {
        await killChild(server.child);
      }
    });
    if (mode === 'dev') {
      it('rebuilds the template and custom-element graph after editing a static component', async () => {
        const file = resolve(root, 'playground/view/components/Label.tsx');
        const original = readFileSync(file, 'utf8');
        const page = await browser.newPage();
        try {
          await page.goto(server.base);
          await page.waitForSelector('vv-button[data-vv-ready]');
          expect(await page.locator('vv-label').count()).toBe(0);
          writeFileSync(
            file,
            original.replace('<span class="label">', '<span class="label" onclick={() => {}}>'),
          );
          await page.waitForSelector('vv-label[data-vv-ready]', { timeout: 10_000 });
        } finally {
          writeFileSync(file, original);
          await expect
            .poll(async () => {
              const response = await fetch(server.base);
              return response.ok && !(await response.text()).includes('<vv-label');
            })
            .toBe(true);
          await page.close();
        }
      });
    }
    it('serves static HTML, only required templates, and no inline event handlers', async () => {
      const html = await (await fetch(server.base)).text();
      expect(html).toContain('Press me');
      expect(html).toContain('Count: 0');
      expect(html).toMatch(/<template id="vv-label(?:-|")/);
      expect(html).toMatch(/<template id="vv-action(?:-|")/);
      expect(html).not.toMatch(/<template id="vv-(intro|home|about)(?:-|")/);
      expect(html).not.toMatch(/<vv-label(?:-|")/);
      expect(html).not.toContain('onclick=');
      expect(html).not.toContain('__VOID_PAGE_DATA__');
      expect(html).toContain('<template id="vv-readout">');
      expect(html).toContain('<template id="vv-caption">');
      expect(html).toContain('<template id="vv-text">');
      expect(html).not.toContain('<vv-caption>');
      if (mode === 'preview') {
        const manifest: Record<string, { isEntry?: boolean }> = JSON.parse(
          readFileSync(resolve(root, 'playground/view/dist/client/.vite/manifest.json'), 'utf8'),
        );
        expect(
          Object.values(manifest).filter((entry: { isEntry?: boolean }) => entry.isEntry),
        ).toHaveLength(1);
        // Vite's entry is only a CSS build anchor; HTML must never request it.
        expect(html).not.toMatch(/<script[^>]+src="[^"]*pages-client/);
        expect(html).toMatch(/stylesheet/);
      }
      expect(html).toContain('data-void-view');
      expect(html).not.toContain('unused-button-source');
    });
    it('sends no view resources on static pages and only the button closure on /button', async () => {
      const page = await browser.newPage();
      const scripts: Array<string> = [];
      page.on('request', (request) => {
        if (request.resourceType() === 'script') {
          scripts.push(request.url());
        }
      });
      try {
        await page.goto(server.base + '/about');
        expect(await page.locator('template').count()).toBe(0);
        expect(await page.locator('script[data-void-view]').count()).toBe(0);
        if (mode === 'preview') {
          expect(await page.locator('script').count()).toBe(0);
          expect(scripts).toEqual([]);
        }
        await page.goto(server.base + '/button');
        expect(
          await page
            .locator('template')
            .evaluateAll((nodes) => nodes.map((node) => node.id).sort()),
        ).toEqual(['vv-button', 'vv-label']);
        const source = await page.locator('script[data-void-view]').textContent();
        expect(source).not.toContain('unused-button-source');
        expect(source).not.toContain('Counter');
        expect(source).not.toContain('Details');
        expect(source).not.toContain('Intro');
        await page.getByRole('button', { name: 'Press me', exact: true }).click();
        await expect
          .poll(() => page.getByRole('button', { name: 'Pressed!', exact: true }).count())
          .toBe(1);
        expect(await page.locator('vv-label').count()).toBe(0);
      } finally {
        await page.close();
      }
    });
    it('selects resources from actual SSR output while retaining future dynamic descendants', async () => {
      const page = await browser.newPage();
      try {
        await page.goto(server.base + '/conditional');
        expect(await page.locator('template, script[data-void-view]').count()).toBe(0);
        await page.goto(server.base + '/conditional?enabled=1');
        const ids = await page
          .locator('template')
          .evaluateAll((nodes) => nodes.map((node) => node.id));
        expect(ids).toEqual(
          expect.arrayContaining(['vv-reveal', 'vv-future-content', 'vv-future-text']),
        );
        expect(await page.locator('aside').count()).toBe(0);
        await page.getByRole('button', { name: 'Reveal content' }).click();
        await expect
          .poll(() => page.locator('aside').textContent())
          .toBe('Only rendered after clicking');
        const results = await Promise.all(
          ['/about', '/button', '/conditional', '/conditional?enabled=1'].map(async (path) =>
            (await (await fetch(server.base + path)).text()).includes('data-void-view'),
          ),
        );
        expect(results).toEqual([false, true, false, true]);
      } finally {
        await page.close();
      }
    });
    it('binds events, keeps instance state, invokes callbacks, and updates after await', async () => {
      const page = await browser.newPage();
      const errors: Array<string> = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(server.base);
        await page.waitForSelector('[data-vv-ready]', { timeout: 10_000 });
        await page.getByRole('button', { name: 'Press me', exact: true }).click();
        await expect
          .poll(() => page.getByRole('button', { name: 'Pressed!', exact: true }).count())
          .toBe(1);
        expect(
          await page.getByRole('button', { name: 'Independent button', exact: true }).count(),
        ).toBe(1);
        const counters = page.locator('section.card').filter({ has: page.locator('.count') });
        await counters.nth(0).getByRole('button', { name: 'Increment', exact: true }).click();
        await expect.poll(() => counters.nth(0).locator('.count').textContent()).toBe('Count: 1');
        expect(await counters.nth(1).locator('.count').textContent()).toBe('Count: 2');
        await counters.nth(1).getByRole('button', { name: 'Increment', exact: true }).click();
        await expect.poll(() => counters.nth(1).locator('li').count()).toBe(3);
        expect(await counters.nth(1).locator('.milestone').textContent()).toBe('Three or more!');
        await counters.nth(0).getByRole('button', { name: 'Delayed update' }).click();
        await expect
          .poll(() => counters.nth(0).locator('.message').textContent())
          .toBe('Updated after await');
        expect(await page.locator('vv-label').count()).toBe(0);
        expect(errors).toEqual([]);
        const details = page.locator('.details');
        await details.getByRole('button').click();
        await expect.poll(() => details.locator('tr').count()).toBe(1);
        await details.getByRole('button').click();
        await expect.poll(() => details.locator('output').textContent()).toBe('Rows: 2');
        expect(await details.locator('tr').count()).toBe(2);
        expect(await details.locator('.badge').textContent()).toBe('Tom & Jerry');
        expect(await details.locator('tr').first().textContent()).toBe('1Row & cell');
        expect(await details.locator('vv-readout').count()).toBe(1);
        expect(errors).toEqual([]);
        await page.getByRole('link', { name: 'Visit a static page' }).click();
        await page.waitForURL('**/about');
        expect(await page.locator('h1').textContent()).toBe('A static page');
        expect(await page.locator('[data-vv-ready]').count()).toBe(0);
      } finally {
        await page.close();
      }
    });
  });
}
