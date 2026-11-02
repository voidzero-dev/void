import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vite-plus/test';
import type { AdminPlanPreview, AdminPlanProgress } from '../../src/admin/plans.ts';
import { app } from '../../src/index.ts';
import { readPlanCatalog } from '../../src/plans.ts';
import { operatorEvents, users } from '../../src/schema.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';
import { nativeFormSubmission } from './native-form-browser.ts';

let env: TestEnv;
let cookie: string;
let failedAccount: string | undefined;
const origin = 'https://api.example.com';
const home = '/admin/config/plans';
const reevaluated: Array<string> = [];
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  failedAccount = undefined;
  reevaluated.length = 0;
  const admin = await createTestUser(
    env.db,
    'administrator',
    'github',
    undefined,
    'custom',
    'admin',
  );
  cookie = `admin_token=${admin.adminJwt}`;
  env.USAGE_COUNTER = {
    idFromName: (id: string) => id,
    get: (id: string) => ({
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === '/reevaluate-limits') {
          if (id === failedAccount) {
            return new Response('unavailable', { status: 503 });
          }
          reevaluated.push(id);
        }
        return Response.json({ ok: true });
      },
    }),
  } as unknown as DurableObjectNamespace;
});
function request(
  path: string,
  form?: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: form ? 'POST' : 'GET',
      headers: {
        Cookie: cookie,
        ...(form ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      ...(form ? { body: new URLSearchParams(form) } : {}),
    }),
    env,
  );
}
async function preview(action: string, id: string, fields: Record<string, string> = {}) {
  const revision = (await readPlanCatalog(env.db)).revision;
  const response = await request(
    `${home}/preview`,
    { action, id, revision: String(revision), ...fields },
    { 'X-VoidPages': 'true' },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { props: { preview: AdminPlanPreview } }).props.preview;
}
function apply(change: AdminPlanPreview) {
  return request(
    `${home}/apply`,
    {
      action: change.action,
      id: change.target,
      revision: String(change.expectedRevision),
      body: JSON.stringify(change.body),
    },
    { 'X-VoidPages': 'true' },
  );
}
async function editFields(id: string) {
  const plan = (await readPlanCatalog(env.db)).plans.find((plan) => plan.id === id)!;
  return {
    name: plan.name,
    buildInstanceType: plan.buildInstanceType,
    ...(plan.allowShortSlugs ? { allowShortSlugs: 'true' } : {}),
    ...Object.fromEntries(Object.entries(plan.limits).map(([key, value]) => [key, String(value)])),
  };
}

describe('administrator plan dashboard', () => {
  test('reviews the replacement policy before removing an assigned plan', async () => {
    await createTestUser(env.db, 'replacement-owner', 'github', undefined, 'pro');
    const response = await request(home + '/preview', {
      action: 'remove',
      id: 'pro',
      revision: '0',
      replacementPlanId: 'free',
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Move accounts to');
    expect(html).toContain('Maximum app CPU per request (ms)');
    expect(html).toContain('100,000,000');
    expect(html).toContain('3,000,000');
    expect(html).toContain('Short project names');
    expect(html).toContain('Not allowed');
    expect((await readPlanCatalog(env.db)).revision).toBe(0);
  });

  test('requires an administrator and same-origin writes before changing the catalog', async () => {
    expect((await request(home, undefined, { Cookie: '' })).status).toBe(302);
    const regular = await createTestUser(env.db, 'regular');
    expect(
      (await request(home, undefined, { Cookie: `admin_token=${regular.adminJwt}` })).status,
    ).toBe(403);
    expect(
      (
        await request(
          `${home}/preview`,
          { action: 'default', id: 'pro', revision: '0' },
          { Origin: 'https://attacker.example' },
        )
      ).status,
    ).toBe(403);
    expect((await readPlanCatalog(env.db)).revision).toBe(0);
    expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
  });

  test('renders plans, existing values, native forms and page navigation with private headers', async () => {
    for (const path of [home, `${home}/new`, `${home}/free/edit`]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin');
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      const html = await response.text();
      expect(html).toContain('href="/admin/config/plans"');
      expect(html).toContain('__VOID_PAGE_DATA__');
      if (path.endsWith('/free/edit')) {
        expect(html).toContain('value="3000000"');
        expect(html).toContain('Review changes');
        expect(html).toContain('Replacement plan');
      }
      const navigation = await request(path, undefined, { 'X-VoidPages': 'true' });
      expect(await navigation.json()).toMatchObject({
        component: path === home ? 'plans' : 'planEdit',
      });
    }
    expect((await request(`${home}/missing/edit`)).status).toBe(404);
  });

  test('a native browser form previews without applying, with an origin-only referrer', async () => {
    expect(
      await nativeFormSubmission({
        env,
        origin,
        cookie,
        path: `${home}/free/edit?private=query`,
        fields: { name: 'Starter', requestsPerMonth: '1000' },
        button: 'Review changes',
      }),
    ).toEqual({
      pagePolicy: 'strict-origin',
      submission: { origin, referrer: `${origin}/`, status: 200 },
    });
    expect((await readPlanCatalog(env.db)).revision).toBe(0);
    expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
  });

  test('reviews exact limits, rejects invalid and stale submissions, and audits application', async () => {
    const fields = await editFields('free');
    const proposed = await preview('set', 'free', {
      ...fields,
      name: 'Starter',
      requestsPerMonth: '1000',
    });
    expect(proposed.after.plans.find((plan) => plan.id === 'free')).toMatchObject({
      name: 'Starter',
      limits: { requestsPerMonth: 1000 },
    });
    expect((await readPlanCatalog(env.db)).revision).toBe(0);
    const saved = await apply(proposed);
    expect(saved.status).toBe(303);
    expect(saved.headers.get('Location')).toBe(`${home}/free/edit?notice=plan-saved&revision=1`);
    const updated = await request(saved.headers.get('Location')!);
    expect(await updated.text()).toContain('Edit Starter');
    expect((await apply(proposed)).status).toBe(409);
    expect(
      (
        await request(`${home}/preview`, {
          ...fields,
          action: 'set',
          id: 'free',
          revision: '1',
          requestsPerMonth: '1.5',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`${home}/preview`, {
          ...fields,
          action: 'set',
          id: 'free',
          revision: '1',
          cpuMsPerRequest: '100',
          maxCpuMsPerRequest: '10',
        })
      ).status,
    ).toBe(400);
    expect((await readPlanCatalog(env.db)).revision).toBe(1);
    expect(await env.db.select().from(operatorEvents)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'success', http_status: 303 }),
        expect.objectContaining({ status: 'failed', http_status: 409 }),
      ]),
    );
  });

  test('adds reserved-looking IDs, defaults, archives, restores, resets and removes with account replacement', async () => {
    const add = await preview('add', 'new', { name: 'New plan', copyFrom: 'pro' });
    expect((await apply(add)).status).toBe(303);
    expect(await (await request(`${home}/new/edit`)).text()).toContain('Edit New plan');
    expect((await apply(await preview('default', 'new'))).status).toBe(303);
    expect((await readPlanCatalog(env.db)).defaultPlanId).toBe('new');
    expect((await apply(await preview('default', 'free'))).status).toBe(303);
    expect((await apply(await preview('archive', 'new', { archived: 'true' }))).status).toBe(303);
    expect((await apply(await preview('archive', 'new', { archived: 'false' }))).status).toBe(303);
    const account = await createTestUser(env.db, 'assigned', 'github', undefined, 'new');
    const original = (await env.db.select().from(users).where(eq(users.id, account.id)))[0]!;
    expect(
      (
        await request(`${home}/preview`, {
          action: 'remove',
          id: 'new',
          revision: String((await readPlanCatalog(env.db)).revision),
        })
      ).status,
    ).toBe(409);
    const remove = await preview('remove', 'new', { replacementPlanId: 'pro' });
    expect(remove.affectedAccounts).toBe(1);
    const removed = await apply(remove);
    expect(removed.status).toBe(303);
    expect(removed.headers.get('Location')).toBe(
      `${home}?notice=plan-removed&revision=${remove.expectedRevision + 1}`,
    );
    expect((await env.db.select().from(users).where(eq(users.id, account.id)))[0]).toMatchObject({
      plan: 'pro',
      billing_cycle_start: original.billing_cycle_start,
    });
    expect(reevaluated).toContain(account.id);
    expect((await apply(await preview('reset', 'free'))).status).toBe(303);
  });

  test('saves interrupted propagation, exposes pending work and resumes through the JSON endpoint', async () => {
    const account = await createTestUser(env.db, 'affected');
    failedAccount = account.id;
    const change = await preview('set', 'free', {
      ...(await editFields('free')),
      requestsPerMonth: '1000',
    });
    const result = await apply(change);
    expect(await result.json()).toMatchObject({
      component: 'planProgress',
      props: {
        initial: { complete: false, error: expect.any(String), processed: 0, revision: 1 },
        target: 'free',
        returnTo: `${home}/free/edit?notice=plan-saved&revision=1`,
      },
    });
    expect(await (await request(home)).text()).toContain('Continue account updates');
    expect(await (await request(`${home}/free/edit`)).text()).not.toContain('Review changes');
    failedAccount = undefined;
    const response = await app.fetch(
      new Request(`${origin}${home}/sync`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1 }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      complete: true,
      processed: 1,
      revision: 1,
      error: null,
    });
    expect((await readPlanCatalog(env.db)).reconciliation?.complete).toBe(true);
    const resumed = await request(`${home}/resume`, { revision: '1', id: 'free' });
    expect(resumed.status).toBe(303);
    expect(resumed.headers.get('Location')).toBe(`${home}/free/edit?notice=plan-saved&revision=1`);
  });

  test('Fate serves the catalog only for supported plan routes', async () => {
    for (const path of [
      home,
      `${home}/new`,
      `${home}/free/edit`,
      '/admin/users',
      `${home}/apply`,
      'https://attacker.example/admin/config/plans',
    ]) {
      const response = await app.fetch(
        new Request(`${origin}/admin/fate`, {
          method: 'POST',
          headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            operations: [
              {
                id: 'plans',
                kind: 'query',
                name: 'plans',
                args: { path },
                select: ['id', 'catalog', 'accounts', 'selectedPlanId'],
              },
            ],
          }),
        }),
        env,
      );
      const body = (await response.json()) as { results: Array<{ ok: boolean }> };
      expect(body.results[0]?.ok).toBe(
        path === home || path === `${home}/new` || path === `${home}/free/edit`,
      );
    }
  });

  test('the built dashboard navigates, edits, reviews and automatically completes multiple account batches', async () => {
    for (let i = 0; i < 31; i++) {
      await createTestUser(env.db, `browser-account-${i}`);
    }
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      await context.addCookies([
        {
          name: 'admin_token',
          value: cookie.slice('admin_token='.length),
          url: origin,
          httpOnly: true,
          secure: true,
        },
      ]);
      const page = await context.newPage();
      const errors: Array<string> = [];
      const syncs: Array<AdminPlanProgress> = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const client = await readFile(
        new URL('../../dist/admin-assets/admin/client.js', import.meta.url),
      );
      const css = await readFile(
        new URL('../../dist/admin-assets/admin/style.css', import.meta.url),
      );
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) {
          return route.abort();
        }
        if (url.pathname === '/admin/client.js' || url.pathname === '/admin/style.css') {
          return route.fulfill({
            contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css',
            body: url.pathname.endsWith('.js') ? client : css,
          });
        }
        const response = await app.fetch(
          new Request(request.url(), {
            method: request.method(),
            headers: await request.allHeaders(),
            ...(['GET', 'HEAD'].includes(request.method())
              ? {}
              : { body: request.postData() ?? '' }),
          }),
          env,
        );
        if (url.pathname === `${home}/sync` && response.ok) {
          syncs.push((await response.clone().json()) as AdminPlanProgress);
        }
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      await page.goto(`${origin}${home}`);
      await page.locator('[data-hydrated="true"]').waitFor();
      await page.evaluate(() => {
        document.documentElement.dataset.plansNavigation = 'ready';
      });
      await page
        .getByRole('row')
        .filter({ has: page.getByRole('link', { name: 'free', exact: true }) })
        .getByRole('link', { name: 'Edit', exact: true })
        .click();
      await page.getByRole('heading', { name: 'Edit free', exact: true }).waitFor();
      expect(await page.evaluate(() => document.documentElement.dataset.plansNavigation)).toBe(
        'ready',
      );
      await page.locator('input[name="name"]').fill('Starter');
      await page.locator('input[name="requestsPerMonth"]').fill('1000');
      await page.getByRole('button', { name: 'Review changes', exact: true }).click();
      await page.getByRole('heading', { name: 'Review plan change', exact: true }).waitFor();
      expect((await readPlanCatalog(env.db)).revision).toBe(0);
      expect(await page.locator('body').innerText()).toContain('31 existing accounts affected');
      await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
      await page.getByRole('heading', { name: 'Edit Starter', exact: true }).waitFor();
      const confirmation = page
        .locator('.astryx-toast[role="status"]')
        .filter({ hasText: 'Plan saved.' });
      await confirmation.waitFor();
      expect(await page.locator('input[name="requestsPerMonth"]').inputValue()).toBe('1000');
      expect(new URL(page.url()).pathname).toBe(`${home}/free/edit`);
      expect(new URL(page.url()).search).toBe('');
      const toastBox = (await confirmation.boundingBox())!;
      expect(toastBox.x + toastBox.width / 2).toBeCloseTo(page.viewportSize()!.width / 2, 0);
      expect(toastBox.y).toBeLessThan(64);
      await page.setViewportSize({ width: 390, height: 844 });
      const mobileToastBox = (await confirmation.boundingBox())!;
      expect(mobileToastBox.x).toBeGreaterThanOrEqual(0);
      expect(mobileToastBox.x + mobileToastBox.width).toBeLessThanOrEqual(390);
      expect(mobileToastBox.x + mobileToastBox.width / 2).toBeCloseTo(195, 0);
      await page.bringToFront();
      await confirmation.waitFor({ state: 'hidden', timeout: 8000 });
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.reload();
      await page.locator('[data-hydrated="true"]').waitFor();
      expect(await page.locator('.astryx-toast').filter({ hasText: 'Plan saved.' }).count()).toBe(
        0,
      );
      expect(syncs).toEqual([
        expect.objectContaining({ processed: 6, complete: true, revision: 1 }),
      ]);
      expect(new Set(reevaluated).size).toBe(31);
      await page
        .getByRole('navigation', { name: 'Admin sections', exact: true })
        .getByRole('link', { name: 'Plans', exact: true })
        .click();
      await page.getByRole('link', { name: 'Starter', exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
