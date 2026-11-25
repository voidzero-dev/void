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
import {
  deployments,
  operatorEvents,
  projects,
  projectZeroTrust,
  securityFindingEvents,
  securityProjectEvents,
  securityPublicRequests,
  securityScanBypasses,
  securityScans,
} from '../../src/schema.ts';
import { cancelSecurityScanRows } from '../../src/security/queue.ts';
import { projectSecuritySettings, securityPlatformSpend } from '../../src/security/schema.ts';
import { previewSecurityBackfill } from '../../src/security/sweeps.ts';
import { operatorFetch } from './ai-logging-helpers.ts';
import {
  clearTables,
  createOperatorToken,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import {
  insertSecurityFinding,
  insertSecurityScan,
  liveProject,
  saveSecurityPolicy,
  securityBindings,
  seedProtectedProject,
} from './security-fixtures.ts';
import { askPublic, setupGate } from './security-gate-fixtures.ts';

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
    // The scheduler Worker: cancel runs the same row update the real one does.
    ...securityBindings(env, {
      scheduler: {
        cancelScans: async (scanIds: Array<string>, reason: string) =>
          (await cancelSecurityScanRows(env.db, { scanIds }, reason)).length,
      },
    }),
    SITE_DOMAIN: 'apps.example.com',
    PLATFORM_INSTALLATION_ID: 'installation-test',
  };
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
  const response = await operatorFetch(options.bindings ?? onEnv, token, path, options.body);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

describe('operator security budget', () => {
  it('reads the caps and spend, and writes them by revision with a preview first', async () => {
    await saveSecurityPolicy(env, { revision: 4 });
    const { project } = await liveProject(env);
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
    await saveSecurityPolicy(env);
    const { project } = await liveProject(env);
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
    await saveSecurityPolicy(env);
    expect(
      (await call('/projects/proj_missing/security/budget', { body: { monthlyUsd: 1 } })).status,
    ).toBe(404);
    const { project } = await liveProject(env);
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

describe('operator project scan rule (M34)', () => {
  async function storedProject(slug: string) {
    const made = await liveProject(env, slug);
    await env.db
      .update(deployments)
      .set({ bundle_stored: true })
      .where(eq(deployments.id, made.deployment.id));
    return made;
  }

  it('sets the rule with a preview first, audits it, and lists it in status', async () => {
    await saveSecurityPolicy(env, { mode: 'public', publicGate: true });
    const { project } = await liveProject(env);
    const path = `/projects/${project.id}/security/policy`;

    const preview = await call(path, { body: { dryRun: true, override: 'never' } });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      dryRun: true,
      action: 'security.project-policy',
      target: project.id,
      slug: project.slug,
      override: { from: 'inherit', to: 'never' },
      policy: { applies: false, override: 'never' },
    });
    expect(preview.body.preview[0]).toBe(
      `${project.slug}: never scanned; a scan before it goes public still runs.`,
    );
    expect(await env.db.select().from(projectSecuritySettings)).toHaveLength(0);

    const set = await call(path, { body: { override: 'never' } });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ ok: true, override: { from: 'inherit', to: 'never' } });
    expect(await env.db.select().from(projectSecuritySettings)).toMatchObject([
      { project_id: project.id, policy_override: 'never', updated_by_user_id: adminId },
    ]);
    // The project's own view says why, for the page, `status` and the admin panel.
    expect(set.body.policy).toMatchObject({
      applies: false,
      reason: 'a platform admin turned scans off for this project',
    });
    const status = await call('/security/status');
    expect(status.body.projectOverrides).toEqual([
      { projectId: project.id, slug: project.slug, override: 'never' },
    ]);
    const audit = await env.db
      .select()
      .from(operatorEvents)
      .where(eq(operatorEvents.action, `projects/${project.id}/security/policy`));
    expect(audit.map((event) => [event.status, JSON.parse(event.target) as unknown])).toEqual([
      ['success', { projectId: project.id, override: 'never' }],
    ]);

    // inherit puts the project back on the mode; the same value again changes nothing.
    const back = await call(path, { body: { override: 'inherit' } });
    expect(back.body.override).toEqual({ from: 'never', to: 'inherit' });
    expect((await call(path, { body: { override: 'inherit' } })).body.override).toEqual({
      from: 'inherit',
      to: 'inherit',
    });
    expect((await call('/security/status')).body.projectOverrides).toEqual([]);

    expect((await call(path, { body: { override: 'sometimes' } })).status).toBe(400);
    expect((await call(path, { body: {} })).status).toBe(400);
    expect(
      (await call('/projects/proj_missing/security/policy', { body: { override: 'never' } }))
        .status,
    ).toBe(404);
    expect((await call(path, { body: { override: 'never' }, bindings: env })).status).toBe(501);
  });

  it('never refuses a rescan and leaves the project out of a backfill', async () => {
    await saveSecurityPolicy(env);
    const { project } = await storedProject('never-app');
    await storedProject('other-app');
    expect((await previewSecurityBackfill(env.db)).slugs).toEqual(
      expect.arrayContaining(['never-app', 'other-app']),
    );
    await call(`/projects/${project.id}/security/policy`, { body: { override: 'never' } });
    const rescan = await call(`/projects/${project.id}/security/scans`, { body: {} });
    expect(rescan.status).toBe(409);
    expect(rescan.body).toMatchObject({
      error: 'security_not_in_scope',
      message: 'never-app is not scanned: a platform admin turned scans off for this project.',
    });
    expect((await previewSecurityBackfill(env.db)).slugs).toEqual(['other-app']);
    expect(await env.db.select().from(securityScans)).toHaveLength(0);
  });

  it('never refuses a plain rescan while a public request is open', async () => {
    await saveSecurityPolicy(env, { mode: 'public', publicGate: true });
    const { project, deployment } = await storedProject('asking-app');
    await env.db.insert(securityPublicRequests).values({
      id: 'spr_asking',
      project_id: project.id,
      state: 'needs_deploy',
      requested_via: 'project',
      target_deployment_id: deployment.id,
    });
    const set = await call(`/projects/${project.id}/security/policy`, {
      body: { override: 'never' },
    });
    // The request keeps the project in scope, for its gate scan only.
    expect(set.body.policy).toMatchObject({ applies: true, override: 'never' });
    expect(set.body.preview).toContain(
      'A waiting scan of it is skipped when it would start, unless it is the scan for its request to go public; a running scan finishes.',
    );
    const rescan = await call(`/projects/${project.id}/security/scans`, { body: {} });
    expect(rescan.status).toBe(409);
    expect(rescan.body).toMatchObject({
      error: 'security_not_in_scope',
      message: 'asking-app is not scanned: a platform admin turned scans off for this project.',
    });
    expect(await env.db.select().from(securityScans)).toHaveLength(0);
  });

  it('always puts a protected project back in scope under public', async () => {
    await saveSecurityPolicy(env, { mode: 'public' });
    const { project } = await storedProject('kept-app');
    await seedProtectedProject(env, project.id);
    expect((await previewSecurityBackfill(env.db)).slugs).toEqual([]);
    const set = await call(`/projects/${project.id}/security/policy`, {
      body: { override: 'always' },
    });
    expect(set.body.policy).toMatchObject({
      applies: true,
      reason: 'a platform admin turned scans on for this project',
    });
    expect((await previewSecurityBackfill(env.db)).slugs).toEqual(['kept-app']);
  });
});

describe('operator security findings', () => {
  it('lists across projects, oldest first, filters and pages', async () => {
    await saveSecurityPolicy(env);
    const a = await liveProject(env, 'alpha');
    const b = await liveProject(env, 'bravo');
    await insertSecurityFinding(env, a.project.id, {
      number: 1,
      severity: 'critical',
      created_at: '2026-01-01T00:00:00Z',
    });
    await insertSecurityFinding(env, a.project.id, {
      number: 2,
      severity: 'low',
      created_at: '2026-01-02T00:00:00Z',
    });
    await insertSecurityFinding(env, b.project.id, {
      number: 1,
      severity: 'high',
      created_at: '2025-12-01T00:00:00Z',
    });
    await insertSecurityFinding(env, b.project.id, {
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
    expect(
      (all.body.findings as Array<{ project: string; id: string }>).map(
        (row) => `${row.project}/${row.id}`,
      ),
    ).toEqual(['bravo/F-1', 'alpha/F-1', 'alpha/F-2']);
    const urgent = await call('/security/findings?urgent=true');
    expect(
      (urgent.body.findings as Array<{ project: string; id: string }>).map(
        (row) => `${row.project}/${row.id}`,
      ),
    ).toEqual(['bravo/F-1', 'alpha/F-1']);
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
    await saveSecurityPolicy(env);
    const { project } = await liveProject(env);
    await insertSecurityFinding(env, project.id, { number: 1 });
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
    const other = await liveProject(env, 'other');
    expect((await call(`/projects/${other.project.id}/security/findings/F-1`)).status).toBe(404);
  });
});

describe('operator security scans', () => {
  it('lists scans of every project with the month totals and filters', async () => {
    await saveSecurityPolicy(env);
    const a = await liveProject(env, 'alpha');
    await insertSecurityScan(env, a.project.id, a.deployment.id, {
      metered_nano_usd: 3_000_000_000,
      cost_nano_usd: 2_900_000_000,
      model_used: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      tier: 'full',
      coverage: 'complete',
    });
    await insertSecurityScan(env, a.project.id, a.deployment.id, {
      status: 'refused',
      trigger: 'gate',
    });
    await insertSecurityScan(env, a.project.id, a.deployment.id, {
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
    await saveSecurityPolicy(env);
    const { project, deployment } = await liveProject(env);
    const queued = await insertSecurityScan(env, project.id, deployment.id, {
      status: 'queued',
      finished_at: null,
    });
    const done = await insertSecurityScan(env, project.id, deployment.id);

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
    await saveSecurityPolicy(env);
    const { project, deployment } = await liveProject(env);
    await storeSnapshot(project.id, deployment.id);
    await insertSecurityScan(env, project.id, deployment.id);
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
    await saveSecurityPolicy(env);
    const { project, deployment } = await liveProject(env);
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
    const { project, deployment } = await liveProject(env);
    const path = `/projects/${project.id}/security/scans`;
    await saveSecurityPolicy(env, { mode: 'disabled' });
    const off = await call(path, { body: {} });
    expect(off.status).toBe(409);
    expect(off.body.error).toBe('security_not_in_scope');

    await saveSecurityPolicy(env);
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
    await saveSecurityPolicy(env);
    const { project, deployment } = await liveProject(env);
    await storeSnapshot(project.id, deployment.id);
    const preview = await call(`/projects/${project.id}/security/scans`, {
      body: { dryRun: true },
    });
    expect(preview.body.alreadyScanned).toBe(false);
  });
});

describe('operator security model', () => {
  it('sets the project model through the project rules and previews without writing', async () => {
    await saveSecurityPolicy(env, { blockedModels: ['@cf/zai-org/glm-5.3'] });
    const { project } = await liveProject(env);
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

describe('operator public requests and bypass', () => {
  async function gateSetup() {
    const s = await setupGate(env);
    await askPublic(s);
    return { owner: s.user, project: s.project, deployment: s.deployment };
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
    expect(
      audit
        .map((event) => [event.action, event.status])
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([
      [`projects/${project.id}/security/public-request/bypass`, 'failed'],
      [`projects/${project.id}/security/public-request/bypass`, 'success'],
    ]);
    expect(audit.map((event): unknown => JSON.parse(event.target))).toEqual([
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
    await saveSecurityPolicy(env, { publicGate: true });
    const { project } = await liveProject(env, 'quiet');
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
    await insertSecurityScan(env, project.id, deployment.id);
    await insertSecurityFinding(env, project.id, { number: 7 });
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
