import { join } from 'node:path';
import spawn from 'cross-spawn';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
  type StartedServer,
} from '../../../../test/integration-helpers.ts';
import { launchPagesBrowser } from '../../../../test/pages-browser.ts';
import { PAGES_PROTOCOL_VERSION } from '../../../edge/src/pages-protocol.ts';
import { deserializePageData } from '../../src/pages/serialize.ts';

const repository = join(import.meta.dirname, '../../../..');
const pagesHeaders = {
  'X-VoidPages': 'true',
  'X-VoidPages-Version': PAGES_PROTOCOL_VERSION,
};
const renderedExamples = [
  {
    path: '/loaders/status/403',
    status: 403,
    heading: 'Status set in a loader',
    message: 'Your account is banned',
    retryAfter: '120',
  },
  {
    path: '/loaders/status/503',
    status: 503,
    heading: 'Status set in a loader',
    message: 'Down for maintenance',
    retryAfter: '120',
  },
  {
    path: '/loaders/validated',
    status: 503,
    heading: 'Status set in a validated loader',
    message: 'Down for maintenance',
    retryAfter: null,
  },
  {
    path: '/loaders/deferred',
    status: 429,
    heading: 'Status set before deferred streaming',
    message: 'Too many requests',
    retryAfter: '120',
  },
  {
    path: '/middleware/application',
    status: 503,
    heading: 'Status set in application middleware',
    message: 'Down for maintenance',
    retryAfter: '120',
  },
  {
    path: '/middleware/handler',
    status: 403,
    heading: 'Status set in handler middleware',
    message: 'Your account is banned',
    retryAfter: null,
  },
  {
    path: '/loaders/unexpected',
    status: 500,
    heading: 'Root error boundary',
    message: 'Internal Server Error',
    retryAfter: null,
  },
  {
    path: '/loaders/not-found',
    status: 404,
    heading: 'Not-found boundary',
    message: 'This page does not exist',
    retryAfter: null,
  },
  ...(
    [
      { status: 401, message: 'Please sign in' },
      { status: 403, message: 'Your account is banned' },
      { status: 410, message: 'This page is permanently gone' },
      { status: 429, message: 'Too many requests' },
      { status: 503, message: 'Down for maintenance' },
    ] as const
  ).map(({ status, message }) => ({
    path: `/loaders/errors/${status}`,
    status,
    heading: 'Nested error boundary',
    message,
    retryAfter: null,
  })),
  ...(
    [
      { status: 403, message: 'Your account is banned' },
      { status: 503, message: 'Down for maintenance' },
    ] as const
  ).map(({ status, message }) => ({
    path: `/middleware/errors/${status}`,
    status,
    heading: 'Root error boundary',
    message,
    retryAfter: null,
  })),
] as const;

type PageData = {
  component: string;
  props: Record<string, unknown>;
  url: string;
  deferredKeys?: Record<string, string>;
};

describe.each(['dev', 'production'] as const)('HTTP errors playground (%s)', (mode) => {
  let playground: IsolatedPlayground;
  let server: StartedServer;
  let browser: Browser;
  let base: string;

  function expectedMessage(example: (typeof renderedExamples)[number]) {
    return mode === 'dev' && example.path === '/loaders/unexpected'
      ? 'Unexpected loader failure'
      : example.message;
  }

  beforeAll(async () => {
    playground = createIsolatedPlayground(repository, 'playground/http-errors');
    if (mode === 'production') {
      const build = spawn.sync('vp', ['build'], {
        cwd: playground.root,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, NODE_ENV: 'production' },
      });
      expect(build.status, `${build.stdout ?? ''}${build.stderr ?? ''}`).toBe(0);
    }
    server = await startServer(
      (port) =>
        mode === 'dev'
          ? spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
              cwd: playground.root,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          : spawn(process.execPath, ['dist/ssr/index.js'], {
              cwd: playground.root,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
            }),
      30_000,
      { expectBody: 'HTTP Errors Example' },
    );
    base = server.base;
    browser = await launchPagesBrowser();
  });

  afterAll(async () => {
    await browser?.close();
    if (server) {
      await killChild(server.child);
    }
    playground?.cleanup();
  });

  for (const representation of ['HTML', 'Pages'] as const) {
    it.each(renderedExamples)(
      `${representation}: $path renders $heading with HTTP $status`,
      async (example) => {
        const pages = representation === 'Pages';
        const response = await fetch(base + example.path, { headers: pages ? pagesHeaders : {} });
        expect(response.status).toBe(example.status);
        expect(response.headers.get('Retry-After')).toBe(example.retryAfter);
        const body = await response.text();
        if (!pages) {
          expect(response.headers.get('content-type')).toContain('text/html');
          expect(body).toContain(example.heading);
          expect(body).toContain(expectedMessage(example));
          expect(body).toContain('aria-label="Example sections"');
          expect(body).toContain('example-page-loaded-toast');
          if (example.path === '/loaders/deferred') {
            expect(body).toContain('Waiting one second for deferred props');
            expect(body).toContain('window.__resolveDeferred("details"');
          }
        } else {
          expect(response.headers.get('X-VoidPages')).toBe('true');
          const lines = body.trim().split('\n');
          const data = deserializePageData<PageData>(lines[0]);
          expect(data.url).toBe(example.path);
          if (example.path === '/loaders/deferred') {
            expect(response.headers.get('content-type')).toContain('application/x-ndjson');
            expect(data.deferredKeys).toEqual({ details: 'details' });
            expect(lines).toHaveLength(2);
            expect(deserializePageData(lines[1])).toMatchObject({
              __deferred: 'details',
              data: example.message,
            });
          } else {
            expect(response.headers.get('content-type')).toContain('application/json');
            expect(data.props).toMatchObject(
              example.path.includes('/errors/') || example.status === 404 || example.status === 500
                ? { error: { status: example.status, message: expectedMessage(example) } }
                : { status: example.status, message: example.message },
            );
          }
        }
        if (example.path.startsWith('/middleware/errors/')) {
          expect(server.output()).not.toContain('Middleware-error page loader ran');
        }
      },
    );
  }

  describe('browser navigation', () => {
    let page: Page;

    beforeEach(async () => {
      page = await browser.newPage();
      page.setDefaultTimeout(10_000);
    });
    afterEach(async () => {
      await page?.close();
    });

    async function openHome() {
      await page.goto(base);
      // The layout effect is also the example's observable hydration signal.
      await page.waitForSelector('.example-page-loaded-toast:popover-open');
      await page.evaluate(() => Reflect.set(globalThis, '__HTTP_ERRORS_DOCUMENT__', true));
      await page
        .locator('header')
        .evaluate((element) => element.setAttribute('data-retained', 'yes'));
    }

    for (const navigation of ['Document load', 'Client navigation'] as const) {
      it.each(renderedExamples)(
        `${navigation}: $path renders $heading with HTTP $status`,
        async (example) => {
          await openHome();
          const responsePromise = page.waitForResponse(
            (response) =>
              response.url() === base + example.path &&
              (navigation === 'Document load'
                ? response.request().isNavigationRequest()
                : response.request().headers()['x-voidpages'] === 'true'),
          );
          await page
            .locator(`a[href="${example.path}"]`)
            .getByText(navigation, { exact: true })
            .click();
          const response = await responsePromise;
          expect(response.status()).toBe(example.status);
          expect(response.headers()['retry-after'] ?? null).toBe(example.retryAfter);
          if (navigation === 'Document load') {
            expect(response.headers()['content-type']).toContain('text/html');
            await page.waitForSelector('.example-page-loaded-toast:popover-open');
          } else {
            expect(response.headers()['x-voidpages']).toBe('true');
          }
          await expect.poll(() => page.locator('main h1').textContent()).toBe(example.heading);
          await expect
            .poll(() => page.locator('main').textContent(), { timeout: 10_000 })
            .toContain(expectedMessage(example));
          expect(await page.locator('header').count()).toBe(1);
          if (example.path.startsWith('/loaders/errors/')) {
            expect(
              await page
                .getByText('Nested layout for HTTP exception examples.', { exact: true })
                .count(),
            ).toBe(1);
            expect(
              await page
                .getByRole('heading', { name: 'Loader exception example', exact: true })
                .count(),
            ).toBe(0);
          }
          if (example.path.startsWith('/middleware/errors/')) {
            expect(server.output()).not.toContain('Middleware-error page loader ran');
            expect(
              await page
                .getByRole('heading', { name: 'Middleware exception example', exact: true })
                .count(),
            ).toBe(0);
          }
          const retained = navigation === 'Client navigation';
          expect(
            await page.evaluate(() => Reflect.get(globalThis, '__HTTP_ERRORS_DOCUMENT__')),
          ).toBe(retained ? true : undefined);
          expect(await page.locator('header').getAttribute('data-retained')).toBe(
            retained ? 'yes' : null,
          );
        },
      );
    }

    it('offers document and client navigation for every example', async () => {
      await openHome();
      const paths = renderedExamples.map(({ path }) => path).sort();
      for (const name of ['Document load', 'Client navigation']) {
        const links = await page.getByRole('link', { name, exact: true }).all();
        const targets = await Promise.all(links.map((link) => link.getAttribute('href')));
        expect(targets.sort()).toEqual(paths);
      }
    });

    it.each(['hover', 'focus'] as const)(
      'prefetches complete deferred props on %s without navigating',
      async (interaction) => {
        await openHome();
        const responsePromise = page.waitForResponse(
          (response) =>
            response.url() === base + '/loaders/deferred' &&
            response.request().headers().purpose === 'prefetch',
        );
        const link = page.getByRole('link', { name: 'Hover or focus to prefetch deferred data' });
        await link[interaction]();
        const response = await responsePromise;
        expect(response.status()).toBe(429);
        expect(response.headers()['retry-after']).toBe('120');
        expect(response.headers()['content-type']).toContain('application/json');
        expect(response.request().headers()['x-voidpages-version']).toBe(PAGES_PROTOCOL_VERSION);
        expect(deserializePageData(await response.text())).toMatchObject({
          props: { details: 'Too many requests' },
        });
        expect(page.url()).toBe(base + '/');
        expect(await page.locator('header').getAttribute('data-retained')).toBe('yes');
      },
    );

    it('shows the document-load toast once and does not reopen it on client navigation', async () => {
      await openHome();
      await page.waitForSelector('.example-page-loaded-toast:popover-open', { state: 'hidden' });
      await page
        .locator('a[href="/loaders/status/403"]')
        .getByText('Client navigation', { exact: true })
        .click();
      await expect.poll(() => page.locator('main h1').textContent()).toBe('Status set in a loader');
      expect(await page.locator('.example-page-loaded-toast:popover-open').count()).toBe(0);
      expect(await page.locator('header').getAttribute('data-retained')).toBe('yes');
      await page.getByRole('link', { name: 'HTTP Errors Example', exact: true }).click();
      await expect.poll(() => page.locator('main h1').textContent()).toBe('HTTP Errors Example');
      expect(await page.locator('.example-page-loaded-toast:popover-open').count()).toBe(0);
      expect(await page.title()).toBe('HTTP Errors Example');
    });
  });
});
