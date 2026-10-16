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
});
