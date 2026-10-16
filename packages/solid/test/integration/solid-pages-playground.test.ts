import { execSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  killChild,
  spawnPlaygroundServer,
  startServer,
} from '../../../../test/integration-helpers.ts';
import { launchPagesBrowser } from '../../../../test/pages-browser.ts';
import {
  registerSharedClientTests,
  registerSharedDevSsrTest,
} from '../../../../test/pages-client-contract.ts';
import {
  defineSharedIslandHmrTests,
  defineSharedIslandTests,
} from '../../../../test/pages-island-contract.ts';

declare global {
  interface Window {
    __boundClickData?: string;
    __boundClickEventType?: string;
  }
}

type StampedElement = HTMLElement & { __stamp?: number };

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
let DEV_BASE: string;
let PREVIEW_BASE: string;

let browser: Browser;

beforeAll(async () => {
  browser = await launchPagesBrowser();
});

afterAll(async () => {
  await browser?.close();
});

function defineClientTests(getBase: () => string, coverage: 'smoke' | 'full' = 'full') {
  describe.concurrent('shared client behavior', () => registerClientTests(getBase, coverage));
}

function registerClientTests(getBase: () => string, coverage: 'smoke' | 'full') {
  registerSharedClientTests({ getBase, newPage, waitForHydration, coverage });
  if (coverage === 'smoke') {
    return;
  }

  let BASE: string;
  beforeAll(() => {
    BASE = getBase();
  });

  async function newPage(): Promise<Page> {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    return page;
  }

  async function waitForHydration(page: Page) {
    await page.waitForSelector('#app[data-hydrated="true"]');
  }

  it('hydrates without console errors', async () => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    try {
      await page.goto(BASE + '/');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      const text = await page.textContent('body');
      expect(text).toContain('Welcome');
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('layout and page state persist across navigation and validation errors', async () => {
    const page = await newPage();
    const stampOf = (selector: string) =>
      page.evaluate((s) => document.querySelector<StampedElement>(s)?.__stamp, selector);
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      await page.evaluate(() => {
        document.querySelector<StampedElement>('nav')!.__stamp = 1;
      });

      await page.click('nav a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(await stampOf('nav')).toBe(1);

      await page.evaluate(() => {
        document.querySelector<StampedElement>('h1')!.__stamp = 1;
      });
      await page.locator('form input').nth(0).fill('Typed Name');
      await page.click('button[type="submit"]');
      await page.waitForFunction(() => document.body?.textContent?.includes('Email is required'));

      expect(await page.locator('form input').nth(0).inputValue()).toBe('Typed Name');
      expect(await stampOf('h1')).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  it('back/forward to another record of the same page re-creates the page', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/users/1');
      await waitForHydration(page);
      await page.evaluate(() => {
        document.querySelector<StampedElement>('h1')!.__stamp = 1;
        history.pushState(null, '', '/users/2');
        history.pushState(null, '', '/users');
        history.back();
      });
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Bob'));

      expect(
        await page.evaluate(() => document.querySelector<StampedElement>('h1')?.__stamp),
      ).toBeUndefined();
    } finally {
      await page.context().close();
    }
  });

  it('back/forward to another route that shares the page component re-creates the page', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/twins/a');
      await waitForHydration(page);
      await page.evaluate(() => {
        document.querySelector<StampedElement>('h1')!.__stamp = 1;
        history.pushState(null, '', '/twins/b');
        history.pushState(null, '', '/');
        history.back();
      });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="twin-path"]')?.textContent === '/twins/b',
      );

      expect(
        await page.evaluate(() => document.querySelector<StampedElement>('h1')?.__stamp),
      ).toBeUndefined();
    } finally {
      await page.context().close();
    }
  });

  it('Link preserves Solid bound onClick handler arguments', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.click('[data-testid="bound-click-link"]');
      await page.waitForFunction(() => window.__boundClickData === 'bound-data');

      expect(await page.evaluate(() => window.__boundClickData)).toBe('bound-data');
      expect(await page.evaluate(() => window.__boundClickEventType)).toBe('click');
      expect(page.url()).toBe(BASE + '/link-behavior');
    } finally {
      await page.context().close();
    }
  });

  it('Link rejects dynamic mutation props with prefetch or reloadDocument', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.click('[data-testid="toggle-prefetch-method"]');
      await page.waitForSelector('[data-testid="reactive-prefetch-error"]');
      expect(await page.textContent('[data-testid="reactive-prefetch-error"]')).toMatch(
        /(?:Link:|Void Link) prefetch only supports GET links/,
      );

      await page.click('[data-testid="toggle-reload-method"]');
      await page.waitForSelector('[data-testid="reactive-reload-error"]');
      expect(await page.textContent('[data-testid="reactive-reload-error"]')).toMatch(
        /(?:Link:|Void Link) reloadDocument only supports GET links/,
      );
    } finally {
      await page.context().close();
    }
  });
}

// `pages/image.tsx`. Srcset widths follow `next/image`: the smallest configured
// size at least 1x and 2x the rendered width.
const IMAGE_ENDPOINT = '/_void/image?url=%2Fvoid-image-test.png';
const IMAGE_FIXED_TAG =
  '<img alt="Void image test" data-testid="image-fixed" loading="lazy" width="640" height="320" ' +
  'decoding="async" data-nimg="1" style="color:transparent" ' +
  `srcset="${IMAGE_ENDPOINT}&amp;w=640&amp;q=75 1x, ${IMAGE_ENDPOINT}&amp;w=1920&amp;q=75 2x" ` +
  `src="${IMAGE_ENDPOINT}&amp;w=1920&amp;q=75"/>`;
const IMAGE_PRELOAD_LINK =
  '<link rel="preload" as="image" imagesrcset="' +
  `${IMAGE_ENDPOINT}&amp;w=640&amp;q=75 1x, ${IMAGE_ENDPOINT}&amp;w=1080&amp;q=75 2x">`;

/** The SSR `<img>` with `data-testid`, without Solid's hydration key. */
function imageTag(html: string, testId: string): string {
  const tag = html.match(new RegExp(`<img [^>]*data-testid="${testId}"[^>]*>`))?.[0];
  expect(tag, `<img data-testid="${testId}">`).toBeDefined();
  return tag!.replace(/ data-hk="[^"]*"/, '');
}

/** The `/_void/image` URL of the `?image` import's 1x candidate, decoded from the SSR markup. */
function importedImageUrl(html: string): string {
  const srcset = imageTag(html, 'image-import').match(/ srcset="([^"]+)"/)?.[1] ?? '';
  return srcset.split(', ')[0].replace(/ 1x$/, '').replaceAll('&amp;', '&');
}

/**
 * `pages/image.tsx`: SSR markup, the `<head>` preload link, the
 * `/_void/image` endpoint (resized through the local Images binding) and
 * hydration in the browser.
 */
function registerImageTests(getBase: () => string, mode: 'dev' | 'preview') {
  it(`${mode}: Image renders next/image markup and a <head> preload link`, async () => {
    const res = await fetch(`${getBase()}/image`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(imageTag(html, 'image-fixed')).toBe(IMAGE_FIXED_TAG);
    // `preload` drops `loading` and adds exactly one preload link to <head>.
    expect(imageTag(html, 'image-preload')).not.toContain('loading=');
    const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
    expect(head).toContain(IMAGE_PRELOAD_LINK);
    expect(html.match(/<link rel="preload" as="image"/g)).toHaveLength(1);

    const fill = imageTag(html, 'image-fill');
    expect(fill).toContain('data-nimg="fill"');
    expect(fill).toContain(
      'style="position:absolute;height:100%;width:100%;left:0;top:0;right:0;bottom:0;object-fit:cover;color:transparent"',
    );
    expect(fill).toContain(`sizes="320px" srcset="${IMAGE_ENDPOINT}&amp;w=32&amp;q=75 32w, `);
    expect(fill).toContain(`${IMAGE_ENDPOINT}&amp;w=3840&amp;q=75 3840w"`);

    // `?image` supplies the intrinsic size; builds fingerprint the file name.
    expect(imageTag(html, 'image-import')).toContain('width="64" height="32"');
    expect(importedImageUrl(html)).toMatch(
      mode === 'dev'
        ? /^\/_void\/image\?url=%2Fassets%2Fvoid-image-import\.png&w=64&q=75$/
        : /^\/_void\/image\?url=%2Fassets%2Fvoid-image-import-[\w-]+\.png&w=64&q=75$/,
    );
  });

  it(`${mode}: /_void/image resizes, negotiates the format and rejects other widths`, async () => {
    const base = getBase();
    const cacheControl =
      mode === 'dev'
        ? 'public, max-age=0, must-revalidate'
        : 'public, max-age=14400, must-revalidate';

    const webp = await fetch(`${base}${IMAGE_ENDPOINT}&w=640&q=75`, {
      headers: { Accept: 'image/webp,*/*' },
    });
    expect(webp.status).toBe(200);
    expect(webp.headers.get('content-type')).toBe('image/webp');
    expect(webp.headers.get('vary')).toBe('Accept');
    expect(webp.headers.get('cache-control')).toBe(cacheControl);
    const webpBytes = Buffer.from(await webp.arrayBuffer());
    expect(webpBytes.subarray(8, 12).toString('latin1')).toBe('WEBP');

    // Without WebP in Accept the source format is kept; the PNG IHDR width is at byte 16.
    const png = await fetch(`${base}${IMAGE_ENDPOINT}&w=640&q=75`, {
      headers: { Accept: '*/*' },
    });
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('cache-control')).toBe(cacheControl);
    expect(Buffer.from(await png.arrayBuffer()).readUInt32BE(16)).toBe(640);

    const rejected = await fetch(`${base}${IMAGE_ENDPOINT}&w=641&q=75`);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toBe('"w" parameter (width) of 641 is not allowed');
  });

  it(`${mode}: Image hydrates and loads through /_void/image`, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const problems: Array<string> = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error' || /hydrat/i.test(text) || text.includes('Image with src')) {
        problems.push(`console.${msg.type()}: ${text}`);
      }
    });

    try {
      await page.goto(`${getBase()}/image`);
      await page.waitForSelector('#app[data-hydrated="true"]');
      // `complete` is also true after an error, which leaves `naturalWidth` at 0.
      await page.waitForFunction(() =>
        ['image-fixed', 'image-import'].every(
          (id) => document.querySelector<HTMLImageElement>(`[data-testid="${id}"]`)?.complete,
        ),
      );
      const images = await page.evaluate(() =>
        Object.fromEntries(
          ['image-fixed', 'image-import'].map((id) => {
            const img = document.querySelector<HTMLImageElement>(`[data-testid="${id}"]`)!;
            const current = new URL(img.currentSrc);
            return [
              id,
              {
                naturalWidth: img.naturalWidth,
                currentSrc: current.pathname + current.search,
                srcset: img.getAttribute('srcset'),
              },
            ];
          }),
        ),
      );
      // A 1x screen picks the 640w candidate, so the 1200px source was resized.
      expect(images['image-fixed']).toEqual({
        naturalWidth: 640,
        currentSrc: `${IMAGE_ENDPOINT}&w=640&q=75`,
        srcset: `${IMAGE_ENDPOINT}&w=640&q=75 1x, ${IMAGE_ENDPOINT}&w=1920&q=75 2x`,
      });
      expect(images['image-import'].naturalWidth).toBe(64);
      expect(images['image-import'].currentSrc).toMatch(/^\/_void\/image\?url=%2Fassets%2F/);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

describe('solid-pages client (dev)', () => {
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    const server = await startServer(
      (port) => (child = spawnPlaygroundServer(ROOT, 'solid-pages', 'dev', port)),
      45_000,
      { expectStatus: 200, expectBody: '__VOID_PAGE_DATA__' },
    );
    DEV_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it('dev: does not prebundle @void/solid in the worker environment', () => {
    const workerDepsDir = join(ROOT, 'playground/solid-pages/node_modules/.vite/deps_void_worker');
    const metadataPath = join(workerDepsDir, '_metadata.json');

    expect(existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as {
      optimized?: Record<string, unknown>;
    };

    expect(metadata.optimized).not.toHaveProperty('@void/solid');
    expect(existsSync(join(workerDepsDir, '@void_solid.js'))).toBe(false);
  });

  registerSharedDevSsrTest({ getBase: () => DEV_BASE, framework: 'Solid' });
  registerImageTests(() => DEV_BASE, 'dev');

  defineClientTests(() => DEV_BASE, 'smoke');
  defineSharedIslandTests(
    () => DEV_BASE,
    () => browser,
    {
      waitForValidation: (page) => page.getByText('Title is required').waitFor({ timeout: 20_000 }),
      coverage: 'smoke',
    },
  );

  defineSharedIslandHmrTests({
    getBase: () => DEV_BASE,
    getBrowser: () => browser,
    counterFile: join(ROOT, 'playground/solid-pages/pages/blog/_Counter.tsx'),
    islandFile: join(ROOT, 'playground/solid-pages/pages/blog/index.island.tsx'),
    hmrKeepsState: false,
  });
});

describe('solid-pages client (preview)', { retry: 2 }, () => {
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    if (!existsSync(join(ROOT, 'playground/solid-pages/dist'))) {
      execSync('vp run --filter ./playground/solid-pages build', {
        cwd: ROOT,
        stdio: 'pipe',
      });
    }

    const server = await startServer(
      (port) => (child = spawnPlaygroundServer(ROOT, 'solid-pages', 'preview', port)),
      30_000,
    );
    PREVIEW_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  defineClientTests(() => PREVIEW_BASE);
  defineSharedIslandTests(
    () => PREVIEW_BASE,
    () => browser,
    {
      waitForValidation: (page) => page.getByText('Title is required').waitFor({ timeout: 20_000 }),
    },
  );

  registerImageTests(() => PREVIEW_BASE, 'preview');

  it('preview: Image uses the Images binding and caches fingerprinted imports', async () => {
    const wranglerConfig = JSON.parse(
      readFileSync(join(ROOT, 'playground/solid-pages/dist/ssr/wrangler.json'), 'utf-8'),
    ) as { images?: unknown };
    expect(wranglerConfig.images).toEqual({ binding: 'IMAGES' });

    // The import is above Vite's 4 KiB inline limit, so the build emits a fingerprinted asset.
    const html = await (await fetch(`${PREVIEW_BASE}/image`)).text();
    const imported = await fetch(`${PREVIEW_BASE}${importedImageUrl(html)}`, {
      headers: { Accept: '*/*' },
    });
    expect(imported.status).toBe(200);
    expect(imported.headers.get('content-type')).toBe('image/png');
    expect(imported.headers.get('cache-control')).toBe('public, max-age=315360000, immutable');
    expect(Buffer.from(await imported.arrayBuffer()).readUInt32BE(16)).toBe(64);
  });
});
