import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
  type SecurityPolicy,
} from '@void/platform/security-policy';
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
import { setPlatformSetting } from '../../src/platform-settings.ts';
import {
  operatorEvents,
  projects,
  projectZeroTrust,
  securityFindingEvents,
  securityFindings,
  securityProjectEvents,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
} from '../../src/schema.ts';
import { cancelSecurityScanRows } from '../../src/security/queue.ts';
import { projectSecuritySettings, securityPlatformSpend } from '../../src/security/schema.ts';
import { configurePlatformZeroTrust } from '../../src/zero-trust/installation.ts';
import { setProjectZeroTrustProtection } from '../../src/zero-trust/project.ts';
import {
  clearTables,
  createOperatorToken,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let onEnv: TestEnv;
let token: string;
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
    // The scheduler Worker: cancel runs the same row update the real one does.
    SECURITY_SCAN_SCHEDULER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => Response.json({ ok: true }),
        cancelScans: async (scanIds: Array<string>, reason: string) =>
          (await cancelSecurityScanRows(env.db, { scanIds }, reason)).length,
      }),
    },
  } as unknown as TestEnv;
  const admin = await createTestUser(
    env.db,
    'security-admin',
    'github',
    undefined,
    'free',
    'admin',
  );
  adminId = admin.id;
  token = await createOperatorToken(env.db, admin);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Replies are checked field by field below, so the body is read loosely.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;

async function call(
  path: string,
  options: { body?: Record<string, unknown>; bindings?: TestEnv } = {},
): Promise<{ status: number; body: Json; headers: Headers }> {
  const response = await app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
      method: options.body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    }),
    options.bindings ?? onEnv,
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function savePolicy(overrides: Partial<SecurityPolicy> = {}) {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
    ...defaultSecurityPolicy(),
    mode: 'all',
    revision: 1,
    ...overrides,
  });
}

async function projectWithDeployment(slug = 'acme-web') {
  const owner = await createTestUser(env.db, `owner-${slug}`);
  const project = await createTestProject(env.db, owner.id, slug);
  const deployment = await createTestDeployment(env.db, project.id, 'live');
  return { owner, project, deployment };
}

let findingCounter = 0;
async function addFinding(
  projectId: string,
  overrides: Partial<typeof securityFindings.$inferInsert> = {},
) {
  const number = overrides.number ?? ++findingCounter;
  await env.db.insert(securityFindings).values({
    id: `sf_${projectId}_${number}`,
    project_id: projectId,
    number,
    fingerprint_key: `fp-${projectId}-${number}`,
    verdict: 'confirmed',
    severity: 'high',
    title: `Finding ${number}`,
    category: 'sqli',
    file: 'src/a.ts',
    line_start: 3,
    first_scan_id: 'ss_x',
    last_seen_scan_id: 'ss_x',
    ...overrides,
  });
  return number;
}

async function addScan(
  projectId: string,
  deploymentId: string | null,
  overrides: Partial<typeof securityScans.$inferInsert> = {},
) {
  const id = overrides.id ?? `ss_${crypto.randomUUID().slice(0, 8)}`;
  await env.db.insert(securityScans).values({
    status: 'succeeded',
    trigger: 'deploy',
    finished_at: new Date().toISOString(),
    ...overrides,
    id,
    project_id: projectId,
    deployment_id: deploymentId,
  });
  return id;
}

describe('operator security budget', () => {
  it('reads the caps and spend, and writes them by revision with a preview first', async () => {
    await savePolicy({ revision: 4 });
    const { project } = await projectWithDeployment();
    await env.db.insert(securityPlatformSpend).values({
      month: `${new Date().toISOString().slice(0, 7)}-01`,
      spent_nano_usd: 12_500_000_000,
    });
    const read = await call('/security/budget');
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      revision: 4,
      platform: { capOn: false, monthlyUsd: 1000, spentUsd: 12.5 },
      projectDefault: { capsOn: false, monthlyUsd: 100 },
    });

    const preview = await call('/security/budget', {
      body: { dryRun: true, platformMonthlyUsd: 250, projectDefaultMonthlyUsd: 40 },
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      dryRun: true,
      expectedRevision: 4,
      to: { platformCapOn: true, platformMonthlyUsd: 250, projectCapsOn: true },
    });
    expect((await call('/security/budget')).body.platform.capOn).toBe(false);

    const missing = await call('/security/budget', { body: { platformMonthlyUsd: 250 } });
    expect(missing.status).toBe(400);
    const stale = await call('/security/budget', {
      body: { expectedRevision: 3, platformMonthlyUsd: 250 },
    });
    expect(stale.status).toBe(409);
    const typo = await call('/security/budget', {
      body: { expectedRevision: 4, platformMonthlyUsd: 250, perProject: 1 },
    });
    expect(typo.status).toBe(400);
    const cents = await call('/security/budget', {
      body: { expectedRevision: 4, platformMonthlyUsd: 10.123 },
    });
    expect(cents.status).toBe(400);

    const written = await call('/security/budget', {
      body: { expectedRevision: 4, platformMonthlyUsd: 250, projectDefaultMonthlyUsd: 40 },
    });
    expect(written.status).toBe(200);
    expect(written.body).toMatchObject({
      ok: true,
      revision: 5,
      budgets: {
        platformCapOn: true,
        platformMonthlyUsd: 250,
        projectCapsOn: true,
        projectDefaultMonthlyUsd: 40,
      },
    });
    const off = await call('/security/budget', {
      body: { expectedRevision: 5, platformMonthlyUsd: null },
    });
    expect(off.body.budgets).toMatchObject({ platformCapOn: false, platformMonthlyUsd: 250 });

    // The next write of the same revision is refused: the two writers never overwrite.
    const again = await call('/security/budget', {
      body: { expectedRevision: 5, platformMonthlyUsd: 1 },
    });
    expect(again.status).toBe(409);
    expect(project.id).toBeTruthy();
  });

  it('sets a project ceiling, records it, and a preview keeps nothing', async () => {
    await savePolicy();
    const { project } = await projectWithDeployment();
    const path = `/projects/${project.id}/security/budget`;
    const preview = await call(path, { body: { dryRun: true, monthlyUsd: 25 } });
    expect(preview.status).toBe(200);
    expect(preview.body.budget).toMatchObject({ ceilingUsd: 25 });
    expect(await env.db.select().from(securityProjectEvents)).toHaveLength(0);
    expect(await env.db.select().from(projectSecuritySettings)).toHaveLength(0);

    const set = await call(path, { body: { monthlyUsd: 25 } });
    expect(set.status).toBe(200);
    expect(set.body.budget).toMatchObject({ ceilingUsd: 25 });
    const [event] = await env.db.select().from(securityProjectEvents);
    expect(event).toMatchObject({
      project_id: project.id,
      actor_kind: 'installation_admin',
      actor_user_id: adminId,
      actor_role: null,
      action: 'cap_changed',
      cap_kind: 'ceiling',
      old_cents: null,
      new_cents: 2500,
    });
    const listed = await call('/security/budget');
    expect(listed.body.projectCaps).toEqual([
      expect.objectContaining({ slug: project.slug, ceilingUsd: 25 }),
    ]);

    expect((await call(path, { body: { monthlyUsd: -1 } })).status).toBe(400);
    expect((await call(path, { body: {} })).status).toBe(400);
    const clear = await call(path, { body: { monthlyUsd: null } });
    expect(clear.body.budget.ceilingUsd).toBeNull();
    expect(await env.db.select().from(securityProjectEvents)).toHaveLength(2);
  });

  it('answers 404 for an unknown project and 501 for writes while the capability is off', async () => {
    await savePolicy();
    expect(
      (await call('/projects/proj_missing/security/budget', { body: { monthlyUsd: 1 } })).status,
    ).toBe(404);
    const { project } = await projectWithDeployment();
    const off = await call(`/projects/${project.id}/security/budget`, {
      body: { monthlyUsd: 1 },
      bindings: env,
    });
    expect(off.status).toBe(501);
    expect(off.body).toMatchObject({ capability: 'securityAudits' });
    expect((await call('/security/budget', { bindings: env })).status).toBe(200);
    const installation = await call('/security/budget', {
      body: { platformMonthlyUsd: 250 },
      bindings: env,
    });
    expect(installation.status).toBe(501);
    expect(installation.body).toMatchObject({ capability: 'securityAudits' });
  });
});

describe('operator security findings', () => {
  it('lists across projects, oldest first, filters and pages', async () => {
    await savePolicy();
    const a = await projectWithDeployment('alpha');
    const b = await projectWithDeployment('bravo');
    await addFinding(a.project.id, {
      number: 1,
      severity: 'critical',
      created_at: '2026-01-01T00:00:00Z',
    });
    await addFinding(a.project.id, {
      number: 2,
      severity: 'low',
      created_at: '2026-01-02T00:00:00Z',
    });
    await addFinding(b.project.id, {
      number: 1,
      severity: 'high',
      created_at: '2025-12-01T00:00:00Z',
    });
    await addFinding(b.project.id, {
      number: 2,
      severity: 'high',
      state: 'resolved',
      resolution: 'fixed',
      resolved_at: new Date().toISOString(),
    });

    const all = await call('/security/findings');
    expect(all.body.total).toBe(3);
    // The SARIF export (M31) reads the CWE, the end line and the verdict source too.
    expect(Object.keys(all.body.findings[0])).toEqual(
      expect.arrayContaining(['cwe', 'lineEnd', 'verdictSource']),
    );
    expect(all.body.findings.map((row: Json) => `${row.project}/${row.id}`)).toEqual([
      'bravo/F-1',
      'alpha/F-1',
      'alpha/F-2',
    ]);
    const urgent = await call('/security/findings?urgent=true');
    expect(urgent.body.findings.map((row: Json) => `${row.project}/${row.id}`)).toEqual([
      'bravo/F-1',
      'alpha/F-1',
    ]);
    const mine = await call('/security/findings?project=alpha&state=all');
    expect(mine.body.total).toBe(2);
    const paged = await call('/security/findings?limit=1&page=2');
    expect(paged.body).toMatchObject({ page: 2, limit: 1, totalPages: 3 });
    expect(paged.body.findings).toHaveLength(1);
    expect((await call('/security/findings?severity=nope')).status).toBe(400);
    expect((await call('/security/findings?limit=101')).status).toBe(400);
    // Reads stay open with the capability off.
    expect((await call('/security/findings', { bindings: env })).status).toBe(200);
  });

  it('resolves, reopens and comments as the installation admin, with a preview first', async () => {
    await savePolicy();
    const { project } = await projectWithDeployment();
    await addFinding(project.id, { number: 1 });
    const base = `/projects/${project.id}/security/findings/F-1`;

    const show = await call(base);
    expect(show.status).toBe(200);
    expect(show.body.finding).toMatchObject({ id: 'F-1', state: 'open', revision: 1 });

    const preview = await call(`${base}/resolve`, {
      body: {
        dryRun: true,
        reason: 'accepted_risk',
        comment: 'internal tool',
        expectedRevision: 1,
      },
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ dryRun: true, action: 'security.finding-resolve' });
    expect((await call(base)).body.finding.state).toBe('open');
    expect(await env.db.select().from(securityFindingEvents)).toHaveLength(0);

    expect(
      (
        await call(`${base}/resolve`, {
          body: { reason: 'nope', comment: 'x', expectedRevision: 1 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(`${base}/resolve`, {
          body: { reason: 'fixed', comment: '', expectedRevision: 1 },
        })
      ).status,
    ).toBe(400);
    const resolved = await call(`${base}/resolve`, {
      body: { reason: 'accepted_risk', comment: 'internal tool', expectedRevision: 1 },
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      state: 'resolved',
      resolution: 'accepted_risk',
      revision: 2,
    });
    const stale = await call(`${base}/resolve`, {
      body: { reason: 'fixed', comment: 'again', expectedRevision: 1 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('finding changed');

    const comment = await call(`${base}/comments`, { body: { text: 'Talked to the owner.' } });
    expect(comment.status).toBe(201);
    const reopened = await call(`${base}/reopen`, {
      body: { comment: 'owner changed their mind', expectedRevision: 2 },
    });
    expect(reopened.body).toMatchObject({ state: 'open', revision: 3 });
    const events = await env.db.select().from(securityFindingEvents);
    expect(events.map((event) => [event.action, event.actor_kind, event.actor_role])).toEqual(
      expect.arrayContaining([
        ['resolved', 'installation_admin', null],
        ['commented', 'installation_admin', null],
        ['reopened', 'installation_admin', null],
      ]),
    );
    expect(events.every((event) => event.actor_user_id === adminId)).toBe(true);
    // A finding of another project is not found.
    const other = await projectWithDeployment('other');
    expect((await call(`/projects/${other.project.id}/security/findings/F-1`)).status).toBe(404);
  });
});

describe('operator security scans', () => {
  it('lists scans of every project with the month totals and filters', async () => {
    await savePolicy();
    const a = await projectWithDeployment('alpha');
    await addScan(a.project.id, a.deployment.id, {
      metered_nano_usd: 3_000_000_000,
      cost_nano_usd: 2_900_000_000,
      model_used: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      tier: 'full',
      coverage: 'complete',
    });
    await addScan(a.project.id, a.deployment.id, { status: 'refused', trigger: 'gate' });
    await addScan(a.project.id, a.deployment.id, {
      status: 'skipped',
      status_reason: 'budget_project',
    });

    const all = await call('/security/scans');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(3);
    expect(all.body.month).toMatchObject({
      scans: 3,
      meteredUsd: 3,
      gatewayUsd: 2.9,
      refused: 1,
      skippedBudget: 1,
    });
    expect(all.body.scans[0]).toMatchObject({ project: 'alpha', projectId: a.project.id });
    const gate = await call('/security/scans?trigger=gate');
    expect(gate.body.scans).toHaveLength(1);
    expect(gate.body.scans[0].status).toBe('refused');
    expect((await call('/security/scans?status=refused&project=alpha')).body.total).toBe(1);
    expect((await call('/security/scans?status=nope')).status).toBe(400);
    expect((await call('/security/scans?trigger=deploy')).status).toBe(400);
  });

  it('cancels a waiting scan, refuses a finished one, and a preview changes nothing', async () => {
    await savePolicy();
    const { project, deployment } = await projectWithDeployment();
    const queued = await addScan(project.id, deployment.id, {
      status: 'queued',
      finished_at: null,
    });
    const done = await addScan(project.id, deployment.id);

    expect((await call('/security/scans/ss_missing/cancel', { body: {} })).status).toBe(404);
    const finished = await call(`/security/scans/${done}/cancel`, { body: {} });
    expect(finished.status).toBe(409);
    expect(finished.body.error).toBe('security_scan_not_cancelable');

    const preview = await call(`/security/scans/${queued}/cancel`, { body: { dryRun: true } });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      dryRun: true,
      action: 'security.scan-cancel',
      target: queued,
    });
    const [still] = await env.db.select().from(securityScans).where(eq(securityScans.id, queued));
    expect(still?.status).toBe('queued');

    const canceled = await call(`/security/scans/${queued}/cancel`, { body: {} });
    expect(canceled.status).toBe(200);
    expect(canceled.body).toMatchObject({ ok: true, scanId: queued, canceled: 1 });
    const [row] = await env.db.select().from(securityScans).where(eq(securityScans.id, queued));
    expect(row).toMatchObject({ status: 'canceled', status_reason: 'operator_canceled' });
  });
});

describe('operator security rescan', () => {
  async function storeSnapshot(projectId: string, deploymentId: string) {
    await env.STATIC_ASSETS_R2.put(
      `security-scans/${projectId}/${deploymentId}/modules.json`,
      '[]',
    );
  }

  it('previews the cost, queues a full scan, and refuses a second while one waits', async () => {
    await savePolicy();
    const { project, deployment } = await projectWithDeployment();
    await storeSnapshot(project.id, deployment.id);
    await addScan(project.id, deployment.id);
    const path = `/projects/${project.id}/security/scans`;

    const preview = await call(path, { body: { dryRun: true } });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      dryRun: true,
      action: 'security.rescan',
      deploymentId: deployment.id,
      alreadyScanned: true,
      tier: 'full',
      model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    });
    expect(typeof preview.body.worstCaseUsd).toBe('number');
    expect(await env.db.select().from(securityScans)).toHaveLength(1);

    const queued = await call(path, { body: {} });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ ok: true, tier: 'full', alreadyScanned: true });
    const rows = await env.db
      .select()
      .from(securityScans)
      .where(eq(securityScans.trigger, 'rescan'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: queued.body.scanId,
      project_id: project.id,
      deployment_id: deployment.id,
      status: 'queued',
    });
    expect(rows[0]?.input_r2_key).toBe(`security-scans/${project.id}/${deployment.id}/`);

    const second = await call(path, { body: {} });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('security_scan_in_progress');
    expect((await call(path, { body: { dryRun: true } })).status).toBe(409);
  });

  it('queues the client asset pass when asked (M31)', async () => {
    await savePolicy();
    const { project, deployment } = await projectWithDeployment();
    await storeSnapshot(project.id, deployment.id);
    const path = `/projects/${project.id}/security/scans`;
    expect((await call(path, { body: { clientAssets: 1 } })).status).toBe(400);
    const preview = await call(path, { body: { dryRun: true, clientAssets: true } });
    expect(preview.body).toMatchObject({ dryRun: true, clientAssets: true });
    const queued = await call(path, { body: { clientAssets: true } });
    expect(queued.body).toMatchObject({ ok: true, clientAssets: true });
    const [row] = await env.db
      .select()
      .from(securityScans)
      .where(eq(securityScans.id, queued.body.scanId));
    expect(row?.coverage_notes).toEqual(['client-assets']);
  });

  it('refuses a rescan that cannot run, each with its own code', async () => {
    const { project, deployment } = await projectWithDeployment();
    const path = `/projects/${project.id}/security/scans`;
    await savePolicy({ mode: 'disabled' });
    const off = await call(path, { body: {} });
    expect(off.status).toBe(409);
    expect(off.body.error).toBe('security_not_in_scope');

    await savePolicy();
    const noInput = await call(path, { body: {} });
    expect(noInput.status).toBe(409);
    expect(noInput.body.error).toBe('security_input_unavailable');

    await storeSnapshot(project.id, deployment.id);
    await env.db
      .update(projects)
      .set({ active_deployment_id: null })
      .where(eq(projects.id, project.id));
    expect((await call(path, { body: {} })).body.error).toBe('no_live_deployment');
    expect((await call('/projects/proj_missing/security/scans', { body: {} })).status).toBe(404);
    expect((await call(path, { body: {}, bindings: env })).status).toBe(501);
    expect(await env.db.select().from(securityScans)).toHaveLength(0);
  });

  it('says a never scanned deployment is not already scanned', async () => {
    await savePolicy();
    const { project, deployment } = await projectWithDeployment();
    await storeSnapshot(project.id, deployment.id);
    const preview = await call(`/projects/${project.id}/security/scans`, {
      body: { dryRun: true },
    });
    expect(preview.body.alreadyScanned).toBe(false);
  });
});

describe('operator security model', () => {
  it('sets the project model through the project rules and previews without writing', async () => {
    await savePolicy({ blockedModels: ['@cf/zai-org/glm-5.3'] });
    const { project } = await projectWithDeployment();
    const path = `/projects/${project.id}/security/model`;
    const blocked = await call(path, { body: { model: '@cf/zai-org/glm-5.3' } });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe('security model not allowed');

    const preview = await call(path, {
      body: { dryRun: true, model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017' },
    });
    expect(preview.status).toBe(200);
    expect(await env.db.select().from(projectSecuritySettings)).toHaveLength(0);
    const set = await call(path, { body: { model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017' } });
    expect(set.status).toBe(200);
    expect(set.body.model).toMatchObject({ requested: '@cf/deepseek-ai/deepseek-v4.1-flash-1017' });
    expect((await env.db.select().from(projectSecuritySettings))[0]?.model).toBe(
      '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    );
  });
});

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

describe('operator public requests and bypass', () => {
  async function gateSetup() {
    vi.stubGlobal('fetch', accessApi());
    const platform = {
      ...onEnv,
      SITE_DOMAIN: 'apps.example.com',
      PLATFORM_INSTALLATION_ID: 'installation-test',
    } as unknown as ApiEnv['Bindings'];
    await configurePlatformZeroTrust(platform, env.db, {
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
    await setProjectZeroTrustProtection(platform, env.db, project.id, true);
    await setProjectZeroTrustProtection(platform, env.db, project.id, false, {
      actorUserId: owner.id,
    });
    return { platform, owner, project, deployment };
  }

  it('lists requests and bypasses, with the reason visible to the operator only here', async () => {
    const { project, deployment } = await gateSetup();
    const open = await call('/security/public-requests');
    expect(open.status).toBe(200);
    expect(open.body.requests).toEqual([
      expect.objectContaining({
        project: project.slug,
        projectId: project.id,
        state: 'needs_deploy',
      }),
    ]);
    expect((await call('/security/public-requests?state=closed')).body.total).toBe(0);
    expect((await call('/security/public-requests?state=nope')).status).toBe(400);
    expect((await call('/security/bypasses')).body).toMatchObject({ total: 0, bypasses: [] });

    const path = `/projects/${project.id}/security/public-request/bypass`;
    expect((await call(path, { body: { reason: '   ' } })).status).toBe(422);
    const preview = await call(path, { body: { dryRun: true, reason: 'launch day' } });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      dryRun: true,
      action: 'security.public-request-bypass',
      publicRequest: { state: 'needs_deploy', targetDeploymentId: deployment.id },
    });
    expect(await env.db.select().from(securityScanBypasses)).toHaveLength(0);

    const done = await call(path, { body: { reason: 'launch day, scanner down' } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ ok: true, publicRequest: { state: 'bypassed' } });
    const [row] = await env.db
      .select()
      .from(projectZeroTrust)
      .where(eq(projectZeroTrust.project_id, project.id));
    expect(row?.desired_protected).toBe(false);
    const [bypass] = await env.db.select().from(securityScanBypasses);
    expect(bypass).toMatchObject({
      actor_kind: 'installation_admin',
      actor_user_id: adminId,
      actor_role: null,
      reason: 'launch day, scanner down',
    });
    const listed = await call('/security/bypasses');
    expect(listed.body.bypasses[0]).toMatchObject({
      project: project.slug,
      reason: 'launch day, scanner down',
      actorKind: 'installation_admin',
      requestState: 'needs_deploy',
    });
    expect((await call('/security/public-requests?state=bypassed')).body.total).toBe(1);

    // The operator API audits the refused attempt and the bypass; the gate writes no
    // second row of its own for an installation admin. No reason text is in any of them.
    const audit = await env.db.select().from(operatorEvents);
    // Exactly one success row for the real bypass; row order is not guaranteed.
    expect(audit.map((event) => [event.action, event.status]).sort()).toEqual([
      [`projects/${project.id}/security/public-request/bypass`, 'failed'],
      [`projects/${project.id}/security/public-request/bypass`, 'success'],
    ]);
    expect(audit.map((event) => JSON.parse(event.target))).toEqual([
      { projectId: project.id },
      { projectId: project.id },
    ]);
    expect(JSON.stringify(audit)).not.toContain('scanner down');
    // Nothing open is left to bypass.
    const again = await call(path, { body: { reason: 'again' } });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('no public request');
  });

  it('refuses a bypass with no request, and with an urgent finding open', async () => {
    await savePolicy({ publicGate: true });
    const { project } = await projectWithDeployment('quiet');
    const path = `/projects/${project.id}/security/public-request/bypass`;
    const none = await call(path, { body: { reason: 'why not' } });
    expect(none.status).toBe(409);
    expect(none.body.error).toBe('no public request');
    expect((await call(path, { body: { dryRun: true, reason: 'why not' } })).status).toBe(409);
    expect(
      (
        await call('/projects/proj_missing/security/public-request/bypass', {
          body: { reason: 'x' },
        })
      ).status,
    ).toBe(404);
  });

  it('refuses a bypass while an urgent finding blocks the request', async () => {
    const { project, deployment } = await gateSetup();
    await addScan(project.id, deployment.id);
    await addFinding(project.id, { number: 7 });
    await env.db
      .update(securityPublicRequests)
      .set({ state: 'held_findings', blockers: 1, blocker_ids: ['F-7'] })
      .where(eq(securityPublicRequests.project_id, project.id));
    const path = `/projects/${project.id}/security/public-request/bypass`;
    const refused = await call(path, { body: { reason: 'ship it' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('security public request has urgent findings');
    expect(refused.body.details.blockers).toEqual({ count: 1, ids: ['F-7'] });
    expect((await call(path, { body: { dryRun: true, reason: 'ship it' } })).status).toBe(409);
    expect(await env.db.select().from(securityScanBypasses)).toHaveLength(0);
  });
});
