import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  importLegacyAuthentication,
  readLoginConnection,
  readLoginRevision,
  readLoginSecret,
  stageLoginConfiguration,
} from '../../src/auth/configuration.ts';
import { createHumanSession } from '../../src/auth/sessions.ts';
import { app } from '../../src/index.ts';
import {
  operatorEvents,
  platformAuthSettings,
  platformLoginConnections,
} from '../../src/schema.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { nativeFormSubmission } from './native-form-browser.ts';

let env: TestEnv;
let cookie: string;
const origin = 'https://api.example.com';
const home = '/admin/config/auth';
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  const admin = await createTestUser(env.db, 'administrator', 'github', '123', 'custom', 'admin');
  await importLegacyAuthentication(env.db, env);
  const session = await createHumanSession(env.db, env.JWT_SECRET, {
    userId: admin.id,
    connectionId: 'github',
    revision: 1,
    generation: 1,
    audience: 'admin',
  });
  cookie = `admin_token=${session.token}`;
});
function request(path: string, form?: Record<string, string>, requestOrigin = origin) {
  return app.fetch(
    new Request(`${origin}${path}`, {
      method: form ? 'POST' : 'GET',
      headers: {
        Cookie: cookie,
        ...(form
          ? { Origin: requestOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      ...(form ? { body: new URLSearchParams(form) } : {}),
    }),
    env,
  );
}
describe('browser authentication configuration', () => {
  it('offers sign-in recovery without bypassing the uncached authentication database requirement', async () => {
    await clearTables(env.db);
    const admin = await createTestUser(env.db, 'setup-admin', 'github', '456', 'custom', 'admin');
    const response = await app.fetch(
      new Request(`${origin}${home}/initialize`, {
        method: 'POST',
        headers: { Cookie: `admin_token=${admin.adminJwt}`, Origin: origin },
      }),
      { ...env, PLATFORM_AUTH_DATABASE_UNCACHED: 'false' },
    );
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain('Platform authentication requires an uncached database connection.');
    expect(html).toMatch(
      /<a\b(?=[^>]*class="[^"]*astryx-button)(?=[^>]*href="\/admin\/logout")[^>]*>[\s\S]*?Sign in again[\s\S]*?<\/a>/,
    );
    expect(html).not.toContain('Return to settings');
  });

  it.each([home, `${home}/new?kind=oidc`, `${home}/connections/google`])(
    'keeps form-compatible origin-only referrers on %s and page navigation',
    async (path) => {
      for (const pageNavigation of [false, true]) {
        const response = await app.fetch(
          new Request(`${origin}${path}`, {
            headers: { Cookie: cookie, ...(pageNavigation ? { 'X-VoidPages': 'true' } : {}) },
          }),
          env,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('Referrer-Policy')).toBe('strict-origin');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      }
    },
  );

  it('accepts a native provider-settings form without leaking the page query', async () => {
    const input = {
      env,
      origin,
      cookie,
      path: `${home}/connections/google?test=private-test-query`,
      fields: { label: 'Native Google login', clientId: env.GOOGLE_CLIENT_ID },
      button: 'Save configuration',
    };
    const suppressed = await nativeFormSubmission({ ...input, noReferrer: true });
    expect(suppressed).toEqual({
      pagePolicy: 'strict-origin',
      submission: { origin: 'null', referrer: undefined, status: 403 },
    });
    expect((await readLoginConnection(env.db, 'google'))?.revision).toBe(1);
    expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
    expect(await nativeFormSubmission(input)).toEqual({
      pagePolicy: 'strict-origin',
      submission: { origin, referrer: `${origin}/`, status: 302 },
    });
    expect((await readLoginConnection(env.db, 'google'))?.revision).toBe(2);
  });

  it('links from authentication settings to the unified Access page without secrets', async () => {
    const response = await request(home);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Platform protection');
    expect(html).toContain('Enable Cloudflare Access');
    expect(html).toContain('Disable Cloudflare Access');
    expect(html).not.toContain('Change platform protection');
    expect(html).toContain('Login methods');
    expect(html).toContain('Manage access');
    expect(html).toContain('href="/admin/signup-control"');
    expect(html).not.toContain('name="mode" value="public"');
    const accessPage = await (await request('/admin/signup-control')).text();
    expect(accessPage).toContain('Signup policy');
    expect(accessPage).toContain('name="mode" value="public"');
    expect(html).not.toContain(env.GITHUB_CLIENT_SECRET);
    expect(html).not.toContain(env.GOOGLE_CLIENT_SECRET);
    const editor = await (await request(`${home}/connections/google`)).text();
    expect(editor.toLowerCase()).toContain('autocomplete="new-password"');
    expect(editor).not.toContain(env.GOOGLE_CLIENT_SECRET);
  });

  it('stages an escaped label and domain restriction while retaining the saved secret', async () => {
    const response = await request(`${home}/connections/google/configure`, {
      revision: '1',
      kind: 'google',
      label: '<script>alert(1)</script>',
      clientId: env.GOOGLE_CLIENT_ID,
      domains: 'example.com',
      clientSecret: '',
    });
    expect(response.status).toBe(302);
    expect(await readLoginConnection(env.db, 'google')).toMatchObject({
      active_revision: 1,
      revision: 2,
    });
    const pending = (await readLoginRevision(env.db, 'google', 2))!;
    expect(await readLoginSecret(env, pending)).toBe(env.GOOGLE_CLIENT_SECRET);
    const html = await (await request(home)).text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    const audit = JSON.stringify(await env.db.select().from(operatorEvents));
    expect(audit).toContain('google');
    expect(audit).not.toContain(env.GOOGLE_CLIENT_SECRET);
  });

  it('rejects cross-origin configuration changes before writing an audit intent or settings', async () => {
    const response = await request(
      `${home}/connections/google/configure`,
      { revision: '1', kind: 'google', label: 'Changed', clientId: env.GOOGLE_CLIENT_ID },
      'https://attacker.example.com',
    );
    expect(response.status).toBe(403);
    expect((await readLoginConnection(env.db, 'google'))?.revision).toBe(1);
    expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
  });

  it('rejects an unscoped social login as company admission and accepts an explicitly trusted OIDC connection', async () => {
    const initial = (await env.db.select().from(platformAuthSettings))[0]!;
    expect(
      (
        await request('/admin/signup-control/policy', {
          revision: String(initial.revision),
          mode: 'company',
          connections: 'google',
        })
      ).status,
    ).toBe(400);
    await stageLoginConfiguration(
      env.db,
      env,
      {
        id: 'company',
        kind: 'oidc',
        label: 'Company',
        clientId: 'client',
        issuer: 'https://identity.example.com',
      },
      'secret',
      null,
    );
    await env.db
      .update(platformLoginConnections)
      .set({ enabled: true, active_revision: 1 })
      .where(eq(platformLoginConnections.id, 'company'));
    const latest = (await env.db.select().from(platformAuthSettings))[0]!;
    expect(
      (
        await request('/admin/signup-control/policy', {
          revision: String(latest.revision),
          mode: 'company',
          connections: 'company',
        })
      ).status,
    ).toBe(302);
    expect((await env.db.select().from(platformAuthSettings))[0]?.admission).toEqual({
      mode: 'company',
      connections: ['company'],
      access: false,
    });
  });

  it('uses the same last-admin safeguards as the CLI and records the actual rejected status', async () => {
    const response = await request(`${home}/connections/github/disable`, { revision: '1' });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('linked alternative');
    expect((await readLoginConnection(env.db, 'github'))?.enabled).toBe(true);
    expect(await env.db.select().from(operatorEvents)).toMatchObject([
      { status: 'failed', http_status: 409 },
    ]);
  });
});
