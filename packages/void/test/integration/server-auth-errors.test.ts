import { join } from 'node:path';
import spawn from 'cross-spawn';
import type { Browser, BrowserContext, Page, Response } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { collectBrowserDiagnostics } from '../../../../test/browser-helpers.ts';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
  type StartedServer,
} from '../../../../test/integration-helpers.ts';
import { launchPagesBrowser } from '../../../../test/pages-browser.ts';

const ROOT = join(import.meta.dirname, '../../../..');
const PLAYGROUND = 'playground/server-auth-errors';
const EMAIL = 'demo@example.com';
const guards = ['require-auth', 'return-redirect', 'throw-redirect', 'auth-redirect'] as const;
const visits = ['Document load', 'Client navigation'] as const;
const forms = ['Native form POST', 'Enhanced form POST'] as const;
const pages = [
  { path: '/loaders/optional-user', status: 200, heading: 'Loader rendered the page' },
  { path: '/loaders/optional-session', status: 200, heading: 'Loader rendered the page' },
  { path: '/loaders/require-auth', status: 401, heading: null },
  { path: '/loaders/return-redirect', status: 302, heading: 'Sign in' },
  { path: '/loaders/throw-redirect', status: 302, heading: 'Sign in' },
  { path: '/loaders/auth-redirect', status: 302, heading: 'Sign in' },
  { path: '/loaders/not-found', status: 404, heading: 'Not-found boundary' },
  { path: '/loaders/unexpected', status: 500, heading: 'Root error boundary' },
  { path: '/middleware/require-auth', status: 401, heading: null },
  { path: '/middleware/return-redirect', status: 302, heading: 'Sign in' },
  { path: '/middleware/throw-redirect', status: 302, heading: 'Sign in' },
  { path: '/middleware/auth-redirect', status: 302, heading: 'Sign in' },
] as const;

let playground: IsolatedPlayground;
let server: StartedServer;
let browser: Browser;
let signedInState: Awaited<ReturnType<BrowserContext['storageState']>>;
let page: Page;
let diagnostics: () => string;

beforeAll(async () => {
  playground = createIsolatedPlayground(ROOT, PLAYGROUND);
  server = await startServer(
    (port) =>
      spawn('vp', ['dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: playground.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
      }),
    60_000,
    { expectStatus: 200, expectBody: 'Server Auth Errors Example' },
  );
  browser = await launchPagesBrowser();

  // A fresh copy has its own D1 database. Create a real session once, then give
  // each signed-in scenario an independent cookie jar containing that session.
  const context = await browser.newContext();
  try {
    const response = await context.request.post(`${server.base}/api/demo-login`);
    expect(response.status(), await response.text()).toBe(200);
    const profile = await context.request.get(`${server.base}/api/profile`);
    expect(profile.status()).toBe(200);
    expect(await profile.json()).toEqual({ name: 'Demo user', email: EMAIL });
    signedInState = await context.storageState();
  } finally {
    await context.close();
  }
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.error(`${diagnostics?.() ?? ''}\n${server?.output() ?? ''}`);
  }
  await page?.context().close();
});

afterAll(async () => {
  await browser?.close();
  if (server) {
    await killChild(server.child);
  }
  playground?.cleanup();
});

async function newPage(signedIn = false) {
  const context = await browser.newContext({ storageState: signedIn ? signedInState : undefined });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  diagnostics = collectBrowserDiagnostics(page);
}

async function open(path = '/', signedIn = false) {
  const response = await page.goto(`${server.base}${path}`);
  expect(response?.status()).toBe(200);
  await page
    .getByRole('navigation')
    .getByRole('link', {
      name: signedIn ? 'Sign out' : 'Sign in',
      exact: true,
    })
    .waitFor();
}

async function markLayout() {
  await page
    .locator('header')
    .evaluate((header) => header.setAttribute('data-test-layout', 'retained'));
  return page.evaluate(() => performance.timeOrigin);
}

async function expectLayout(timeOrigin: number, retained: boolean) {
  expect((await page.evaluate(() => performance.timeOrigin)) === timeOrigin).toBe(retained);
  expect(await page.locator('header[data-test-layout="retained"]').count()).toBe(retained ? 1 : 0);
}

function responseFor(path: string, method = 'GET') {
  return page.waitForResponse(
    (response) =>
      response.url() === `${server.base}${path}` && response.request().method() === method,
  );
}

async function expectRedirect(
  response: Response,
  destination: string,
  status: number,
  enhanced = false,
) {
  // Pages negotiates redirects as HTTP 200 so fetch can read Location (including
  // fragments). Document requests keep the original HTTP redirect status.
  expect(response.status()).toBe(enhanced ? 200 : status);
  expect(await response.request().headerValue('X-VoidPages-Redirect')).toBe(
    enhanced ? 'manual' : null,
  );
  expect(await response.headerValue('X-VoidPages-Redirect')).toBe(enhanced ? String(status) : null);
  expect(await response.headerValue('location')).toBe(destination);
  await page.waitForURL(`${server.base}${destination}`);
}

describe.each([
  { state: 'signed out', signedIn: false },
  { state: 'signed in', signedIn: true },
])('server auth: $state', ({ signedIn }) => {
  beforeEach(() => newPage(signedIn));

  describe.each(visits)('%s', (visit) => {
    it.each(pages)('handles $path', async ({ path, status, heading }) => {
      await open('/', signedIn);
      const timeOrigin = await markLayout();
      const pending = responseFor(path);
      await page.locator(`a[href="${path}"]`).filter({ hasText: visit }).click();
      const response = await pending;
      const expectedStatus = signedIn ? 200 : status;
      if (expectedStatus !== 302) {
        expect(response.status()).toBe(expectedStatus);
      }

      if (expectedStatus === 401) {
        await expect.poll(() => page.locator('body').innerText()).toBe('Unauthorized');
        expect(await response.headerValue('content-type')).toContain('text/plain');
        expect(await page.locator('header').count()).toBe(0);
        expect(await page.getByRole('heading', { name: 'Root error boundary' }).count()).toBe(0);
        expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
        expect(page.url()).toBe(`${server.base}${path}`);
        return;
      }

      if (expectedStatus === 302) {
        await expectRedirect(response, '/login', 302, visit === 'Client navigation');
      } else {
        await page.waitForURL(`${server.base}${path}`);
      }
      await page
        .getByRole('heading', {
          name: signedIn ? 'Loader rendered the page' : heading!,
          exact: true,
        })
        .waitFor();
      await expectLayout(timeOrigin, visit === 'Client navigation');

      if (signedIn) {
        expect(await page.locator('main').innerText()).toContain(`Signed in as ${EMAIL}.`);
        if (path === '/loaders/optional-session') {
          expect(await page.locator('main').innerText()).toMatch(
            /Session expires: \d{4}-\d{2}-\d{2}T/,
          );
        }
      } else if (status === 200) {
        expect(await page.locator('main').innerText()).toContain(
          'Anonymous visitor: user is null.',
        );
        expect(await page.locator('main').innerText()).not.toContain('Session expires:');
      }
    });
  });

  describe.each(forms)('%s', (form) => {
    it.each(guards)('checks authentication for the %s action', async (guard) => {
      const path = `/actions/${guard}`;
      await open(path, signedIn);
      const timeOrigin = await markLayout();
      const pending = responseFor(path, 'POST');
      const destination = signedIn ? '/actions/success' : '/login';
      const followUp = signedIn || guard !== 'require-auth' ? responseFor(destination) : undefined;
      await page.getByRole('button', { name: form, exact: true }).click();
      const response = await pending;

      if (!signedIn && guard === 'require-auth') {
        expect(response.status()).toBe(401);
        expect(await response.text()).toBe('Unauthorized');
        if (form === 'Native form POST') {
          await expect.poll(() => page.locator('body').innerText()).toBe('Unauthorized');
          expect(await page.locator('header').count()).toBe(0);
          expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
        } else {
          await expect.poll(() => page.getByRole('alert').innerText()).toBe('401: Unauthorized');
          expect(await page.getByRole('heading', { name: `Action: ${guard}` }).count()).toBe(1);
          await expectLayout(timeOrigin, true);
        }
        expect(page.url()).toBe(`${server.base}${path}`);
        return;
      }

      await expectRedirect(response, destination, 303, form === 'Enhanced form POST');
      expect((await followUp)?.status()).toBe(200);
      if (form === 'Native form POST') {
        expect(response.request().redirectedTo()?.method()).toBe('GET');
      }
      await page
        .getByRole('heading', {
          name: signedIn ? 'Action authorized' : 'Sign in',
          exact: true,
        })
        .waitFor();
      await expectLayout(timeOrigin, form === 'Enhanced form POST');
    });
  });

  it('returns the API profile as a document', async () => {
    await open('/', signedIn);
    const timeOrigin = await markLayout();
    const pending = responseFor('/api/profile');
    await page.locator('a[href="/api/profile"]').click();
    const response = await pending;
    expect(response.status()).toBe(signedIn ? 200 : 401);
    if (signedIn) {
      expect(await response.json()).toEqual({ name: 'Demo user', email: EMAIL });
    } else {
      expect(await response.text()).toBe('Unauthorized');
    }
    await page.waitForURL(`${server.base}/api/profile`);
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(timeOrigin);
    expect(await page.locator('header').count()).toBe(0);
  });

  it('displays the API profile fetch result without navigating', async () => {
    await open('/', signedIn);
    const timeOrigin = await markLayout();
    await page.getByRole('button', { name: 'Fetch API response' }).click();
    const result = page.locator('#api').locator('..').getByRole('status');
    await expect.poll(() => result.innerText()).toContain(signedIn ? 'HTTP 200' : 'HTTP 401');
    expect(await result.innerText()).toContain(signedIn ? EMAIL : 'Unauthorized');
    expect(await result.innerText()).toContain(signedIn ? 'application/json' : 'text/plain');
    expect(page.url()).toBe(`${server.base}/`);
    await expectLayout(timeOrigin, true);
  });
});

describe('demo session and navigation', () => {
  beforeEach(() => newPage());

  it.each(['throw-redirect', 'auth-redirect'])(
    'signs in after the %s guard and updates the auth links',
    async (guard) => {
      const destination = `/loaders/${guard}`;
      await open();
      const timeOrigin = await markLayout();
      await page
        .locator(`a[href="${destination}"]`)
        .filter({ hasText: 'Client navigation' })
        .click();
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      expect(await page.getByLabel('Email', { exact: true }).inputValue()).toBe(EMAIL);
      expect(await page.getByLabel('Email', { exact: true }).isDisabled()).toBe(true);
      expect(await page.getByLabel('Password', { exact: true }).inputValue()).toBe('demo-password');
      expect(await page.getByLabel('Password', { exact: true }).isDisabled()).toBe(true);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page
        .getByRole('heading', { name: 'Server Auth Errors Example', exact: true })
        .waitFor();
      expect(page.url()).toBe(`${server.base}/`);
      await page.getByRole('link', { name: 'Sign out', exact: true }).waitFor();
      await page
        .locator(`a[href="${destination}"]`)
        .filter({ hasText: 'Client navigation' })
        .click();
      await page.getByRole('heading', { name: 'Loader rendered the page' }).waitFor();
      expect(await page.getByRole('link', { name: 'Sign in', exact: true }).count()).toBe(0);
      await expectLayout(timeOrigin, true);

      await page.reload();
      await page.getByRole('link', { name: 'Sign out', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Sign out', exact: true }).click();
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
      expect(await page.getByRole('link', { name: 'Sign out', exact: true }).count()).toBe(0);
      expect((await page.request.get(`${server.base}/api/profile`)).status()).toBe(401);
    },
  );

  it('uses the demo credentials regardless of the submitted fields', async () => {
    const response = await page.request.post(`${server.base}/api/demo-login`, {
      data: { email: 'other@example.com', password: 'different-password' },
    });
    expect(response.status()).toBe(200);
    const profile = await page.request.get(`${server.base}/api/profile`);
    expect(await profile.json()).toEqual({ name: 'Demo user', email: EMAIL });
  });

  describe.each(forms)('%s after the session ends', (form) => {
    it.each(guards)('rechecks authentication for the %s action', async (guard) => {
      expect((await page.request.post(`${server.base}/api/demo-login`)).status()).toBe(200);
      const path = `/actions/${guard}`;
      await open(path, true);
      expect(await page.locator('main').innerText()).toContain(`Signed in as ${EMAIL}.`);

      // End the session without refreshing the already-rendered form.
      const signedOut = await page.request.post(`${server.base}/api/auth/sign-out`, {
        headers: { Origin: server.base },
        data: {},
      });
      expect(signedOut.status()).toBe(200);
      const pending = responseFor(path, 'POST');
      const followUp = guard !== 'require-auth' ? responseFor('/login') : undefined;
      await page.getByRole('button', { name: form, exact: true }).click();
      const response = await pending;

      if (guard === 'require-auth') {
        expect(response.status()).toBe(401);
        if (form === 'Native form POST') {
          await expect.poll(() => page.locator('body').innerText()).toBe('Unauthorized');
        } else {
          await expect.poll(() => page.getByRole('alert').innerText()).toBe('401: Unauthorized');
        }
      } else {
        await expectRedirect(response, '/login', 303, form === 'Enhanced form POST');
        expect((await followUp)?.status()).toBe(200);
        await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      }
      expect(await page.getByRole('heading', { name: 'Action authorized' }).count()).toBe(0);
    });
  });

  it.each(['return-redirect', 'throw-redirect', 'auth-redirect'])(
    'does not replay the %s action after login',
    async (guard) => {
      const path = `/actions/${guard}`;
      await open(path);
      const submissions: Array<string> = [];
      page.on('request', (request) => {
        if (request.url() === `${server.base}${path}` && request.method() === 'POST') {
          submissions.push(request.method());
        }
      });
      await page.getByRole('button', { name: 'Enhanced form POST' }).click();
      await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page
        .getByRole('heading', { name: 'Server Auth Errors Example', exact: true })
        .waitFor();
      expect(submissions).toEqual(['POST']);
      expect(page.url()).toBe(`${server.base}/`);
      await page.locator(`a[href="${path}"]`).filter({ hasText: 'Client navigation' }).click();
      await page.getByRole('heading', { name: `Action: ${guard}` }).waitFor();
      await page.getByRole('button', { name: 'Enhanced form POST' }).click();
      await page.getByRole('heading', { name: 'Action authorized' }).waitFor();
      expect(submissions).toEqual(['POST', 'POST']);
    },
  );

  it('renders the client error boundary when an enhanced form throws its 401', async () => {
    await open('/actions/require-auth');
    const timeOrigin = await markLayout();
    await page.getByRole('checkbox', { name: /Throw enhanced-form errors/ }).check();
    await page.getByRole('button', { name: 'Enhanced form POST' }).click();
    await page.getByRole('heading', { name: 'Root error boundary' }).waitFor();
    expect(await page.locator('main').innerText()).toContain('401: Unauthorized');
    await expectLayout(timeOrigin, true);
    await page.getByRole('link', { name: 'Server Auth Errors Example', exact: true }).click();
    await page.getByRole('heading', { name: 'Server Auth Errors Example', exact: true }).waitFor();
    expect(await page.getByRole('heading', { name: 'Root error boundary' }).count()).toBe(0);
  });

  it('shows a temporary page-loaded popover only on document loads', async () => {
    await open();
    const toast = page.locator('.page-loaded-toast');
    await expect
      .poll(() => toast.evaluate((element) => element.matches(':popover-open')))
      .toBe(true);
    const timeOrigin = await markLayout();
    await page
      .locator('a[href="/loaders/optional-user"]')
      .filter({ hasText: 'Client navigation' })
      .click();
    await page.getByRole('heading', { name: 'Loader rendered the page' }).waitFor();
    expect(await toast.evaluate((element) => element.matches(':popover-open'))).toBe(false);
    await expectLayout(timeOrigin, true);
    await page.reload();
    await expect
      .poll(() => toast.evaluate((element) => element.matches(':popover-open')))
      .toBe(true);
    await expect
      .poll(() => toast.evaluate((element) => element.matches(':popover-open')), {
        timeout: 5000,
      })
      .toBe(false);
  });
});
