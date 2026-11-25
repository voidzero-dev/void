import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import app from '../../src/index.ts';
import {
  projectSecuritySettings,
  securityFindingEvents,
  securityFindings,
  securityScans,
} from '../../src/security/schema.ts';
import { clearTables, createTestDeployment, mockCfApi, setupEnv, teardownEnv } from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import {
  freshEntitlement,
  insertCompletedScan,
  insertSecurityFinding,
  projectWithRoles,
  saveSecurityPolicy,
  securityOn,
} from './security-fixtures.ts';
import {
  askPublic,
  setupGate,
  succeededScan,
  urgentFinding,
  ztRow,
} from './security-gate-fixtures.ts';
let env: TestEnv;
let onEnv: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  vi.restoreAllMocks();
  onEnv = securityOn(env);
  mockCfApi();
});

function call(
  path: string,
  jwt: string,
  options: { method?: string; body?: unknown; bindings?: TestEnv } = {},
) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    options.bindings ?? onEnv,
  );
}

// Replies are checked field by field below, so the body is read loosely.
// oxlint-disable-next-line typescript/no-explicit-any
async function json(response: Response): Promise<any> {
  return response.json();
}
describe('project security routes', () => {
  it('gives every role the status, and titles, files and dollars only to deploy roles', async () => {
    await saveSecurityPolicy(env);
    const { project, people, outsider } = await projectWithRoles(env);
    const deployment = await createTestDeployment(env.db, project.id);
    await insertCompletedScan(env, project.id, deployment.id);
    await insertSecurityFinding(env, project.id, { number: 1, severity: 'critical' });

    const admin = await json(await call(`/projects/${project.id}/security`, people.admin.jwt));
    expect(admin).toMatchObject({ canResolve: true, urgent: { count: 1, detail: 'full' } });
    expect(admin.urgent.findings[0]).toMatchObject({ id: 'F-1', title: 'SECRET TITLE 1' });
    expect(admin.budget).not.toBeNull();

    const reader = await json(await call(`/projects/${project.id}/security`, people.reader.jwt));
    expect(reader).toMatchObject({ canResolve: false, budget: null, urgent: { count: 1 } });
    expect(reader.urgent.findings[0]).toEqual({ id: 'F-1', severity: 'critical' });
    expect(JSON.stringify(reader)).not.toContain('SECRET TITLE');

    expect((await call(`/projects/${project.id}/security`, outsider.jwt)).status).toBe(403);
  });

  it('only a project admin resolves; a stale revision loses; a reopen opens it again (I5)', async () => {
    await saveSecurityPolicy(env);
    const { project, people } = await projectWithRoles(env);
    await insertSecurityFinding(env, project.id, { number: 1 });
    const base = `/projects/${project.id}/security/findings/F-1`;
    const resolve = { reason: 'fixed', comment: 'patched', expectedRevision: 1 };

    const denied = await call(`${base}/resolve`, people.collaborator.jwt, {
      method: 'POST',
      body: resolve,
    });
    expect(denied.status).toBe(403);
    const resolved = await call(`${base}/resolve`, people.admin.jwt, {
      method: 'POST',
      body: resolve,
    });
    expect(await json(resolved)).toMatchObject({ id: 'F-1', state: 'resolved', revision: 2 });
    const stale = await call(`${base}/resolve`, people.owner.jwt, {
      method: 'POST',
      body: { ...resolve, reason: 'false_positive' },
    });
    expect(stale.status).toBe(409);

    const reopened = await call(`${base}/reopen`, people.admin.jwt, {
      method: 'POST',
      body: { comment: 'still broken', expectedRevision: 2 },
    });
    expect(await json(reopened)).toMatchObject({ state: 'open', revision: 3 });
    const actions = await env.db.select().from(securityFindingEvents);
    expect(actions.map((event) => event.action).sort()).toEqual(['reopened', 'resolved']);
  });

  it('lowering the last urgent finding frees a held public request, as a resolve does', async () => {
    const s = await setupGate(env);
    await succeededScan(s);
    await urgentFinding(s);
    expect((await askPublic(s)).publicRequest?.state).toBe('held_findings');

    const response = await call(
      `/projects/${s.project.id}/security/findings/F-1/severity`,
      s.user.jwt,
      {
        method: 'POST',
        body: { severity: 'medium', comment: 'Behind admin auth', expectedRevision: 1 },
        bindings: s.platform as unknown as TestEnv,
      },
    );
    expect(response.status).toBe(200);
    expect((await json(response)).publicRequest.state).toBe('passed');
    expect((await ztRow(s)).desired_protected).toBe(false);
    const [row] = await env.db.select().from(securityFindings);
    expect(row).toMatchObject({ severity: 'high', severity_override: 'medium' });
  });

  it('queues one rescan of the live deployment and refuses a second', async () => {
    await saveSecurityPolicy(env);
    const { project, people } = await projectWithRoles(env);
    const deployment = await createTestDeployment(env.db, project.id);
    await env.STATIC_ASSETS_R2.put(
      `security-scans/${project.id}/${deployment.id}/modules.json`,
      '[]',
    );
    const path = `/projects/${project.id}/security/scans`;
    const queued = await call(path, people.owner.jwt, { method: 'POST', body: {} });
    expect(queued.status).toBe(202);
    const { scanId } = await json(queued);
    const [row] = await env.db.select().from(securityScans).where(eq(securityScans.id, scanId));
    expect(row).toMatchObject({
      trigger: 'rescan',
      status: 'queued',
      deployment_id: deployment.id,
    });
    expect((await call(path, people.admin.jwt, { method: 'POST', body: {} })).status).toBe(409);
  });

  it('a third-party model needs the provider notice; writes answer 501 with the capability off (I8, I13)', async () => {
    const FOREIGN = 'openai/gpt-6.1-terra';
    await saveSecurityPolicy(env, {
      entitlement: freshEntitlement({ openai: true, anthropic: false }),
      thirdPartyNotice: { version: 1, acceptedAt: new Date().toISOString(), acceptedByUserId: 'u' },
    });
    const { project, people } = await projectWithRoles(env);
    const put = (body: unknown, bindings?: TestEnv) =>
      call(`/projects/${project.id}/security/model`, people.admin.jwt, {
        method: 'PUT',
        body,
        bindings,
      });
    expect((await put({ model: '@cf/zai-org/glm-5.3' }, env)).status).toBe(501);
    expect(await env.db.select().from(projectSecuritySettings)).toEqual([]);

    const needsNotice = await put({ model: FOREIGN });
    expect(needsNotice.status).toBe(422);
    expect(await json(needsNotice)).toMatchObject({ error: 'provider notice not accepted' });
    expect(await env.db.select().from(projectSecuritySettings)).toEqual([]);

    const accepted = await put({ model: FOREIGN, acceptProviderNoticeVersion: 1 });
    expect(accepted.status).toBe(200);
    const [row] = await env.db.select().from(projectSecuritySettings);
    expect(row).toMatchObject({ model: FOREIGN, provider_notice_version: 1 });
  });
});
