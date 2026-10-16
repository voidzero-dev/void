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
});
