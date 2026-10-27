import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

// Exercise the bundle without loading its global declarations alongside source declarations.
const { createErrorRenderer } = (await import(
  new URL('../../dist/runtime/routing.mjs', import.meta.url).href
)) as typeof import('../../src/runtime/routing-errors.ts');

const errors = createErrorRenderer({ projectRoot: '/project', homeDir: '/home' });
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

describe('default error page actions', () => {
  it('shows Go back only when a previous entry exists and returns to that entry', async () => {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.route('https://app.test/**', async (route) => {
      if (new URL(route.request().url()).pathname === '/article') {
        return route.fulfill({
          contentType: 'text/html',
          body: '<a href="/missing">Missing page</a>',
        });
      }
      const response = errors.createResponse(new Request(route.request().url()), 404, 'Not Found');
      return route.fulfill({
        status: response.status,
        contentType: 'text/html',
        body: await response.text(),
      });
    });
    try {
      await page.goto('https://app.test/missing');
      const back = page.getByRole('button', { name: 'Go back', includeHidden: true });
      expect(await back.isVisible()).toBe(false);
      await page.goto('https://app.test/article');
      await page.getByRole('link', { name: 'Missing page' }).click();
      expect(await back.isVisible()).toBe(true);
      await back.click();
      await page.waitForURL('https://app.test/article');
    } finally {
      await page.close();
    }
  });

  it('retries the current URL including its query without JavaScript or extra assets', async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const requests: Array<string> = [];
    const url = 'https://app.test/account?view=activity';
    await page.route('https://app.test/**', async (route) => {
      requests.push(route.request().url());
      if (requests.length > 1) {
        return route.fulfill({ contentType: 'text/html', body: '<h1>Recovered</h1>' });
      }
      const response = errors.createResponse(new Request(url), 500, 'Internal Server Error');
      return route.fulfill({
        status: response.status,
        contentType: 'text/html',
        body: await response.text(),
      });
    });
    try {
      await page.goto(url);
      await page.getByRole('link', { name: 'Reload page' }).click();
      await page.getByRole('heading', { name: 'Recovered' }).waitFor();
      expect(requests).toEqual([url, url]);
    } finally {
      await context.close();
    }
  });
});
