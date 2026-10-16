import { execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type Page } from 'playwright';
import { describe, expect, it, beforeAll, afterAll } from 'vite-plus/test';
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

  it('hydrates without errors', async () => {
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
      expect(navText).toContain('Svelte Pages Demo');
    } finally {
      await page.context().close();
    }
  });
}

describe('svelte-pages client (dev)', () => {
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    const server = await startServer(
      (port) => (child = spawnPlaygroundServer(ROOT, 'svelte-pages', 'dev', port)),
      20_000,
    );
    DEV_BASE = server.base;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  registerSharedDevSsrTest({ getBase: () => DEV_BASE, framework: 'Svelte' });

  defineClientTests(() => DEV_BASE, 'smoke');
  defineSharedIslandTests(
    () => DEV_BASE,
    () => browser,
    { coverage: 'smoke' },
  );

  defineSharedIslandHmrTests({
    getBase: () => DEV_BASE,
    getBrowser: () => browser,
    counterFile: join(ROOT, 'playground/svelte-pages/pages/blog/_Counter.svelte'),
    islandFile: join(ROOT, 'playground/svelte-pages/pages/blog/index.island.svelte'),
    hmrKeepsState: false,
  });
});

describe('svelte-pages client (preview)', { retry: 2 }, () => {
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    if (!existsSync(join(ROOT, 'playground/svelte-pages/dist'))) {
      execSync('vp run --filter ./playground/svelte-pages build', {
        cwd: ROOT,
        stdio: 'pipe',
      });
    }

    const server = await startServer(
      (port) => (child = spawnPlaygroundServer(ROOT, 'svelte-pages', 'preview', port)),
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
