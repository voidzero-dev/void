import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
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
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { getPlatformSetting, setPlatformSetting } from '../../src/platform-settings.ts';
import {
  operatorEvents,
  projectZeroTrust,
  securityFindings,
  securityPlatformSpend,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
} from '../../src/schema.ts';
import { securityScanReserveNano } from '../../src/security/budget.ts';
import { cancelSecurityScanRows } from '../../src/security/queue.ts';
import { projectSecuritySettings, securityProjectEvents } from '../../src/security/schema.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import { setProjectZeroTrustProtection } from '../../src/zero-trust/project.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
let onEnv: TestEnv;
let cookie: string;
let adminId: string;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  onEnv = {
    ...env,
    SITE_DOMAIN: 'apps.example.com',
    PLATFORM_INSTALLATION_ID: 'installation-test',
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
    SECURITY_SCAN_SCHEDULER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => Response.json({ ok: true }),
        cancelScans: async (scanIds: Array<string>, reason: string) =>
          (await cancelSecurityScanRows(env.db, { scanIds }, reason)).length,
      }),
    },
  } as unknown as TestEnv;
  const admin = await createTestUser(env.db, 'sec-admin', 'github', undefined, 'free', 'admin');
  adminId = admin.id;
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

async function savePolicy(overrides: Partial<SecurityPolicy> = {}) {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
    ...defaultSecurityPolicy(),
    mode: 'all',
    revision: 1,
    ...overrides,
  });
}

async function readPolicy(): Promise<SecurityPolicy> {
  return (await getPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY)) as SecurityPolicy;
}

async function projectWithDeployment(slug = 'acme-web') {
  const owner = await createTestUser(env.db, `owner-${slug}`);
  const project = await createTestProject(env.db, owner.id, slug);
  const deployment = await createTestDeployment(env.db, project.id, 'live');
  return { owner, project, deployment };
}

// A trimmed copy of the Zero Trust fake the public gate suite uses.
function accessApi() {
  const applications = new Map<string, Record<string, unknown>>();
  let next = 1;
  return vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = new URL(request.toString());
    const path = url.pathname.split('/access/')[1] ?? '';
    if (path === 'organizations') {
      return Response.json({
        success: true,
        result: { auth_domain: 'company.cloudflareaccess.com' },
      });
    }
    if (path === 'identity_providers/idp-1') {
      return Response.json({ success: true, result: { id: 'idp-1', name: 'Company SSO' } });
    }
    if (path === 'policies/policy-1') {
      return Response.json({
        success: true,
        result: {
          id: 'policy-1',
          decision: 'allow',
          include: [{ email_domain: { domain: 'example.com' } }],
        },
      });
    }
    if (path === 'apps' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const id = `app-${next++}`;
      const application = { ...body, id, aud: `aud-${id}` };
      applications.set(id, application);
      return Response.json({ success: true, result: application });
    }
    if (path === 'apps') {
      return Response.json({ success: true, result: [...applications.values()] });
    }
    const match = path.match(/^apps\/([^/]+)$/);
    if (match && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const application = { ...body, id: match[1], aud: `aud-${match[1]}` };
      applications.set(match[1]!, application);
      return Response.json({ success: true, result: application });
    }
    if (match && init?.method === 'DELETE') {
      applications.delete(match[1]!);
      return Response.json({ success: true, result: { id: match[1] } });
    }
    if (match) {
      const application = applications.get(match[1]!);
      return application
        ? Response.json({ success: true, result: application })
        : Response.json({ success: false, errors: [{ message: 'not found' }] }, { status: 404 });
    }
    throw new Error(`unexpected Cloudflare request: ${url}`);
  });
}

async function gateSetup() {
  vi.stubGlobal('fetch', accessApi());
  await configurePlatformZeroTrust(onEnv as unknown as ApiEnv['Bindings'], env.db, {
    apiToken: 'access-management-token',
    identityProviderIds: ['idp-1'],
    policyIds: ['policy-1'],
    protectNewProjects: true,
    existingProjects: 'public',
  });
  await savePolicy({ publicGate: true });
  const { owner, project, deployment } = await projectWithDeployment();
  await env.ROUTING.put(
    project.slug,
    JSON.stringify({
      projectId: project.id,
      userId: owner.id,
      workerName: `user-${project.slug}-${deployment.id}`,
      version: deployment.id,
    }),
  );
  const platform = onEnv as unknown as ApiEnv['Bindings'];
  await setProjectZeroTrustProtection(platform, env.db, project.id, true);
  await setProjectZeroTrustProtection(platform, env.db, project.id, false, {
    actorUserId: owner.id,
  });
  return { owner, project, deployment };
}

describe('admin security: capability off', () => {
  it('shows the install command, hides the nav item and refuses every write', async () => {
    const page = await get('/admin/security', env);
    expect(page.status).toBe(200);
    const html = text(await page.text());
    expect(html).toContain('void platform upgrade --security-audits');

    const users = text(await (await get('/admin/users', env)).text());
    expect(users).not.toContain('/admin/security');

    for (const path of ['/admin/security/policy', '/admin/security/probe']) {
      expect((await post(path, {}, env)).status).toBe(501);
    }
    expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
  });
});

describe('admin security: banners and badge', () => {
  it('shows the failing probe and the platform cap on any admin page', async () => {
    await savePolicy({
      entitlement: {
        checkedAt: new Date().toISOString(),
        ok: false,
        missing: ['egress'],
        hosts: { openai: false, anthropic: false },
        failingSince: '2026-11-11T03:00:00.000Z',
      },
      budgets: {
        ...defaultSecurityPolicy().budgets,
        platformCapOn: true,
        platformMonthlyUsd: 100,
      },
    });
    await env.db.insert(securityPlatformSpend).values({
      month: `${new Date().toISOString().slice(0, 7)}-01`,
      spent_nano_usd: 100_000_000_000,
    });
    const html = text(await (await get('/admin/users')).text());
    expect(html).toContain('Security probe failing since Nov 11, 03:00 UTC:');
    expect(html).toContain('Security scans stopped: platform monthly budget used up ($100.00)');
    expect(html).toContain('/admin/security');
  });
});

describe('admin security: settings', () => {
  it('previews first, applies by revision and keeps no free text in the audit row', async () => {
    await savePolicy({
      mode: 'disabled',
      revision: 3,
      entitlement: {
        checkedAt: new Date().toISOString(),
        ok: true,
        missing: [],
        hosts: { openai: false, anthropic: false },
      },
    });
    const page = text(await (await get('/admin/security')).text());
    expect(page).toContain('Public projects only');
    expect(page).toContain('Preview change');

    const fields = {
      expectedRevision: '3',
      mode: 'public',
      defaultModel: (await readPolicy()).defaultModel,
      concurrency: '2',
      timeoutMinutes: '20',
      [`allow:${(await readPolicy()).defaultModel}`]: 'yes',
    };
    const preview = await post('/admin/security/policy', { ...fields, step: 'preview' });
    expect(preview.status).toBe(200);
    expect(text(await preview.text())).toContain('Apply change');
    expect((await readPolicy()).mode).toBe('disabled');
    expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
  });

  it('applies a budget change after its preview', async () => {
    await savePolicy({ revision: 4 });
    const fields = {
      expectedRevision: '4',
      platformCapOn: 'yes',
      platformMonthlyUsd: '250',
      projectDefaultMonthlyUsd: '40',
    };
    const preview = await post('/admin/security/budget', { ...fields, step: 'preview' });
    expect(preview.status).toBe(200);
    expect(text(await preview.text())).toContain('Platform cap: on, $250 / month');
    expect((await readPolicy()).budgets.platformCapOn).toBe(false);

    const applied = await post('/admin/security/budget', { ...fields, step: 'apply' });
    expect(applied.status).toBe(302);
    expect((await readPolicy()).budgets).toMatchObject({
      platformCapOn: true,
      platformMonthlyUsd: 250,
      projectCapsOn: false,
    });
    const audit = await env.db.select().from(operatorEvents);
    expect(audit.map((event) => [event.action, event.status])).toEqual([
      ['security/budget', 'success'],
    ]);

    // The old revision is refused, so a stale form cannot overwrite a newer change.
    const stale = await post('/admin/security/budget', { ...fields, step: 'apply' });
    expect(stale.status).toBe(409);
  });
});

describe('admin security: findings, scans and requests', () => {
  it('lists urgent findings oldest first and the scans of the month', async () => {
    await savePolicy();
    const { project, deployment } = await projectWithDeployment();
    await env.db.insert(securityFindings).values([
      {
        id: 'sf_1',
        project_id: project.id,
        number: 1,
        fingerprint_key: 'fp-1',
        verdict: 'confirmed',
        severity: 'critical',
        title: 'SQL built from request query',
        category: 'sqli',
        file: 'src/routes/search.ts',
        line_start: 3,
        first_scan_id: 'ss_x',
        last_seen_scan_id: 'ss_x',
      },
      {
        id: 'sf_2',
        project_id: project.id,
        number: 2,
        fingerprint_key: 'fp-2',
        verdict: 'confirmed',
        severity: 'low',
        title: 'Verbose error',
        category: 'info',
        file: 'src/b.ts',
        line_start: 9,
        first_scan_id: 'ss_x',
        last_seen_scan_id: 'ss_x',
      },
    ]);
    await env.db.insert(securityScans).values({
      id: 'ss_a',
      project_id: project.id,
      deployment_id: deployment.id,
      status: 'succeeded',
      trigger: 'deploy',
      finished_at: new Date().toISOString(),
    });
    const urgent = text(await (await get('/admin/security/findings?urgent=1')).text());
    expect(urgent).toContain('SQL built from request query');
    expect(urgent).not.toContain('Verbose error');
    expect(urgent).toContain('1 urgent');
    expect(text(await (await get('/admin/security/findings')).text())).toContain('Verbose error');

    const scans = text(await (await get('/admin/security/scans')).text());
    expect(scans).toContain('1 scans');
    expect(scans).toContain('succeeded');
    expect((await get('/admin/security/scans?status=nope')).status).toBe(400);
  });

  it('badges unseen bypasses, lists them with the reason, and marks them seen', async () => {
    const { project } = await gateSetup();
    const bypass = await post(`/admin/projects/${project.id}/security/bypass`, {
      reason: 'launch day, scanner down',
    });
    expect(bypass.status).toBe(302);
    expect(bypass.headers.get('Location')).toBe(`/admin/projects/${project.id}#zero-trust`);
    const [row] = await env.db.select().from(securityScanBypasses);
    expect(row).toMatchObject({
      actor_kind: 'installation_admin',
      actor_user_id: adminId,
      reason: 'launch day, scanner down',
    });
    const [request] = await env.db.select().from(securityPublicRequests);
    expect(request?.state).toBe('bypassed');

    // One audit row; the reason is on the bypass record only.
    const audit = await env.db.select().from(operatorEvents);
    expect(audit.map((event) => [event.action, event.status])).toEqual([
      [`projects/${project.id}/security/public-request/bypass`, 'success'],
    ]);
    expect(JSON.stringify(audit)).not.toContain('scanner down');

    const users = text(await (await get('/admin/users')).text());
    expect(users).toContain('/admin/security');

    const requests = text(await (await get('/admin/security/requests?state=all')).text());
    expect(requests).toContain('launch day, scanner down');
    expect(requests).toContain('1 new');

    expect((await post('/admin/security/bypasses/seen', { through: row!.created_at })).status).toBe(
      302,
    );
    const after = text(await (await get('/admin/security/requests?state=all')).text());
    expect(after).not.toContain('1 new');
    expect(after).toContain('launch day, scanner down');
    expect((await env.db.select().from(operatorEvents)).map((event) => event.action)).toContain(
      'security/bypasses-seen',
    );
  });
});

describe('admin security: project detail', () => {
  it('shows the Security section, sets the model and the limit', async () => {
    await savePolicy();
    const { project } = await projectWithDeployment();
    const page = text(await (await get(`/admin/projects/${project.id}`)).text());
    expect(page).toContain('Security');
    expect(page).toContain('no urgent findings');
    expect(page).toContain('Set model');

    const limit = await post(`/admin/projects/${project.id}/security/budget`, { monthlyUsd: '25' });
    expect(limit.status).toBe(302);
    const [settings] = await env.db
      .select()
      .from(projectSecuritySettings)
      .where(eq(projectSecuritySettings.project_id, project.id));
    expect(settings?.cap_ceiling_cents).toBe(2500);

    const model = await post(`/admin/projects/${project.id}/security/model`, {
      model: '@cf/zai-org/glm-5.3',
    });
    expect(model.status).toBe(302);
    const [after] = await env.db
      .select()
      .from(projectSecuritySettings)
      .where(eq(projectSecuritySettings.project_id, project.id));
    expect(after?.model).toBe('@cf/zai-org/glm-5.3');
    expect(
      (await env.db.select().from(operatorEvents)).map((event) => event.action).sort(),
    ).toEqual([`projects/${project.id}/security/budget`, `projects/${project.id}/security/model`]);
  });

  it('sets the project scan rule (M34) and shows why scans do not apply', async () => {
    await savePolicy();
    const { project } = await projectWithDeployment();
    const page = text(await (await get(`/admin/projects/${project.id}`)).text());
    expect(page).toContain('Scan rule for this project');
    const set = await post(`/admin/projects/${project.id}/security/policy`, { override: 'never' });
    expect(set.status).toBe(302);
    const [settings] = await env.db
      .select()
      .from(projectSecuritySettings)
      .where(eq(projectSecuritySettings.project_id, project.id));
    expect(settings?.policy_override).toBe('never');
    const after = text(await (await get(`/admin/projects/${project.id}`)).text());
    expect(after).toContain('a platform admin turned scans off for this project');
    expect(
      (await env.db.select().from(operatorEvents)).map((event) => [
        event.action,
        JSON.parse(event.target),
      ]),
    ).toEqual([
      [`projects/${project.id}/security/policy`, { projectId: project.id, override: 'never' }],
    ]);
    const bad = await post(`/admin/projects/${project.id}/security/policy`, { override: 'x' });
    expect(bad.status).toBe(400);
  });

  it('has no Security section while the capability is off', async () => {
    const { project } = await projectWithDeployment();
    const page = text(await (await get(`/admin/projects/${project.id}`, env)).text());
    expect(page).not.toContain('Set model');
    expect((await post(`/admin/projects/${project.id}/security/model`, {}, env)).status).toBe(501);
  });

  it('shows a held request with Cancel and Bypass, and no Bypass while findings hold it', async () => {
    const { project } = await gateSetup();
    const open = text(await (await get(`/admin/projects/${project.id}`)).text());
    expect(open).toContain('Cancel request');
    expect(open).toContain('Bypass scan');
    expect(open).not.toContain('Make project public');

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
    const held = text(await (await get(`/admin/projects/${project.id}`)).text());
    expect(held).toContain('Resolve the urgent findings first (F-12)');
    expect(held).not.toContain('Bypass scan');
    const refused = await post(`/admin/projects/${project.id}/security/bypass`, { reason: 'x' });
    expect(refused.status).toBe(409);
    const [zt] = await env.db
      .select()
      .from(projectZeroTrust)
      .where(eq(projectZeroTrust.project_id, project.id));
    expect(zt?.desired_protected).toBe(true);
  });

  it('greys out Disable on the Zero Trust page while the gate is on', async () => {
    await gateSetup();
    const on = text(await (await get('/admin/zero-trust')).text());
    expect(on).toContain('first (Security → Settings)');
    expect(on).toMatch(/aria-disabled="true"[^>]*>(<[^>]+>)*Disable Zero Trust/);

    await savePolicy({ publicGate: false });
    const off = text(await (await get('/admin/zero-trust')).text());
    expect(off).not.toContain('first (Security → Settings)');
  });
});

async function audit(): Promise<Array<[string, string]>> {
  return (await env.db.select().from(operatorEvents)).map((event) => [event.action, event.status]);
}

function withScheduler(overrides: Record<string, unknown>): TestEnv {
  const scheduler = onEnv.SECURITY_SCAN_SCHEDULER as unknown as {
    idFromName: (name: string) => unknown;
    get: () => Record<string, unknown>;
  };
  return {
    ...onEnv,
    SECURITY_SCAN_SCHEDULER: {
      idFromName: scheduler.idFromName,
      get: () => ({ ...scheduler.get(), ...overrides }),
    },
  } as unknown as TestEnv;
}

async function addScan(projectId: string, deploymentId: string, status: 'queued' | 'succeeded') {
  const id = `ss_${status}`;
  await env.db.insert(securityScans).values({
    id,
    project_id: projectId,
    deployment_id: deploymentId,
    status,
    trigger: 'deploy',
    finished_at: status === 'queued' ? null : new Date().toISOString(),
  });
  return id;
}

describe('admin security: every write refuses while the capability is off', () => {
  it('answers 501 to each security POST and writes no audit row', async () => {
    const { project } = await projectWithDeployment();
    const paths = [
      '/admin/security/policy',
      '/admin/security/budget',
      '/admin/security/probe',
      '/admin/security/scans/ss_any/cancel',
      '/admin/security/bypasses/seen',
      `/admin/projects/${project.id}/security/model`,
      `/admin/projects/${project.id}/security/budget`,
      `/admin/projects/${project.id}/security/policy`,
      `/admin/projects/${project.id}/security/rescan`,
    ];
    for (const path of paths) {
      expect([path, (await post(path, {}, env)).status]).toEqual([path, 501]);
    }
    expect(await audit()).toEqual([]);
  });

  it('answers the real state, not 501, to a bypass with the capability off: the request no longer holds', async () => {
    const { owner, project } = await gateSetup();
    const off = {
      ...onEnv,
      PLATFORM_CAPABILITIES: JSON.stringify({
        ...getPlatformCapabilities(env),
        securityAudits: false,
      }),
    } as unknown as TestEnv;
    // The route guard does not depend on the capability; the operator route does the same.
    const response = await post(
      `/admin/projects/${project.id}/security/bypass`,
      { reason: 'capability removed while held' },
      off,
    );
    expect(response.status).toBe(409);
    expect(text(await response.text())).toContain('The public request is already canceled.');
    // With the gate read as off, asking to go public again is not held.
    const result = await setProjectZeroTrustProtection(
      off as unknown as ApiEnv['Bindings'],
      env.db,
      project.id,
      false,
      { actorUserId: owner.id },
    );
    expect(result.held).toBe(false);
  });
});

describe('admin security: policy apply', () => {
  async function applyFields(overrides: Record<string, string> = {}) {
    const policy = await readPolicy();
    return {
      step: 'apply',
      expectedRevision: String(policy.revision),
      mode: policy.mode,
      defaultModel: policy.defaultModel,
      concurrency: '2',
      timeoutMinutes: '20',
      [`allow:${policy.defaultModel}`]: 'yes',
      ...overrides,
    };
  }

  it('applies a change and audits it without the form text', async () => {
    await savePolicy({ mode: 'all', revision: 5 });
    const response = await post('/admin/security/policy', await applyFields({ mode: 'public' }));
    expect(response.status).toBe(302);
    expect(await readPolicy()).toMatchObject({ mode: 'public', revision: 6 });
    expect(await audit()).toEqual([['security/policy', 'success']]);
  });

  it('runs the probe before leaving disabled and keeps the policy when it fails', async () => {
    await savePolicy({ mode: 'disabled', revision: 2 });
    const response = await post('/admin/security/policy', await applyFields({ mode: 'public' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await readPolicy()).toMatchObject({ mode: 'disabled' });
    expect((await readPolicy()).entitlement?.ok).toBe(false);
    expect((await audit()).map(([action]) => action)).toEqual(['security/policy']);
    expect((await audit())[0]?.[1]).not.toBe('success');
  });

  it('pokes the scheduler after canceling requests, and not otherwise', async () => {
    await gateSetup();
    await savePolicy({
      publicGate: true,
      entitlement: {
        checkedAt: new Date().toISOString(),
        ok: true,
        missing: [],
        hosts: { openai: false, anthropic: false },
      },
    });
    const poke = vi.fn(async () => Response.json({ ok: true }));
    const bindings = withScheduler({ fetch: poke });

    const none = await post(
      '/admin/security/policy',
      await applyFields({ publicGate: 'yes' }),
      bindings,
    );
    expect(none.status).toBe(302);
    expect(poke).not.toHaveBeenCalled();

    const off = await post('/admin/security/policy', await applyFields(), bindings);
    expect(off.status).toBe(302);
    const [request] = await env.db.select().from(securityPublicRequests);
    expect(request?.state).toBe('canceled');
    expect(poke).toHaveBeenCalledTimes(1);
    expect((await audit()).filter(([action]) => action === 'security/policy')).toHaveLength(2);
  });
});

describe('admin security: probe and scan cancel', () => {
  it('runs the probe and audits it', async () => {
    await savePolicy();
    const response = await post('/admin/security/probe');
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/security');
    expect(await audit()).toEqual([['security/probe', 'success']]);
    expect((await readPolicy()).entitlement).toBeDefined();
  });

  it('cancels a waiting scan', async () => {
    await savePolicy();
    const { project, deployment } = await projectWithDeployment();
    const id = await addScan(project.id, deployment.id, 'queued');
    const response = await post(`/admin/security/scans/${id}/cancel`);
    expect(response.status).toBe(302);
    const [row] = await env.db.select().from(securityScans).where(eq(securityScans.id, id));
    expect(row).toMatchObject({ status: 'canceled', status_reason: 'operator_canceled' });
    expect(await audit()).toEqual([[`security/scans/${id}/cancel`, 'success']]);
  });

  it('answers 404 for an unknown scan and 409 for a finished one', async () => {
    await savePolicy();
    const { project, deployment } = await projectWithDeployment();
    const done = await addScan(project.id, deployment.id, 'succeeded');
    expect((await post('/admin/security/scans/ss_missing/cancel')).status).toBe(404);
    expect((await post(`/admin/security/scans/${done}/cancel`)).status).toBe(409);
    expect(await audit()).toEqual([
      ['security/scans/ss_missing/cancel', 'failed'],
      [`security/scans/${done}/cancel`, 'failed'],
    ]);
  });

  it('answers 502 and leaves the scan alone when the scheduler fails', async () => {
    await savePolicy();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { project, deployment } = await projectWithDeployment();
    const id = await addScan(project.id, deployment.id, 'queued');
    const bindings = withScheduler({
      cancelScans: async () => {
        throw new Error('scheduler down');
      },
    });
    expect((await post(`/admin/security/scans/${id}/cancel`, {}, bindings)).status).toBe(502);
    const [row] = await env.db.select().from(securityScans).where(eq(securityScans.id, id));
    expect(row?.status).toBe('queued');
    expect(await audit()).toEqual([[`security/scans/${id}/cancel`, 'failed']]);
  });
});

describe('admin security: project writes', () => {
  it('queues a rescan, pokes the scheduler and audits it', async () => {
    await savePolicy();
    const { project, deployment } = await projectWithDeployment();
    await env.STATIC_ASSETS_R2.put(
      `security-scans/${project.id}/${deployment.id}/modules.json`,
      '[]',
    );
    const poke = vi.fn(async () => Response.json({ ok: true }));
    const response = await post(
      `/admin/projects/${project.id}/security/rescan`,
      {},
      withScheduler({ fetch: poke }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`/admin/projects/${project.id}#security`);
    const rows = await env.db
      .select()
      .from(securityScans)
      .where(eq(securityScans.trigger, 'rescan'));
    expect(rows).toHaveLength(1);
    expect(poke).toHaveBeenCalledTimes(1);
    expect(await audit()).toEqual([[`projects/${project.id}/security/scans`, 'success']]);
  });

  it('answers 404 for an unknown project on every project route', async () => {
    await savePolicy();
    for (const [route, fields] of [
      ['model', { model: '@cf/zai-org/glm-5.3' }],
      ['budget', { monthlyUsd: '5' }],
      ['rescan', {}],
      ['bypass', { reason: 'no such project' }],
    ] as const) {
      const response = await post(`/admin/projects/missing/security/${route}`, fields);
      expect([route, response.status]).toEqual([route, 404]);
    }
    const events = await audit();
    expect(events).toHaveLength(4);
    expect(events.every(([, status]) => status === 'failed')).toBe(true);
  });

  it('refuses a bypass with an empty reason and records the refusal', async () => {
    const { project } = await gateSetup();
    const response = await post(`/admin/projects/${project.id}/security/bypass`, { reason: '  ' });
    expect(response.status).toBe(422);
    expect(await env.db.select().from(securityScanBypasses)).toHaveLength(0);
    expect(await audit()).toEqual([
      [`projects/${project.id}/security/public-request/bypass`, 'failed'],
    ]);
  });
});

describe('admin security: mark bypasses seen', () => {
  async function bypassNow(projectId: string, reason: string) {
    expect((await post(`/admin/projects/${projectId}/security/bypass`, { reason })).status).toBe(
      302,
    );
  }

  it('hides only what the page showed and keeps a later bypass new', async () => {
    const { project } = await gateSetup();
    await bypassNow(project.id, 'first');
    const [first] = await env.db.select().from(securityScanBypasses);
    const through = new Date(Date.parse(first!.created_at)).toISOString();

    // A second bypass lands after the page loaded, before the button is pressed.
    const later = new Date(Date.parse(first!.created_at) + 5000).toISOString();
    await env.db.insert(securityScanBypasses).values({
      ...first!,
      id: `${first!.id}-later`,
      created_at: later,
      reason: 'second',
    });
    expect((await post('/admin/security/bypasses/seen', { through })).status).toBe(302);
    const page = text(await (await get('/admin/security/requests?state=all')).text());
    expect(page).toContain('1 new');
  });

  it('clamps a time in the future to the newest bypass and refuses a bad value', async () => {
    const { project } = await gateSetup();
    await bypassNow(project.id, 'only');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await post('/admin/security/bypasses/seen', { through: future })).status).toBe(302);
    const stored = (await getPlatformSetting(env.db, `security.bypasses-seen.${adminId}`)) as {
      at: string;
    };
    const [row] = await env.db.select().from(securityScanBypasses);
    expect(Date.parse(stored.at)).toBe(Date.parse(row!.created_at) + 1);
    expect(text(await (await get('/admin/security/requests?state=all')).text())).not.toContain(
      '1 new',
    );
    expect((await post('/admin/security/bypasses/seen', { through: 'soon' })).status).toBe(400);
    expect((await post('/admin/security/bypasses/seen', {})).status).toBe(400);
  });
});

describe('admin security: paging', () => {
  it('accepts a whole page number and refuses anything else', async () => {
    await savePolicy();
    expect((await get('/admin/security/scans?page=2')).status).toBe(200);
    for (const bad of ['0', '-1', '1e3', '%202', '0x10', '1.5', '1000001']) {
      expect([bad, (await get(`/admin/security/scans?page=${bad}`)).status]).toEqual([bad, 400]);
    }
  });
});

describe('admin security: completeness review gaps', () => {
  function urgentFinding(projectId: string, number: number, verdict = 'confirmed') {
    return {
      id: `sf_gap${number}`,
      project_id: projectId,
      number,
      fingerprint_key: `fp-gap-${number}`,
      verdict: verdict as 'confirmed' | 'needs_validation',
      severity: verdict === 'confirmed' ? ('high' as const) : null,
      title: `Gap finding ${number}`,
      category: 'auth',
      file: 'src/a.ts',
      first_scan_id: 'ss_x',
      last_seen_scan_id: 'ss_x',
    };
  }

  it('warns in Settings while few findings are confirmed (PRD §8.1)', async () => {
    await savePolicy();
    const copy = 'Few findings are confirmed; most results are leads that need a human look.';
    // No findings yet: the target is not met.
    expect(text(await (await get('/admin/security')).text())).toContain(copy);
    const { project } = await projectWithDeployment();
    await env.db
      .insert(securityFindings)
      .values([
        urgentFinding(project.id, 1),
        urgentFinding(project.id, 2, 'needs_validation'),
        urgentFinding(project.id, 3, 'needs_validation'),
      ]);
    expect(text(await (await get('/admin/security')).text())).toContain(copy);
    await env.db.insert(securityFindings).values(urgentFinding(project.id, 4));
    expect(text(await (await get('/admin/security')).text())).not.toContain(copy);
  });

  it('shows the platform cap as used up once the next default scan no longer fits', async () => {
    await savePolicy({
      budgets: { ...defaultSecurityPolicy().budgets, platformCapOn: true, platformMonthlyUsd: 100 },
    });
    const policy = await readPolicy();
    const reserve = securityScanReserveNano(policy.defaultModel, policy.limits)!;
    expect(reserve).toBeGreaterThan(0);
    await env.db.insert(securityPlatformSpend).values({
      month: `${new Date().toISOString().slice(0, 7)}-01`,
      // Under the cap, as holds keep it, but with less room than one scan's reserve.
      spent_nano_usd: 100_000_000_000 - reserve + 1,
    });
    const html = text(await (await get('/admin/users')).text());
    expect(html).toContain('Security scans stopped: platform monthly budget used up ($100.00)');
    expect(html).not.toContain("of the platform's monthly budget used");
  });

  it('flags 2+ protection changes in 7 days while urgent findings are open (edge #39)', async () => {
    const { project } = await gateSetup();
    const events = await env.db
      .select({ action: securityProjectEvents.action })
      .from(securityProjectEvents)
      .where(eq(securityProjectEvents.project_id, project.id));
    // gateSetup protects the project once; the unprotect is held by the gate (a request).
    expect(events.map((event) => event.action)).toContain('protection_on');
    await env.db.insert(securityProjectEvents).values({
      id: 'spe_gap_off',
      project_id: project.id,
      actor_kind: 'user',
      action: 'protection_off',
    });
    const title = 'Projects switching Zero Trust protection';
    expect(text(await (await get('/admin/security/scans')).text())).not.toContain(title);
    await env.db.insert(securityFindings).values(urgentFinding(project.id, 1));
    const scans = text(await (await get('/admin/security/scans')).text());
    expect(scans).toContain(title);
    expect(scans).toContain(`${project.slug} (`);
  });

  it('badges a model refused in over 30% of its recent scans as High refusal (PRD §16)', async () => {
    await savePolicy({
      entitlement: {
        checkedAt: new Date().toISOString(),
        ok: true,
        missing: [],
        hosts: { openai: false, anthropic: false },
      },
    });
    const policy = await readPolicy();
    const { project, deployment } = await projectWithDeployment();
    const finished = new Date().toISOString();
    await env.db.insert(securityScans).values(
      Array.from({ length: 10 }, (_, index) => ({
        id: `ss_refusal_${index}`,
        project_id: project.id,
        deployment_id: deployment.id,
        trigger: 'deploy' as const,
        status: index < 4 ? ('refused' as const) : ('succeeded' as const),
        model_used: policy.defaultModel,
        finished_at: finished,
      })),
    );
    expect(text(await (await get('/admin/security')).text())).toContain('High refusal');
    const detail = text(await (await get(`/admin/projects/${project.id}`)).text());
    expect(detail).toContain('High refusal');
    await env.db
      .update(securityScans)
      .set({ status: 'succeeded' })
      .where(eq(securityScans.id, 'ss_refusal_0'));
    expect(text(await (await get('/admin/security')).text())).not.toContain('High refusal');
  });
});
