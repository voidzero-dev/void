import { execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, type Page } from 'playwright';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vite-plus/test';
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
    __SPA_MARKER?: boolean;
    __visitAwaitObserved?: string | null;
    __hashNavigationReady?: boolean;
    __headRefs?: {
      font: Element | null;
      stylesheet: Element | null;
    };
  }
}

type NavElement = HTMLElement & { __stamp?: number };
type PageHead = {
  title: string;
  meta: ReadonlyArray<Record<string, unknown>>;
};

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const REACT_PAGES_ROOT = join(ROOT, 'playground/react-pages');
const REACT_PAGES_LAYOUT = join(REACT_PAGES_ROOT, 'pages/layout.tsx');
const LATE_WORKER_DEPS_ROOT = join(REACT_PAGES_ROOT, 'node_modules/@void-repro');
let DEV_BASE: string;
let PREVIEW_BASE: string;

let browser: Browser;

function writeLateWorkerDep(name: string, source: string) {
  const packageDir = join(LATE_WORKER_DEPS_ROOT, name);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: `@void-repro/${name}`,
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }),
  );
  writeFileSync(join(packageDir, 'index.js'), source);
}

function installLateWorkerDeps() {
  rmSync(LATE_WORKER_DEPS_ROOT, { recursive: true, force: true });
  writeLateWorkerDep(
    'boundary',
    `import React from 'react';
export function Boundary({ children }) {
  return React.createElement(React.Fragment, null, children);
}
`,
  );
  writeLateWorkerDep(
    'cva',
    `export function cva(base) {
  return () => base;
}
`,
  );
  writeLateWorkerDep(
    'merge',
    `export function merge(...values) {
  return values.filter(Boolean).join(' ');
}
`,
  );
  writeLateWorkerDep(
    'slot',
    `import React from 'react';
export function Slot({ children }) {
  return React.Children.only(children);
}
`,
  );
  writeLateWorkerDep(
    'stack',
    `import React from 'react';
export default function Stack({ children, className }) {
  return React.createElement(
    'div',
    { className, style: { display: 'flex', flexDirection: 'column' } },
    children,
  );
}
`,
  );
}

function lateWorkerDepLayout() {
  return `import type { ReactNode } from 'react';
import { Boundary } from '@void-repro/boundary';
import { cva } from '@void-repro/cva';
import { merge } from '@void-repro/merge';
import { Slot } from '@void-repro/slot';
import Stack from '@void-repro/stack';

await new Promise((resolve) => setTimeout(resolve, 1000));
const { Link, useShared } = await import('@void/react');

const rootClass = cva('late-worker-dep-probe');

export default function Layout({ children }: { children: ReactNode }) {
  const shared = useShared();
  return (
    <Boundary>
      <Slot>
        <Stack className={merge(rootClass())}>
          <nav>
            <Link href="/" prefetch>
              Home
            </Link>{' '}
            |{' '}
            <Link href="/users" prefetch>
              Users
            </Link>{' '}
            |{' '}
            <Link href="/blog" prefetch>
              Blog
            </Link>{' '}
            |{' '}
            <Link href="/deferred" prefetch>
              Deferred
            </Link>{' '}
            |{' '}
            <Link href="/router-params" prefetch>
              Router Params
            </Link>{' '}
            |{' '}
            <Link href="/live" prefetch>
              Live
            </Link>{' '}
            |{' '}
            <Link href="/action-error" prefetch>
              Form Lab
            </Link>{' '}
            | <span>{shared.appName}</span>
          </nav>
          <hr />
          {children}
        </Stack>
      </Slot>
    </Boundary>
  );
}
`;
}

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

  it('hydrates without React errors', async () => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.text().includes('Hydration')) {
        errors.push(msg.text());
      }
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    try {
      await page.goto(BASE + '/');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      const text = await page.textContent('body');
      expect(text).toContain('Welcome');
      expect(
        errors.filter((e) => e.includes('Hydration') || e.includes('error while hydrating')),
      ).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('router.visit resolves after the React navigation commits', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/visit-await');
      await waitForHydration(page);

      await page.click('button:has-text("Visit users")');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      await page.waitForFunction(() => window.__visitAwaitObserved != null);

      const observedHeading = await page.evaluate(() => window.__visitAwaitObserved);
      expect(observedHeading).toBe('Users');
      expect(page.url()).toBe(BASE + '/users');
    } finally {
      await page.context().close();
    }
  });

  it('router.visit works from an initial layout effect', async () => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    try {
      await page.goto(BASE + '/initial-redirect');
      await waitForHydration(page);
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(page.url()).toBe(BASE + '/users');
      expect(errors).not.toContain('router.visit() called before router initialized');
    } finally {
      await page.context().close();
    }
  });

  it('SPA navigation: loaderless dynamic page exposes current route params', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/router-params');
      await waitForHydration(page);

      await page.click('a[href="/router-params/alpha"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Router Param alpha'),
      );

      expect(page.url()).toBe(BASE + '/router-params/alpha');
      expect(await page.textContent('[data-testid="router-param-id"]')).toBe('alpha');
      expect(await page.textContent('[data-testid="router-path"]')).toBe('/router-params/alpha');

      await page.click('a[href="/router-params/bravo"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Router Param bravo'),
      );

      expect(page.url()).toBe(BASE + '/router-params/bravo');
      expect(await page.textContent('[data-testid="router-param-id"]')).toBe('bravo');
      expect(await page.textContent('[data-testid="router-path"]')).toBe('/router-params/bravo');
    } finally {
      await page.context().close();
    }
  });

  it('client-only page uses the shell on first load and mounts from loader props', async () => {
    const htmlRes = await fetch(BASE + '/client-only');
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain('__VOID_PAGE_DATA__');
    expect(html).toContain('data-void-ssr="false"');
    expect(html).toContain('<title>Client-only Route | React Pages Demo</title>');
    expect(html).toContain('React Pages client-only route');
    expect(html).toContain('Client-only Route');
    expect(html).not.toContain('Client-only Page');
    expect(html).not.toContain('client-only page component rendered on the server');

    const page = await newPage();
    try {
      await page.goto(BASE + '/client-only');
      await waitForHydration(page);
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Client-only Page'),
      );

      expect(await page.textContent('[data-testid="client-only-title"]')).toBe('Client-only Route');
      expect(await page.textContent('[data-testid="client-only-marker"]')).toBe(
        'loader-props-available',
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
      expect(navText).toContain('React Pages Demo');
    } finally {
      await page.context().close();
    }
  });

  it('keeps the current route visible while back navigation loads', async () => {
    const page = await newPage();

    try {
      await page.route('**/users?keep-visible=1', async (route) => {
        if (route.request().headers()['x-voidpages']) {
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
        await route.continue();
      });

      await page.goto(BASE + '/users?keep-visible=1');
      await waitForHydration(page);

      await page.click('a[href="/users/1"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Alice'),
      );

      const back = page.goBack({ waitUntil: 'commit' });
      await page.waitForURL(BASE + '/users?keep-visible=1');
      await page.waitForTimeout(50);

      expect(await page.textContent('body')).toContain('alice@example.com');

      await back;
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(await page.textContent('body')).toContain('Bob');
    } finally {
      await page.context().close();
    }
  });

  it('form call-site action errors stay in form state', async () => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
        errors.push(msg.text());
      }
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    try {
      await page.goto(BASE + '/action-error');
      await waitForHydration(page);

      await page.click('button:has-text("Trigger conflict")');
      await page.waitForSelector('[data-testid="conflict-error"]');

      const text = await page.textContent('body');
      expect(text).toContain('Action failed with 409 Conflict');
      expect(text).toContain('Action Error');
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('deferred props: SPA navigation resolves in browser', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      await page.evaluate(() => {
        window.__SPA_MARKER = true;
      });

      // Avoid hover prefetch so this exercises the deferred NDJSON navigation path.
      await page.evaluate(() => {
        document.querySelector<HTMLAnchorElement>('a[href="/deferred"]')?.click();
      });
      await page.waitForFunction(() => document.querySelector('[data-testid="deferred-resolved"]'));

      const text = await page.textContent('[data-testid="deferred-resolved"]');
      expect(text).toBe('Count: 42');
      expect(await page.evaluate(() => window.__SPA_MARKER)).toBe(true);
      expect(page.url()).toBe(BASE + '/deferred');
    } finally {
      await page.context().close();
    }
  });

  it('deferred props: useId hydrates without mismatches', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/deferred');
      await waitForHydration(page);
      await page.waitForFunction(() => document.querySelector('[data-testid="deferred-resolved"]'));
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>('[data-testid="deferred-title"]')?.dataset.clientId,
      );

      const ids = await page.evaluate(() => {
        const title = document.querySelector<HTMLElement>('[data-testid="deferred-title"]')!;
        return { server: title.id, client: title.dataset.clientId };
      });
      expect(ids.server).toBe(ids.client);
    } finally {
      await page.context().close();
    }
  });

  it('SPA navigation updates document.title from head()', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      expect(await page.title()).toBe('Home | React Pages Demo');

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      await page.click('a[href="/users/1"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Alice'),
      );
      expect(await page.title()).toBe('Alice | React Pages Demo');

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      expect(await page.title()).toBe('Home | React Pages Demo');
    } finally {
      await page.context().close();
    }
  });

  it('Link ignores aborted GET navigations from interrupted clicks', async () => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.click('button:has-text("Run interrupted navigation check")');
      await page.waitForFunction(() =>
        document
          .querySelector('[data-testid="abort-navigation-status"]')
          ?.textContent?.startsWith('Passed:'),
      );

      expect(errors.filter((error) => error.includes('Navigation aborted'))).toEqual([]);
      expect(errors.filter((error) => error.includes('AbortError'))).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('Link keeps the current page when the target downloads a file', async () => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    try {
      // A non-Void response makes the client fall back to a full page load, which only
      // downloads the file, so the current page must stay on screen.
      await page.route(BASE + '/users', (route) =>
        route.fulfill({
          status: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition': 'attachment; filename="users.csv"',
          },
          body: 'id,name\n1,Ada\n',
        }),
      );
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      const download = page.waitForEvent('download');
      await page.click('[data-testid="onclick-link"]');
      await download;
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="navigation-state"]')?.textContent === 'idle' &&
          document.querySelector('h1')?.textContent === 'Link Behavior',
      );

      expect(errors).toEqual([]);
      expect(page.url()).toBe(BASE + '/link-behavior');
    } finally {
      await page.context().close();
    }
  });

  it('Link hash navigation runs the navigation lifecycle', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);
      await page.waitForFunction(() => window.__hashNavigationReady === true);

      await page.click('[data-testid="hash-link"]');
      await page.waitForURL(BASE + '/link-behavior#hash-target');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="navigation-location"]')?.textContent ===
          '/link-behavior#hash-target',
      );

      expect(await page.textContent('[data-testid="navigation-location"]')).toBe(
        '/link-behavior#hash-target',
      );
    } finally {
      await page.context().close();
    }
  });

  it('plain hash anchor navigation does not fetch or replace managed head links', async () => {
    const page = await newPage();
    const requests: Array<string> = [];

    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);
      await page.waitForLoadState('networkidle');

      await page.evaluate(() => {
        window.__headRefs = {
          font: document.querySelector('link[rel="preload"][href="/hash-navigation-test.woff2"]'),
          stylesheet: document.querySelector(
            'link[rel="stylesheet"][href="/hash-navigation-test.css"]',
          ),
        };
      });

      page.on('request', (request) => {
        requests.push(request.url());
      });

      await page.click('[data-testid="plain-hash-link"]');
      await page.waitForURL(BASE + '/link-behavior#plain-hash-target');
      await page.waitForTimeout(100);

      const headRefs = await page.evaluate(() => {
        const refs = window.__headRefs!;
        return {
          fontPreserved:
            refs.font ===
            document.querySelector('link[rel="preload"][href="/hash-navigation-test.woff2"]'),
          stylesheetPreserved:
            refs.stylesheet ===
            document.querySelector('link[rel="stylesheet"][href="/hash-navigation-test.css"]'),
        };
      });
      expect(headRefs).toEqual({ fontPreserved: true, stylesheetPreserved: true });
      expect(
        requests.filter((url) => url.startsWith(BASE) && !url.endsWith('/favicon.ico')),
      ).toEqual([]);
    } finally {
      await page.context().close();
    }
  });
  // The next pushState or replaceState call throws, like a browser that rate-limits history.
  async function failNextHistoryWrite(page: Page, method: 'pushState' | 'replaceState') {
    await page.evaluate((name) => {
      const original = History.prototype[name];
      History.prototype[name] = function () {
        History.prototype[name] = original;
        throw new DOMException('History blocked by test', 'SecurityError');
      };
    }, method);
  }

  async function waitForIdle(page: Page) {
    await page.waitForFunction(
      () => document.querySelector('[data-testid="navigation-state"]')?.textContent === 'idle',
    );
  }

  for (const [link, method] of [
    ['onclick-link', 'pushState'],
    ['replace-link', 'replaceState'],
  ] as const) {
    it(`${link} keeps the current page when ${method} fails`, async () => {
      const page = await newPage();
      const errors: Array<string> = [];
      page.on('pageerror', (error) => {
        errors.push(error.message);
      });

      try {
        await page.goto(BASE + '/link-behavior');
        await waitForHydration(page);
        const heading = await page.textContent('h1');
        await failNextHistoryWrite(page, method);

        await page.click(`[data-testid="${link}"]`);
        await vi.waitFor(() => expect(errors).toContain('History blocked by test'), {
          timeout: 10_000,
        });
        await waitForIdle(page);
        expect(await page.textContent('h1')).toBe(heading);
        expect(page.url()).toBe(BASE + '/link-behavior');

        await page.click(`[data-testid="${link}"]`);
        await page.waitForURL(BASE + '/users');
        await page.waitForFunction(() =>
          document.querySelector('h1')?.textContent?.includes('Users'),
        );
      } finally {
        await page.context().close();
      }
    });
  }
}

describe('react-pages client (dev)', () => {
  let child: ChildProcess | undefined;
  let stderr = '';
  let originalLayout: string | undefined;
  const coldStartResponses: Array<{ path: string; status: number; body: string }> = [];

  beforeAll(
    async () => {
      originalLayout = readFileSync(REACT_PAGES_LAYOUT, 'utf-8');
      installLateWorkerDeps();
      writeFileSync(REACT_PAGES_LAYOUT, lateWorkerDepLayout());
      rmSync(join(REACT_PAGES_ROOT, 'node_modules/.vite'), { recursive: true, force: true });

      const serverTimeout = process.platform === 'win32' ? 45_000 : 20_000;
      const server = await startServer((port) => {
        child = spawnPlaygroundServer(ROOT, 'react-pages', 'dev', port);
        stderr = '';
        child.stderr!.on('data', (chunk: Buffer) => {
          stderr += String(chunk);
        });
        return child;
      }, serverTimeout);
      DEV_BASE = server.base;
      const paths = ['/', '/users', '/action-error', '/router-params/alpha', '/visit-await'];
      coldStartResponses.push(
        ...(await Promise.all(
          paths.map(async (path) => {
            const response = await fetch(`${DEV_BASE}${path}`);
            return {
              path,
              status: response.status,
              body: await response.text(),
            };
          }),
        )),
      );

      writeFileSync(REACT_PAGES_LAYOUT, originalLayout);
      originalLayout = undefined;
      await waitForServer(DEV_BASE, 10_000, { rejectBody: 'late-worker-dep-probe' });
    },
    process.platform === 'win32' ? 60_000 : 30_000,
  );

  afterAll(async () => {
    if (originalLayout !== undefined) {
      writeFileSync(REACT_PAGES_LAYOUT, originalLayout);
      originalLayout = undefined;
    }
    if (child) {
      await killChild(child);
    }
    rmSync(LATE_WORKER_DEPS_ROOT, { recursive: true, force: true });
  });

  it('dev: cold SSR startup does not hit invalid React hook calls', () => {
    expect(coldStartResponses.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: '/', status: 200 },
      { path: '/users', status: 200 },
      { path: '/action-error', status: 200 },
      { path: '/router-params/alpha', status: 200 },
      { path: '/visit-await', status: 200 },
    ]);
    expect(coldStartResponses.find(({ path, body }) => path === '/')?.body).toContain('Welcome');
    expect(coldStartResponses.find(({ path, body }) => path === '/users')?.body).toContain('Alice');
    expect(stderr).not.toContain('Invalid hook call');
    expect(stderr).not.toMatch(/\(void_worker\).*new dependencies optimized: @void-repro/);
  });

  it('dev: client-only shells retain the React preamble and mount loader props', async () => {
    const response = await fetch(`${DEV_BASE}/client-only`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('data-void-ssr="false"');
    expect(html).toContain('__vite_plugin_react_preamble_installed__ = true');
    expect(html).not.toContain('client-only page component rendered on the server');

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${DEV_BASE}/client-only`);
      await page.waitForSelector('#app[data-hydrated="true"]');
      expect(await page.textContent('[data-testid="client-only-title"]')).toBe('Client-only Route');
      expect(await page.textContent('[data-testid="client-only-marker"]')).toBe(
        'loader-props-available',
      );
    } finally {
      await context.close();
    }
  });

  registerSharedDevSsrTest({ getBase: () => DEV_BASE, framework: 'React' });

  it('dev: head tags, pages protocol, form handling, API coexistence', async () => {
    const rootHtml = await (await fetch(`${DEV_BASE}/`)).text();
    expect(rootHtml).toContain('<title>Home | React Pages Demo</title>');
    expect(rootHtml).toContain('<meta charset="utf-8">');
    expect(rootHtml).toContain('<meta name="description" content="React Pages playground home">');
    expect(rootHtml).toContain('<html lang="en"');

    const userHtml = await (await fetch(`${DEV_BASE}/users/1`)).text();
    expect(userHtml).toContain('<title>Alice | React Pages Demo</title>');
    expect(userHtml).toContain('<meta property="og:title" content="Alice">');

    const inertiaRoot = await fetch(`${DEV_BASE}/`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(inertiaRoot.status).toBe(200);
    expect(inertiaRoot.headers.get('X-VoidPages')).toBe('true');
    const rootPage = (await inertiaRoot.json()) as {
      component: string;
      props: Record<string, unknown>;
      shared: Record<string, unknown>;
      url: string;
      head: PageHead;
    };
    expect(rootPage.component).toBe('index');
    expect(rootPage.props).toHaveProperty('title', 'Home');
    expect(rootPage.shared).toHaveProperty('appName', 'React Pages Demo');
    expect(rootPage.url).toBe('/');
    expect(rootPage.head).toBeDefined();
    expect(rootPage.head.title).toBe('Home | React Pages Demo');
    expect(rootPage.head.meta).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'description', content: 'React Pages playground home' }),
      ]),
    );

    const inertiaUsers = await fetch(`${DEV_BASE}/users`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(inertiaUsers.status).toBe(200);
    const usersPage = (await inertiaUsers.json()) as {
      component: string;
      props: { users: ReadonlyArray<{ id: number; name: string }> };
    };
    expect(usersPage.component).toBe('users');
    expect(usersPage.props.users).toHaveLength(2);
    expect(usersPage.props.users[0].name).toBe('Alice');

    const healthRes = await fetch(`${DEV_BASE}/api/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as { status: string };
    expect(healthBody.status).toBe('ok');

    const postValid = await fetch(`${DEV_BASE}/users`, {
      method: 'POST',
      headers: { 'X-VoidPages': 'true', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Charlie', email: 'charlie@example.com' }),
    });
    expect(postValid.status).toBe(200);
    const validPage = (await postValid.json()) as {
      component: string;
      props: { users: ReadonlyArray<{ id: number; name: string }> };
      errors: Record<string, string> | null;
    };
    expect(validPage.errors).toBeNull();
    expect(validPage.props.users).toHaveLength(3);
    expect(validPage.props.users[2].name).toBe('Charlie');

    const postInvalid = await fetch(`${DEV_BASE}/users`, {
      method: 'POST',
      headers: { 'X-VoidPages': 'true', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', email: '' }),
    });
    expect(postInvalid.status).toBe(200);
    const invalidPage = (await postInvalid.json()) as {
      component: string;
      props: { users: ReadonlyArray<{ id: number; name: string }> };
      errors: Record<string, string> | null;
    };
    expect(invalidPage.errors).not.toBeNull();
    expect(invalidPage.errors!.name).toBe('Name is required');
    expect(invalidPage.errors!.email).toBe('Email is required');
    expect(invalidPage.props.users.length).toBeGreaterThanOrEqual(2);

    const inertiaUser = await fetch(`${DEV_BASE}/users/1`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(inertiaUser.status).toBe(200);
    const userPage = (await inertiaUser.json()) as {
      component: string;
      props: { user: { id: number; name: string; email: string } };
      head: PageHead;
    };
    expect(userPage.component).toBe('users/[id]');
    expect(userPage.props.user.name).toBe('Alice');
    expect(userPage.head.title).toBe('Alice | React Pages Demo');

    const inertiaCharlie = await fetch(`${DEV_BASE}/users/3`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(inertiaCharlie.status).toBe(200);
    const charliePage = (await inertiaCharlie.json()) as {
      component: string;
      props: { user: { id: number; name: string; email: string } };
    };
    expect(charliePage.component).toBe('users/[id]');
    expect(charliePage.props.user.name).toBe('Charlie');
    expect(charliePage.props.user.email).toBe('charlie@example.com');

    const inertiaBlog = await fetch(`${DEV_BASE}/blog`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(inertiaBlog.status).toBe(200);
    expect(inertiaBlog.headers.get('content-type')).toContain('text/html');
    expect(inertiaBlog.headers.get('X-VoidPages')).toBeNull();
    const inertiaBlogHtml = await inertiaBlog.text();
    expect(inertiaBlogHtml).toContain('data-island=');

    const blogPostInvalid = await fetch(`${DEV_BASE}/blog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', body: '' }),
    });
    expect(blogPostInvalid.status).toBe(422);
    const invalidBlog = (await blogPostInvalid.json()) as { errors: Record<string, string> };
    expect(invalidBlog.errors.title).toBe('Title is required');
    expect(invalidBlog.errors.body).toBe('Body is required');

    const blogPostValid = await fetch(`${DEV_BASE}/blog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Third Post', body: 'Content here' }),
    });
    expect(blogPostValid.status).toBe(200);
    const validBlog = (await blogPostValid.json()) as { success: boolean };
    expect(validBlog.success).toBe(true);

    const deferredInertia = await fetch(`${DEV_BASE}/deferred`, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(deferredInertia.headers.get('content-type')).toContain('application/x-ndjson');
    const ndjsonText = await deferredInertia.text();
    const ndjsonLines = ndjsonText.trim().split('\n');
    expect(ndjsonLines.length).toBe(2);
    const pageObj = JSON.parse(ndjsonLines[0]);
    expect(pageObj.component).toBe('deferred');
    expect(pageObj.props.title).toBe('Deferred Page');
    expect(pageObj.deferredKeys).toEqual({ stats: 'stats' });
    const deferredLine = JSON.parse(ndjsonLines[1]);
    expect(deferredLine.__deferred).toBe('stats');
    expect(deferredLine.data).toEqual({ count: 42 });

    const deferredHtml = await (await fetch(`${DEV_BASE}/deferred`)).text();
    expect(deferredHtml).toContain('Deferred Page');
    expect(deferredHtml).not.toContain('Switched to client rendering');
    expect(deferredHtml).not.toContain('server rendering aborted');
  });

  defineClientTests(() => DEV_BASE, 'smoke');
  defineSharedIslandTests(
    () => DEV_BASE,
    () => browser,
    { coverage: 'smoke' },
  );

  it('dev: newly added page route renders after the program reload', { retry: 2 }, async () => {
    const newPageFile = join(REACT_PAGES_ROOT, 'pages/hmr-new-route.tsx');
    rmSync(newPageFile, { force: true });

    try {
      writeFileSync(
        newPageFile,
        `export default function HmrNewRoute() {
  return <h1>HMR New Route</h1>;
}
`,
      );

      const start = Date.now();
      let lastStatus = 0;
      let lastBody = '';
      while (Date.now() - start < 10_000) {
        await new Promise((r) => setTimeout(r, 100));
        const res = await fetch(`${DEV_BASE}/hmr-new-route`);
        lastStatus = res.status;
        lastBody = await res.text();
        expect(lastBody).not.toContain('components[pageObj.component] is not a function');
        if (lastStatus === 200 && lastBody.includes('HMR New Route')) {
          break;
        }
      }

      expect(lastStatus).toBe(200);
      expect(lastBody).toContain('HMR New Route');
    } finally {
      rmSync(newPageFile, { force: true });
      await waitForServer(`${DEV_BASE}/hmr-new-route`, 10_000, { expectStatus: 404 });
    }
  });

  defineSharedIslandHmrTests({
    getBase: () => DEV_BASE,
    getBrowser: () => browser,
    counterFile: join(REACT_PAGES_ROOT, 'pages/blog/_Counter.tsx'),
    islandFile: join(REACT_PAGES_ROOT, 'pages/blog/index.island.tsx'),
    hmrKeepsState: true,
  });
});

describe('react-pages client (preview)', { retry: 2 }, () => {
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    if (!existsSync(join(ROOT, 'playground/react-pages/dist'))) {
      execSync('vp run --filter ./playground/react-pages build', {
        cwd: ROOT,
        stdio: 'pipe',
      });
    }

    const server = await startServer(
      (port) => (child = spawnPlaygroundServer(ROOT, 'react-pages', 'preview', port)),
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
