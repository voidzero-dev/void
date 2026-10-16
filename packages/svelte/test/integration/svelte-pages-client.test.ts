import { execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type Page } from 'playwright';
import { describe, expect, it, beforeAll, afterAll } from 'vite-plus/test';
import { collectBrowserDiagnostics } from '../../../../test/browser-helpers.ts';
import {
  createIsolatedPlayground,
  killChild,
  spawnFixtureServer,
  startServer,
  type IsolatedPlayground,
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
// Both server groups build and serve one isolated copy of the playground, never its source.
let fixture: IsolatedPlayground;
let DEV_BASE: string;
let PREVIEW_BASE: string;

let browser: Browser;

beforeAll(async () => {
  fixture = createIsolatedPlayground(ROOT, 'playground/svelte-pages');
  browser = await launchPagesBrowser();
});

afterAll(async () => {
  await browser?.close();
  fixture?.cleanup();
});

function defineClientTests(getBase: () => string, coverage: 'smoke' | 'full' = 'full') {
  const clientSuite = coverage === 'smoke' ? describe : describe.concurrent;
  clientSuite('shared client behavior', () => registerClientTests(getBase, coverage));
}

function registerClientTests(getBase: () => string, coverage: 'smoke' | 'full') {
  const diagnostics = new WeakMap<Page, () => string>();
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
    diagnostics.set(page, collectBrowserDiagnostics(page));
    return page;
  }

  async function waitForHydration(page: Page) {
    try {
      await page.waitForSelector('#app[data-hydrated="true"]');
    } catch (error) {
      console.error(diagnostics.get(page)?.());
      throw error;
    }
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
      (port) => (child = spawnFixtureServer(fixture.root, 'dev', port)),
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
    counterFile: () => join(fixture.root, 'pages/blog/_Counter.svelte'),
    islandFile: () => join(fixture.root, 'pages/blog/index.island.svelte'),
    hmrKeepsState: false,
  });
});

describe('svelte-pages client (preview)', { retry: 2 }, () => {
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    execFileSync('vp', ['run', 'build'], { cwd: fixture.root, stdio: 'pipe' });

    const server = await startServer(
      (port) => (child = spawnFixtureServer(fixture.root, 'preview', port)),
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
