import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createPlatformDeploymentManifest,
  createPlatformInstallationManifest,
  PLATFORM_DISABLED_KEY,
  type PlatformInstallationManifest,
} from '@void/platform';
import {
  getPlatformRuntimeDirectory,
  PLATFORM_ADMIN_CLIENT_ASSET_PATH,
  PLATFORM_ADMIN_STYLE_ASSET_PATH,
} from '@void/platform/installer';
import { eq, sql } from 'drizzle-orm';
import { chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vite-plus/test';
import { importLegacyAuthentication } from '../../src/auth/configuration.ts';
import { app } from '../../src/index.ts';
import { users } from '../../src/schema.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv, type TestEnv } from './helpers.ts';

let env: TestEnv;
let admin: Awaited<ReturnType<typeof createTestUser>>;
let manifest: PlatformInstallationManifest;
const installationId = 'status-fixture';
beforeAll(async () => {
  env = await setupEnv();
  await env.db.execute(sql`CREATE TABLE __void_platform_installation (
    singleton boolean PRIMARY KEY, installation_id text NOT NULL, ownership_nonce text NOT NULL DEFAULT 'status-owner', lifecycle_manifest jsonb NOT NULL
  )`);
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  await env.db.execute(sql`DELETE FROM __void_platform_installation`);
  await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
  admin = await createTestUser(env.db, 'status-admin', 'github', undefined, 'free', 'admin');
  const timestamp = '2026-10-05T00:00:00.000Z';
  manifest = {
    ...createPlatformInstallationManifest({
      account: { id: 'account', name: 'Account' },
      createdAt: timestamp,
      deployment: createPlatformDeploymentManifest({
        application: { baseDomain: 'apps.example.com', zoneName: 'example.com' },
        displayName: 'Example',
        installationSlug: 'example',
      }),
      id: installationId,
      ownershipNonce: 'private-owner-nonce-0123456789abcdef',
      platformVersion: '1.0.0',
    }),
    status: 'verifying',
    operation: {
      id: 'operation',
      action: 'rollback',
      fromVersion: '2.0.0',
      toVersion: '1.0.0',
      phase: 'waiting-for-sandbox-drain',
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  };
  await save();
});

async function save() {
  await env.db
    .execute(sql`INSERT INTO __void_platform_installation (singleton, installation_id, lifecycle_manifest) VALUES
    (true, ${installationId}, ${JSON.stringify(manifest)}::jsonb)
    ON CONFLICT (singleton) DO UPDATE SET lifecycle_manifest = excluded.lifecycle_manifest`);
}
function request(
  path: string,
  token: string | undefined = admin.adminJwt,
  init: RequestInit = {},
  trafficState = 'staging',
) {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Cookie', `admin_token=${token}`);
  }
  return app.fetch(new Request(`http://localhost${path}`, { ...init, headers }), {
    ...env,
    PLATFORM_INSTALLATION_ID: installationId,
    PLATFORM_TRAFFIC_STATE: trafficState,
  });
}

it.each(['staging', 'sandbox-drain'])(
  'serves private saved status to an admin during %s maintenance',
  async (trafficState) => {
    const response = await request('/admin/status.json', admin.adminJwt, {}, trafficState);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({
      traffic: 'paused',
      checkpoint: { operation: { action: 'rollback', phase: 'waiting-for-sandbox-drain' } },
    });
    expect(body).not.toContain('private-owner-nonce');
    expect(body).not.toContain('resources');
    const html = await request('/admin/status', admin.adminJwt, {}, trafficState);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('Waiting for Sandbox drain');
  },
);

it('observes the disabled KV gate even when the saved operation is complete', async () => {
  manifest = {
    ...manifest,
    status: 'installed',
    operation: { ...manifest.operation!, phase: 'complete' },
  };
  await save();
  await env.ROUTING.put(PLATFORM_DISABLED_KEY, 'disabled');
  expect(await (await request('/admin/status.json', admin.adminJwt, {}, '')).json()).toMatchObject({
    traffic: 'paused',
    checkpoint: { operation: { phase: 'complete' } },
  });
  await env.ROUTING.delete(PLATFORM_DISABLED_KEY);
  expect(await (await request('/admin/status.json', admin.adminJwt, {}, '')).json()).toMatchObject({
    traffic: 'enabled',
  });
});

it('requires a current administrator identity during maintenance', async () => {
  const anonymous = await request('/admin/status.json', '', {});
  expect(anonymous.status).toBe(302);
  expect(anonymous.headers.get('Location')).toBe('/admin/login');
  const regular = await createTestUser(env.db, 'status-member');
  expect((await request('/admin/status.json', regular.adminJwt)).status).toBe(403);
  await env.db.update(users).set({ suspended_reason: 'admin' }).where(eq(users.id, admin.id));
  expect((await request('/admin/status.json')).status).toBe(403);
});

it('keeps writes and other API routes gated while redirecting admin navigation to status', async () => {
  const response = await request('/admin/projects', admin.adminJwt, {
    headers: { Accept: 'text/html' },
  });
  expect(response.status).toBe(302);
  expect(response.headers.get('Location')).toBe('/admin/status');
  for (const path of [
    '/admin/status.json',
    '/admin/status',
    '/admin/fate',
    '/admin/backfill-queue-tokens',
    '/projects',
  ]) {
    const write = await request(path, admin.adminJwt, {
      method: 'POST',
      headers: { Origin: 'http://localhost' },
    });
    expect(write.status).toBe(503);
    expect(await write.json()).toEqual({ error: 'Platform disabled', reason: 'maintenance' });
  }
  expect((await request('/admin/health')).status).toBe(503);
  expect((await request('/auth/callback?state=not-admin&code=fixture')).status).toBe(503);
  expect((await request('/auth/callback?state=platform.unknown&code=fixture')).status).toBe(503);
  expect((await request('/admin/login', '')).status).toBe(200);
});

it('reports unavailable checkpoints without exposing database errors or inventing progress', async () => {
  await env.db.execute(sql`DELETE FROM __void_platform_installation`);
  const response = await request('/admin/status.json');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Platform status is temporarily unavailable' });
  const html = await (await request('/admin/status')).text();
  expect(html).toContain('Live status is unavailable');
  expect(html).toContain('Unknown');
  expect(html).not.toContain('waiting-for-sandbox-drain');
});

it('omits empty operation details when no installation checkpoint is configured', async () => {
  const response = await app.fetch(
    new Request('http://localhost/admin/status', {
      headers: { Cookie: `admin_token=${admin.adminJwt}` },
    }),
    { ...env, PLATFORM_INSTALLATION_ID: undefined, PLATFORM_TRAFFIC_STATE: '' },
  );
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('Traffic enabled');
  expect(html).toContain(
    'Maintenance mode is off. The platform is allowing requests to your apps.',
  );
  expect(html).not.toContain('Confirmed ');
  expect(html).not.toContain('Some apps may be temporarily unavailable');
  expect(html).not.toContain('No saved operation');
  expect(html).not.toContain('platform-operation-heading');
  expect(html).not.toContain('Detailed progress is available');
});

it('shows installation failure even when the last recorded operation completed', async () => {
  manifest = {
    ...manifest,
    status: 'failed',
    operation: { ...manifest.operation!, phase: 'complete' },
  };
  await save();
  const html = await (await request('/admin/status')).text();
  expect(html).toContain('Operation needs attention');
  expect(html).toContain('Next step');
  expect(html).not.toContain('The lifecycle operation completed.');
});

it('allows administrator sign-in callbacks without allowing other login attempts', async () => {
  await importLegacyAuthentication(env.db, env);
  const login = await request('/admin/login/github', '');
  expect(login.status).toBe(302);
  const state = new URL(login.headers.get('Location')!).searchParams.get('state')!;
  // Missing browser proof is still rejected by normal authentication after the gate.
  expect(
    (await request(`/auth/callback?state=${encodeURIComponent(state)}&code=fixture`, '')).status,
  ).toBe(400);
  const memberLogin = await request(
    `/auth/login?redirect=${encodeURIComponent('http://localhost:1234/callback?state=fixture')}&provider=github&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`,
    '',
    {},
    '',
  );
  expect(memberLogin.status).toBe(302);
  const memberState = new URL(memberLogin.headers.get('Location')!).searchParams.get('state')!;
  expect(
    (await request(`/auth/callback?state=${encodeURIComponent(memberState)}&code=fixture`, ''))
      .status,
  ).toBe(503);
});

it.each([390, 1280])(
  'retains the last confirmed snapshot and refreshes without a write at %ipx',
  async (width) => {
    const browser = await chromium.launch();
    let unavailable = true;
    let trafficState = 'staging';
    const methods: Array<string> = [];
    const errors: Array<string> = [];
    try {
      const context = await browser.newContext({ viewport: { width, height: 844 } });
      await context.addCookies([
        { name: 'admin_token', value: admin.adminJwt, url: 'http://localhost' },
      ]);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const incoming = route.request();
        const url = new URL(incoming.url());
        if (url.origin !== 'http://localhost') {
          await route.abort();
          return;
        }
        methods.push(incoming.method());
        if (url.pathname === '/admin/client.js' || url.pathname === '/admin/style.css') {
          const asset = url.pathname.endsWith('.js')
            ? PLATFORM_ADMIN_CLIENT_ASSET_PATH
            : PLATFORM_ADMIN_STYLE_ASSET_PATH;
          await route.fulfill({
            status: 200,
            contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css',
            body: await readFile(join(getPlatformRuntimeDirectory(), asset)),
          });
          return;
        }
        if (url.pathname === '/admin/status.json' && unavailable) {
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"error":"unavailable"}',
          });
          return;
        }
        const response = await request(
          url.pathname + url.search,
          admin.adminJwt,
          {
            headers: await incoming.allHeaders(),
          },
          trafficState,
        );
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      await page.goto('http://localhost/admin/status');
      await page.getByText('Showing the last confirmed snapshot', { exact: false }).waitFor();
      const summary = page.getByRole('list', { name: 'Installation and traffic' });
      const card = page.locator('.void-admin-status-card');
      expect(await card.count()).toBe(1);
      expect(await card.getAttribute('data-state')).toBe('unavailable');
      expect(await summary.getByText('Waiting for Sandbox drain', { exact: true }).count()).toBe(1);
      expect(
        await summary.getByText('Traffic paused (last confirmed)', { exact: true }).count(),
      ).toBe(1);
      manifest = {
        ...manifest,
        status: 'installed',
        operation: { ...manifest.operation!, phase: 'complete' },
      };
      await save();
      unavailable = false;
      await page.getByRole('button', { name: 'Refresh status' }).click();
      await summary.getByText('Operation complete', { exact: true }).waitFor();
      expect(await summary.getByText('Traffic paused', { exact: true }).count()).toBe(1);
      expect(await card.getAttribute('data-state')).toBe('waiting');
      trafficState = '';
      await page.getByRole('button', { name: 'Refresh status' }).click();
      await summary.getByText('Traffic enabled', { exact: true }).waitFor();
      expect(await card.getAttribute('data-state')).toBe('healthy');
      manifest = {
        ...manifest,
        status: 'failed',
        operation: { ...manifest.operation!, phase: 'failed' },
      };
      await save();
      await page.getByRole('button', { name: 'Refresh status' }).click();
      await summary.getByText('Operation needs attention', { exact: true }).waitFor();
      expect(await card.getAttribute('data-state')).toBe('error');
      await page.getByRole('heading', { name: 'Next step', exact: true }).waitFor();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(methods.every((method) => method === 'GET')).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  },
  // Launching Chromium alone can take longer than the default under a full parallel run.
  30_000,
);
