import type { Page } from 'playwright';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

type TestWindow = Window & {
  __SPA_MARKER?: boolean;
  __linkOnClick?: boolean;
  __preventedClick?: boolean;
  __preventedNavigate?: boolean;
};

/**
 * Check the adapter's dev SSR output. The JSON, mutation and NDJSON responses come from void
 * core, so only the React suite checks them.
 */
export function registerSharedDevSsrTest({
  getBase,
  framework,
}: {
  getBase: () => string;
  /** The playground's framework name, as in `Vue Pages Demo`. */
  framework: string;
}): void {
  it('dev: SSR renders pages, island pages and deferred props', async () => {
    const base = getBase();
    const appName = `${framework} Pages Demo`;

    const rootRes = await fetch(`${base}/`);
    expect(rootRes.status).toBe(200);
    const rootHtml = await rootRes.text();
    expect(rootHtml).toContain('__VOID_PAGE_DATA__');
    expect(rootHtml).toContain('Welcome');
    expect(rootHtml).toContain(appName); // shared data from middleware

    // scriptProbe tries to close the inline page-data <script> tag early.
    const probe = '</script><script>alert(1)</script>\u2028\u2029&';
    const probeMatch = rootHtml.match(/<script id="__VOID_PAGE_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    expect(probeMatch).not.toBeNull();
    const probeJson = probeMatch![1];
    expect(probeJson).not.toMatch(/<\/script/i);
    expect(JSON.parse(probeJson).shared.scriptProbe).toBe(probe);
    expect(rootHtml).toContain(`This is the ${framework} Pages playground.`);

    const usersRes = await fetch(`${base}/users`);
    expect(usersRes.status).toBe(200);
    const usersHtml = await usersRes.text();
    expect(usersHtml).toContain('__VOID_PAGE_DATA__');
    expect(usersHtml).toContain('Alice');
    expect(usersHtml).toContain('Bob');
    expect(usersHtml).toContain(appName); // layout with shared data

    const userRes = await fetch(`${base}/users/1`);
    expect(userRes.status).toBe(200);
    const userHtml = await userRes.text();
    expect(userHtml).toContain('Alice');
    expect(userHtml).toContain('alice@example.com');

    const blogRes = await fetch(`${base}/blog`);
    expect(blogRes.status).toBe(200);
    const blogHtml = await blogRes.text();
    expect(blogHtml).toContain('data-island=');
    expect(blogHtml).toContain('data-props=');
    expect(blogHtml).toContain('data-hydrate=');
    expect(blogHtml).not.toContain('__VOID_PAGE_DATA__');
    expect(blogHtml).toContain('Hello World');
    expect(blogHtml).toContain('Second Post');
    expect(blogHtml).toContain('Count:');

    const detailRes = await fetch(`${base}/blog/hello-world`);
    expect(detailRes.status).toBe(200);
    const detailHtml = await detailRes.text();
    expect(detailHtml).toContain('Hello World');
    expect(detailHtml).toContain('First post');
    expect(detailHtml).not.toContain('__VOID_PAGE_DATA__');

    const deferredSsr = await fetch(`${base}/deferred`);
    const deferredHtml = await deferredSsr.text();
    expect(deferredHtml).toContain('__VOID_PAGE_DATA__');
    expect(deferredHtml).toContain('Deferred Page');
    expect(deferredHtml).toContain('window.__resolveDeferred("stats"');
    expect(deferredHtml).toContain('"count":42');
  });
}

/** Run the full browser contract in preview and navigation/history smoke tests in dev. */
export function registerSharedClientTests({
  getBase,
  newPage,
  waitForHydration,
  coverage = 'full',
}: {
  getBase: () => string;
  newPage: () => Promise<Page>;
  waitForHydration: (page: Page) => Promise<void>;
  coverage?: 'smoke' | 'full';
}): void {
  let BASE: string;
  beforeAll(() => {
    BASE = getBase();
  });

  it('visits typed destinations', async ({ expect }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.getByTestId('typed-visit').click();
      await page.waitForURL(BASE + '/users/2?tab=visit');
      expect(await page.textContent('body')).toContain('Bob');
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it('restores scroll after browser Back from an ordinary document link', async ({ expect }) => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('pageerror', (error) => errors.push(error.message));

    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      const ssrResponse = await page.request.get(BASE + '/scroll-restoration');
      expect(ssrResponse.status()).toBe(200);
      expect(await ssrResponse.text()).toContain('data-testid="scroll-row-30"');
      const response = await page.goto(BASE + '/scroll-restoration');
      expect(response?.status()).toBe(200);
      await waitForHydration(page);

      const row = page.getByTestId('scroll-row-30');
      const scrollY = await row.evaluate((element) =>
        Math.round(element.getBoundingClientRect().top - 100),
      );
      await page.mouse.move(400, 400);
      await page.mouse.wheel(0, scrollY);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(scrollY, 0);
      const before = await row.evaluate((element) => {
        (window as TestWindow).__SPA_MARKER = true;
        return {
          scrollY: window.scrollY,
          rowTop: element.getBoundingClientRect().top,
          timeOrigin: performance.timeOrigin,
        };
      });
      expect(before.scrollY).toBeGreaterThan(1000);

      await row.getByRole('link', { name: 'Go to Users' }).click();
      await page.waitForURL(BASE + '/users');
      await waitForHydration(page);
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBeUndefined();

      // Verify a new document even when the browser serves it from its HTTP cache.
      const backResponse = await page.goBack();
      if (backResponse) {
        expect(backResponse.status()).toBe(200);
      }
      expect(page.url()).toBe(BASE + '/scroll-restoration');
      await waitForHydration(page);
      const navigation = await page.evaluate(() => ({
        type: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type,
        timeOrigin: performance.timeOrigin,
        marker: (window as TestWindow).__SPA_MARKER,
      }));
      expect(navigation.type).toBe('back_forward');
      expect(navigation.timeOrigin).not.toBe(before.timeOrigin);
      expect(navigation.marker).toBeUndefined();
      expect(errors).toEqual([]);

      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(before.scrollY, 0);
      expect(await row.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
        before.rowTop,
        0,
      );
    } finally {
      await page.context().close();
    }
  });

  if (coverage === 'smoke') {
    it('SPA navigation: home → users', async () => {
      const page = await newPage();

      try {
        await page.goto(BASE + '/');
        await waitForHydration(page);

        // Set a marker to detect if a full page reload happens
        await page.evaluate(() => {
          (window as TestWindow).__SPA_MARKER = true;
        });

        await page.click('a[href="/users"]');
        await page.waitForFunction(() =>
          document.querySelector('h1')?.textContent?.includes('Users'),
        );

        expect(page.url()).toBe(BASE + '/users');
        expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);

        const text = await page.textContent('body');
        expect(text).toContain('Alice');
        expect(text).toContain('Bob');
      } finally {
        await page.context().close();
      }
    });
    return;
  }

  it('restores document scroll after reload', async ({ expect }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/scroll-restoration');
      await waitForHydration(page);
      await page.mouse.move(400, 400);
      await page.mouse.wheel(0, 3500);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3500);
      await page.reload();
      await waitForHydration(page);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3500);
    } finally {
      await page.context().close();
    }
  });

  it('restores scroll on SPA Back after visiting a shorter page', async ({ expect }) => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/scroll-restoration');
      await waitForHydration(page);
      await page.mouse.move(400, 400);
      await page.mouse.wheel(0, 3500);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3500);
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.getByTestId('scroll-row-30').getByRole('link', { name: 'Visit Users' }).click();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
      await page.goBack();
      await page.getByRole('heading', { name: 'Scroll restoration' }).waitFor();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(3500);
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it('replaces shared data when a page response omits a previous key', async () => {
    const page = await newPage();
    await page.route('**/users', async (route) => {
      if (route.request().headers()['x-voidpages'] !== 'true') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const pageData = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        body: JSON.stringify({ ...pageData, shared: {} }),
      });
    });

    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      expect(await page.locator('nav span').textContent()).toContain('Pages Demo');

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      await page.waitForFunction(() => document.querySelector('nav span')?.textContent === '');

      await page.click('a[href="/"]');
      await page.waitForFunction(() =>
        document.querySelector('nav span')?.textContent?.includes('Pages Demo'),
      );
    } finally {
      await page.context().close();
    }
  });

  it('revisits prefetched deferred pages without nesting their resolved props', async () => {
    const page = await newPage();
    let deferredRequests = 0;
    page.on('request', (request) => {
      if (request.url() === BASE + '/deferred') {
        deferredRequests++;
      }
    });
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      const prefetched = page.waitForResponse(
        (response) =>
          response.url() === BASE + '/deferred' &&
          response.request().headers()['purpose'] === 'prefetch',
      );
      await page.hover('a[href="/deferred"]');
      await (await prefetched).json();
      for (let visit = 0; visit < 3; visit++) {
        await page.click('a[href="/deferred"]');
        await page.waitForFunction(() =>
          document.querySelector('[data-testid="deferred-resolved"]')?.textContent?.includes('42'),
        );
        expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
        await page.click('a[href="/"]');
        await page.waitForFunction(() => window.location.pathname === '/');
      }
      expect(deferredRequests).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  // The longer journey also covers both forward navigation steps and their
  // rendered data, so separate list/detail browser contexts add no coverage.
  it('browser back/forward navigation', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);
      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });

      await page.click('a[href="/users"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(page.url()).toBe(BASE + '/users');
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
      expect(await page.textContent('body')).toContain('Bob');

      await page.click('a[href="/users/1"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Alice'),
      );
      expect(page.url()).toBe(BASE + '/users/1');
      expect(await page.textContent('body')).toContain('alice@example.com');

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(page.url()).toBe(BASE + '/users');

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      expect(page.url()).toBe(BASE + '/');

      await page.goForward();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(page.url()).toBe(BASE + '/users');
    } finally {
      await page.context().close();
    }
  });

  it('Form preserves a draft and displays quota failures until retry is available', async () => {
    const page = await newPage();
    let submissions = 0;
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    try {
      await page.clock.install();
      await page.route('**/users', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        submissions++;
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'usage_limit',
            resource: 'ai',
            reason: 'rate_limit',
            message: 'Your draft is still editable.',
            retryAt,
          }),
        });
      });
      await page.goto(BASE + '/users');
      await waitForHydration(page);
      await page.locator('form input').nth(0).fill('Quota draft');
      await page.locator('form input').nth(1).fill('quota@example.com');
      await page.click('button[type="submit"]');
      await page.waitForFunction(() =>
        document
          .querySelector('[data-void-form-error]')
          ?.textContent?.includes('Your draft is still editable.'),
      );
      expect(await page.locator('form input').nth(0).inputValue()).toBe('Quota draft');
      expect(await page.locator('form').getAttribute('aria-busy')).toBe('false');
      expect(await page.locator('[role="alert"]').textContent()).toContain('Try again after');
      await page.locator('form input').nth(0).fill('Edited draft');
      await page.click('button[type="submit"]');
      expect(submissions).toBe(1);
      await page.clock.fastForward(61_000);
      const retried = page.waitForRequest(
        (request) => request.method() === 'POST' && request.url() === BASE + '/users',
      );
      await page.click('button[type="submit"]');
      await retried;
      expect(submissions).toBe(2);
      expect(await page.locator('form input').nth(0).inputValue()).toBe('Edited draft');
    } finally {
      await page.context().close();
    }
  });

  it('form resets preserve nested snapshots and update dirty state after repeated submits', async ({
    expect,
  }) => {
    const page = await newPage();
    const errors: Array<string> = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const initial = { profile: { name: '' }, tags: [] };
    const edited = { profile: { name: 'edited' }, tags: ['edited'] };

    try {
      await page.goto(BASE + '/form-reset');
      await waitForHydration(page);

      for (const automatic of [false, true]) {
        const form = page.getByTestId(automatic ? 'automatic-form' : 'manual-form');
        async function assertState(data: typeof edited, dirty: boolean) {
          await expect
            .poll(async () => ({
              data: JSON.parse((await form.getByTestId('values').textContent())!),
              dirty: await form.getByTestId('dirty').textContent(),
            }))
            .toEqual({ data, dirty: String(dirty) });
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          await form.getByRole('button', { name: 'Edit', exact: true }).click();
          await assertState(edited, true);
          await form.getByRole('button', { name: 'Reset current', exact: true }).click();
          await assertState(initial, false);
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          await form.getByRole('button', { name: 'Edit', exact: true }).click();
          const response = page.waitForResponse(
            (response) =>
              response.url() === BASE + '/form-reset' && response.request().method() === 'POST',
          );
          await form.getByRole('button', { name: 'Save', exact: true }).click();
          expect((await response).ok()).toBe(true);
          await assertState(automatic ? initial : edited, false);
          expect(await form.getByTestId('success').textContent()).toBe('true');
          if (!automatic) {
            await form.getByRole('button', { name: 'Edit', exact: true }).click();
            await assertState({ ...edited, tags: ['edited', 'edited'] }, true);
            await form.getByRole('button', { name: 'Reset current', exact: true }).click();
            await assertState(edited, false);
            await form.getByRole('button', { name: 'Reset profile', exact: true }).click();
            await assertState({ profile: { name: '' }, tags: ['edited'] }, true);
            await form.getByRole('button', { name: 'Reset initial', exact: true }).click();
            await assertState(initial, true);
          }
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  describe('form field errors', () => {
    async function openForm() {
      const page = await newPage();
      await page.goto(BASE + '/form-errors');
      await waitForHydration(page);
      return page;
    }

    it('preserves new client validation errors and clears only edited fields', async ({
      expect,
    }) => {
      const page = await openForm();
      const readErrors = async () => JSON.parse((await page.getByTestId('errors').textContent())!);
      try {
        await page.getByRole('button', { name: 'Set errors', exact: true }).click();
        await expect.poll(readErrors).toEqual({
          email: 'Email invalid',
          name: 'Name invalid',
          profile: 'Profile invalid',
          tags: 'Tags invalid',
        });
        await page.getByLabel('Email', { exact: true }).fill('invalid');
        await expect.poll(readErrors).toEqual({
          email: 'Client email invalid',
          name: 'Name invalid',
          profile: 'Profile invalid',
          tags: 'Tags invalid',
        });
        await page.getByLabel('Name', { exact: true }).fill('Alice');
        await page.getByLabel('Email', { exact: true }).fill('alice@example.com');
        await expect.poll(readErrors).toEqual({ profile: 'Profile invalid', tags: 'Tags invalid' });
        await page.getByRole('button', { name: 'Clear all', exact: true }).click();
        await expect.poll(readErrors).toEqual({});
      } finally {
        await page.context().close();
      }
    });

    it('clears errors after repeated nested object and array edits', async ({ expect }) => {
      const page = await openForm();
      const readErrors = async () => JSON.parse((await page.getByTestId('errors').textContent())!);
      try {
        for (let edit = 0; edit < 3; edit++) {
          await page.getByRole('button', { name: 'Set nested errors', exact: true }).click();
          await expect
            .poll(readErrors)
            .toEqual({ profile: 'Profile invalid', tags: 'Tags invalid' });
          await page.getByLabel('Profile', { exact: true }).fill('Name ' + edit);
          await expect.poll(readErrors).toEqual({ tags: 'Tags invalid' });
          await page.getByRole('button', { name: 'Add tag', exact: true }).click();
          await expect.poll(readErrors).toEqual({});
        }
      } finally {
        await page.context().close();
      }
    });

    it('merges client and server errors without reviving cleared errors', async ({ expect }) => {
      const page = await openForm();
      const readErrors = async () => JSON.parse((await page.getByTestId('errors').textContent())!);
      try {
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect
          .poll(readErrors)
          .toEqual({ email: 'Email is required', name: 'Name is required' });
        await page.getByRole('button', { name: 'Set nested errors', exact: true }).click();
        await expect.poll(readErrors).toEqual({
          email: 'Email is required',
          name: 'Name is required',
          profile: 'Profile invalid',
          tags: 'Tags invalid',
        });
        await page.getByRole('button', { name: 'Clear email', exact: true }).click();
        await page.getByLabel('Name', { exact: true }).fill('Alice');
        await expect.poll(readErrors).toEqual({ profile: 'Profile invalid', tags: 'Tags invalid' });
        await page.getByRole('button', { name: 'Clear all', exact: true }).click();
        await expect.poll(readErrors).toEqual({});
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(readErrors).toEqual({ email: 'Email is required' });
        await page.getByLabel('Email', { exact: true }).fill('alice@example.com');
        await expect.poll(readErrors).toEqual({});
      } finally {
        await page.context().close();
      }
    });
  });

  it('form validation errors display', async () => {
    const page = await newPage();

    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);

      await page.click('button[type="submit"]');
      await page.waitForFunction(() => document.body?.textContent?.includes('Name is required'));

      const text = await page.textContent('body');
      expect(text).toContain('Name is required');
      expect(text).toContain('Email is required');

      // User list should still be present (GET re-ran)
      expect(text).toContain('Alice');
      expect(text).toContain('Bob');
    } finally {
      await page.context().close();
    }
  });

  it('form submission adds a user and navigates to its detail', { concurrent: false }, async () => {
    const page = await newPage();
    const id = crypto.randomUUID();
    const name = `Browser Dana ${id}`;
    const email = `dana-${id}@example.com`;

    try {
      await page.goto(BASE + '/users');
      await waitForHydration(page);

      await page.fill('input:near(:text("Name:"))', name);
      await page.fill('input:near(:text("Email:"))', email);
      await page.click('button[type="submit"]');
      await page.waitForFunction((value) => document.body?.textContent?.includes(value), name);
      const submittedText = await page.textContent('body');
      expect(submittedText).not.toContain('Name is required');
      expect(submittedText).not.toContain('Email is required');
      expect(page.url()).toBe(BASE + '/users');

      await page.getByRole('link', { name, exact: true }).click();
      await page.waitForFunction(
        (value) => document.querySelector('h1')?.textContent?.includes(value),
        name,
      );

      expect(page.url()).toMatch(/\/users\/\d+$/);
      const text = await page.textContent('body');
      expect(text).toContain(name);
      expect(text).toContain(email);
    } finally {
      await page.context().close();
    }
  });

  it('Link composes user onClick before SPA navigation', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.click('[data-testid="onclick-link"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(await page.evaluate(() => (window as TestWindow).__linkOnClick)).toBe(true);
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBe(true);
      expect(page.url()).toBe(BASE + '/users');
    } finally {
      await page.context().close();
    }
  });

  it('Link respects onClick preventDefault', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.click('[data-testid="prevented-click-link"]');
      await page.waitForFunction(() => (window as TestWindow).__preventedClick === true);

      expect(page.url()).toBe(BASE + '/link-behavior');
    } finally {
      await page.context().close();
    }
  });

  it('Link supports cancellable onNavigate', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.click('[data-testid="prevented-navigate-link"]');
      await page.waitForFunction(() => (window as TestWindow).__preventedNavigate === true);

      expect(page.url()).toBe(BASE + '/link-behavior');
    } finally {
      await page.context().close();
    }
  });

  it('Link replace updates the current history entry', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/');
      await waitForHydration(page);

      await page.click('a[href="/link-behavior"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Link Behavior'),
      );
      await waitForHydration(page);

      await page.click('[data-testid="replace-link"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );
      expect(page.url()).toBe(BASE + '/users');

      await page.goBack();
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Welcome'),
      );
      expect(page.url()).toBe(BASE + '/');
    } finally {
      await page.context().close();
    }
  });

  it('Link reloadDocument uses browser navigation', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      await page.evaluate(() => {
        (window as TestWindow).__SPA_MARKER = true;
      });
      await page.click('[data-testid="reload-link"]');
      await page.waitForFunction(() =>
        document.querySelector('h1')?.textContent?.includes('Users'),
      );

      expect(page.url()).toBe(BASE + '/users');
      expect(await page.evaluate(() => (window as TestWindow).__SPA_MARKER)).toBeUndefined();
    } finally {
      await page.context().close();
    }
  });

  it('Link leaves target and download links to the browser', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      const popupPromise = page.context().waitForEvent('page');
      await page.click('[data-testid="blank-link"]');
      const popup = await popupPromise;
      await popup.waitForLoadState();
      expect(page.url()).toBe(BASE + '/link-behavior');
      expect(popup.url()).toBe(BASE + '/users');
      await popup.close();

      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-testid="download-link"]');
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('users.html');
      expect(page.url()).toBe(BASE + '/link-behavior');
      await download.delete();
    } finally {
      await page.context().close();
    }
  });

  it('Link merges GET data into href and navigation URL', async () => {
    const page = await newPage();
    try {
      await page.goto(BASE + '/link-behavior');
      await waitForHydration(page);

      const href = await page.getAttribute('[data-testid="query-data-link"]', 'href');
      expect(href).toBe('/link-behavior?tag=a&tag=b&page=2&active=true');

      await page.click('[data-testid="query-data-link"]');
      await page.waitForURL(BASE + '/link-behavior?tag=a&tag=b&page=2&active=true');
      expect(page.url()).toBe(BASE + '/link-behavior?tag=a&tag=b&page=2&active=true');
    } finally {
      await page.context().close();
    }
  });
}
