import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { chromium } from 'playwright';
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vite-plus/test';
import { respondToProjectInvitation } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import * as systemOperations from '../../src/operator/system-operations.ts';
import {
  deployments,
  domains,
  githubInstallations,
  invitations,
  platformSettings,
  platformLoginConnections,
  platformLoginRevisions,
  operatorEvents,
  projectAccessEvents,
  projectCleanupJobs,
  projectInvitations,
  projectMembers,
  projectOwnershipPeriods,
  projectZeroTrust,
  projects,
  users,
} from '../../src/schema.ts';
import {
  setupEnv,
  teardownEnv,
  captureQueries,
  clearTables,
  createTestUser,
  createTestProject,
  createTestDeployment,
  mockCfApi,
  skipOrphanSweepDelay,
  type TestEnv,
} from './helpers.ts';
import { nativeFormSubmission } from './native-form-browser.ts';
import { createUsageCounterFixture } from './usage-counter-fixture.ts';

let env: TestEnv;
let manifestCounter = 0;

function visibleMarkup(html: string): string {
  return html.replaceAll('<!-- -->', '');
}

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
  env.REQUESTS_DATASET = 'void_requests';
});

afterEach(() => {
  vi.restoreAllMocks();
});

function req(
  path: string,
  cookie?: string,
  init?: RequestInit,
  overrides?: Partial<ApiEnv['Bindings']>,
): Response | Promise<Response> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  const method = init?.method?.toUpperCase() ?? 'GET';
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && headers.Origin === undefined) {
    headers.Origin = 'http://localhost';
  }
  if (cookie) {
    headers.Cookie = `admin_token=${cookie}`;
  }
  return app.fetch(
    new Request(`http://localhost${path}`, { ...init, headers, redirect: 'manual' }),
    { ...env, ...overrides },
  );
}

function tableRowContaining(html: string, needle: string): string {
  const needleIndex = html.indexOf(needle);
  expect(needleIndex).toBeGreaterThan(-1);
  const rowStart = html.lastIndexOf('<tr', needleIndex);
  const rowEnd = html.indexOf('</tr>', needleIndex);
  expect(rowStart).toBeGreaterThan(-1);
  expect(rowEnd).toBeGreaterThan(rowStart);
  return html.slice(rowStart, rowEnd);
}

function fateQuery(name: string, path: string, select: Array<string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      operations: [{ id: 'page', kind: 'query', name, args: { path }, select }],
    }),
  };
}

describe('auth middleware', () => {
  test.each([
    ['/admin', '/admin/'],
    ['/admin?source=bookmark', '/admin/?source=bookmark'],
  ])('redirects %s to %s', async (path, destination) => {
    const response = await req(path);
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe(destination);
  });

  test('protects the admin Fate endpoint with admin auth and same-origin CSRF', async () => {
    const regular = await createTestUser(env.db, 'fate-regular');
    const admin = await createTestUser(env.db, 'fate-admin', 'github', undefined, 'free', 'admin');
    const query = fateQuery('usersPage', '/admin/users', ['id', 'users']);

    expect((await req('/admin/fate', undefined, query)).status).toBe(302);
    expect((await req('/admin/fate', regular.adminJwt, query)).status).toBe(403);
    expect(
      (
        await req('/admin/fate', admin.adminJwt, {
          ...query,
          headers: { 'content-type': 'application/json', Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect((await req('/admin/fate', admin.adminJwt, query)).status).toBe(200);
  });

  test('exposes typed admin page data through Fate without widening accepted routes', async () => {
    const admin = await createTestUser(
      env.db,
      'fate-page-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    await createTestUser(env.db, 'fate-page-member');
    const page = await req(
      '/admin/fate',
      admin.adminJwt,
      fateQuery('usersPage', '/admin/users?search=fate-page-member', ['id', 'users', 'search']),
    );
    expect(page.status).toBe(200);
    const body = (await page.json()) as {
      results: Array<{ ok: boolean; data?: { users?: Array<{ login: string }> } }>;
    };
    expect(body.results[0]?.ok).toBe(true);
    expect(body.results[0]?.data?.users?.map((user) => user.login)).toEqual(['fate-page-member']);

    const invalid = await req(
      '/admin/fate',
      admin.adminJwt,
      fateQuery('usersPage', '/operator/v1/users', ['id', 'users']),
    );
    const invalidBody = (await invalid.json()) as {
      results: Array<{ ok: boolean; error?: { code: string } }>;
    };
    expect(invalidBody.results[0]).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  test('Fate searches find users, projects, and deployments beyond the current page', async () => {
    const admin = await createTestUser(
      env.db,
      'search-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    const targetUser = await createTestUser(env.db, 'offpage-user');
    await env.db
      .update(users)
      .set({ created_at: '2020-01-01 00:00:00' })
      .where(eq(users.id, targetUser.id));
    const targetProject = await createTestProject(env.db, targetUser.id, 'offpage-project');
    await env.db
      .update(projects)
      .set({ created_at: '2020-01-01 00:00:00' })
      .where(eq(projects.id, targetProject.id));
    const deploymentProject = await createTestProject(
      env.db,
      admin.id,
      'offpage-deployment-project',
    );
    const targetDeployment = await createTestDeployment(env.db, deploymentProject.id, 'live');
    await env.db
      .update(deployments)
      .set({ created_at: '2020-01-01 00:00:00' })
      .where(eq(deployments.id, targetDeployment.id));
    for (let index = 0; index < 20; index++) {
      await createTestUser(env.db, `filler-user-${index}`);
      await createTestProject(env.db, admin.id, `filler-project-${index}`);
      await createTestDeployment(env.db, deploymentProject.id, 'live');
    }

    const ids = async (name: string, path: string, field: string) => {
      const response = await req(
        '/admin/fate',
        admin.adminJwt,
        fateQuery(name, path, ['id', field]),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        results: Array<{ ok: boolean; data?: Record<string, Array<{ id: string }>> }>;
      };
      expect(body.results[0]?.ok).toBe(true);
      return body.results[0]?.data?.[field]?.map((row) => row.id) ?? [];
    };

    expect(await ids('usersPage', '/admin/users', 'users')).not.toContain(targetUser.id);
    expect(await ids('usersPage', '/admin/users?search=offpage-user', 'users')).toContain(
      targetUser.id,
    );
    expect(await ids('projectsPage', '/admin/projects', 'projects')).not.toContain(
      targetProject.id,
    );
    expect(
      await ids('projectsPage', '/admin/projects?search=offpage-project', 'projects'),
    ).toContain(targetProject.id);
    expect(await ids('deploymentsPage', '/admin/deployments', 'deployments')).not.toContain(
      targetDeployment.id,
    );
    expect(
      await ids(
        'deploymentsPage',
        '/admin/deployments?search=offpage-deployment-project',
        'deployments',
      ),
    ).toContain(targetDeployment.id);
  });
  test('redirects to /admin/login without cookie', async () => {
    const res = await req('/admin/');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login');
  });

  test('redirects to /admin/login with invalid cookie', async () => {
    const res = await req('/admin/', 'invalid-token');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login');
  });

  test('returns 403 for non-admin user', async () => {
    const user = await createTestUser(env.db, 'regular');
    const res = await req('/admin/', user.adminJwt);
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Sign in with an administrator account for this platform.');
    expect(html).toContain('href="/admin/logout"');
    expect(html).not.toContain('suspended');
  });

  test('allows admin user', async () => {
    const admin = await createTestUser(env.db, 'admin', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/', admin.adminJwt);
    expect(res.status).toBe(200);
  });

  test.each(['/admin/', '/admin/users', '/admin/not-a-page'])(
    'protects %s for signed-out and non-admin users',
    async (path) => {
      const signedOut = await req(path);
      expect(signedOut.status).toBe(302);
      expect(signedOut.headers.get('Location')).toBe('/admin/login');
      const user = await createTestUser(env.db, 'regular');
      expect((await req(path, user.adminJwt)).status).toBe(403);
    },
  );

  test('checks admin auth once for the dashboard', async () => {
    const admin = await createTestUser(env.db, 'admin', 'github', undefined, 'free', 'admin');
    const { result, queries } = await captureQueries(env.db, async () =>
      req('/admin/', admin.adminJwt),
    );
    expect(result.status).toBe(200);
    expect(
      queries.filter((query) => query.includes('from "users" where "users"."id"')),
    ).toHaveLength(1);
  });

  test.each([
    { installed: true, names: ['api', 'proxy', 'dispatch', 'db'] },
    { installed: false, names: ['api', 'proxy', 'dashboard', 'dispatch', 'db'] },
  ])(
    'renders all system-status checks before polling (installed: $installed)',
    async ({ installed, names }) => {
      const admin = await createTestUser(
        env.db,
        'health-admin',
        'github',
        undefined,
        'free',
        'admin',
      );
      const response = await app.fetch(
        new Request('http://localhost/admin/', {
          headers: { Cookie: `admin_token=${admin.adminJwt}` },
        }),
        { ...env, PLATFORM_INSTALLATION_ID: installed ? 'inst_test' : undefined },
      );
      expect(response.status).toBe(200);
      const html = visibleMarkup(await response.text());
      const checks = html.split('id="health-checks"')[1]?.split('</ul>')[0];
      expect(checks).toBeDefined();
      expect(checks?.match(/class="void-admin-health-check"/g)).toHaveLength(names.length);
      const labels: Record<string, string> = {
        api: 'API',
        proxy: 'Proxy',
        dashboard: 'Dashboard',
        dispatch: 'Dispatch',
        db: 'Database',
      };
      for (const name of names) {
        expect(checks).toContain(`>${labels[name]}</span>`);
        expect(checks).toContain(`aria-label="${labels[name]}: Pending"`);
      }
      expect(checks).not.toContain('Checking…');
      expect(html).not.toContain('All health checks passed');
    },
  );

  test('serves authenticated React pages and Void navigation data', async () => {
    const admin = await createTestUser(env.db, 'react-admin', 'github', undefined, 'free', 'admin');
    const htmlResponse = await req('/admin/', admin.adminJwt);
    const html = await htmlResponse.text();
    expect(html).toContain('id="__VOID_PAGE_DATA__"');
    expect(html).toContain('<div id="app">');
    expect(html).toContain('src="/admin/client.js"');
    expect(html).toContain('href="/admin/style.css"');
    expect(html).toContain('class="astryx-app-shell');
    expect(htmlResponse.headers.get('Cache-Control')).toBe('private, no-store');

    const navigation = await req('/admin/users', admin.adminJwt, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(navigation.headers.get('X-VoidPages')).toBe('true');
    expect(navigation.headers.get('Vary')).toBe('X-VoidPages');
    expect(navigation.headers.get('Cache-Control')).toBe('private, no-store');
    expect(((await navigation.json()) as { component: string }).component).toBe('users');
  });

  test('keeps system-status geometry stable through loading, errors and failed refreshes', async () => {
    const admin = await createTestUser(
      env.db,
      'health-layout-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    const client = await readFile(
      new URL('../../dist/admin-assets/admin/client.js', import.meta.url),
    );
    const css = await readFile(new URL('../../dist/admin-assets/admin/style.css', import.meta.url));
    const browser = await chromium.launch();
    const detail =
      'The upstream service did not respond before the health-check deadline. Please retry later.';
    let state: 'loading' | 'healthy' | 'error' | 'unavailable' = 'loading';
    let releaseHealth: (() => void) | undefined;
    vi.spyOn(systemOperations, 'systemHealth').mockImplementation(async () => {
      if (state === 'loading') {
        await new Promise<void>((resolve) => {
          releaseHealth = resolve;
        });
      }
      if (state === 'unavailable') {
        throw new Error('Health endpoint unavailable');
      }
      return {
        allOk: state !== 'error',
        checks: ['api', 'proxy', 'dashboard', 'dispatch', 'db'].map((name) => ({
          name,
          ok: state !== 'error' || name !== 'proxy',
          latencyMs: 1,
          ...(state === 'error' && name === 'proxy' ? { error: detail } : {}),
        })),
      };
    });
    try {
      for (const width of [1280, 390, 320]) {
        state = 'loading';
        releaseHealth = undefined;
        const context = await browser.newContext({ viewport: { width, height: 844 } });
        await context.addCookies([
          { name: 'admin_token', value: admin.adminJwt, url: 'http://localhost' },
        ]);
        const page = await context.newPage();
        const errors: Array<string> = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.clock.install();
        await page.route('**/*', async (route) => {
          const incoming = route.request();
          const url = new URL(incoming.url());
          if (url.origin !== 'http://localhost') {
            return route.abort();
          }
          if (url.pathname === '/admin/client.js' || url.pathname === '/admin/style.css') {
            return route.fulfill({
              contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css',
              body: url.pathname.endsWith('.js') ? client : css,
            });
          }
          const response = await app.fetch(
            new Request(incoming.url(), {
              method: incoming.method(),
              headers: await incoming.allHeaders(),
              ...(incoming.method() === 'POST' ? { body: incoming.postData() ?? '' } : {}),
            }),
            { ...env, DEV_AUTH_BYPASS: 'true' },
          );
          await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          });
        });
        await page.goto('http://localhost/admin/');
        await page.locator('[data-hydrated="true"]').waitFor();
        await expect.poll(() => releaseHealth !== undefined).toBe(true);
        const sizes: Array<{ width: number; height: number }> = [];
        await page.exposeFunction('recordHealthSize', (width: number, height: number) => {
          sizes.push({ width, height });
        });
        await page.evaluate(() => {
          const record = (
            window as unknown as {
              recordHealthSize: (width: number, height: number) => void;
            }
          ).recordHealthSize;
          new ResizeObserver(([entry]) => {
            record(entry.contentRect.width, entry.contentRect.height);
          }).observe(document.querySelector('#health-status')!);
        });
        const geometry = () =>
          page.evaluate(() =>
            ['#health-status', '#health-status .astryx-layout-header', '#health-checks'].map(
              (selector) => {
                const { x, y, width, height } = document
                  .querySelector(selector)!
                  .getBoundingClientRect();
                return { x, y, width, height };
              },
            ),
          );
        const loading = await geometry();
        expect(
          await page
            .locator('#health-status .astryx-layout-header')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        ).not.toBe('rgba(0, 0, 0, 0)');
        state = 'healthy';
        releaseHealth!();
        await page.locator('#health-status[data-state="healthy"]').waitFor();
        expect(await geometry()).toEqual(loading);
        state = 'error';
        await page.clock.runFor(30_000);
        await page.locator('#health-status[data-state="error"]').waitFor();
        expect(await geometry()).toEqual(loading);
        const failedService = page
          .locator('.void-admin-health-service')
          .filter({ hasText: detail });
        await failedService.focus();
        await page.getByRole('tooltip').filter({ hasText: detail }).waitFor();
        expect(await geometry()).toEqual(loading);
        state = 'unavailable';
        await page.clock.runFor(30_000);
        await page.locator('#health-status[data-state="unavailable"]').waitFor();
        expect(await geometry()).toEqual(loading);
        state = 'healthy';
        await page.clock.runFor(30_000);
        await page.locator('#health-status[data-state="healthy"]').waitFor();
        expect(await geometry()).toEqual(loading);
        await expect.poll(() => sizes.length).toBeGreaterThan(0);
        expect(new Set(sizes.map((size) => JSON.stringify(size))).size).toBe(1);
        expect(errors).toEqual([]);
        await context.close();
      }
    } finally {
      releaseHealth?.();
      await browser.close();
    }
  }, 30_000);

  test('does not expose the retired platform operations pages', async () => {
    const admin = await createTestUser(env.db, 'admin', 'github', undefined, 'free', 'admin');
    const dashboard = await req('/admin/', admin.adminJwt);
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).not.toContain('href="/admin/platform"');

    for (const path of ['/admin/platform', '/admin/platform/api']) {
      const response = await req(path, admin.adminJwt);
      expect(response.status).toBe(404);
    }
  });

  test('uses the installation name in admin login and page titles', async () => {
    const namedEnv = { ...env, PLATFORM_DISPLAY_NAME: '<Example Platform>' };
    const login = await app.fetch(new Request('http://localhost/admin/login'), namedEnv);
    expect(await login.text()).toContain(
      '<title>Admin Login · &lt;Example Platform&gt; · Void</title>',
    );

    const admin = await createTestUser(env.db, 'named-admin', 'github', undefined, 'free', 'admin');
    for (const path of ['/admin/', '/admin/users']) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, {
          headers: { Cookie: `admin_token=${admin.adminJwt}` },
        }),
        namedEnv,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        `<title>${path === '/admin/' ? 'Dashboard' : 'Users'} · &lt;Example Platform&gt; · Void</title>`,
      );
    }
  });

  test('returns 403 for an administrator suspended by another administrator', async () => {
    const admin = await createTestUser(
      env.db,
      'suspended-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, admin.id));

    const res = await req('/admin/', admin.adminJwt);

    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('Administrator access suspended');
    expect(html).toContain('Contact another platform administrator to restore access.');
    expect(html).toContain('href="/admin/logout"');
    expect(html).not.toContain('admin_suspended');
  });

  test('allows an administrator suspended only by a usage limit', async () => {
    const admin = await createTestUser(
      env.db,
      'usage-suspended-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, admin.id));

    const res = await req('/admin/', admin.adminJwt);

    expect(res.status).toBe(200);
  });

  test('rejects same-site sibling origins for admin mutations', async () => {
    const admin = await createTestUser(env.db, 'admin-csrf', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/signup-control/toggle', admin.adminJwt, {
      method: 'POST',
      headers: { Origin: 'https://attacker.apps.example.com' },
    });
    expect(res.status).toBe(403);
  });

  test('rejects admin mutations without browser origin evidence', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-csrf-missing',
      'github',
      undefined,
      'free',
      'admin',
    );
    const res = await req('/admin/signup-control/toggle', admin.adminJwt, {
      method: 'POST',
      headers: { Origin: '' },
    });
    expect(res.status).toBe(403);
  });

  test.each(['https://attacker.example.com/private', 'http://localhost'])(
    'renders recovery navigation for rejected browser writes from %s',
    async (origin) => {
      const admin = await createTestUser(
        env.db,
        'admin-recovery',
        'github',
        undefined,
        'free',
        'admin',
      );
      // The same host with a different scheme passes the first guard and reaches the
      // stricter CSRF middleware; both guards must give browser users a way back.
      const res = await app.fetch(
        new Request('https://localhost/admin/signup-control/toggle', {
          method: 'POST',
          headers: {
            Cookie: `admin_token=${admin.adminJwt}`,
            Origin: origin,
            Accept: 'text/html,application/xhtml+xml',
          },
        }),
        env,
      );
      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('Refresh the dashboard and try again.');
      expect(html).toContain('href="/admin/"');
      expect(html).not.toContain(origin);
      expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
    },
  );
});

const zeroTrustCredential = 'stored-access-management-credential';

function zeroTrustSetting(overrides: Record<string, unknown> = {}) {
  return {
    key: 'zeroTrust.configuration',
    value: {
      version: 1,
      revision: 918273645,
      enabled: true,
      protectNewProjects: true,
      accountId: 'zero-trust-account',
      teamDomain: 'https://company.cloudflareaccess.com',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      credential: { ciphertext: zeroTrustCredential, iv: 'credential-iv', keyVersion: 'v1' },
      wildcardApplicationName: 'managed-wildcard-name',
      wildcardApplication: {
        id: 'managed-wildcard-id',
        name: 'managed-wildcard-name',
        audience: 'managed-wildcard-audience',
        destinations: ['*.example.com'],
      },
      operation: null,
      lastError: null,
      updatedAt: '2026-09-22T00:00:00.000Z',
      ...overrides,
    },
  };
}

const configuringZeroTrust = {
  enabled: false,
  wildcardApplication: null,
  operation: {
    id: 'configure-operation',
    kind: 'configure',
    phase: 'public-bypasses',
    owner: null,
    leaseExpiresAt: null,
    startedAt: '2026-09-22T00:00:00.000Z',
    existingProjects: 'public',
  },
};

function pageSnapshot(html: string): string {
  const match =
    /<script id="__VOID_PAGE_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  expect(match).not.toBeNull();
  const page = JSON.parse(match![1]!) as { shared: { adminFateSnapshot?: unknown } };
  expect(page.shared.adminFateSnapshot).toBeDefined();
  return JSON.stringify(page.shared.adminFateSnapshot);
}

function checkedValues(html: string, name: string): Array<string> {
  return Array.from(html.matchAll(/<input\b[^>]*>/g), ([tag]) => tag)
    .filter((tag) => tag.includes(`name="${name}"`) && tag.includes(' checked=""'))
    .map((tag) => /value="([^"]*)"/.exec(tag)?.[1] ?? '');
}

function expectNoZeroTrustSecrets(text: string) {
  for (const secret of [
    zeroTrustCredential,
    'credential-iv',
    '918273645',
    'managed-wildcard-id',
    'managed-wildcard-name',
    'managed-wildcard-audience',
    env.CF_API_TOKEN,
  ]) {
    expect(text).not.toContain(secret);
  }
}

describe('admin Zero Trust', () => {
  test('admits native setup form validation while retaining its exact-origin CSRF guard', async () => {
    const admin = await createTestUser(env.db, 'zt-native', 'github', undefined, 'free', 'admin');
    const origin = 'https://api.example.com';
    const input = {
      env,
      origin,
      cookie: `admin_token=${admin.adminJwt}`,
      path: '/admin/zero-trust?test=private-query',
      fields: {
        apiToken: 'synthetic-form-token',
        identityProviderIds: '   ',
        policyIds: 'policy-1',
      },
      button: 'Save and reconcile',
    };
    expect(await nativeFormSubmission({ ...input, noReferrer: true })).toEqual({
      pagePolicy: 'strict-origin',
      submission: { origin: 'null', referrer: undefined, status: 403 },
    });
    expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
    expect(await nativeFormSubmission(input)).toEqual({
      pagePolicy: 'strict-origin',
      submission: { origin, referrer: `${origin}/`, status: 400 },
    });
    // Empty provider IDs fail validation before any Cloudflare request or mutation.
    expect(await env.db.select().from(platformSettings)).toHaveLength(0);
  });

  test('renders the installation page without exposing a credential', async () => {
    const admin = await createTestUser(
      env.db,
      'zero-trust-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    await env.db.insert(platformSettings).values(zeroTrustSetting(configuringZeroTrust));
    const project = await createTestProject(env.db, admin.id, 'zero-trust-admin-status');
    await env.db.insert(projectZeroTrust).values({
      project_id: project.id,
      desired_protected: false,
      effective_protected: false,
      status: 'ready',
    });

    const res = await req('/admin/zero-trust', admin.adminJwt);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin');
    const html = await res.text();
    const visible = visibleMarkup(html);
    expect(visible).toContain('Project Zero Trust');
    expect(visible).toContain('Protect new projects by default');
    expect(visible).toContain('zero-trust-account');
    expect(visible).toContain('configure · public-bypasses');
    expect(visible).toContain('pending operation will resume');
    expect(visible).toContain('Cancel setup and clean up');
    expect(visible).toContain('Project states');
    expect(html).toContain('action="/admin/zero-trust/configure"');
    expect(html).toContain('action="/admin/zero-trust/reconcile"');
    expect(html).toContain('action="/admin/zero-trust/disable"');
    expect(html).toContain(
      'data-confirm="Remove Void-managed Access protection? Apps may become public or be blocked by account-wide Default-Deny."',
    );
    expect(html).toContain('name="apiToken"');
    expect(html.toLowerCase()).toContain('autocomplete="new-password"');
    expect(checkedValues(html, 'existingProjects')).toEqual(['public']);
    expect(html).toContain('name="protectNewProjects" value="yes"');
    // Zero Trust always uses the installation account; there is no account field.
    expect(html).not.toContain('name="accountId"');
    expectNoZeroTrustSecrets(html);
    expectNoZeroTrustSecrets(pageSnapshot(html));
  });

  test('keeps managed application identifiers out of an enabled installation page', async () => {
    const admin = await createTestUser(env.db, 'zt-enabled', 'github', undefined, 'free', 'admin');
    await env.db.insert(platformSettings).values(zeroTrustSetting());
    // The seeded credential cannot be decrypted, so the live check reports drift.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await req('/admin/zero-trust', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    const visible = visibleMarkup(html);
    expect(visible).toContain('Enabled');
    expect(visible).toContain('Not checked');
    expect(html).toContain('href="/admin/zero-trust?check=1"');
    expect(visible).toContain('Disable Zero Trust');
    // Existing projects keep their protection once Zero Trust is enabled.
    expect(html).not.toContain('name="existingProjects"');
    expectNoZeroTrustSecrets(html);
    expectNoZeroTrustSecrets(pageSnapshot(html));
    // A plain page view reads saved state only.
    expect(logged).not.toHaveBeenCalledWith(
      '[zero-trust] live status check failed',
      expect.anything(),
    );

    const checked = await req('/admin/zero-trust?check=1', admin.adminJwt);
    expect(checked.status).toBe(200);
    const checkedHtml = await checked.text();
    expect(visibleMarkup(checkedHtml)).toContain('Missing or drifted');
    expectNoZeroTrustSecrets(checkedHtml);
    expectNoZeroTrustSecrets(pageSnapshot(checkedHtml));
    expect(logged).toHaveBeenCalledWith('[zero-trust] live status check failed', expect.anything());
  });

  test('serves a fixed redacted shape through Fate for the Zero Trust path only', async () => {
    const admin = await createTestUser(env.db, 'zt-fate', 'github', undefined, 'free', 'admin');
    await env.db.insert(platformSettings).values(zeroTrustSetting(configuringZeroTrust));
    const fields = [
      'id',
      'configured',
      'enabled',
      'status',
      'accountId',
      'teamDomain',
      'identityProviderIds',
      'policyIds',
      'protectNewProjects',
      'operation',
      'lastError',
      'checked',
      'live',
      'projects',
    ];

    const page = await req(
      '/admin/fate',
      admin.adminJwt,
      fateQuery('zeroTrust', '/admin/zero-trust', fields),
    );
    expect(page.status).toBe(200);
    const text = await page.text();
    expectNoZeroTrustSecrets(text);
    const body = JSON.parse(text) as {
      results: Array<{ ok: boolean; data?: Record<string, unknown> }>;
    };
    expect(body.results[0]?.ok).toBe(true);
    expect(body.results[0]?.data).toEqual({
      id: '/admin/zero-trust',
      configured: true,
      enabled: false,
      status: 'configuring',
      accountId: 'zero-trust-account',
      teamDomain: 'https://company.cloudflareaccess.com',
      identityProviderIds: ['idp-1'],
      policyIds: ['policy-1'],
      protectNewProjects: true,
      operation: { kind: 'configure', phase: 'public-bypasses', existingProjects: 'public' },
      lastError: null,
      checked: false,
      live: null,
      projects: [],
    });

    const invalid = await req(
      '/admin/fate',
      admin.adminJwt,
      fateQuery('zeroTrust', '/admin/users', ['id', 'configured']),
    );
    const invalidBody = (await invalid.json()) as {
      results: Array<{ ok: boolean; error?: { code: string } }>;
    };
    expect(invalidBody.results[0]).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  test('serves page-object navigation and a navigation link', async () => {
    const admin = await createTestUser(env.db, 'zt-nav', 'github', undefined, 'free', 'admin');
    const navigation = await req('/admin/zero-trust', admin.adminJwt, {
      headers: { 'X-VoidPages': 'true' },
    });
    expect(navigation.status).toBe(200);
    expect(navigation.headers.get('X-VoidPages')).toBe('true');
    expect(navigation.headers.get('Cache-Control')).toBe('no-store');
    expect(navigation.headers.get('Referrer-Policy')).toBe('strict-origin');
    const pageObject = (await navigation.json()) as { component: string; shared: object };
    expect(pageObject.component).toBe('zeroTrust');
    expect(pageObject.shared).not.toHaveProperty('adminFateSnapshot');

    const dashboard = await (await req('/admin/', admin.adminJwt)).text();
    expect(dashboard).toContain('href="/admin/zero-trust"');
  });

  test('shows why project protection cannot change when Zero Trust is not enabled', async () => {
    const admin = await createTestUser(env.db, 'zt-project', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'zt-project-off');

    const html = await (await req(`/admin/projects/${project.id}`, admin.adminJwt)).text();
    const visible = visibleMarkup(html);
    expect(html).toContain('id="zero-trust"');
    expect(visible).toContain('Platform: not configured');
    expect(visible).toContain('Project Zero Trust is not enabled.');
    expect(html).toContain('href="/admin/zero-trust"');
    expect(html).not.toContain(`action="/admin/projects/${project.id}/zero-trust"`);
    expect(html).not.toContain(`action="/admin/projects/${project.id}/zero-trust/reconcile"`);
  });

  test('shows project protection actions from saved state without calling Cloudflare', async () => {
    const admin = await createTestUser(env.db, 'zt-ready', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'zt-project-ready');
    await env.db.insert(platformSettings).values(zeroTrustSetting());
    await env.db.insert(projectZeroTrust).values({
      project_id: project.id,
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    const fetched = vi.spyOn(globalThis, 'fetch');
    // The seeded credential cannot be decrypted, so a live status check would fail before
    // fetch and only show up as this log line.
    const logged = vi.spyOn(console, 'error');

    const html = await (await req(`/admin/projects/${project.id}`, admin.adminJwt)).text();
    const visible = visibleMarkup(html);
    expect(visible).toContain('Platform: enabled');
    expect(visible).toContain('Desired: protected');
    expect(visible).toContain('Effective: protected');
    expect(html).toContain(`action="/admin/projects/${project.id}/zero-trust"`);
    expect(html).toContain('name="protected" value="false"');
    expect(visible).toContain('Make project public');
    expect(html).toContain(`action="/admin/projects/${project.id}/zero-trust/reconcile"`);
    // The server-side Fate client calls the local /admin/fate handler.
    const external = fetched.mock.calls
      .map(([input]) => (input instanceof Request ? input.url : String(input)))
      .filter((url) => !url.startsWith('http://localhost/'));
    expect(external).toEqual([]);
    expect(logged).not.toHaveBeenCalledWith(
      '[zero-trust] live status check failed',
      expect.anything(),
    );
    expectNoZeroTrustSecrets(html);
  });

  test('hides project protection actions while an installation operation runs', async () => {
    const admin = await createTestUser(env.db, 'zt-busy', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'zt-project-busy');
    await env.db.insert(platformSettings).values(
      zeroTrustSetting({
        operation: {
          id: 'reconcile-operation',
          kind: 'reconcile',
          phase: 'projects',
          owner: null,
          leaseExpiresAt: null,
          startedAt: '2026-09-22T00:00:00.000Z',
          existingProjects: null,
        },
      }),
    );

    const html = await (await req(`/admin/projects/${project.id}`, admin.adminJwt)).text();
    expect(visibleMarkup(html)).toContain('Platform: enabled, configuring');
    expect(visibleMarkup(html)).toContain('A Zero Trust reconcile operation is running.');
    expect(html).not.toContain(`action="/admin/projects/${project.id}/zero-trust"`);
    expect(html).not.toContain(`action="/admin/projects/${project.id}/zero-trust/reconcile"`);
  });

  test('hides project protection actions while the installation needs attention', async () => {
    const admin = await createTestUser(env.db, 'zt-error', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'zt-project-error');
    await env.db
      .insert(platformSettings)
      .values(zeroTrustSetting({ lastError: 'Access token was revoked' }));

    const html = await (await req(`/admin/projects/${project.id}`, admin.adminJwt)).text();
    const visible = visibleMarkup(html);
    expect(visible).toContain('Platform: enabled, needs attention');
    expect(visible).toContain('Platform Zero Trust status: needs attention.');
    expect(html).not.toContain(`action="/admin/projects/${project.id}/zero-trust"`);
  });

  test('rejects an invalid project protection form value', async () => {
    const admin = await createTestUser(
      env.db,
      'zero-trust-project-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    const project = await createTestProject(env.db, admin.id, 'zero-trust-project-form');

    const res = await req(`/admin/projects/${project.id}/zero-trust`, admin.adminJwt, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ protected: 'invalid' }).toString(),
    });

    expect(res.status).toBe(400);
    expect(visibleMarkup(await res.text())).toContain('Project protection must be true or false.');
  });

  test('renders an invalid installation form as an admin error page', async () => {
    const admin = await createTestUser(env.db, 'zt-form', 'github', undefined, 'free', 'admin');

    const res = await req('/admin/zero-trust/configure', admin.adminJwt, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        apiToken: 'form-token-value',
        identityProviderIds: '',
        policyIds: 'policy-1',
        existingProjects: 'protected',
      }).toString(),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin');
    const html = await res.text();
    expect(visibleMarkup(html)).toContain('identity providers must contain between 1 and 16 ids');
    expect(html).not.toContain('form-token-value');
  });
});

describe('GET /admin/ (dashboard)', () => {
  test('includes the actual probe time in Fate health data', async () => {
    const admin = await createTestUser(
      env.db,
      'health-time-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    const startedAt = Date.now();
    const response = await req(
      '/admin/fate',
      admin.adminJwt,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          operations: [
            { id: 'health', kind: 'query', name: 'health', select: ['id', 'checks', 'checkedAt'] },
          ],
        }),
      },
      { DEV_AUTH_BYPASS: 'true' },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{
        ok: boolean;
        data: { checkedAt: number; checks: Array<{ name: string; ok: boolean }> };
      }>;
    };
    expect(body.results[0]?.ok).toBe(true);
    const health = body.results[0]!.data;
    expect(health.checkedAt).toBeGreaterThanOrEqual(startedAt);
    expect(health.checkedAt).toBeLessThanOrEqual(Date.now());
    expect(health.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'api', ok: true })]),
    );
  });

  test('renders dashboard with stats and projects', async () => {
    const admin = await createTestUser(env.db, 'admin1', 'github', undefined, 'free', 'admin');
    await createTestUser(env.db, 'user1');
    await createTestProject(env.db, admin.id, 'dash-proj');
    mockCfApi();

    const res = await req('/admin/', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Dashboard');
    expect(html).toContain('Users');
    expect(html).toContain('Projects');
    expect(html).toContain('dash-proj');
    expect(html).toContain('Top Projects by Traffic (last hour)');
    vi.restoreAllMocks();
  });

  test('keeps tables readable and settings cards within the viewport', async () => {
    const admin = await createTestUser(
      env.db,
      'deployment-layout-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    const project = await createTestProject(
      env.db,
      admin.id,
      'a-project-with-a-long-name-for-truncation',
    );
    const invited = await createTestUser(env.db, 'team-layout-invitee');
    await env.db.insert(projectInvitations).values({
      id: 'team-layout-invitation',
      project_id: project.id,
      target_user_id: invited.id,
      target_email_snapshot: 'team-layout-invitee@example.com',
      role: 'reader',
      invited_by_user_id: admin.id,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const error = 'Worker upload failed: upstream rejected the deployment.\n'.repeat(20);
    const failed = await createTestDeployment(env.db, project.id, 'failed', 'cli', error);
    const email = `${'long-email-address-'.repeat(5)}@example.com`;
    await env.db.update(users).set({ email }).where(eq(users.id, admin.id));
    const client = await readFile(
      new URL('../../dist/admin-assets/admin/client.js', import.meta.url),
    );
    const css = await readFile(new URL('../../dist/admin-assets/admin/style.css', import.meta.url));
    const browser = await chromium.launch();
    try {
      for (const width of [1280, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 844 } });
        await context.addCookies([
          { name: 'admin_token', value: admin.adminJwt, url: 'http://localhost' },
        ]);
        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'clipboard', {
            value: {
              writeText: async (text: string) => {
                (window as unknown as { copiedError: string }).copiedError = text;
              },
            },
          });
        });
        const page = await context.newPage();
        const errors: Array<string> = [];
        let emailEnabled = false;
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', async (route) => {
          const incoming = route.request();
          const url = new URL(incoming.url());
          if (url.origin !== 'http://localhost') {
            return route.abort();
          }
          if (url.pathname === '/admin/client.js' || url.pathname === '/admin/style.css') {
            return route.fulfill({
              contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css',
              body: url.pathname.endsWith('.js') ? client : css,
            });
          }
          const response = await app.fetch(
            new Request(incoming.url(), {
              method: incoming.method(),
              headers: await incoming.allHeaders(),
              ...(incoming.method() === 'POST' ? { body: incoming.postData() ?? '' } : {}),
            }),
            {
              ...env,
              DEV_AUTH_BYPASS: 'true',
              ...(emailEnabled
                ? { EMAIL_GATEWAY_ORIGIN: 'https://email-gateway.example.test' }
                : {}),
            },
          );
          await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          });
        });
        for (const path of [
          '/admin/',
          '/admin/deployments',
          `/admin/projects/${project.id}`,
          '/admin/users',
        ]) {
          page.setDefaultTimeout(5000);
          await page.goto(`http://localhost${path}`);
          await page.locator('[data-hydrated="true"]').waitFor();
          if (path === '/admin/users' || path === '/admin/deployments') {
            const heading = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
            const search = (await page.locator('.void-admin-search').boundingBox())!;
            expect(search.y - (heading.y + heading.height)).toBeCloseTo(16, 0);
          }
          if (width === 1280 && path === '/admin/') {
            const link = page
              .locator('.void-admin-projects-table .void-admin-resource-link')
              .first();
            await link.scrollIntoViewIfNeeded();
            await link.hover();
            expect(
              await link.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                for (let y = rect.top + 1; y < rect.bottom; y += 3) {
                  for (let x = rect.left + 1; x < rect.right; x += 3) {
                    const target = document.elementFromPoint(x, y);
                    if (
                      !target ||
                      !element.contains(target) ||
                      getComputedStyle(target).cursor !== 'pointer'
                    ) {
                      return false;
                    }
                  }
                }
                return true;
              }),
            ).toBe(true);
          }
          if (path === `/admin/projects/${project.id}`) {
            const sectionGaps = await page.evaluate(() => {
              const builds = Array.from(document.querySelectorAll('h2')).find((heading) =>
                heading.textContent?.startsWith('Builds ('),
              )!.parentElement!;
              const zeroTrust = document.getElementById('zero-trust')!;
              const team = document.getElementById('team')!;
              const ownership = document.getElementById('owner-transfer')!;
              const sections = [builds, zeroTrust, team, ownership];
              return sections.slice(1).map((section, index) => {
                const previous = sections[index]!.getBoundingClientRect();
                return section.getBoundingClientRect().top - previous.bottom;
              });
            });
            for (const gap of sectionGaps) {
              expect(gap).toBeCloseTo(32, 0);
            }
            const zeroTrust = page.locator('#zero-trust');
            const heading = (await zeroTrust
              .getByRole('heading', { name: 'Zero Trust' })
              .boundingBox())!;
            const state = (await zeroTrust
              .locator('.void-admin-project-zero-trust-state')
              .boundingBox())!;
            expect(state.y - (heading.y + heading.height)).toBeCloseTo(16, 0);
            const configure = (await zeroTrust
              .getByRole('link', { name: 'Configure Zero Trust' })
              .boundingBox())!;
            const teamHeading = (await page
              .locator('#team')
              .getByRole('heading', { name: 'Team members (1)' })
              .boundingBox())!;
            expect(teamHeading.y - (configure.y + configure.height)).toBeCloseTo(32, 0);
            expect(configure.width).toBeLessThan((await zeroTrust.boundingBox())!.width);
            const teamTables = page.locator('.void-admin-team-table-scroll');
            expect(await teamTables.count()).toBe(2);
            for (const teamTable of await teamTables.all()) {
              const rows = await teamTable.evaluate((container) => {
                const bounds = container.getBoundingClientRect();
                return Array.from(container.querySelectorAll('tr'), (row) => {
                  const rect = row.getBoundingClientRect();
                  return { top: rect.top - bounds.top, bottom: rect.bottom - bounds.bottom };
                });
              });
              expect(rows.every(({ top, bottom }) => top >= -1 && bottom <= 1)).toBe(true);
            }
          }
          const isUsers = path === '/admin/users';
          const table = page.locator(
            isUsers ? '.void-admin-users-table' : '.void-admin-deployments-table',
          );
          const row = table.getByRole('row').filter({
            has: page.getByRole('link', { name: isUsers ? admin.login : failed.id, exact: true }),
          });
          expect((await row.boundingBox())!.height).toBeLessThan(55);
          const columns = await table.locator('th').evaluateAll((headers) =>
            headers.map((header) => ({
              title: header.textContent,
              width: header.getBoundingClientRect().width,
            })),
          );
          expect(columns.find((column) => column.title === 'Created')!.width).toBeLessThan(
            (await table.boundingBox())!.width / 3,
          );
          expect(columns.every((column) => column.width >= 64)).toBe(true);
          if (isUsers) {
            const emailCell = row.getByRole('cell').nth(2);
            expect(await emailCell.textContent()).toBe(email);
            await emailCell.hover();
            await page.getByRole('tooltip').filter({ hasText: email }).waitFor();
            const deleteButton = row.getByRole('button', { name: 'Delete', exact: true });
            expect(
              await deleteButton.evaluate((button) => {
                const form = (button as HTMLButtonElement).form;
                return {
                  action: form?.getAttribute('action'),
                  confirmation: form?.dataset.confirm,
                };
              }),
            ).toEqual({
              action: `/admin/users/${admin.id}/delete`,
              confirmation: `Delete user "${admin.login}" and all their projects?`,
            });
            expect(
              await deleteButton.evaluate((button) =>
                Array.from(button.querySelectorAll('span'))
                  .filter(
                    (label) =>
                      label.textContent === 'Delete' &&
                      getComputedStyle(label).display !== 'contents',
                  )
                  .every((label) => label.scrollWidth <= label.clientWidth),
              ),
            ).toBe(true);
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            ).toBe(true);
            continue;
          }
          const message = row.locator('.void-admin-deployment-error-message');
          expect(await message.textContent()).toBe(error);
          expect((await message.boundingBox())!.height).toBeLessThan(30);
          if (width === 1280 && path === '/admin/') {
            const url = page.url();
            await message.dblclick();
            const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
            expect(selected).not.toBe('');
            expect(error).toContain(selected);
            expect(page.url()).toBe(url);
            await page.mouse.move(0, 0);
          }
          await message.hover();
          await page.getByRole('tooltip').filter({ hasText: 'Worker upload failed' }).waitFor();
          await row.getByRole('button', { name: 'Copy', exact: true }).click();
          await expect
            .poll(() =>
              page.evaluate(() => (window as unknown as { copiedError?: string }).copiedError),
            )
            .toBe(error);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
        }
        for (const [path, enabled] of [
          ['/admin/signup-control', false],
          ['/admin/config/auth', false],
          ['/admin/zero-trust', false],
          ['/admin/email', false],
          ['/admin/email', true],
        ] as const) {
          emailEnabled = enabled;
          await page.goto(`http://localhost${path}`);
          await page.locator('[data-hydrated="true"]').waitFor({ timeout: 5000 });
          const cards = page.locator('.void-admin-card');
          expect(await cards.count()).toBeGreaterThan(0);
          const gaps = await page
            .locator('.void-admin-content > .void-admin-stack')
            .evaluate((stack) => {
              const sections = Array.from(stack.children).filter(
                (section) => section.getBoundingClientRect().height > 0,
              );
              return sections
                .slice(1)
                .map(
                  (section, index) =>
                    section.getBoundingClientRect().top -
                    sections[index]!.getBoundingClientRect().bottom,
                );
            });
          expect(gaps.length).toBeGreaterThan(0);
          for (const gap of gaps) {
            expect(gap).toBeCloseTo(32, 0);
          }
          const contentGaps = await cards
            .locator('.void-admin-card-content')
            .evaluateAll((stacks) =>
              stacks.flatMap((stack) => {
                const elements = Array.from(stack.children).filter(
                  (element) => element.getBoundingClientRect().height > 0,
                );
                return elements
                  .slice(1)
                  .map(
                    (element, index) =>
                      element.getBoundingClientRect().top -
                      elements[index]!.getBoundingClientRect().bottom,
                  );
              }),
            );
          expect(contentGaps.length).toBeGreaterThan(0);
          for (const gap of contentGaps) {
            expect(gap).toBeCloseTo(16, 0);
          }
          const copyStyles = await cards.locator('p').evaluateAll((paragraphs) =>
            paragraphs.map((paragraph) => {
              const { color, fontSize, fontWeight, lineHeight } = getComputedStyle(paragraph);
              return JSON.stringify({ color, fontSize, fontWeight, lineHeight });
            }),
          );
          expect(new Set(copyStyles).size).toBe(1);
          expect(
            await cards.evaluateAll((elements) =>
              elements.every((element) => {
                const { left, right } = element.getBoundingClientRect();
                return left >= 0 && right <= window.innerWidth;
              }),
            ),
          ).toBe(true);
          if (path === '/admin/signup-control') {
            const pattern = page.getByRole('textbox', { name: 'Pattern Required', exact: true });
            const patternHeight = await pattern.evaluate(
              (input) => input.parentElement!.getBoundingClientRect().height,
            );
            const noteHeight = await page
              .getByRole('textbox', { name: 'Note', exact: true })
              .evaluate((input) => input.parentElement!.getBoundingClientRect().height);
            expect(Math.abs(patternHeight - noteHeight)).toBeLessThan(1);
            await pattern.fill('alice\nbob\ncarol');
            await expect
              .poll(() => pattern.evaluate((input) => input.getBoundingClientRect().height))
              .toBeGreaterThan(patternHeight + 30);
            await pattern.fill('alice');
            await expect
              .poll(() =>
                pattern.evaluate((input) => input.parentElement!.getBoundingClientRect().height),
              )
              .toBeCloseTo(patternHeight, 0);
            await pattern.fill('a-very-long-company-domain.example.com, '.repeat(10));
            expect(
              await pattern.evaluate((input) => input.scrollHeight <= input.clientHeight),
            ).toBe(true);
            if (width === 390) {
              const wrappedHeight = (await pattern.boundingBox())!.height;
              await page.setViewportSize({ width: 320, height: 844 });
              await expect
                .poll(() => pattern.evaluate((input) => input.getBoundingClientRect().height))
                .toBeGreaterThan(wrappedHeight);
              expect(
                await pattern.evaluate((input) => input.scrollHeight <= input.clientHeight),
              ).toBe(true);
              await page.setViewportSize({ width, height: 844 });
            }
            await pattern.fill('');
            expect(
              await pattern.evaluate(
                (input) => input.parentElement!.getBoundingClientRect().height,
              ),
            ).toBeCloseTo(patternHeight, 0);
            const policy = page.getByRole('region', { name: 'Who can join?', exact: true });
            const toggle = policy.locator('form[action="/admin/signup-control/toggle"]');
            const setupCopy = (await policy
              .locator('p')
              .filter({ hasText: 'To use company-approved signup' })
              .boundingBox())!;
            expect((await toggle.boundingBox())!.y - (setupCopy.y + setupCopy.height)).toBeCloseTo(
              16,
              0,
            );
            const signupCopy = await toggle.locator('p').boundingBox();
            const signupButton = await toggle.getByRole('button').boundingBox();
            expect(signupButton!.y).toBeGreaterThan(signupCopy!.y + signupCopy!.height);
            const invite = page.getByRole('region', { name: 'Invite people', exact: true });
            for (const [label, value] of [
              ['Platform invitation page', 'http://localhost/invite'],
              ['Void CLI connection command', "void connect 'localhost'"],
            ]) {
              const field = invite.getByRole('group', { name: label, exact: true });
              const input = field.getByRole('textbox', { name: label, exact: true });
              expect(await input.inputValue()).toBe(value);
              const copy = field.getByRole('button', { name: `Copy ${label}`, exact: true });
              const fieldBox = (await field.boundingBox())!;
              const copyBox = (await copy.boundingBox())!;
              expect(fieldBox.width).toBeLessThanOrEqual(576);
              expect(copyBox.x).toBeGreaterThan(fieldBox.x + fieldBox.width / 2);
              expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(fieldBox.x + fieldBox.width);
              expect(copyBox.y).toBeGreaterThanOrEqual(fieldBox.y);
              expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(fieldBox.y + fieldBox.height);
              await copy.click();
              await field.getByRole('button', { name: `Copied ${label}`, exact: true }).waitFor();
              await expect
                .poll(() =>
                  page.evaluate(() => (window as unknown as { copiedError?: string }).copiedError),
                )
                .toBe(value);
            }
          }
        }
        expect(errors).toEqual([]);
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }, 30_000);

  test('does not query Analytics Engine during the initial dashboard render', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-deferred',
      'github',
      undefined,
      'free',
      'admin',
    );
    const fetchMock = mockCfApi({
      analyticsQuery: () => {
        throw new Error('The deferred top-project query ran during initial rendering.');
      },
    });
    const response = await req('/admin/', admin.adminJwt);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Top Projects by Traffic (last hour)');
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/analytics_engine/sql')),
    ).toBe(false);
  });

  test('stat cards link to views', async () => {
    const admin = await createTestUser(env.db, 'admin1b', 'github', undefined, 'free', 'admin');
    mockCfApi();
    const res = await req('/admin/', admin.adminJwt);
    const html = await res.text();
    expect(html).toContain('href="/admin/users"');
    expect(html).toContain('href="/admin/projects"');
    expect(html).toContain('href="/admin/deployments"');
    vi.restoreAllMocks();
  });

  test('renders top projects sorted by recent site traffic', async () => {
    const admin = await createTestUser(env.db, 'admin1c', 'github', undefined, 'free', 'admin');
    const ownerA = await createTestUser(env.db, 'owner-a');
    const ownerB = await createTestUser(env.db, 'owner-b');
    const alpha = await createTestProject(env.db, ownerA.id, 'alpha');
    const beta = await createTestProject(env.db, ownerB.id, 'beta');

    mockCfApi({
      analyticsQuery: () =>
        Response.json({
          data: [
            {
              blob1: beta.id,
              requests: 420,
              bandwidth_bytes: 8192,
              last_seen: '2026-04-21 10:59:00',
            },
            {
              blob1: alpha.id,
              requests: 120,
              bandwidth_bytes: 2048,
              last_seen: '2026-04-21 10:58:00',
            },
          ],
        }),
    });

    const res = await req('/admin/fate', admin.adminJwt, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        operations: [
          {
            id: 'top-projects',
            kind: 'byId',
            type: 'AdminDashboard',
            ids: ['overview'],
            select: [
              'id',
              'topProjects.id',
              'topProjects.slug',
              'topProjects.owner_login',
              'topProjects.requests',
              'topProjects.bandwidthBytes',
            ],
          },
        ],
      }),
    });
    const response = await res.text();
    expect(res.status, response).toBe(200);
    const betaIndex = response.indexOf('"slug":"beta"');
    const alphaIndex = response.indexOf('"slug":"alpha"');
    expect(betaIndex).toBeGreaterThan(-1);
    expect(alphaIndex).toBeGreaterThan(-1);
    expect(betaIndex).toBeLessThan(alphaIndex);
    expect(response).toContain('420');
    expect(response).toContain('owner-b');

    vi.restoreAllMocks();
  });

  test('queries the configured requests dataset for top projects', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-dataset',
      'github',
      undefined,
      'free',
      'admin',
    );
    env.REQUESTS_DATASET = 'void_requests_staging';

    const fetchMock = mockCfApi({
      analyticsQuery: (_url, init) => {
        expect(init?.body).toContain('FROM void_requests_staging');
        return Response.json({ data: [] });
      },
    });

    const res = await req('/admin/fate', admin.adminJwt, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        operations: [
          {
            id: 'top-projects',
            kind: 'byId',
            type: 'AdminDashboard',
            ids: ['overview'],
            select: ['id', 'topProjects.id'],
          },
        ],
      }),
    });
    expect(res.status, await res.text()).toBe(200);
    expect(fetchMock).toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe('GET /admin/users', () => {
  test('renders users list', async () => {
    const admin = await createTestUser(env.db, 'admin2', 'github', undefined, 'free', 'admin');
    await createTestUser(env.db, 'user2');

    const res = await req('/admin/users', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('user2');
  });

  test('paginates users', async () => {
    const admin = await createTestUser(env.db, 'admin2b', 'github', undefined, 'free', 'admin');
    // Create 20 more users to span 2 pages (PAGE_SIZE=20, +1 admin = 21)
    for (let i = 0; i < 20; i++) {
      await createTestUser(env.db, `paguser-${String(i).padStart(2, '0')}`);
    }

    const res1 = await req('/admin/users', admin.adminJwt);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    expect(visibleMarkup(html1)).toContain('1 / 2');
    expect(html1).toContain('?page=2');

    const res2 = await req('/admin/users?page=2', admin.adminJwt);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(visibleMarkup(html2)).toContain('2 / 2');
  });

  test('searches users', async () => {
    const admin = await createTestUser(env.db, 'admin3', 'github', undefined, 'free', 'admin');
    await createTestUser(env.db, 'findable');
    await createTestUser(env.db, 'hidden');

    const res = await req('/admin/users?search=findable', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('findable');
    expect(html).toContain('name="search" value="findable"');
    expect(html).toContain('role="combobox"');
    expect(visibleMarkup(html)).not.toContain('>hidden<');
  });
});

describe('GET /admin/users/:id', () => {
  test('renders user detail', async () => {
    const admin = await createTestUser(env.db, 'admin4', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'detailuser');

    const res = await req(`/admin/users/${user.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('detailuser');
    expect(html).toContain('Plan');
    expect(html).toContain('Suspension');
    expect(html).toContain('Queue messages are dropped when their retries run out');
  });

  test('renders plan limits card', async () => {
    const admin = await createTestUser(env.db, 'admin4b', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'limitsuser');

    const res = await req(`/admin/users/${user.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('>Plan<');
    expect(html).toContain('Requests / month');
    expect(html).toContain('3,000,000');
    expect(html).toContain('CPU ms / request');
    expect(html).toContain('Deploys / day');
    expect(html).toContain('D1 storage');
    expect(html).toContain('1 GB');
  });

  test('shows deploy count today', async () => {
    const admin = await createTestUser(env.db, 'admin4c', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'deploycountuser');
    const project = await createTestProject(env.db, user.id, 'dc-proj');
    await createTestDeployment(env.db, project.id, 'live');
    await createTestDeployment(env.db, project.id, 'live');

    // Mock CF API — the user detail page calls queryBatchProjectUsageWindows which
    // fetches from Analytics Engine. Without a mock, the real fetch hangs in CI.
    mockCfApi();

    const res = await req(`/admin/users/${user.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should show "2 / 100" (2 deploys today, free tier limit 100)
    expect(visibleMarkup(html)).toContain('2 / 100');

    vi.restoreAllMocks();
  });
});

describe('POST /admin/users/:id/plan', () => {
  test('updates plan and redirects', async () => {
    const admin = await createTestUser(env.db, 'admin5', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'planuser');

    const body = new URLSearchParams({ plan: 'pro' });
    const res = await req(`/admin/users/${user.id}/plan`, admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/users/${user.id}`);
  });

  test('updates the serving policy without publishing retired Sandbox proxy account mirrors', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-plan-kv',
      'github',
      undefined,
      'free',
      'admin',
    );
    const user = await createTestUser(env.db, 'planuser-kv', 'github', undefined, 'free');
    const p1 = await createTestProject(env.db, user.id, 'plan-kv-a');
    const p2 = await createTestProject(env.db, user.id, 'plan-kv-b');

    for (const project of [p1, p2]) {
      await env.ROUTING.put(
        project.slug,
        JSON.stringify({ projectId: project.id, userId: user.id, workerName: 'test-worker' }),
      );
    }

    const body = new URLSearchParams({ plan: 'pro' });
    const res = await req(`/admin/users/${user.id}/plan`, admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);

    for (const project of [p1, p2]) {
      expect(await env.ROUTING.get(project.slug, 'json')).toMatchObject({
        userId: user.id,
        limits: { cpuMs: 50, subRequests: 1000 },
      });
      expect(await env.ROUTING.get(`project:${project.id}`)).toBeNull();
    }
  });

  test('clears sandbox-block KV and sandbox_runtime_exceeded DB suspension on plan change', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-plan-sb',
      'github',
      undefined,
      'free',
      'admin',
    );
    const user = await createTestUser(env.db, 'planuser-sb', 'github', undefined, 'solo');

    // Pre-seed the suspension state as the UsageCounter DO would have left it.
    await env.ROUTING.put(`sandbox-block:${user.id}`, '1');
    await env.db
      .update(users)
      .set({ suspended_reason: 'sandbox_runtime_exceeded' })
      .where(eq(users.id, user.id));

    const body = new URLSearchParams({ plan: 'pro' });
    const res = await req(
      `/admin/users/${user.id}/plan`,
      admin.adminJwt,
      {
        method: 'POST',
        body: body.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
      },
      {
        USAGE_COUNTER: createUsageCounterFixture(env as unknown as ApiEnv['Bindings'], {
          [user.id]: { totalSandboxSeconds: 40 * 3600, sandboxRuntimeSuspended: true },
        }),
      },
    );
    expect(res.status).toBe(302);

    // KV block key should be deleted.
    expect(await env.ROUTING.get(`sandbox-block:${user.id}`)).toBeNull();

    // DB suspension reason should be cleared.
    const [row] = await env.db
      .select({ suspended_reason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row.suspended_reason).toBeNull();
  });

  test('reevaluates recorded request usage and clears its suspension when the new plan is unlimited', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-plan-req',
      'github',
      undefined,
      'free',
      'admin',
    );
    const user = await createTestUser(env.db, 'planuser-req', 'github', undefined, 'solo');
    const project = await createTestProject(env.db, user.id, 'planuser-req-slug');

    // Execute the production counter so this verifies actual quota reevaluation.
    await env.db
      .update(users)
      .set({ suspended_reason: 'requests_exceeded' })
      .where(eq(users.id, user.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'w', projectId: project.id, suspended: 'requests_exceeded' }),
    );

    const body = new URLSearchParams({ plan: 'sponsored' });
    const res = await req(
      `/admin/users/${user.id}/plan`,
      admin.adminJwt,
      {
        method: 'POST',
        body: body.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
      },
      {
        USAGE_COUNTER: createUsageCounterFixture(env as unknown as ApiEnv['Bindings'], {
          [user.id]: { totalRequests: 10_000_000, requestsSuspended: true },
        }),
      },
    );
    expect(res.status).toBe(302);

    const [row] = await env.db
      .select({ suspended_reason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row.suspended_reason).toBeNull();
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).suspended).toBeUndefined();
  });

  test('plan change does NOT lift an admin suspension (reason-scoped)', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-plan-adm',
      'github',
      undefined,
      'free',
      'admin',
    );
    const user = await createTestUser(env.db, 'planuser-adm', 'github', undefined, 'solo');
    const project = await createTestProject(env.db, user.id, 'planuser-adm-slug');

    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, user.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'w', projectId: project.id, suspended: 'admin_suspended' }),
    );

    const body = new URLSearchParams({ plan: 'pro' });
    const res = await req(`/admin/users/${user.id}/plan`, admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);

    const [row] = await env.db
      .select({ suspended_reason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, user.id));
    // A plan change is a usage-cap action; it must never lift an admin block.
    expect(row.suspended_reason).toBe('admin_suspended');
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).suspended).toBe('admin_suspended');
  });

  test('succeeds when no sandbox block exists and no suspension is set', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-plan-noop',
      'github',
      undefined,
      'free',
      'admin',
    );
    const user = await createTestUser(env.db, 'planuser-noop', 'github', undefined, 'free');

    const body = new URLSearchParams({ plan: 'pro' });
    const res = await req(`/admin/users/${user.id}/plan`, admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/users/${user.id}`);

    const [row] = await env.db
      .select({ suspended_reason: users.suspended_reason, plan: users.plan })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row.suspended_reason).toBeNull();
    expect(row.plan).toBe('pro');
  });

  test('surfaces a failed /reevaluate-sandbox DO response (plan persisted, cleanup flagged for retry)', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-plan-faildo',
      'github',
      undefined,
      'free',
      'admin',
    );
    const user = await createTestUser(env.db, 'planuser-faildo', 'github', undefined, 'solo');
    await createTestProject(env.db, user.id, 'planuser-faildo-slug');

    const failingDo = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({ fetch: async () => new Response('boom', { status: 500 }) }),
    } as unknown as typeof env.USAGE_COUNTER;

    const res = await app.fetch(
      new Request(`http://localhost/admin/users/${user.id}/plan`, {
        method: 'POST',
        headers: {
          Cookie: `admin_token=${admin.adminJwt}`,
          Origin: 'http://localhost',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ plan: 'pro' }).toString(),
        redirect: 'manual',
      }),
      { ...env, USAGE_COUNTER: failingDo } as typeof env,
    );
    expect(res.status).toBe(500);

    // The plan change is the primary action and IS persisted; only the cleanup
    // failed, and the plan form is always available for a retry.
    const [row] = await env.db
      .select({ plan: users.plan })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row.plan).toBe('pro');
  });
});

describe('POST /admin/users/:id/suspend + unsuspend', () => {
  test('suspends and unsuspends via forms', async () => {
    const admin = await createTestUser(env.db, 'admin6', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'suspuser');
    const project = await createTestProject(env.db, user.id, 'susp-slug');
    await env.ROUTING.put(project.slug, JSON.stringify({ workerName: 'w', projectId: project.id }));

    // Suspend
    const suspBody = new URLSearchParams({ reason: 'test_reason' });
    const suspRes = await req(`/admin/users/${user.id}/suspend`, admin.adminJwt, {
      method: 'POST',
      body: suspBody.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(suspRes.status).toBe(302);

    const routingAfter = JSON.parse((await env.ROUTING.get(project.slug))!);
    expect(routingAfter.suspended).toBe('test_reason');

    // Unsuspend
    const unsuspRes = await req(`/admin/users/${user.id}/unsuspend`, admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(unsuspRes.status).toBe(302);

    const routingAfter2 = JSON.parse((await env.ROUTING.get(project.slug))!);
    expect(routingAfter2.suspended).toBeUndefined();
  });

  test('syncs the slug AND active custom-domain routes, and clears sandbox-block on unsuspend', async () => {
    const admin = await createTestUser(env.db, 'admin6b', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'suspuser-dom');
    const project = await createTestProject(env.db, user.id, 'susp-dom-slug');

    // Active custom domain → has a `domain:<host>` routing entry dispatch serves.
    await env.db.insert(domains).values({
      id: 'dom_susp_active',
      project_id: project.id,
      hostname: 'susp-custom.example.com',
      cf_hostname_id: 'cf_susp_active',
      status: 'active',
    });
    // Pending domain → no routing entry yet; must be left untouched.
    await env.db.insert(domains).values({
      id: 'dom_susp_pending',
      project_id: project.id,
      hostname: 'susp-pending.example.com',
      cf_hostname_id: 'cf_susp_pending',
      status: 'pending',
    });

    const slugJson = JSON.stringify({ workerName: 'w', projectId: project.id });
    await env.ROUTING.put(project.slug, slugJson);
    await env.ROUTING.put('domain:susp-custom.example.com', slugJson);
    // The UsageCounter DO would have left this on a sandbox-runtime suspension.
    await env.ROUTING.put(`sandbox-block:${user.id}`, '1');

    // Suspend stamps slug + active domain. The pending domain has no published
    // KV route, so the fan-out is a harmless no-op there (no key is created).
    const suspRes = await req(`/admin/users/${user.id}/suspend`, admin.adminJwt, {
      method: 'POST',
      body: new URLSearchParams({ reason: 'admin_suspended' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(suspRes.status).toBe(302);
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).suspended).toBe('admin_suspended');
    expect(JSON.parse((await env.ROUTING.get('domain:susp-custom.example.com'))!).suspended).toBe(
      'admin_suspended',
    );
    expect(await env.ROUTING.get('domain:susp-pending.example.com')).toBeNull();

    // Unsuspend clears slug + domain markers and removes the sandbox block.
    const unsuspRes = await req(`/admin/users/${user.id}/unsuspend`, admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(unsuspRes.status).toBe(302);
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).suspended).toBeUndefined();
    expect(
      JSON.parse((await env.ROUTING.get('domain:susp-custom.example.com'))!).suspended,
    ).toBeUndefined();
    expect(await env.ROUTING.get(`sandbox-block:${user.id}`)).toBeNull();
  });

  test('admin suspend REJECTS a reserved usage reason (would be auto-cleared by the reconcile)', async () => {
    const admin = await createTestUser(env.db, 'admin6f', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'suspuser-reserved');
    const project = await createTestProject(env.db, user.id, 'susp-reserved-slug');
    await env.ROUTING.put(project.slug, JSON.stringify({ workerName: 'w', projectId: project.id }));

    // `requests_exceeded` classifies as a USAGE suspension (isAdminSuspended === false),
    // and the scheduled reconcile would auto-clear it whenever the DO latch is false —
    // silently un-blocking an admin-intended block. The route must reject it.
    const res = await req(`/admin/users/${user.id}/suspend`, admin.adminJwt, {
      method: 'POST',
      body: new URLSearchParams({ reason: 'requests_exceeded' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(400);
    // Neither DB nor KV mutated.
    const [row] = await env.db
      .select({ suspended_reason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row.suspended_reason).toBeNull();
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).suspended).toBeUndefined();
  });

  test('admin suspend is authoritative — overwrites an existing usage marker on the route', async () => {
    const admin = await createTestUser(env.db, 'admin6c', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'suspuser-overwrite');
    const project = await createTestProject(env.db, user.id, 'susp-overwrite-slug');
    // The route already carries a usage-driven marker from the request cap.
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'w', projectId: project.id, suspended: 'requests_exceeded' }),
    );

    const suspRes = await req(`/admin/users/${user.id}/suspend`, admin.adminJwt, {
      method: 'POST',
      body: new URLSearchParams({ reason: 'admin_suspended' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(suspRes.status).toBe(302);
    // Admin reason outranks the usage reason and replaces it.
    expect(JSON.parse((await env.ROUTING.get(project.slug))!).suspended).toBe('admin_suspended');
  });

  // POST the unsuspend form against a custom env (req() uses the fixed env, so
  // we call app.fetch directly to inject a faulty binding).
  function unsuspendWith(userId: string, adminJwt: string, overrides: Partial<TestEnv>) {
    return app.fetch(
      new Request(`http://localhost/admin/users/${userId}/unsuspend`, {
        method: 'POST',
        headers: {
          Cookie: `admin_token=${adminJwt}`,
          Origin: 'http://localhost',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: '',
        redirect: 'manual',
      }),
      { ...env, ...overrides } as typeof env,
    );
  }

  // POST the suspend form against a custom env (req() uses the fixed env, so we
  // call app.fetch directly to inject a faulty binding).
  function suspendWith(
    userId: string,
    adminJwt: string,
    reason: string,
    overrides: Partial<TestEnv>,
  ) {
    return app.fetch(
      new Request(`http://localhost/admin/users/${userId}/suspend`, {
        method: 'POST',
        headers: {
          Cookie: `admin_token=${adminJwt}`,
          Origin: 'http://localhost',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ reason }).toString(),
        redirect: 'manual',
      }),
      { ...env, ...overrides } as typeof env,
    );
  }

  test('failed suspend leaves the user NOT suspended in the DB (fail-closed, retryable)', async () => {
    const admin = await createTestUser(env.db, 'admin6h', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'susp-failopen');
    await createTestProject(env.db, user.id, 'susp-failopen-slug');

    // ROUTING whose reads throw — setProjectsRoutingSuspension rejects, so the
    // edge stamp fails. The DB write must NOT have happened: a DB-first ordering
    // would leave `suspended_reason` set while dispatch (which enforces only
    // `routing.suspended`) keeps serving the unstamped route — a fail-OPEN strand
    // whose detail view shows Unsuspend, not a retry of the failed suspend.
    const failingRouting = {
      get: async () => {
        throw new Error('KV unavailable');
      },
      put: async () => {},
      delete: async () => {},
    } as unknown as typeof env.ROUTING;

    const res = await suspendWith(user.id, admin.adminJwt, 'admin_suspended', {
      ROUTING: failingRouting,
    });
    expect(res.status).toBe(500);

    // DB must stay active so the user-detail view keeps the Suspend form — i.e. the
    // operator retries the idempotent stamp rather than seeing a false "suspended".
    const [row] = await env.db
      .select({ suspended_reason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row.suspended_reason).toBeNull();
  });

  test('unsuspend surfaces a non-2xx /clear-suspension DO response instead of redirecting as success', async () => {
    const admin = await createTestUser(env.db, 'admin6d', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'unsusp-do-fail');
    await createTestProject(env.db, user.id, 'unsusp-do-fail-slug');

    // DO whose /clear-suspension fails (e.g. storage error) — unchecked, this
    // would 302 as success while the latch (and next /init re-stamp) persists.
    const failingDo = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({
        fetch: async () => new Response('boom', { status: 500 }),
      }),
    } as unknown as typeof env.USAGE_COUNTER;

    const res = await unsuspendWith(user.id, admin.adminJwt, { USAGE_COUNTER: failingDo });
    expect(res.status).toBe(500);
  });

  test('unsuspend surfaces a ROUTING cleanup failure instead of redirecting as success', async () => {
    const admin = await createTestUser(env.db, 'admin6e', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'unsusp-kv-fail');
    await createTestProject(env.db, user.id, 'unsusp-kv-fail-slug');

    // ROUTING whose reads throw — setProjectsRoutingSuspension rejects, so the
    // cleanup Promise.all rejects and must not redirect as success.
    const failingRouting = {
      get: async () => {
        throw new Error('KV unavailable');
      },
      put: async () => {},
      delete: async () => {},
    } as unknown as typeof env.ROUTING;

    const res = await unsuspendWith(user.id, admin.adminJwt, { ROUTING: failingRouting });
    expect(res.status).toBe(500);
  });

  test('failed unsuspend cleanup leaves the user SUSPENDED in the DB (retryable, truthful UI)', async () => {
    const admin = await createTestUser(env.db, 'admin6g', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'unsusp-retryable');
    await createTestProject(env.db, user.id, 'unsusp-retryable-slug');
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, user.id));

    const failingDo = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (_id: unknown) => ({ fetch: async () => new Response('boom', { status: 500 }) }),
    } as unknown as typeof env.USAGE_COUNTER;

    const res = await unsuspendWith(user.id, admin.adminJwt, { USAGE_COUNTER: failingDo });
    expect(res.status).toBe(500);

    // DB must stay suspended so the user-detail view keeps the Unsuspend form
    // (it gates on suspended_reason) — i.e. the operator can retry the cleanup.
    const [row] = await env.db
      .select({ suspended_reason: users.suspended_reason })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row.suspended_reason).toBe('admin_suspended');
  });
});

describe('POST /admin/users/:id/delete', () => {
  test('deletes a user with a linked github installation (FK set null, not a 500)', async () => {
    mockCfApi();
    const admin = await createTestUser(env.db, 'admin-udel', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'gh-linked-user');
    // A GitHub App installation linked to the user (the backfilled state). The
    // FK is `on delete set null`, so deleting the owner must orphan the row, not
    // violate the constraint.
    await env.db.insert(githubInstallations).values({
      id: 'ghi_udel_test',
      installation_id: 'inst-udel-1',
      user_id: user.id,
      account_login: 'octo',
      account_id: '4242',
      account_type: 'User',
    });

    const res = await req(`/admin/users/${user.id}/delete`, admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);

    // User gone; installation orphaned back to the unlinked state.
    expect((await env.db.select().from(users).where(eq(users.id, user.id))).length).toBe(0);
    const [install] = await env.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, 'ghi_udel_test'));
    expect(install).toBeDefined();
    expect(install.user_id).toBeNull();

    // Keep the suite self-contained (clearTables doesn't cover installations).
    await env.db.delete(githubInstallations).where(eq(githubInstallations.id, 'ghi_udel_test'));
    vi.restoreAllMocks();
  });
});

describe('GET /admin/projects', () => {
  test('uses the same year-free timestamp format as deployments and project detail', async () => {
    const admin = await createTestUser(env.db, 'date-admin', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'dated-project');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const createdAt = '2026-01-02 03:04:00';
    await env.db.update(projects).set({ created_at: createdAt }).where(eq(projects.id, project.id));
    await env.db
      .update(deployments)
      .set({ created_at: createdAt })
      .where(eq(deployments.id, deployment.id));

    const [projectsResponse, projectResponse, deploymentsResponse] = await Promise.all([
      req('/admin/projects', admin.adminJwt),
      req(`/admin/projects/${project.id}`, admin.adminJwt),
      req('/admin/deployments', admin.adminJwt),
    ]);
    const displayedTime = 'Jan 2, 3:04 AM';
    for (const response of [projectsResponse, projectResponse, deploymentsResponse]) {
      expect(response.status).toBe(200);
      expect(visibleMarkup(await response.text())).toContain(displayedTime);
    }
  });

  test('renders projects list', async () => {
    const admin = await createTestUser(env.db, 'admin7', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'projowner');
    await createTestProject(env.db, user.id, 'my-proj');

    const res = await req('/admin/projects', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('my-proj');
    const projectLink = visibleMarkup(html).match(
      /<a\b[^>]*href="https:\/\/my-proj\.void\.app"[^>]*>[\s\S]*?<\/a>/,
    )?.[0];
    expect(projectLink).toBeDefined();
    expect(projectLink).toContain('target="_blank"');
    expect(projectLink).toContain('rel="noopener noreferrer"');
    expect(projectLink).toContain('<svg');
    expect(projectLink?.replace(/<[^>]+>/g, '')).toContain('my-proj.void.app');
    expect(projectLink?.replace(/<[^>]+>/g, '')).not.toContain('https://');
  });

  test('paginates projects', async () => {
    const admin = await createTestUser(env.db, 'admin7b', 'github', undefined, 'free', 'admin');
    // Create 21 projects to span 2 pages (PAGE_SIZE=20)
    for (let i = 0; i < 21; i++) {
      await createTestProject(env.db, admin.id, `pagproj-${String(i).padStart(2, '0')}`);
    }

    // Page 1: should have 20 projects and a Next link
    const res1 = await req('/admin/projects?page=1', admin.adminJwt);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    expect(visibleMarkup(html1)).toContain('1 / 2');
    expect(html1).toContain('?page=2');

    // Page 2: should have 1 project and no Next link
    const res2 = await req('/admin/projects?page=2', admin.adminJwt);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(visibleMarkup(html2)).toContain('2 / 2');
    expect(html2).toContain('?page=1');
  });

  test('renders each project row with its own latest deployment', async () => {
    const admin = await createTestUser(env.db, 'admin7c', 'github', undefined, 'free', 'admin');
    const owner = await createTestUser(env.db, 'latest-owner');
    const alpha = await createTestProject(env.db, owner.id, 'latest-alpha');
    const beta = await createTestProject(env.db, owner.id, 'latest-beta');
    const alphaOld = await createTestDeployment(env.db, alpha.id, 'failed');
    const alphaLatest = await createTestDeployment(env.db, alpha.id, 'live');
    const betaLatest = await createTestDeployment(env.db, beta.id, 'canceled');

    await env.db
      .update(deployments)
      .set({ created_at: '2026-01-01 00:00:00' })
      .where(eq(deployments.id, alphaOld.id));
    await env.db
      .update(deployments)
      .set({ created_at: '2026-01-02 00:00:00' })
      .where(eq(deployments.id, alphaLatest.id));
    await env.db
      .update(deployments)
      .set({ created_at: '2026-01-03 00:00:00' })
      .where(eq(deployments.id, betaLatest.id));

    const res = await req('/admin/projects?search=latest-owner', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="search" value="latest-owner"');
    expect(html).toContain('role="combobox"');
    const alphaRow = tableRowContaining(html, `/admin/projects/${alpha.id}`);
    const betaRow = tableRowContaining(html, `/admin/projects/${beta.id}`);

    expect(alphaRow).toContain(`/admin/deployments/${alphaLatest.id}`);
    expect(alphaRow).not.toContain(`/admin/deployments/${alphaOld.id}`);
    expect(alphaRow).not.toContain(`/admin/deployments/${betaLatest.id}`);
    expect(betaRow).toContain(`/admin/deployments/${betaLatest.id}`);
    expect(betaRow).not.toContain(`/admin/deployments/${alphaLatest.id}`);
  });
});

describe('GET /admin/projects/:id', () => {
  test('renders project detail', async () => {
    const admin = await createTestUser(env.db, 'admin8', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'projowner2');
    const project = await createTestProject(env.db, user.id, 'detail-proj');

    const res = await req(`/admin/projects/${project.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('detail-proj');
    expect(html).toContain('Resources');
    expect(html).toContain('Recent Deployments');
    expect(html).toContain('Transfer Ownership');
    expect(html).toContain(`/admin/projects/${project.id}/owner/preview`);
    expect(visibleMarkup(html)).toContain('Team members (1)');
    expect(visibleMarkup(html)).toContain('Add team member');
    expect(html).toContain(`/admin/projects/${project.id}/team/add`);
    expect(html).toContain('name="userId"');
    expect(html).toContain('Search by login, email, or ID');
    expect(html).toContain('Transfer ownership');
  });

  test('admin can add, change a member role, and remove a member without changing the owner', async () => {
    const admin = await createTestUser(env.db, 'team-admin', 'github', undefined, 'free', 'admin');
    const owner = await createTestUser(env.db, 'team-owner');
    const teammate = await createTestUser(env.db, 'team-member');
    const project = await createTestProject(env.db, owner.id, 'team-admin-project');
    const form = (body: Record<string, string>): RequestInit => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });

    const add = await req(
      `/admin/projects/${project.id}/team/add`,
      admin.adminJwt,
      form({ userId: teammate.id, role: 'reader' }),
    );
    expect(add.status).toBe(302);
    expect(await env.db.select().from(projectInvitations)).toEqual([]);
    expect((await env.db.select().from(projectMembers))[0]).toMatchObject({
      project_id: project.id,
      user_id: teammate.id,
      added_by_user_id: admin.id,
      role: 'reader',
    });
    expect(
      (
        await req(
          `/admin/projects/${project.id}/team/add`,
          admin.adminJwt,
          form({ userId: teammate.id, role: 'admin' }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await req(
          `/admin/projects/${project.id}/team/add`,
          admin.adminJwt,
          form({ userId: owner.id, role: 'reader' }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await req(
          `/admin/projects/${project.id}/team/add`,
          admin.adminJwt,
          form({ userId: 'user_missing', role: 'reader' }),
        )
      ).status,
    ).toBe(404);
    const detail = await (await req(`/admin/projects/${project.id}`, admin.adminJwt)).text();
    expect(visibleMarkup(detail)).toContain('Team members (2)');
    expect(detail).toContain(`/admin/projects/${project.id}/team/${teammate.id}/role`);
    expect(detail).not.toContain(`/admin/projects/${project.id}/team/${owner.id}/remove`);

    const roleChange = await req(
      `/admin/projects/${project.id}/team/${teammate.id}/role`,
      admin.adminJwt,
      form({ role: 'collaborator' }),
    );
    expect(roleChange.status).toBe(302);
    expect((await env.db.select().from(projectMembers))[0]?.role).toBe('collaborator');
    expect(await env.db.select().from(projectCleanupJobs)).toEqual([]);

    const ownerRemoval = await req(
      `/admin/projects/${project.id}/team/${owner.id}/remove`,
      admin.adminJwt,
      form({}),
    );
    expect(ownerRemoval.status).toBe(409);
    const ownerRoleChange = await req(
      `/admin/projects/${project.id}/team/${owner.id}/role`,
      admin.adminJwt,
      form({ role: 'reader' }),
    );
    expect(ownerRoleChange.status).toBe(409);
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0]?.user_id,
    ).toBe(owner.id);

    const removal = await req(
      `/admin/projects/${project.id}/team/${teammate.id}/remove`,
      admin.adminJwt,
      form({}),
    );
    expect(removal.status).toBe(302);
    expect(await env.db.select().from(projectMembers)).toEqual([]);
    // The removed collaborator could deploy: the project's proxy token rotates.
    expect(await env.db.select().from(projectCleanupJobs)).toMatchObject([
      {
        target: `proxy-token-rotation:${project.id}`,
        kind: 'proxy-token-rotation',
        payload: { phase: 'requested', reason: 'member-removed' },
      },
    ]);
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0]?.user_id,
    ).toBe(owner.id);
    const adminAccessEvents = (await env.db.select().from(projectAccessEvents)).filter((event) =>
      ['member_added', 'role_changed', 'member_removed'].includes(event.action),
    );
    expect(adminAccessEvents).toHaveLength(3);
    expect(adminAccessEvents.every((event) => event.actor_user_id === admin.id)).toBe(true);
    expect((await env.db.select().from(operatorEvents)).map((event) => event.action)).toEqual(
      expect.arrayContaining([
        `projects/${project.id}/team/add`,
        `projects/${project.id}/team/${teammate.id}/role`,
        `projects/${project.id}/team/${teammate.id}/remove`,
      ]),
    );
  });

  test('directly adding a user revokes their pending invitation', async () => {
    const admin = await createTestUser(env.db, 'add-admin', 'github', undefined, 'free', 'admin');
    const owner = await createTestUser(env.db, 'add-owner');
    const teammate = await createTestUser(env.db, 'add-member');
    const email = 'add-member@example.com';
    await env.db.update(users).set({ email }).where(eq(users.id, teammate.id));
    const project = await createTestProject(env.db, owner.id, 'add-team-project');
    const form = (body: Record<string, string>): RequestInit => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const invite = await req(
      `/admin/projects/${project.id}/team/invite`,
      admin.adminJwt,
      form({ email, role: 'reader' }),
    );
    expect(invite.status).toBe(302);
    const [invitation] = await env.db.select().from(projectInvitations);

    const add = await req(
      `/admin/projects/${project.id}/team/add`,
      admin.adminJwt,
      form({ userId: teammate.id, role: 'collaborator' }),
    );
    expect(add.status).toBe(302);
    expect((await env.db.select().from(projectInvitations))[0]).toMatchObject({
      status: 'revoked',
      revoked_by_user_id: admin.id,
    });
    expect((await env.db.select().from(projectMembers))[0]).toMatchObject({
      user_id: teammate.id,
      role: 'collaborator',
    });
    expect((await env.db.select().from(projectAccessEvents)).map((event) => event.action)).toEqual(
      expect.arrayContaining(['invited', 'invitation_revoked', 'member_added']),
    );
    await expect(
      respondToProjectInvitation(env.db, {
        invitationId: invitation!.id,
        actorUserId: teammate.id,
        response: 'accept',
      }),
    ).rejects.toMatchObject({ reason: 'invitation-not-pending' });
  });

  test('admin can revoke a pending team invitation', async () => {
    const admin = await createTestUser(
      env.db,
      'revoke-admin',
      'github',
      undefined,
      'free',
      'admin',
    );
    const owner = await createTestUser(env.db, 'revoke-owner');
    const teammate = await createTestUser(env.db, 'revoke-member');
    const email = 'revoke-member@example.com';
    await env.db.update(users).set({ email }).where(eq(users.id, teammate.id));
    const project = await createTestProject(env.db, owner.id, 'revoke-team-project');
    const form = (body: Record<string, string>): RequestInit => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const invite = await req(
      `/admin/projects/${project.id}/team/invite`,
      admin.adminJwt,
      form({ email, role: 'reader' }),
    );
    expect(invite.status).toBe(302);
    const [invitation] = await env.db.select().from(projectInvitations);

    const revoke = await req(
      `/admin/projects/${project.id}/team/invitations/${invitation!.id}/revoke`,
      admin.adminJwt,
      form({}),
    );
    expect(revoke.status).toBe(302);
    expect((await env.db.select().from(projectInvitations))[0]).toMatchObject({
      status: 'revoked',
      revoked_by_user_id: admin.id,
    });
    expect(await (await req(`/admin/projects/${project.id}`, admin.adminJwt)).text()).not.toContain(
      'Pending invitations (1)',
    );
  });

  test('shows deployment error in project detail table', async () => {
    const admin = await createTestUser(env.db, 'admin8b', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'proj-err');
    await createTestDeployment(env.db, project.id, 'failed', 'cli', 'worker upload failed: 500');

    const res = await req(`/admin/projects/${project.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('worker upload failed: 500');
  });

  test('links deployment IDs to detail page', async () => {
    const admin = await createTestUser(env.db, 'admin8c', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'proj-link');
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const res = await req(`/admin/projects/${project.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`/admin/deployments/${deployment.id}`);
  });
});

describe('GET /admin/deployments', () => {
  test('renders deployments list', async () => {
    const admin = await createTestUser(env.db, 'admin10', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'deplowner');
    const project = await createTestProject(env.db, user.id, 'depl-proj');
    await createTestDeployment(env.db, project.id, 'live', 'cli', undefined, {
      cliVersion: '0.8.3',
    });

    const res = await req('/admin/deployments', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Deployments');
    expect(html).toContain(`/admin/projects/${project.id}`);
    expect(html).toContain('live');
    expect(html).toContain('cli');
    expect(html).toContain('0.8.3');
  });

  test('shows error preview for failed deployments', async () => {
    const admin = await createTestUser(env.db, 'admin10b', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'errl-proj');
    await createTestDeployment(env.db, project.id, 'failed', 'cli', 'migration failed: syntax');

    const res = await req('/admin/deployments', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('migration failed: syntax');
  });

  test('searches deployments by CLI version', async () => {
    const admin = await createTestUser(env.db, 'admin10c', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'search-cli-version');
    await createTestDeployment(env.db, project.id, 'live', 'cli', undefined, {
      cliVersion: '0.8.9',
    });

    const res = await req('/admin/deployments?search=0.8.9', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="search" value="0.8.9"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('search-cli-version');
    expect(html).toContain('0.8.9');
  });

  test('renders CLI version aggregate page', async () => {
    const admin = await createTestUser(env.db, 'admin10d', 'github', undefined, 'free', 'admin');
    const owner = await createTestUser(env.db, 'cli-owner');
    const projectA = await createTestProject(env.db, owner.id, 'cli-stats-a');
    const projectB = await createTestProject(env.db, owner.id, 'cli-stats-b');
    await createTestDeployment(env.db, projectA.id, 'live', 'cli', undefined, {
      cliVersion: '0.8.3',
    });
    await createTestDeployment(env.db, projectB.id, 'failed', 'cli', undefined, {
      cliVersion: '0.8.3',
    });
    await createTestDeployment(env.db, projectB.id, 'live');

    const res = await req('/admin/cli-versions', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('CLI Versions');
    expect(html).toContain('Last 30 Days');
    expect(html).toContain('All Time');
    expect(html).toContain('0.8.3');
    expect(html).toContain('unknown');
  });

  test('paginates deployments', async () => {
    const admin = await createTestUser(env.db, 'admin11', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'pagdepl-proj');
    for (let i = 0; i < 21; i++) {
      await createTestDeployment(env.db, project.id, 'live');
    }

    const res1 = await req('/admin/deployments?page=1', admin.adminJwt);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    expect(visibleMarkup(html1)).toContain('1 / 2');
    expect(html1).toContain('?page=2');

    const res2 = await req('/admin/deployments?page=2', admin.adminJwt);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(visibleMarkup(html2)).toContain('2 / 2');
    expect(html2).toContain('?page=1');
  });
});

describe('GET /admin/deployments/:id', () => {
  test('renders deployment detail', async () => {
    const admin = await createTestUser(env.db, 'admin12', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'depldetail-proj');
    const deployment = await createTestDeployment(env.db, project.id, 'live', 'cli', undefined, {
      cliVersion: '0.8.3',
    });

    const res = await req(`/admin/deployments/${deployment.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(deployment.id);
    expect(html).toContain('depldetail-proj');
    expect(html).toContain('live');
    expect(html).toContain('cli');
    expect(html).toContain('CLI Version');
    expect(html).toContain('0.8.3');
  });

  test('shows error banner for failed deployment', async () => {
    const admin = await createTestUser(env.db, 'admin12b', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'errdetail-proj');
    const deployment = await createTestDeployment(
      env.db,
      project.id,
      'failed',
      'cli',
      'worker upload failed: internal error',
    );

    const res = await req(`/admin/deployments/${deployment.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Error');
    expect(html).toContain('worker upload failed: internal error');
  });

  test('renders parsed manifest card', async () => {
    const admin = await createTestUser(env.db, 'admin12c', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'manifest-proj');
    const n = ++manifestCounter;
    const id = `dpl_manifest${n}`;
    const manifest = JSON.stringify({
      bindings: { d1: ['DB'], kv: ['CACHE', '</code><script>alert("unsafe")</script>'] },
      migrations: { dialect: 'sqlite', pending: 1 },
      schedules: [{ name: 'sync', cron: '0 * * * *' }],
    });
    await env.db.insert(deployments).values({
      id,
      project_id: project.id,
      status: 'live',
      manifest,
    });

    const res = await req(`/admin/deployments/${id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Manifest');
    expect(html).toContain('D1');
    expect(html).toContain('DB');
    expect(html).toContain('KV');
    expect(html).toContain('CACHE');
    expect(html).toContain('sqlite');
    expect(visibleMarkup(html)).toContain('1 pending');
    expect(html).toContain('sync');
    expect(html).toContain('0 * * * *');
    expect(html).toContain('Raw JSON');

    const client = await readFile(
      new URL('../../dist/admin-assets/admin/client.js', import.meta.url),
    );
    const css = await readFile(new URL('../../dist/admin-assets/admin/style.css', import.meta.url));
    const browser = await chromium.launch();
    try {
      for (const width of [1280, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: 844 },
          reducedMotion: 'no-preference',
        });
        await context.addCookies([
          { name: 'admin_token', value: admin.adminJwt, url: 'http://localhost' },
        ]);
        const page = await context.newPage();
        page.setDefaultTimeout(5000);
        const errors: Array<string> = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', async (route) => {
          const incoming = route.request();
          const url = new URL(incoming.url());
          if (url.origin !== 'http://localhost') {
            return route.abort();
          }
          if (url.pathname === '/admin/client.js' || url.pathname === '/admin/style.css') {
            return route.fulfill({
              contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css',
              body: url.pathname.endsWith('.js') ? client : css,
            });
          }
          const response = await app.fetch(
            new Request(incoming.url(), {
              method: incoming.method(),
              headers: await incoming.allHeaders(),
              ...(incoming.method() === 'POST' ? { body: incoming.postData() ?? '' } : {}),
            }),
            { ...env, DEV_AUTH_BYPASS: 'true' },
          );
          await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          });
        });
        await page.goto(`http://localhost/admin/deployments/${id}`);
        await page.locator('[data-hydrated="true"]').waitFor();
        const card = page
          .locator('.void-admin-card')
          .filter({ has: page.getByRole('heading', { name: 'Manifest', exact: true }) });
        const heading = (await card
          .getByRole('heading', { name: 'Manifest', exact: true })
          .boundingBox())!;
        const kv = (await card.locator('th').filter({ hasText: /^KV$/ }).boundingBox())!;
        expect(kv.y).toBeGreaterThan(heading.y + heading.height);
        const table = (await card
          .getByRole('group', { name: 'Table', exact: true })
          .boundingBox())!;
        expect(kv.y).toBeGreaterThanOrEqual(table.y);
        expect(kv.y + kv.height).toBeLessThanOrEqual(table.y + table.height);
        const trigger = card.getByRole('button', { name: 'Raw JSON', exact: true });
        expect(await trigger.getAttribute('aria-expanded')).toBe('false');
        const triggerBox = (await trigger.boundingBox())!;
        expect(triggerBox.y - (table.y + table.height)).toBeCloseTo(16, 0);
        const json = card.locator('pre');
        expect(await json.isVisible()).toBe(false);
        await trigger.hover();
        expect(await trigger.evaluate((button) => getComputedStyle(button).transform)).toBe('none');
        await page.mouse.down();
        expect(await trigger.evaluate((button) => getComputedStyle(button).transform)).toBe('none');
        await page.mouse.up();
        await json.waitFor({ state: 'visible' });
        expect(await trigger.getAttribute('aria-expanded')).toBe('true');
        expect(await json.textContent()).toBe(JSON.stringify(JSON.parse(manifest), null, 2));
        await json.locator('code span').first().waitFor();
        expect(await json.textContent()).toBe(JSON.stringify(JSON.parse(manifest), null, 2));
        expect(await json.locator('script').count()).toBe(0);
        const stringToken = json.locator('code span').filter({ hasText: /^"CACHE"$/ });
        expect(await stringToken.evaluate((token) => getComputedStyle(token).color)).toBe(
          'rgb(0, 163, 63)',
        );
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.waitForFunction(() => {
          const token = Array.from(
            document.querySelectorAll('.void-admin-code-block code span'),
          ).find((span) => span.textContent === '"CACHE"');
          return token && getComputedStyle(token).color === 'rgb(82, 206, 129)';
        });
        expect(await json.textContent()).toBe(JSON.stringify(JSON.parse(manifest), null, 2));
        await trigger.focus();
        await trigger.press('Enter');
        await json.waitFor({ state: 'hidden' });
        expect(await trigger.getAttribute('aria-expanded')).toBe('false');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        expect(errors).toEqual([]);
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }, 30_000);

  test('returns 404 for unknown deployment', async () => {
    const admin = await createTestUser(env.db, 'admin13', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/deployments/dpl_nonexistent', admin.adminJwt);
    expect(res.status).toBe(404);
  });

  test('shows cancel button for active deployment', async () => {
    const admin = await createTestUser(env.db, 'admin12d', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'active-deploy-proj');
    const deployment = await createTestDeployment(env.db, project.id, 'uploading');

    const res = await req(`/admin/deployments/${deployment.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Deploy Control');
    expect(html).toContain('Cancel Deploy');
    expect(html).toContain(`/admin/deployments/${deployment.id}/cancel`);
  });
});

describe('POST /admin/deployments/:id/cancel', () => {
  test('cancels active deployment and redirects to detail', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-cancel1',
      'github',
      undefined,
      'free',
      'admin',
    );
    const project = await createTestProject(env.db, admin.id, 'cancel-admin-proj');
    const deployment = await createTestDeployment(env.db, project.id, 'uploading');

    const res = await req(`/admin/deployments/${deployment.id}/cancel`, admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`/admin/deployments/${deployment.id}`);

    const rows = await env.db.select().from(deployments);
    const canceling = rows.find((d) => d.id === deployment.id);
    expect(canceling?.status).toBe('canceling');
    expect(canceling?.error_message).toBe('canceled by admin');
  });
});

describe('GET /admin/login', () => {
  test('renders login page without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/admin/login'), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sign in to administer');
    expect(html).toContain('Void Platform');
    expect(html).toContain('aria-label="Void"');
    expect(html).toContain('GitHub');
    expect(html).toContain('Google');
  });

  // A tenant app can share a site with the API, so a page that frames the
  // admin UI would still be sent the admin cookie.
  test('admin pages refuse framing', async () => {
    const page = await app.fetch(new Request('http://localhost/admin/login'), env);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");

    const health = await app.fetch(new Request('http://localhost/health'), env);
    expect(health.headers.get('content-type')).toContain('application/json');
    expect(health.headers.get('x-frame-options')).toBeNull();
    expect(health.headers.get('content-security-policy')).toBeNull();
  });

  test('shows only the authentication providers enabled by the platform', async () => {
    env.PLATFORM_CAPABILITIES = JSON.stringify({
      ai: true,
      customDomains: false,
      email: false,
      githubActions: true,
      githubOAuth: true,
      googleOAuth: false,
      managedBuilds: false,
      sandbox: false,
    });
    try {
      const res = await app.fetch(new Request('http://localhost/admin/login'), env);
      const html = await res.text();
      expect(visibleMarkup(html)).toContain('Sign in with GitHub');
      expect(html).not.toContain('Sign in with Google');
    } finally {
      env.PLATFORM_CAPABILITIES = undefined;
    }
  });

  test('signs an administrator in with GitHub OAuth', async () => {
    await createTestUser(env.db, 'octocat', 'github', '4242', 'custom', 'admin');
    const start = await app.fetch(
      new Request('http://localhost/admin/login/github', { redirect: 'manual' }),
      env,
    );
    expect(start.status).toBe(302);
    const authorization = new URL(start.headers.get('Location')!);
    expect(authorization.origin + authorization.pathname).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(authorization.searchParams.get('redirect_uri')).toBe('http://localhost/auth/callback');
    const state = authorization.searchParams.get('state')!;
    const browserCookie = start.headers.get('Set-Cookie')!.split(';', 1)[0]!;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url === 'https://github.com/login/oauth/access_token') {
          return Response.json({ access_token: 'github-token' });
        }
        if (url === 'https://api.github.com/user') {
          return Response.json({ id: 4242, login: 'octocat', email: null });
        }
        if (url === 'https://api.github.com/user/emails') {
          return Response.json([]);
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
    try {
      const callback = await app.fetch(
        new Request(
          `http://localhost/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
          { headers: { Cookie: browserCookie }, redirect: 'manual' },
        ),
        env,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get('Location')).toBe('/admin/');
      expect(callback.headers.get('Set-Cookie')).toContain('admin_token=');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('names the cause when GitHub refuses the admin sign-in', async () => {
    const start = await app.fetch(
      new Request('http://localhost/admin/login/github', { redirect: 'manual' }),
      env,
    );
    const state = new URL(start.headers.get('Location')!).searchParams.get('state')!;
    const browserCookie = start.headers.get('Set-Cookie')!.split(';', 1)[0]!;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        if (input.toString() === 'https://github.com/login/oauth/access_token') {
          return Response.json({ error: 'redirect_uri_mismatch' });
        }
        throw new Error(`Unexpected fetch: ${input.toString()}`);
      }),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const callback = await app.fetch(
        new Request(
          `http://localhost/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
          { headers: { Cookie: browserCookie }, redirect: 'manual' },
        ),
        env,
      );
      expect(callback.status).toBe(400);
      const html = await callback.text();
      expect(html).toContain('GitHub rejected the callback URL.');
      expect(html).toContain('Error code: github_redirect_uri_mismatch');
      expect(html).toContain('Callback URL: http://localhost/auth/callback');
      expect(errors).toHaveBeenCalledWith('[auth] login failed', {
        code: 'github_redirect_uri_mismatch',
        purpose: 'admin',
        provider: 'github',
      });
    } finally {
      errors.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  test.each([
    { reason: 'admin_suspended', expectedStatus: 403, issuesCookie: false },
    { reason: 'requests_exceeded', expectedStatus: 302, issuesCookie: true },
  ])(
    'handles an OAuth login for an administrator suspended with $reason',
    async ({ reason, expectedStatus, issuesCookie }) => {
      const admin = await createTestUser(
        env.db,
        `oauth-${reason}`,
        'github',
        '4343',
        'custom',
        'admin',
      );
      await env.db.update(users).set({ suspended_reason: reason }).where(eq(users.id, admin.id));
      const start = await app.fetch(
        new Request('http://localhost/admin/login/github', { redirect: 'manual' }),
        env,
      );
      const authorization = new URL(start.headers.get('Location')!);
      const state = authorization.searchParams.get('state')!;
      const browserCookie = start.headers.get('Set-Cookie')!.split(';', 1)[0]!;

      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request): Promise<Response> => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (url === 'https://github.com/login/oauth/access_token') {
            return Response.json({ access_token: 'github-token' });
          }
          if (url === 'https://api.github.com/user') {
            return Response.json({ id: 4343, login: 'octocat', email: null });
          }
          if (url === 'https://api.github.com/user/emails') {
            return Response.json([]);
          }
          throw new Error(`Unexpected fetch: ${url}`);
        }),
      );
      try {
        const callback = await app.fetch(
          new Request(
            `http://localhost/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
            { headers: { Cookie: browserCookie }, redirect: 'manual' },
          ),
          env,
        );

        expect(callback.status).toBe(expectedStatus);
        expect(callback.headers.get('Set-Cookie')?.includes('admin_token=') ?? false).toBe(
          issuesCookie,
        );
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});

describe('GET /admin/logout', () => {
  test('clears cookie and redirects', async () => {
    const admin = await createTestUser(env.db, 'admin9', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/logout', admin.adminJwt);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/login');
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toContain('admin_token=');
  });
});

describe('POST /admin/projects/:id/owner', () => {
  test('previews owners, plans, suspension, and active-work blockers without auditing', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-transfer-preview',
      'github',
      undefined,
      'free',
      'admin',
    );
    const owner = await createTestUser(env.db, 'browser-transfer-owner');
    const target = await createTestUser(
      env.db,
      'browser-transfer-target',
      'github',
      undefined,
      'pro',
    );
    await env.db
      .update(users)
      .set({ suspended_reason: 'operator_review' })
      .where(eq(users.id, target.id));
    const project = await createTestProject(env.db, owner.id, 'browser-transfer-project');
    const deployment = await createTestDeployment(env.db, project.id, 'pending');

    const response = await req(`/admin/projects/${project.id}/owner/preview`, admin.adminJwt, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ userId: target.id }),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(visibleMarkup(html)).toContain(`Transfer Ownership: ${project.slug}`);
    expect(html).toContain(owner.login);
    expect(html).toContain(target.login);
    expect(html).toContain('pro');
    expect(html).toContain('Suspended (operator_review)');
    expect(visibleMarkup(html)).toContain(`deployment: ${deployment.id} (pending)`);
    expect(html).toContain('Resolve or cancel all active work');
    expect(html).not.toContain(`action="/admin/projects/${project.id}/owner"`);
    expect(await env.db.select().from(operatorEvents)).toEqual([]);
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0],
    ).toMatchObject({ user_id: owner.id });
  });

  test('renders a same-owner preview as convergence-only without null placeholders', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-convergence-preview',
      'github',
      undefined,
      'free',
      'admin',
    );
    const formerOwner = await createTestUser(env.db, 'browser-convergence-former-owner');
    const owner = await createTestUser(env.db, 'browser-convergence-owner');
    const project = await createTestProject(env.db, owner.id, 'browser-convergence-project');
    const deployment = await createTestDeployment(env.db, project.id, 'pending');
    await env.db
      .delete(projectOwnershipPeriods)
      .where(eq(projectOwnershipPeriods.project_id, project.id));
    await env.db.insert(projectOwnershipPeriods).values([
      {
        id: 'pown_browser_convergence_former',
        project_id: project.id,
        owner_user_id: formerOwner.id,
        starts_at: '2026-01-01T00:00:00.000Z',
        ends_at: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'pown_browser_convergence_current',
        project_id: project.id,
        owner_user_id: owner.id,
        starts_at: '2026-02-01T00:00:00.000Z',
      },
    ]);

    const response = await req(`/admin/projects/${project.id}/owner/preview`, admin.adminJwt, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ userId: owner.id }),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(visibleMarkup(html)).toContain(`Converge Ownership State: ${project.slug}`);
    expect(html).toContain('This is a convergence-only operation');
    expect(html).toContain(`detach from <code>${formerOwner.id}</code>`);
    expect(visibleMarkup(html)).toContain(`deployment: ${deployment.id} (pending)`);
    expect(html).toContain('Active work does not block convergence.');
    expect(html).toContain('Apply Convergence');
    expect(html).toContain(`action="/admin/projects/${project.id}/owner"`);
    expect(html).not.toContain('Resolve or cancel all active work');
    expect(html).not.toContain('The former owner will become');
    expect(html).not.toContain('detach from <code></code>');
    expect(await env.db.select().from(operatorEvents)).toEqual([]);
  });

  test('applies the confirmed transfer, audits it, and redirects to project detail', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-transfer-apply',
      'github',
      undefined,
      'free',
      'admin',
    );
    const owner = await createTestUser(env.db, 'browser-apply-owner');
    const target = await createTestUser(env.db, 'browser-apply-target');
    const project = await createTestProject(env.db, owner.id, 'browser-apply-project');

    const response = await req(`/admin/projects/${project.id}/owner`, admin.adminJwt, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ userId: target.id }),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`/admin/projects/${project.id}`);
    expect(response.headers.get('X-Void-Audit-Id')).toBeTruthy();
    expect(
      (await env.db.select().from(projects).where(eq(projects.id, project.id)))[0],
    ).toMatchObject({ user_id: target.id });
    expect(await env.db.select().from(operatorEvents)).toEqual([
      expect.objectContaining({
        action: `projects/${project.id}/owner`,
        target: JSON.stringify({ projectId: project.id, userId: target.id }),
        status: 'success',
        http_status: 302,
      }),
    ]);
  });
});

describe('POST /admin/projects/:id/delete', () => {
  test('deletes project and redirects to list', async () => {
    mockCfApi();
    skipOrphanSweepDelay();
    const admin = await createTestUser(env.db, 'admin-pdel1', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'projdel-owner');
    const project = await createTestProject(env.db, user.id, 'del-proj');
    await createTestDeployment(env.db, project.id, 'live');

    const res = await req(`/admin/projects/${project.id}/delete`, admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/projects');

    // Verify project is gone from DB
    const remaining = await env.db.select().from(projects);
    expect(remaining.find((p) => p.id === project.id)).toBeUndefined();
    vi.restoreAllMocks();
  });

  test('returns 404 for unknown project', async () => {
    const admin = await createTestUser(env.db, 'admin-pdel2', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/projects/proj_nonexistent/delete', admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(404);
  });

  test('shows delete button on project detail page', async () => {
    const admin = await createTestUser(env.db, 'admin-pdel3', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'delbtn-proj');

    const res = await req(`/admin/projects/${project.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Danger Zone');
    expect(html).toContain('Delete Project');
    expect(html).toContain(`/admin/projects/${project.id}/delete`);
  });
});

describe('POST /admin/users/:id/delete', () => {
  test('deletes user and cascades to projects, redirects to list', async () => {
    mockCfApi();
    skipOrphanSweepDelay();
    const admin = await createTestUser(env.db, 'admin-udel1', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'delusertarget');
    const project1 = await createTestProject(env.db, user.id, 'udel-proj1');
    const project2 = await createTestProject(env.db, user.id, 'udel-proj2');
    await createTestDeployment(env.db, project1.id, 'live');
    await createTestDeployment(env.db, project2.id, 'live');

    const res = await req(`/admin/users/${user.id}/delete`, admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/admin/users');

    // Verify user and projects are gone
    const remainingUsers = await env.db.select().from(users);
    expect(remainingUsers.find((u) => u.id === user.id)).toBeUndefined();
    const remainingProjects = await env.db.select().from(projects);
    expect(remainingProjects.find((p) => p.id === project1.id)).toBeUndefined();
    expect(remainingProjects.find((p) => p.id === project2.id)).toBeUndefined();
    vi.restoreAllMocks();
  });

  test('returns 404 for unknown user', async () => {
    const admin = await createTestUser(env.db, 'admin-udel2', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/users/user_nonexistent/delete', admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(404);
  });

  test('shows delete button on user detail page', async () => {
    const admin = await createTestUser(env.db, 'admin-udel3', 'github', undefined, 'free', 'admin');
    const user = await createTestUser(env.db, 'delbtnuser');
    await createTestProject(env.db, user.id, 'ubtn-proj');

    const res = await req(`/admin/users/${user.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Danger Zone');
    expect(html).toContain('Delete User');
    expect(html).toContain(`/admin/users/${user.id}/delete`);
    expect(html).toContain('1 project(s)');
  });
});

describe('GET /admin/deployments/:id/logs', () => {
  test('selects and orders by ingestion time so newly ingested errors from old requests remain visible', async () => {
    const admin = await createTestUser(env.db, 'admin-logs1', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'logs-proj');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    const now = 1_709_333_000_000;
    const oldRequestStart = now - 60 * 60 * 1000;
    const newlyIngested = now - 30 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    mockCfApi({
      analyticsQuery: (_url, init) => {
        const query = String(init?.body);
        expect(query).toContain(
          `timestamp >= toDateTime('${new Date(now - 60_000).toISOString().replace('T', ' ').slice(0, 19)}')`,
        );
        expect(query).not.toMatch(/AND double1 >= \d+/);
        expect(query).toContain(
          'GROUP BY blob1, blob2, blob3, blob4, blob5, blob6, blob7, blob8, double1',
        );
        expect(query).toContain('ORDER BY ingestedAt DESC, ts DESC');
        return Response.json({
          data: [
            {
              outcome: 'exception',
              logData: '[{"level":"error","message":"late failure"}]',
              exceptionData: '[{"name":"Error","message":"late failure"}]',
              url: 'https://logs-proj.void.app/',
              method: 'GET',
              statusCode: '500',
              ts: oldRequestStart,
              ingestedAt: new Date(newlyIngested).toISOString(),
            },
          ],
        });
      },
    });

    const res = await req(`/admin/deployments/${deployment.id}/logs?since=1m`, admin.adminJwt);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: Array<{ outcome: string; logs: Array<unknown>; timestamp: number; ingestedAt: number }>;
    };
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      outcome: 'exception',
      timestamp: oldRequestStart,
      ingestedAt: newlyIngested,
    });
    expect(json.data[0].logs).toHaveLength(1);
    const fateResponse = await req('/admin/fate', admin.adminJwt, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        operations: [
          {
            id: 'logs',
            kind: 'query',
            name: 'deploymentLogs',
            args: { id: deployment.id, since: '1m', limit: 50 },
            select: ['id', 'data'],
          },
        ],
      }),
    });
    expect(fateResponse.status).toBe(200);
    const fateBody = (await fateResponse.json()) as {
      results: Array<{ ok: boolean; data?: { data?: Array<{ outcome: string }> } }>;
    };
    expect(fateBody.results[0]?.ok).toBe(true);
    expect(fateBody.results[0]?.data?.data?.[0]?.outcome).toBe('exception');
    vi.restoreAllMocks();
  });

  test('marks admin log responses only when runtime logs are minimal', async () => {
    const admin = await createTestUser(env.db, 'admin-logs3', 'github', undefined, 'free', 'admin');
    const project = await createTestProject(env.db, admin.id, 'logs-minimal');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    mockCfApi({
      analyticsQuery: () =>
        Response.json({
          data: [
            {
              outcome: 'exception',
              logData: '[{"level":"error","timestamp":1,"message":[]}]',
              exceptionData: '[{"name":"Error","timestamp":1,"message":""}]',
              url: '',
              method: 'GET',
              statusCode: '500',
              ts: Date.now() - 1000,
              ingestedAt: new Date(Date.now() - 500).toISOString(),
            },
          ],
        }),
    });
    const minimal = { PLATFORM_RUNTIME_LOGS: 'minimal' } as const;
    const fateLogs = (overrides?: Partial<ApiEnv['Bindings']>) =>
      req(
        '/admin/fate',
        admin.adminJwt,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            operations: [
              {
                id: 'logs',
                kind: 'query',
                name: 'deploymentLogs',
                args: { id: deployment.id, since: '1h', limit: 50 },
                select: ['id', 'data', 'runtimeLogs'],
              },
            ],
          }),
        },
        overrides,
      );

    const full = await req(`/admin/deployments/${deployment.id}/logs`, admin.adminJwt);
    expect(await full.json()).not.toHaveProperty('runtimeLogs');
    const route = await req(
      `/admin/deployments/${deployment.id}/logs`,
      admin.adminJwt,
      undefined,
      minimal,
    );
    expect(await route.json()).toMatchObject({ runtimeLogs: 'minimal', data: [{ url: '' }] });

    type FateBody = { results: Array<{ ok: boolean; data?: Record<string, unknown> }> };
    const fullFate = (await (await fateLogs()).json()) as FateBody;
    expect(fullFate.results[0]?.ok).toBe(true);
    expect(fullFate.results[0]?.data?.runtimeLogs ?? null).toBeNull();
    const minimalFate = (await (await fateLogs(minimal)).json()) as FateBody;
    expect(minimalFate.results[0]?.ok).toBe(true);
    expect(minimalFate.results[0]?.data?.runtimeLogs).toBe('minimal');
  });

  test('returns 404 for unknown deployment', async () => {
    const admin = await createTestUser(env.db, 'admin-logs2', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/deployments/dpl_unknown/logs', admin.adminJwt);
    expect(res.status).toBe(404);
  });
});

describe('GET /admin/deployments/:id (logs section)', () => {
  test('renders runtime logs section for live deployment', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-logsui',
      'github',
      undefined,
      'free',
      'admin',
    );
    const project = await createTestProject(env.db, admin.id, 'logsui-proj');
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const res = await req(`/admin/deployments/${deployment.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Runtime Logs');
    expect(html).toContain('Live Tail');
    expect(html).toContain('log-entries');
  });

  test('renders the client-side runtime log filter', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-logsui3',
      'github',
      undefined,
      'free',
      'admin',
    );
    const project = await createTestProject(env.db, admin.id, 'logsui3-proj');
    const deployment = await createTestDeployment(env.db, project.id, 'live');

    const res = await req(`/admin/deployments/${deployment.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('role="combobox"');
    expect(html).toContain('placeholder="Filter logs"');
    expect(html).toContain('"component":"deploymentDetail"');
    expect(html).toContain('src="/admin/client.js"');
  });

  test('does not render logs section for failed deployment', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-logsui2',
      'github',
      undefined,
      'free',
      'admin',
    );
    const project = await createTestProject(env.db, admin.id, 'logsui2-proj');
    const deployment = await createTestDeployment(
      env.db,
      project.id,
      'failed',
      'cli',
      'some error',
    );

    const res = await req(`/admin/deployments/${deployment.id}`, admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Runtime Logs');
  });
});

describe('GET /admin/signup-control', () => {
  test('renders Access with basic signup control and manual invitation instructions', async () => {
    const admin = await createTestUser(env.db, 'admin-sc1', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/signup-control', admin.adminJwt);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(visibleMarkup(html)).toContain('>Access</h1>');
    expect(visibleMarkup(html)).toContain('Signup is open to anyone with an enabled login');
    expect(html).toContain('Share these details manually');
    expect(html).toContain("void connect 'localhost'");
    expect(html).toContain('Email not enabled');
  });

  test('shows entries when they exist', async () => {
    const admin = await createTestUser(env.db, 'admin-sc2', 'github', undefined, 'free', 'admin');
    await env.ROUTING.put(
      'signup:allowlist',
      JSON.stringify([{ type: 'github', pattern: 'octocat', note: 'Test' }]),
    );
    const res = await req('/admin/signup-control', admin.adminJwt);
    const html = await res.text();
    expect(html).toContain('octocat');
    expect(html).toContain('Test');
    await env.ROUTING.delete('signup:allowlist');
  });

  test('shows accepted and deployed status for allowlist entries', async () => {
    const admin = await createTestUser(env.db, 'admin-sc2c', 'github', undefined, 'free', 'admin');
    const acceptedEmailUser = await createTestUser(env.db, 'email-user');
    await env.db
      .update(users)
      .set({ email: 'accepted@example.com' })
      .where(eq(users.id, acceptedEmailUser.id));
    const project = await createTestProject(env.db, acceptedEmailUser.id, 'allowlist-status-proj');
    await createTestDeployment(env.db, project.id, 'live');
    await createTestUser(env.db, 'octocat');

    await env.ROUTING.put(
      'signup:allowlist',
      JSON.stringify([
        { type: 'email', pattern: 'accepted@example.com', note: 'Email user' },
        { type: 'github', pattern: 'octocat', note: 'GitHub user' },
        { type: 'email', pattern: 'pending@example.com', note: 'Pending' },
      ]),
    );

    const res = await req('/admin/signup-control', admin.adminJwt);
    const html = await res.text();

    function rowFor(pattern: string): string {
      const markup = html.slice(html.indexOf('<div id="app">'));
      const row = markup.split('<tr').find((part) => part.includes(`>${pattern}</td>`));
      expect(row).not.toBeNull();
      return `<tr${row}`;
    }

    expect(html).toMatch(/<th[^>]*>Accepted<\/th>/);
    expect(html).toMatch(/<th[^>]*>Deployed<\/th>/);
    expect(rowFor('accepted@example.com').match(/>Yes</g)).toHaveLength(2);
    expect(rowFor('octocat').match(/>Yes</g)).toHaveLength(1);
    expect(rowFor('octocat').match(/>No</g)).toHaveLength(1);
    expect(rowFor('pending@example.com').match(/>No</g)).toHaveLength(2);

    await env.ROUTING.delete('signup:allowlist');
  });

  test('nav bar has a single Access link', async () => {
    const admin = await createTestUser(env.db, 'admin-sc2b', 'github', undefined, 'free', 'admin');
    const res = await req('/admin/signup-control', admin.adminJwt);
    const html = await res.text();
    expect(html).toContain('href="/admin/signup-control"');
    expect(visibleMarkup(html)).toContain('Access');
    expect(html).not.toContain('href="/admin/invitations"');
  });
});

describe('POST /admin/signup-control/toggle', () => {
  test('toggles restriction on and off', async () => {
    const admin = await createTestUser(env.db, 'admin-sc3', 'github', undefined, 'free', 'admin');

    // Toggle ON
    const res1 = await req('/admin/signup-control/toggle', admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res1.status).toBe(302);
    expect(await env.ROUTING.get('signup:enabled')).toBe('true');

    // Toggle OFF
    const res2 = await req('/admin/signup-control/toggle', admin.adminJwt, {
      method: 'POST',
      body: '',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res2.status).toBe(302);
    expect(await env.ROUTING.get('signup:enabled')).toBe('false');

    await env.ROUTING.delete('signup:enabled');
  });
});

describe('POST /admin/signup-control/add + delete', () => {
  test('adds an exact identity grant for a configured login connection', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-sc-identity',
      'github',
      undefined,
      'free',
      'admin',
    );
    await env.db.insert(platformLoginConnections).values({
      id: 'company',
      kind: 'oidc',
      revision: 1,
    });
    await env.db.insert(platformLoginRevisions).values({
      connection_id: 'company',
      revision: 1,
      configuration: {
        id: 'company',
        kind: 'oidc',
        label: 'Company SSO',
        clientId: 'client',
        issuer: 'https://identity.example.com',
        allowedDomains: [],
        requiredGroups: [],
      },
      secret: { ciphertext: 'unused', iv: 'unused', keyVersion: 'unused' },
    });
    const page = await req('/admin/signup-control', admin.adminJwt);
    const html = await page.text();
    expect(html).toContain('Exact provider subject');
    expect(visibleMarkup(html)).toContain('Company SSO (company)');

    const body = new URLSearchParams({
      type: 'identity',
      connectionId: 'company',
      subject: 'Employee-42',
      note: 'No email',
    });
    const response = await req('/admin/signup-control/add', admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(response.status).toBe(302);
    expect(JSON.parse((await env.ROUTING.get('signup:allowlist'))!)).toEqual([
      {
        type: 'identity',
        connectionId: 'company',
        subject: 'Employee-42',
        note: 'No email',
      },
    ]);
    await env.ROUTING.delete('signup:allowlist');
  });

  test('adds and removes entries', async () => {
    const admin = await createTestUser(env.db, 'admin-sc4', 'github', undefined, 'free', 'admin');
    await env.ROUTING.delete('signup:allowlist');

    // Add entry
    const addBody = new URLSearchParams({ type: 'github', pattern: 'testuser', note: 'Test' });
    const addRes = await req('/admin/signup-control/add', admin.adminJwt, {
      method: 'POST',
      body: addBody.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(addRes.status).toBe(302);

    const raw = await env.ROUTING.get('signup:allowlist');
    const entries = JSON.parse(raw!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ type: 'github', pattern: 'testuser', note: 'Test' });

    // Delete entry
    const delBody = new URLSearchParams({ index: '0' });
    const delRes = await req('/admin/signup-control/delete', admin.adminJwt, {
      method: 'POST',
      body: delBody.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(delRes.status).toBe(302);

    const rawAfter = await env.ROUTING.get('signup:allowlist');
    expect(JSON.parse(rawAfter!)).toHaveLength(0);

    await env.ROUTING.delete('signup:allowlist');
  });

  test('adds multiple comma or whitespace separated entries', async () => {
    const admin = await createTestUser(env.db, 'admin-sc7', 'github', undefined, 'free', 'admin');
    await env.ROUTING.delete('signup:allowlist');

    const body = new URLSearchParams({
      type: 'email',
      pattern: 'One@Example.com, two@example.com\n*@Example.org  One@Example.com',
      note: 'Sales list',
    });
    const res = await req('/admin/signup-control/add', admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(302);

    const raw = await env.ROUTING.get('signup:allowlist');
    expect(JSON.parse(raw!)).toEqual([
      { type: 'email', pattern: 'one@example.com', note: 'Sales list' },
      { type: 'email', pattern: 'two@example.com', note: 'Sales list' },
      { type: 'email', pattern: '*@example.org', note: 'Sales list' },
    ]);

    await env.ROUTING.delete('signup:allowlist');
  });

  test('rejects invalid entry type', async () => {
    const admin = await createTestUser(env.db, 'admin-sc5', 'github', undefined, 'free', 'admin');

    const body = new URLSearchParams({ type: 'invalid', pattern: 'test' });
    const res = await req('/admin/signup-control/add', admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('href="/admin/"');
    expect(html).toContain('Refresh dashboard');
  });

  test('rejects delete with out-of-bounds index', async () => {
    const admin = await createTestUser(env.db, 'admin-sc6', 'github', undefined, 'free', 'admin');

    const body = new URLSearchParams({ index: '99' });
    const res = await req('/admin/signup-control/delete', admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/invitations/send', () => {
  test('shows an email-free grant once on Access with separate delivery status', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-inv-no-email',
      'github',
      undefined,
      'free',
      'admin',
    );
    await env.ROUTING.delete('signup:allowlist');
    await env.ROUTING.put('signup:enabled', 'true');
    try {
      const before = await req('/admin/signup-control', admin.adminJwt);
      expect(visibleMarkup(await before.text())).toContain('Create invitations');

      const response = await req('/admin/invitations/send', admin.adminJwt, {
        method: 'POST',
        body: new URLSearchParams({ email: 'guest@example.com' }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/admin/signup-control?result=invited');

      const page = await req('/admin/signup-control?result=invited', admin.adminJwt);
      const visible = visibleMarkup((await page.text()).split('<div id="app">')[1] ?? '');
      expect(visible).toContain('Invitations created. Share the platform link below');
      expect(visible).toContain('Email off');
      expect(visible.split('Direct grants')[1]?.split('Invitation history')[0]).not.toContain(
        'guest@example.com',
      );
      expect(tableRowContaining(visible, 'guest@example.com')).toContain('Revoke');

      const oldPage = await req('/admin/invitations', admin.adminJwt);
      expect(oldPage.status).toBe(302);
      expect(oldPage.headers.get('Location')).toBe('/admin/signup-control');
    } finally {
      await env.ROUTING.delete('signup:enabled');
      await env.ROUTING.delete('signup:allowlist');
    }
  });

  test('keeps invitation grants out of direct grants across invitation pages', async () => {
    const admin = await createTestUser(
      env.db,
      'admin-inv-pages',
      'github',
      undefined,
      'free',
      'admin',
    );
    await env.ROUTING.put(
      'signup:allowlist',
      JSON.stringify([{ type: 'email', pattern: 'older@example.com', note: 'Invited' }]),
    );
    try {
      await env.db.insert(invitations).values([
        {
          id: 'older-invitation',
          email: 'older@example.com',
          invited_by: admin.id,
          status: 'accepted',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        ...Array.from({ length: 50 }, (_, index) => ({
          id: `newer-invitation-${index}`,
          email: `newer-${index}@example.com`,
          invited_by: admin.id,
          created_at: '2026-09-01T00:00:00.000Z',
        })),
      ]);
      const first = visibleMarkup(
        (await (await req('/admin/signup-control', admin.adminJwt)).text()).split(
          '<div id="app">',
        )[1] ?? '',
      );
      expect(first.split('Direct grants')[1]?.split('Invitation history')[0]).not.toContain(
        'older@example.com',
      );
      const second = visibleMarkup(
        (await (await req('/admin/signup-control?page=2', admin.adminJwt)).text()).split(
          '<div id="app">',
        )[1] ?? '',
      );
      expect(tableRowContaining(second, 'older@example.com')).toContain('Remove signup grant');
    } finally {
      await env.ROUTING.delete('signup:allowlist');
    }
  });

  test('invites multiple comma or whitespace separated emails', async () => {
    const admin = await createTestUser(env.db, 'admin-inv1', 'github', undefined, 'free', 'admin');
    await env.ROUTING.delete('signup:allowlist');

    const body = new URLSearchParams({
      email: 'abc@x.com, zyc@gmail.com\nThird@Example.com  abc@x.com',
    });
    const res = await req('/admin/invitations/send', admin.adminJwt, {
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });

    expect(res.status).toBe(302);

    const rows = await env.db.select().from(invitations);
    expect(rows.map((row) => row.email).sort()).toEqual([
      'abc@x.com',
      'third@example.com',
      'zyc@gmail.com',
    ]);

    const raw = await env.ROUTING.get('signup:allowlist');
    expect(JSON.parse(raw!)).toEqual([
      { type: 'email', pattern: 'abc@x.com', note: 'Invited by admin-inv1' },
      { type: 'email', pattern: 'zyc@gmail.com', note: 'Invited by admin-inv1' },
      { type: 'email', pattern: 'third@example.com', note: 'Invited by admin-inv1' },
    ]);

    await env.ROUTING.delete('signup:allowlist');
  });

  test('rejects a batch if any email is already invited', async () => {
    const admin = await createTestUser(env.db, 'admin-inv2', 'github', undefined, 'free', 'admin');
    await env.ROUTING.delete('signup:allowlist');

    const firstBody = new URLSearchParams({ email: 'existing@example.com' });
    const firstRes = await req('/admin/invitations/send', admin.adminJwt, {
      method: 'POST',
      body: firstBody.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });
    expect(firstRes.status).toBe(302);

    const secondBody = new URLSearchParams({
      email: 'new@example.com, existing@example.com',
    });
    const secondRes = await req('/admin/invitations/send', admin.adminJwt, {
      method: 'POST',
      body: secondBody.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } as Record<string, string>,
    });

    expect(secondRes.status).toBe(400);
    const rows = await env.db.select().from(invitations);
    expect(rows.map((row) => row.email)).toEqual(['existing@example.com']);

    await env.ROUTING.delete('signup:allowlist');
  });
});

describe('GET /signup-restricted', () => {
  test('explains administrator-controlled signup without auth', async () => {
    const res = await app.fetch(new Request('http://localhost/signup-restricted'), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Signup Restricted');
    expect(html).toContain('require administrator approval');
  });
});
