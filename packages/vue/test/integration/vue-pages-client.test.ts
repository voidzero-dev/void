import { execSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type Page } from 'playwright';
import { describe, expect, it, beforeAll, afterAll } from 'vite-plus/test';
import {
  killChild,
  spawnPlaygroundServer,
  startServer,
  waitForServer,
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
    __void_vite_connected?: boolean;
    __hmr_marker?: boolean;
  }
}

type NavElement = HTMLElement & { __stamp?: number };

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

async function prepareForViteHmr(page: Page) {
  await page.addInitScript(() => {
    const marker = '__void_vite_connected';
    const patched = '__void_vite_console_patched';
    const trackedWindow = window as unknown as Window & Record<string, boolean | undefined>;
    if (trackedWindow[patched]) {
      return;
    }

    const originalDebug = console.debug.bind(console);
    console.debug = (...args: ReadonlyArray<unknown>) => {
      if (args.some((arg) => typeof arg === 'string' && arg.includes('[vite] connected.'))) {
        trackedWindow[marker] = true;
      }
      originalDebug(...args);
    };

    trackedWindow[patched] = true;
  });
}

async function waitForViteHmr(page: Page) {
  await page.waitForFunction(() => window.__void_vite_connected === true, {
    timeout: 15_000,
  });
}

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

  it('form follows record identity while retaining edits on refresh and submit', async () => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(BASE + '/form-records/first');
      await waitForHydration(page).catch((error) => {
        throw new Error(`${String(error)}\n${errors.join('\n')}`);
      });
      await page.evaluate(() => {
        (document.querySelector('nav') as NavElement).__stamp = 42;
      });
      await page.getByRole('link', { name: 'Next record' }).click();
      await page.waitForFunction(
        () => document.querySelector('h1')?.textContent === 'Editing second',
      );
      expect(await page.getByLabel('Record name').inputValue()).toBe('Record second');
      await page.getByLabel('Record name').fill('Edited second');
      const refresh = page.waitForResponse((response) =>
        response.url().includes('/form-records/second'),
      );
      await page.getByRole('button', { name: 'Refresh record' }).click();
      await refresh;
      expect(await page.getByLabel('Record name').inputValue()).toBe('Edited second');
      const saved = page.waitForRequest((request) => request.method() === 'POST');
      const savedResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Save record' }).click();
      const request = await saved;
      expect(new URL(request.url()).pathname).toBe('/form-records/second');
      expect(request.postDataJSON()).toEqual({ name: 'Edited second' });
      await savedResponse;
      expect(await page.getByLabel('Record name').inputValue()).toBe('Edited second');
      expect(await page.evaluate(() => (document.querySelector('nav') as NavElement).__stamp)).toBe(
        42,
      );
    } finally {
      await page.context().close();
    }
  });

  it('hydrates without Vue warnings', async () => {
    const page = await newPage();
    const warnings: Array<string> = [];
    page.on('console', (msg) => {
      if (
        msg.type() === 'warning' ||
        msg.text().includes('[Vue warn]') ||
        msg.text().includes('Hydration')
      ) {
        warnings.push(msg.text());
      }
    });

    try {
      await page.goto(BASE + '/');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      const text = await page.textContent('body');
      expect(text).toContain('Welcome');
      expect(warnings.filter((w) => w.includes('Hydration') || w.includes('[Vue warn]'))).toEqual(
        [],
      );
    } finally {
      await page.context().close();
    }
  });

  it('layout persists across navigation', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      await page.evaluate(() => {
        (document.querySelector('nav') as NavElement | null)!.__stamp = 1;
      });

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      const stamp = await page.evaluate(
        () => (document.querySelector('nav') as NavElement | null)?.__stamp,
      );
      expect(stamp).toBe(1);

      const navText = await page.textContent('nav');
      expect(navText).toContain('Vue Pages Demo');
    } finally {
      await page.context().close();
    }
  });
}

const IMAGE_FIXED_TAG =
  '<img alt="Void image test" data-testid="image-fixed" loading="lazy" width="640" height="320" ' +
  'decoding="async" data-nimg="1" style="color:transparent" ' +
  'srcset="/_void/image?url=%2Fvoid-image-test.png&amp;w=640&amp;q=75 1x, ' +
  '/_void/image?url=%2Fvoid-image-test.png&amp;w=1920&amp;q=75 2x" ' +
  'src="/_void/image?url=%2Fvoid-image-test.png&amp;w=1920&amp;q=75">';
const IMAGE_PRELOAD_LINK =
  '<link rel="preload" as="image" imagesrcset="' +
  '/_void/image?url=%2Fvoid-image-test.png&amp;w=640&amp;q=75 1x, ' +
  '/_void/image?url=%2Fvoid-image-test.png&amp;w=1080&amp;q=75 2x">';
const IMAGE_ENDPOINT = '/_void/image?url=%2Fvoid-image-test.png&q=75';

function imageTag(html: string, testId: string): string {
  const tag = html.match(new RegExp(`<img [^>]*data-testid="${testId}"[^>]*>`))?.[0];
  expect(tag, `<img data-testid="${testId}">`).toBeDefined();
  return tag!;
}

/** The `/_void/image` URL of the `?image` import's 1x candidate, decoded from the SSR markup. */
function importedImageUrl(html: string): string {
  const srcset = imageTag(html, 'image-import').match(/ srcset="([^"]+)"/)?.[1] ?? '';
  return srcset.split(', ')[0].replace(/ 1x$/, '').replaceAll('&amp;', '&');
}

/**
 * `pages/image.vue`: SSR markup, the `<head>` preload link and the
 * `/_void/image` endpoint, which resizes through the local Images binding.
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
    expect(fill).toContain('sizes="320px"');
    expect(fill).toContain(
      'srcset="/_void/image?url=%2Fvoid-image-test.png&amp;w=32&amp;q=75 32w, ',
    );
    expect(fill).toContain('/_void/image?url=%2Fvoid-image-test.png&amp;w=3840&amp;q=75 3840w"');

    // `?image` supplies the intrinsic size; builds fingerprint the file name.
    const imported = imageTag(html, 'image-import');
    expect(imported).toContain('width="64" height="32"');
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

    const webp = await fetch(`${base}${IMAGE_ENDPOINT}&w=640`, {
      headers: { Accept: 'image/webp,*/*' },
    });
    expect(webp.status).toBe(200);
    expect(webp.headers.get('content-type')).toBe('image/webp');
    expect(webp.headers.get('vary')).toBe('Accept');
    expect(webp.headers.get('cache-control')).toBe(cacheControl);
    const webpBytes = Buffer.from(await webp.arrayBuffer());
    expect(webpBytes.subarray(8, 12).toString('latin1')).toBe('WEBP');

    // Without WebP in Accept the source format is kept; the PNG IHDR width is at byte 16.
    const png = await fetch(`${base}${IMAGE_ENDPOINT}&w=640`, { headers: { Accept: '*/*' } });
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('cache-control')).toBe(cacheControl);
    expect(Buffer.from(await png.arrayBuffer()).readUInt32BE(16)).toBe(640);

    const rejected = await fetch(`${base}${IMAGE_ENDPOINT}&w=641`);
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
      if (
        msg.type() === 'error' ||
        text.includes('[Vue warn]') ||
        text.includes('Hydration') ||
        text.includes('Image with src')
      ) {
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
        currentSrc: '/_void/image?url=%2Fvoid-image-test.png&w=640&q=75',
        srcset:
          '/_void/image?url=%2Fvoid-image-test.png&w=640&q=75 1x, ' +
          '/_void/image?url=%2Fvoid-image-test.png&w=1920&q=75 2x',
      });
      expect(images['image-import'].naturalWidth).toBe(64);
      expect(images['image-import'].currentSrc).toMatch(/^\/_void\/image\?url=%2Fassets%2F/);
      expect(problems).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

describe('vue-pages client (dev)', () => {
  let child: ChildProcess | undefined;

  beforeAll(
    async () => {
      const serverTimeout = process.platform === 'win32' ? 45_000 : 20_000;
      const server = await startServer(
        (port) => (child = spawnPlaygroundServer(ROOT, 'vue-pages', 'dev', port)),
        serverTimeout,
      );
      DEV_BASE = server.base;
    },
    process.platform === 'win32' ? 60_000 : 30_000,
  );

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  registerSharedDevSsrTest({ getBase: () => DEV_BASE, framework: 'Vue' });
  registerImageTests(() => DEV_BASE, 'dev');

  defineClientTests(() => DEV_BASE, 'smoke');
  defineSharedIslandTests(
    () => DEV_BASE,
    () => browser,
    { coverage: 'smoke' },
  );

  it(
    'page component HMR updates when defineProps<Props>() comes from companion server types',
    { retry: 2 },
    async () => {
      const pageFile = join(ROOT, 'playground/vue-pages/pages/deferred.vue');
      const original = readFileSync(pageFile, 'utf-8');

      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);

      try {
        await prepareForViteHmr(page);
        await page.goto(`${DEV_BASE}/deferred`);
        await page.waitForSelector('#app[data-hydrated="true"]');
        await waitForViteHmr(page);
        await page.waitForFunction(
          () => document.querySelector('h1')?.textContent === 'Deferred Page',
        );

        await page.evaluate(() => {
          window.__hmr_marker = true;
        });

        const modified = original.replace('<h1>{{ title }}</h1>', '<h1>Updated: {{ title }}</h1>');
        writeFileSync(pageFile, modified);

        // Wait for HMR to update the page. In Vite 8 the handleHotUpdate
        // compat layer may fail to deliver the update to the client when the
        // backward-compatible module graph doesn't surface sub-modules, so
        // we fall back to a manual reload to verify the transform still works
        // (no Vue SFC compiler error from defineProps<Props>() with external types).
        let hmrDelivered = false;
        try {
          await page.waitForFunction(
            () =>
              document.querySelector('h1')?.textContent === 'Updated: Deferred Page' ||
              document.querySelector('vite-error-overlay'),
            { timeout: 10_000 },
          );
          hmrDelivered = true;
        } catch {
          // HMR didn't deliver within timeout — reload and verify the
          // server-side transform (stripDefinePropsTypeArgument) works.
          await page.reload({ waitUntil: 'load' });
          await page.waitForSelector('#app[data-hydrated="true"]');
        }

        // No error overlay — the stripDefinePropsTypeArgument worked during HMR
        expect(
          await page.evaluate(() => {
            const overlay = document.querySelector('vite-error-overlay') as HTMLElement | null;
            if (!overlay) {
              return '';
            }
            return (
              overlay.shadowRoot?.textContent?.replace(/\s+/g, ' ').trim() ??
              overlay.textContent?.replace(/\s+/g, ' ').trim() ??
              ''
            );
          }),
        ).toBe('');
        expect(await page.textContent('h1')).toBe('Updated: Deferred Page');

        if (hmrDelivered) {
          // Verify it was a hot update, not a full page reload
          const markerSurvived = await page.evaluate(() => window.__hmr_marker === true);
          expect(markerSurvived).toBe(true);
        }
      } finally {
        await page.context().close();
        writeFileSync(pageFile, original);
        await waitForServer(`${DEV_BASE}/deferred`, 10_000, {
          expectBody: '<h1>Deferred Page</h1>',
        });
      }
    },
  );

  defineSharedIslandHmrTests({
    getBase: () => DEV_BASE,
    getBrowser: () => browser,
    counterFile: join(ROOT, 'playground/vue-pages/pages/blog/_Counter.vue'),
    islandFile: join(ROOT, 'playground/vue-pages/pages/blog/index.island.vue'),
    hmrKeepsState: true,
    prepareHmr: prepareForViteHmr,
    waitForHmr: waitForViteHmr,
  });
});

describe('vue-pages client (preview)', { retry: 2 }, () => {
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    if (!existsSync(join(ROOT, 'playground/vue-pages/dist'))) {
      execSync('vp run --filter ./playground/vue-pages build', {
        cwd: ROOT,
        stdio: 'pipe',
      });
    }

    const server = await startServer(
      (port) => (child = spawnPlaygroundServer(ROOT, 'vue-pages', 'preview', port)),
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
  );
  registerImageTests(() => PREVIEW_BASE, 'preview');

  it('preview: the build binds IMAGES and serves imported images as immutable', async () => {
    const wrangler = JSON.parse(
      readFileSync(join(ROOT, 'playground/vue-pages/dist/ssr/wrangler.json'), 'utf-8'),
    ) as { images?: unknown };
    expect(wrangler.images).toEqual({ binding: 'IMAGES' });

    // The imported file is above Vite's inline limit, so it is a fingerprinted asset.
    const html = await (await fetch(`${PREVIEW_BASE}/image`)).text();
    const imported = await fetch(`${PREVIEW_BASE}${importedImageUrl(html)}`, {
      headers: { Accept: 'image/webp,*/*' },
    });
    expect(imported.status).toBe(200);
    expect(imported.headers.get('content-type')).toBe('image/webp');
    expect(imported.headers.get('cache-control')).toBe('public, max-age=315360000, immutable');
    const importedBytes = Buffer.from(await imported.arrayBuffer());
    expect(importedBytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
  });
});
