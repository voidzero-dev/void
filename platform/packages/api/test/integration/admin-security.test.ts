import type { SecurityPolicy } from '@void/platform/security-policy';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { app } from '../../src/index.ts';
import {
  operatorEvents,
  projectZeroTrust,
  securityFindings,
  securityPublicRequests,
} from '../../src/schema.ts';
import { clearTables, createTestUser, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import {
  liveProject,
  saveSecurityPolicy,
  securityBindings,
  storedSecurityPolicy,
} from './security-fixtures.ts';
import { askPublic, setupGate } from './security-gate-fixtures.ts';

let env: TestEnv;
let onEnv: TestEnv;
let cookie: string;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  onEnv = {
    ...securityBindings(env),
    SITE_DOMAIN: 'apps.example.com',
    PLATFORM_INSTALLATION_ID: 'installation-test',
  };
  const admin = await createTestUser(env.db, 'sec-admin', 'github', undefined, 'free', 'admin');
  cookie = admin.adminJwt;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function text(html: string): string {
  return html.replaceAll('<!-- -->', '');
}

async function get(path: string, bindings: TestEnv = onEnv): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      headers: { Cookie: `admin_token=${cookie}` },
      redirect: 'manual',
    }),
    bindings,
  );
}

async function post(
  path: string,
  fields: Record<string, string> = {},
  bindings: TestEnv = onEnv,
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        Cookie: `admin_token=${cookie}`,
        Origin: 'http://localhost',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    }),
    bindings,
  );
}

async function readPolicy(): Promise<SecurityPolicy> {
  return (await storedSecurityPolicy(env)) as unknown as SecurityPolicy;
}

describe('admin security pages', () => {
  it('capability off: shows the install command, hides the nav item, refuses every write (I13)', async () => {
    const { project } = await liveProject(env);
    expect(text(await (await get('/admin/security', env)).text())).toContain(
      'void platform upgrade --security-audits',
    );
    expect(text(await (await get('/admin/users', env)).text())).not.toContain('/admin/security');
    for (const path of [
      '/admin/security/policy',
      '/admin/security/budget',
      '/admin/security/probe',
      `/admin/projects/${project.id}/security/model`,
      `/admin/projects/${project.id}/security/rescan`,
    ]) {
      expect([path, (await post(path, {}, env)).status]).toEqual([path, 501]);
    }
    expect(await env.db.select().from(operatorEvents)).toEqual([]);
  });

  it('applies a budget change after its preview, by revision', async () => {
    await saveSecurityPolicy(env, { revision: 4 });
    const fields = {
      expectedRevision: '4',
      platformCapOn: 'yes',
      platformMonthlyUsd: '250',
      projectDefaultMonthlyUsd: '40',
    };
    const preview = await post('/admin/security/budget', { ...fields, step: 'preview' });
    expect(preview.status).toBe(200);
    expect((await readPolicy()).budgets.platformCapOn).toBe(false);

    expect((await post('/admin/security/budget', { ...fields, step: 'apply' })).status).toBe(302);
    expect((await readPolicy()).budgets).toMatchObject({
      platformCapOn: true,
      platformMonthlyUsd: 250,
    });
    expect((await env.db.select().from(operatorEvents)).map((event) => event.action)).toEqual([
      'security/budget',
    ]);
    // The old revision is refused, so a stale form cannot overwrite a newer change.
    expect((await post('/admin/security/budget', { ...fields, step: 'apply' })).status).toBe(409);
  });

  it('offers no bypass while findings hold a public request, and refuses one (I6)', async () => {
    const s = await setupGate(env);
    await askPublic(s);
    const { project } = s;
    expect(text(await (await get(`/admin/projects/${project.id}`)).text())).toContain(
      'Bypass scan',
    );
    await env.db.insert(securityFindings).values({
      id: 'sf_hold',
      project_id: project.id,
      number: 12,
      fingerprint_key: 'fp-hold',
      verdict: 'confirmed',
      severity: 'critical',
      title: 'Hold',
      category: 'sqli',
      file: 'src/a.ts',
      line_start: 1,
      first_scan_id: 'ss_x',
      last_seen_scan_id: 'ss_x',
    });
    await env.db
      .update(securityPublicRequests)
      .set({ state: 'held_findings', blockers: 1, blocker_ids: ['F-12'] })
      .where(eq(securityPublicRequests.project_id, project.id));
    expect(text(await (await get(`/admin/projects/${project.id}`)).text())).not.toContain(
      'Bypass scan',
    );
    const refused = await post(`/admin/projects/${project.id}/security/bypass`, { reason: 'x' });
    expect(refused.status).toBe(409);
    const [zt] = await env.db
      .select()
      .from(projectZeroTrust)
      .where(eq(projectZeroTrust.project_id, project.id));
    expect(zt?.desired_protected).toBe(true);
  });
});
