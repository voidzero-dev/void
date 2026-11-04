import { readFileSync, writeFileSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from './browser-helpers.ts';
import { waitForServer } from './integration-helpers.ts';

type HmrWindow = Window & { __hmr_marker?: boolean };

/** Keep independent island coverage for every adapter without copying the tests. */
export function defineSharedIslandTests(
  getBase: () => string,
  getBrowser: () => Browser,
  options: {
    waitForValidation?: (page: Page) => Promise<unknown>;
    coverage?: 'smoke' | 'full';
  } = {},
): void {
  describe.concurrent('shared island behavior', () =>
    registerIslandTests(
      getBase,
      getBrowser,
      options.waitForValidation ??
        ((page) =>
          page.waitForFunction(() => document.body?.textContent?.includes('Title is required'))),
      options.coverage ?? 'full',
    ));
}

function registerIslandTests(
  getBase: () => string,
  getBrowser: () => Browser,
  waitForValidation: (page: Page) => Promise<unknown>,
  coverage: 'smoke' | 'full',
) {
  let BASE: string;
  beforeAll(() => {
    BASE = getBase();
  });

  async function newPage(): Promise<Page> {
    const context = await getBrowser().newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    return page;
  }

  it('island layouts leave links inactive without a router', async () => {
    const page = await newPage();
    try {
      const response = await page.goto(BASE + '/blog');
      expect(response!.status()).toBe(200);
      await waitForIslandsHydrated(page, 2);
      expect(await page.locator('nav a').count()).toBeGreaterThan(0);
      expect(await page.locator('nav a[aria-current], nav a[data-void-active]').count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  it('island hydration and interaction: counter increments on click', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/blog');
      await waitForIslandsHydrated(page, 2);

      const countBefore = await page.textContent('[data-testid="count"]');
      expect(countBefore).toBe('Count: 0');

      await page.click("button:has-text('Increment')");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="count"]')?.textContent === 'Count: 1',
      );

      const countAfter = await page.textContent('[data-testid="count"]');
      expect(countAfter).toBe('Count: 1');
    } finally {
      await page.context().close();
    }
  });

  // The dev island check exercises loading and hydration as well as browser
  // interaction. The remaining scenarios run against each production build.
  if (coverage === 'smoke') {
    return;
  }

  it('island form: validation errors display', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/blog');
      await waitForIslandsHydrated(page, 2);

      await page.click('button:has-text("Add Post")');
      await waitForValidation(page);

      const text = await page.textContent('body');
      expect(text).toContain('Title is required');
      expect(text).toContain('Body is required');
    } finally {
      await page.context().close();
    }
  });

  it('island form: successful submission reloads page', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/blog');
      await waitForIslandsHydrated(page, 2);

      await page.fill('input:near(:text("Title:"))', 'New Post');
      await page.fill('textarea:near(:text("Body:"))', 'Some content');

      await page.click('button:has-text("Add Post")');
      await page.waitForFunction(() => document.body?.textContent?.includes('New Post'));

      const text = await page.textContent('body');
      expect(text).toContain('New Post');
    } finally {
      await page.context().close();
    }
  });

  it('cross-navigation: Inertia page to island page falls back to full navigation', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await page.waitForSelector('#app[data-hydrated="true"]');

      // Set SPA marker to detect full page reload
      await page.evaluate(() => {
        (window as Window & { __SPA_MARKER?: boolean }).__SPA_MARKER = true;
      });

      // Click Blog link (goes through Void Router visit)
      await page.click('a[href="/blog"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Blog'));

      expect(page.url()).toBe(BASE + '/blog');

      // SPA marker should be gone — full page navigation happened
      const marker = await page.evaluate(
        () => (window as Window & { __SPA_MARKER?: boolean }).__SPA_MARKER,
      );
      expect(marker).toBeUndefined();

      await waitForIslandsHydrated(page, 2);
    } finally {
      await page.context().close();
    }
  });
}

/** Edit the playground's blog island files while its dev server runs. */
export function defineSharedIslandHmrTests({
  getBase,
  getBrowser,
  counterFile,
  islandFile,
  hmrKeepsState,
  prepareHmr,
  waitForHmr,
}: {
  getBase: () => string;
  getBrowser: () => Browser;
  counterFile: string;
  islandFile: string;
  hmrKeepsState: boolean;
  /** Runs before the page loads. */
  prepareHmr?: (page: Page) => Promise<void>;
  /** Runs once the islands hydrate, before the edit. */
  waitForHmr?: (page: Page) => Promise<void>;
}): void {
  it('island component HMR updates without full page reload', { retry: 2 }, async () => {
    const base = getBase();
    const original = readFileSync(counterFile, 'utf-8');

    const context = await getBrowser().newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);

    try {
      await prepareHmr?.(page);
      await page.goto(`${base}/blog`);
      await waitForIslandsHydrated(page, 2);
      await waitForHmr?.(page);

      await page.click("button:has-text('Increment')");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="count"]')?.textContent === 'Count: 1',
      );

      // A full page reload drops this marker.
      await page.evaluate(() => {
        (window as HmrWindow).__hmr_marker = true;
      });

      writeFileSync(counterFile, original.replace('Count: ', 'Total: '));

      await page.waitForFunction(
        () => document.querySelector('[data-testid="count"]')?.textContent?.startsWith('Total:'),
        { timeout: 15_000 },
      );

      expect(await page.evaluate(() => (window as HmrWindow).__hmr_marker === true)).toBe(true);
      expect(await page.textContent('[data-testid="count"]')).toBe(
        hmrKeepsState ? 'Total: 1' : 'Total: 0',
      );
    } finally {
      await page.context().close();
      writeFileSync(counterFile, original);
      await waitForServer(`${base}/blog`, 10_000, { expectBody: 'Count:' });
    }
  });

  it('island file edit triggers reload with updated content', { retry: 2 }, async () => {
    const base = getBase();
    const original = readFileSync(islandFile, 'utf-8');

    try {
      const initialRes = await fetch(`${base}/blog`);
      expect(initialRes.status).toBe(200);
      expect(await initialRes.text()).toContain('<h1>Blog</h1>');

      writeFileSync(islandFile, original.replace('<h1>Blog</h1>', '<h1>Blog Updated</h1>'));

      // Every request while the edit lands must succeed.
      const start = Date.now();
      let updatedHtml = '';
      while (Date.now() - start < 10_000) {
        await new Promise((r) => setTimeout(r, 100));
        const res = await fetch(`${base}/blog`);
        expect(res.status).toBe(200);
        updatedHtml = await res.text();
        if (updatedHtml.includes('Blog Updated')) {
          break;
        }
      }

      expect(updatedHtml).toContain('<h1>Blog Updated</h1>');
      expect(updatedHtml).toContain('data-island=');
    } finally {
      writeFileSync(islandFile, original);
      await waitForServer(`${base}/blog`, 10_000, { expectBody: '<h1>Blog</h1>' });
    }
  });
}
