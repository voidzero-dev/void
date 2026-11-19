import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
  type SecurityPolicy,
} from '@void/platform/security-policy';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { signDeployToken } from '../../src/auth/deploy-token.ts';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import app from '../../src/index.ts';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import { ProjectAccessDeniedError } from '../../src/project-access.ts';
import { deployments, projectMembers } from '../../src/schema.ts';
import { verifySecurityPageToken } from '../../src/security/page-token.ts';
import { resolveSecurityFinding } from '../../src/security/project-findings.ts';
import {
  projectSecuritySettings,
  securityFindingEvents,
  securityNotifications,
  securityFindings,
  securityProjectEvents,
  securityProjectSpend,
  securityScans,
} from '../../src/security/schema.ts';
import {
  clearTables,
  createTestBuild,
  createTestDeployment,
  createTestProject,
  createTestUser,
  mockCfApi,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

let env: TestEnv;
let onEnv: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  vi.restoreAllMocks();
  onEnv = {
    ...env,
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
  };
  mockCfApi();
});

type Policy = Partial<SecurityPolicy>;

async function savePolicy(policy: Policy = {}) {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
    ...defaultSecurityPolicy(),
    mode: 'all',
    revision: 1,
    ...policy,
  });
}

const ROLES = ['owner', 'admin', 'collaborator', 'reader'] as const;
type Role = (typeof ROLES)[number];

async function setup(slug = 'acme-web') {
  const owner = await createTestUser(env.db, `owner-${slug}`);
  const project = await createTestProject(env.db, owner.id, slug);
  const people: Record<Role, { id: string; login: string; jwt: string }> = {
    owner,
    admin: owner,
    collaborator: owner,
    reader: owner,
  };
  for (const role of ['admin', 'collaborator', 'reader'] as const) {
    const user = await createTestUser(env.db, `${role}-${slug}`);
    await env.db.insert(projectMembers).values({
      project_id: project.id,
      user_id: user.id,
      role,
      added_by_user_id: owner.id,
    });
    people[role] = user;
  }
  const outsider = await createTestUser(env.db, `outsider-${slug}`);
  return { owner, project, people, outsider };
}

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

let findingCounter = 0;

async function addFinding(
  projectId: string,
  overrides: Partial<typeof securityFindings.$inferInsert> = {},
) {
  const n = overrides.number ?? ++findingCounter;
  const id = `sf_test${projectId}${n}`;
  await env.db.insert(securityFindings).values({
    id,
    project_id: projectId,
    number: n,
    fingerprint_key: `key-${projectId}-${n}`,
    verdict: 'confirmed',
    severity: 'high',
    title: `SECRET TITLE ${n}`,
    category: 'sqli',
    file: `src/routes/secret-${n}.ts`,
    line_start: 41,
    detail: { trace: ['a', 'b'], evidence: 'EVIDENCE', conditions: 'c', fix: 'FIX' },
    sink_path: `src/routes/secret-${n}.ts`,
    sink_content_hash: 'hash-1',
    first_scan_id: 'scan_x',
    last_seen_scan_id: 'scan_x',
    first_deployment_id: 'dpl_first',
    ...overrides,
  });
  return id;
}

async function addScan(
  projectId: string,
  deploymentId: string,
  overrides: Partial<typeof securityScans.$inferInsert> = {},
) {
  const id = overrides.id ?? `scan_${projectId}_${deploymentId}`;
  await env.db.insert(securityScans).values({
    status: 'succeeded',
    trigger: 'deploy',
    model_used: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    engine: 'void_loop',
    tier: 'built_diff',
    coverage: 'complete',
    files_scanned: 12,
    metered_nano_usd: 2_500_000_000,
    finished_at: new Date().toISOString(),
    ...overrides,
    id,
    project_id: projectId,
    deployment_id: deploymentId,
  });
  return id;
}

describe('GET /projects/:id/security: who sees what', () => {
  it('gives every role the status and filters titles, files and dollars by role', async () => {
    await savePolicy();
    const { project, people, outsider } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    await addScan(project.id, deployment.id);
    await addFinding(project.id, { number: 1, severity: 'critical' });
    await addFinding(project.id, { number: 2, severity: 'high' });
    await addFinding(project.id, { number: 3, severity: 'medium' });
    await addFinding(project.id, { number: 4, verdict: 'needs_validation', severity: null });
    await env.db.insert(securityProjectSpend).values({
      project_id: project.id,
      month: `${new Date().toISOString().slice(0, 7)}-01`,
      spent_nano_usd: 4_000_000_000,
    });

    for (const role of ROLES) {
      const response = await call(`/projects/${project.id}/security`, people[role].jwt);
      expect(response.status, role).toBe(200);
      const body = await json(response);
      const text = JSON.stringify(body);
      expect(body.policy).toMatchObject({ mode: 'all', applies: true, publicGate: false });
      expect(body.urgent).toMatchObject({
        count: 2,
        counts: { critical: 1, high: 1 },
        more: 0,
      });
      expect(body.counts).toMatchObject({ urgent: 2, leads: 1, open: { medium: 1 } });
      expect(body.urgent.findings.map((row: { id: string }) => row.id)).toEqual(['F-1', 'F-2']);
      expect(body.lastSuccessfulScan).toMatchObject({ status: 'succeeded', filesScanned: 12 });
      expect(body.publicRequest).toBeNull();
      if (role === 'reader') {
        expect(body.urgent.detail).toBe('counts');
        expect(body.budget).toBeNull();
        expect(body.urgent.findings[0]).toEqual({ id: 'F-1', severity: 'critical' });
        expect(text).not.toContain('SECRET TITLE');
        expect(text).not.toContain('secret-1.ts');
        expect(text).not.toContain('spentUsd');
        expect(body.lastSuccessfulScan.meteredUsd).toBeNull();
      } else {
        expect(body.urgent.detail).toBe('full');
        expect(body.urgent.findings[0]).toMatchObject({
          id: 'F-1',
          severity: 'critical',
          title: 'SECRET TITLE 1',
          file: 'src/routes/secret-1.ts',
          line: 41,
          deploymentId: 'dpl_first',
        });
        expect(body.budget).toMatchObject({ spentUsd: 4, capUsd: null, capSource: 'none' });
        expect(body.lastSuccessfulScan.meteredUsd).toBe(2.5);
      }
    }

    // A person with no role on the project: 403 that names what is needed, never a role.
    const denied = await call(`/projects/${project.id}/security`, outsider.jwt);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await json(denied))).not.toMatch(/reader|collaborator/);
    expect((await call('/projects/proj_missing/security', outsider.jwt)).status).toBe(404);
  });

  it('shows counts and F-ids only to a CI deploy token', async () => {
    await savePolicy();
    const { owner, project } = await setup();
    await addFinding(project.id, { number: 7, severity: 'critical' });
    const build = await createTestBuild(env.db, {
      projectId: project.id,
      userId: owner.id,
      executor: 'github_actions',
      status: 'building',
    });
    const token = await signDeployToken(
      { projectId: project.id, userId: owner.id, login: owner.login, buildId: build.id },
      env.JWT_SECRET,
    );
    const response = await call(`/projects/${project.id}/security`, token);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.urgent.detail).toBe('counts');
    expect(body.urgent.findings).toEqual([{ id: 'F-7', severity: 'critical' }]);
    expect(body.budget).toBeNull();
    expect(JSON.stringify(body)).not.toContain('SECRET TITLE');
    // The token reaches the notice read and nothing else under /security.
    expect((await call(`/projects/${project.id}/security/findings`, token)).status).toBe(403);
    expect((await call(`/projects/${project.id}/security/scans`, token)).status).toBe(403);
  });

  it('reads while the capability is off and says why scans do not apply', async () => {
    await savePolicy({ mode: 'disabled' });
    const { project, people } = await setup();
    await addFinding(project.id, { number: 1 });
    const response = await call(`/projects/${project.id}/security`, people.reader.jwt, {
      bindings: env,
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.policy).toMatchObject({
      mode: 'disabled',
      applies: false,
      reason: 'Security audits are off on this platform.',
    });
    expect(body.urgent.count).toBe(1);
  });

  it('counts deploys since the last successful scan and keeps only 5 urgent rows', async () => {
    await savePolicy();
    const { project, people } = await setup();
    const first = await createTestDeployment(env.db, project.id);
    await addScan(project.id, first.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await createTestDeployment(env.db, project.id);
    await createTestDeployment(env.db, project.id);
    for (let n = 1; n <= 7; n++) {
      await addFinding(project.id, { number: n, severity: n === 6 ? 'critical' : 'high' });
    }
    const body = await json(await call(`/projects/${project.id}/security`, people.admin.jwt));
    expect(body.deploysSinceLastSuccess).toBe(2);
    expect(body.urgent.count).toBe(7);
    expect(body.urgent.findings).toHaveLength(5);
    expect(body.urgent.findings[0].id).toBe('F-6');
    expect(body.urgent.more).toBe(2);
    await env.db.delete(deployments).where(eq(deployments.project_id, project.id));
  });

  it('explains the policy reason for a protected project in public mode', async () => {
    await savePolicy({ mode: 'public' });
    const { project, people } = await setup();
    const body = await json(await call(`/projects/${project.id}/security`, people.admin.jwt));
    expect(body.policy).toMatchObject({ applies: true, reason: 'not protected by Zero Trust' });
  });
});

describe('findings: list, show, scoping', () => {
  it('filters by role, pages with a cursor, and 404s a finding of another project', async () => {
    await savePolicy();
    const a = await setup('proj-a');
    const b = await setup('proj-b');
    for (let n = 1; n <= 3; n++) {
      await addFinding(a.project.id, { number: n });
    }
    await addFinding(a.project.id, {
      number: 4,
      state: 'resolved',
      resolution: 'false_positive',
      resolved_at: new Date().toISOString(),
      severity: 'medium',
    });
    const foreign = await addFinding(b.project.id, { number: 9 });

    // Readers: open rows carry no title or file; the resolved row keeps its title.
    const reader = await json(
      await call(`/projects/${a.project.id}/security/findings?state=all`, a.people.reader.jwt),
    );
    expect(reader.findings).toHaveLength(4);
    expect(JSON.stringify(reader.findings.slice(0, 3))).not.toMatch(/SECRET TITLE|secret-|trace/);
    expect(reader.findings[3]).toMatchObject({
      id: 'F-4',
      title: 'SECRET TITLE 4',
      state: 'resolved',
    });
    expect(JSON.stringify(reader)).not.toContain('secret-4.ts');

    const first = await json(
      await call(`/projects/${a.project.id}/security/findings?limit=2`, a.people.collaborator.jwt),
    );
    expect(first.findings.map((row: { id: string }) => row.id)).toEqual(['F-1', 'F-2']);
    expect(first.findings[0]).toMatchObject({
      title: 'SECRET TITLE 1',
      file: 'src/routes/secret-1.ts',
    });
    const second = await json(
      await call(
        `/projects/${a.project.id}/security/findings?limit=2&cursor=${first.nextCursor}`,
        a.people.collaborator.jwt,
      ),
    );
    expect(second.findings.map((row: { id: string }) => row.id)).toEqual(['F-3']);
    expect(second.nextCursor).toBeNull();
    for (const bad of [
      'limit=0',
      'limit=101',
      'limit=x',
      'cursor=abc',
      'state=nope',
      'severity=x',
    ]) {
      expect(
        (await call(`/projects/${a.project.id}/security/findings?${bad}`, a.people.admin.jwt))
          .status,
        bad,
      ).toBe(400);
    }

    // Show: by F-number, number and id; a reader gets no detail; another project's id is 404.
    const shown = await json(
      await call(`/projects/${a.project.id}/security/findings/F-2`, a.people.collaborator.jwt),
    );
    expect(shown.finding).toMatchObject({
      id: 'F-2',
      fix: 'FIX',
      evidence: 'EVIDENCE',
      revision: 1,
    });
    expect(shown.events).toEqual([]);
    const byNumber = await call(
      `/projects/${a.project.id}/security/findings/2`,
      a.people.admin.jwt,
    );
    expect((await json(byNumber)).finding.id).toBe('F-2');
    const readerShow = await json(
      await call(`/projects/${a.project.id}/security/findings/F-2`, a.people.reader.jwt),
    );
    expect(readerShow.events).toBeUndefined();
    expect(JSON.stringify(readerShow)).not.toMatch(/SECRET TITLE|FIX|EVIDENCE|secret-/);
    expect(
      (await call(`/projects/${a.project.id}/security/findings/${foreign}`, a.people.admin.jwt))
        .status,
    ).toBe(404);
    // F-9 exists only in project B.
    expect(
      (await call(`/projects/${a.project.id}/security/findings/F-9`, a.people.admin.jwt)).status,
    ).toBe(404);
    expect(
      (await call(`/projects/${a.project.id}/security/findings/F-1`, b.people.admin.jwt)).status,
    ).toBe(403);
  });
});

describe('comment, resolve, reopen', () => {
  it('needs configure to comment and settings to resolve or reopen', async () => {
    await savePolicy();
    const { project, people } = await setup();
    await addFinding(project.id, { number: 1 });
    const base = `/projects/${project.id}/security/findings/F-1`;

    const readerComment = await call(`${base}/comments`, people.reader.jwt, {
      method: 'POST',
      body: { text: 'nope' },
    });
    expect(readerComment.status).toBe(403);
    expect((await json(readerComment)).message).toContain(
      'requires the collaborator, admin, or owner',
    );
    expect(
      (
        await call(`${base}/comments`, people.collaborator.jwt, {
          method: 'POST',
          body: { text: '   ' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(`${base}/comments`, people.collaborator.jwt, {
          method: 'POST',
          body: { text: 'x'.repeat(4001) },
        })
      ).status,
    ).toBe(400);
    for (const role of ['collaborator', 'admin', 'owner'] as const) {
      const response = await call(`${base}/comments`, people[role].jwt, {
        method: 'POST',
        body: { text: `note from ${role}` },
      });
      expect(response.status, role).toBe(201);
    }
    const [finding] = await env.db.select().from(securityFindings);
    expect(finding!.revision).toBe(1);
    const events = await env.db.select().from(securityFindingEvents);
    expect(events.map((event) => [event.action, event.actor_role]).sort()).toEqual([
      ['commented', 'admin'],
      ['commented', 'collaborator'],
      ['commented', 'owner'],
    ]);

    const resolveBody = {
      reason: 'false_positive',
      comment: 'sanitized upstream',
      expectedRevision: 1,
    };
    for (const role of ['reader', 'collaborator'] as const) {
      const denied = await call(`${base}/resolve`, people[role].jwt, {
        method: 'POST',
        body: resolveBody,
      });
      expect(denied.status, role).toBe(403);
      expect((await json(denied)).message).toContain('requires the admin or owner role');
    }
    expect(
      (await call(`${base}/reopen`, people.collaborator.jwt, { method: 'POST', body: resolveBody }))
        .status,
    ).toBe(403);
    const [untouched] = await env.db.select().from(securityFindings);
    expect(untouched).toMatchObject({ state: 'open', revision: 1 });
  });

  it('resolves, shows the history, reopens, and refuses a stale revision', async () => {
    await savePolicy();
    const { project, people } = await setup();
    await addFinding(project.id, { number: 1, fix_checked_scan_id: 'scan_old' });
    const base = `/projects/${project.id}/security/findings/F-1`;

    for (const body of [
      { reason: 'fixed', comment: 'ok' },
      { reason: 'nope', comment: 'ok', expectedRevision: 1 },
      { reason: 'fixed', comment: '', expectedRevision: 1 },
      { reason: 'fixed', comment: 'ok', expectedRevision: 'one' },
    ]) {
      expect(
        (await call(`${base}/resolve`, people.admin.jwt, { method: 'POST', body })).status,
      ).toBe(400);
    }

    const resolved = await call(`${base}/resolve`, people.admin.jwt, {
      method: 'POST',
      body: { reason: 'fixed', comment: 'patched in dpl_9', expectedRevision: 1 },
    });
    expect(resolved.status).toBe(200);
    expect(await json(resolved)).toMatchObject({ id: 'F-1', state: 'resolved', revision: 2 });
    const [row] = await env.db.select().from(securityFindings);
    expect(row).toMatchObject({
      state: 'resolved',
      resolution: 'fixed',
      resolved_sink_hash: 'hash-1',
      resolved_severity: 'high',
      fix_checked_scan_id: null,
      revision: 2,
    });
    expect(row!.resolved_by_user_id).toBe(people.admin.id);

    // A second admin who read revision 1 loses.
    const stale = await call(`${base}/resolve`, people.owner.jwt, {
      method: 'POST',
      body: { reason: 'false_positive', comment: 'me too', expectedRevision: 1 },
    });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({
      error: 'finding changed',
      state: 'resolved',
      resolution: 'fixed',
      byRole: 'admin',
      revision: 2,
    });
    // Even with the new revision, a resolved finding cannot be resolved again.
    expect(
      (
        await call(`${base}/resolve`, people.owner.jwt, {
          method: 'POST',
          body: { reason: 'fixed', comment: 'again', expectedRevision: 2 },
        })
      ).status,
    ).toBe(409);

    const shown = await json(await call(base, people.collaborator.jwt));
    expect(shown.finding).toMatchObject({
      state: 'resolved',
      resolution: 'fixed',
      fixChecked: false,
    });
    expect(shown.finding.resolvedBy).toBe(people.admin.login);
    expect(shown.events).toMatchObject([
      { action: 'resolved', resolution: 'fixed', comment: 'patched in dpl_9', actorRole: 'admin' },
    ]);

    const reopened = await call(`${base}/reopen`, people.admin.jwt, {
      method: 'POST',
      body: { comment: 'still broken', expectedRevision: 2 },
    });
    expect(reopened.status).toBe(200);
    expect(await json(reopened)).toMatchObject({ state: 'open', revision: 3 });
    const [after] = await env.db.select().from(securityFindings);
    expect(after).toMatchObject({ state: 'open', resolution: null, reopen_count: 1, revision: 3 });
    expect(
      (
        await call(`${base}/reopen`, people.admin.jwt, {
          method: 'POST',
          body: { comment: 'twice', expectedRevision: 3 },
        })
      ).status,
    ).toBe(409);
    const actions = await env.db.select().from(securityFindingEvents);
    expect(actions.map((event) => event.action).sort()).toEqual(['reopened', 'resolved']);
    // A human reopen of an urgent finding queues one "reopened" email, once per reopen.
    expect(
      (await env.db.select().from(securityNotifications)).map((notice) => [
        notice.kind,
        notice.project_id,
        notice.dedupe_key,
      ]),
    ).toEqual([['reopen', project.id, `reopen:sf_test${project.id}1:1`]]);
  });

  it('stays open while the capability is off, and re-checks the role inside the transaction', async () => {
    await savePolicy({ mode: 'disabled' });
    const { project, people } = await setup();
    await addFinding(project.id, { number: 1 });
    await addFinding(project.id, { number: 2 });
    const off = await call(
      `/projects/${project.id}/security/findings/F-1/resolve`,
      people.admin.jwt,
      {
        method: 'POST',
        body: { reason: 'accepted_risk', comment: 'legacy', expectedRevision: 1 },
        bindings: env,
      },
    );
    expect(off.status).toBe(200);

    // Edge #22: the caller passed the route check, then lost the role before the lock.
    await env.db
      .update(projectMembers)
      .set({ role: 'collaborator' })
      .where(
        and(eq(projectMembers.project_id, project.id), eq(projectMembers.user_id, people.admin.id)),
      );
    await expect(
      resolveSecurityFinding(env.db, {
        projectId: project.id,
        ref: 'F-2',
        userId: people.admin.id,
        resolution: 'fixed',
        comment: 'late',
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    const [second] = await env.db
      .select()
      .from(securityFindings)
      .where(eq(securityFindings.number, 2));
    expect(second).toMatchObject({ state: 'open', revision: 1 });
  });
});

describe('scans', () => {
  it('needs deploy, pages, and shows spend only through this level', async () => {
    await savePolicy();
    const { project, people } = await setup();
    const d1 = await createTestDeployment(env.db, project.id);
    const d2 = await createTestDeployment(env.db, project.id);
    await addScan(project.id, d1.id, { created_at: '2026-01-01T00:00:00.000Z' });
    await addScan(project.id, d2.id, {
      created_at: '2026-01-02T00:00:00.000Z',
      status: 'failed',
      status_reason: 'timed_out',
      failure_cause: 'project',
    });
    const path = `/projects/${project.id}/security/scans`;
    const denied = await call(path, people.reader.jwt);
    expect(denied.status).toBe(403);
    expect((await json(denied)).message).toContain('Deploying requires');
    const off = await call(path, people.admin.jwt, { bindings: env });
    expect(off.status).toBe(501);
    const first = await json(await call(`${path}?limit=1`, people.collaborator.jwt));
    expect(first.scans).toMatchObject([{ status: 'failed', failureCause: 'project' }]);
    expect(first.scans[0].coverageLabel).toBe('built-output diff · 12 files');
    const second = await json(
      await call(`${path}?limit=1&cursor=${first.nextCursor}`, people.collaborator.jwt),
    );
    expect(second.scans).toMatchObject([{ status: 'succeeded', meteredUsd: 2.5 }]);
    expect(second.nextCursor).toBeNull();
    expect((await call(`${path}?cursor=garbage`, people.admin.jwt)).status).toBe(400);
  });
});

describe('model', () => {
  const FOREIGN = 'openai/gpt-6.1-terra';
  const notice = {
    version: 1,
    acceptedAt: new Date().toISOString(),
    acceptedByUserId: 'user_admin',
  };
  const entitled = {
    checkedAt: new Date().toISOString(),
    ok: true,
    missing: [],
    hosts: { openai: true, anthropic: false },
  };

  it('needs settings, and answers 501 while the capability is off', async () => {
    await savePolicy();
    const { project, people } = await setup();
    const path = `/projects/${project.id}/security/model`;
    for (const role of ['reader', 'collaborator'] as const) {
      const denied = await call(path, people[role].jwt, {
        method: 'PUT',
        body: { model: '@cf/zai-org/glm-5.3' },
      });
      expect(denied.status, role).toBe(403);
    }
    const off = await call(path, people.admin.jwt, {
      method: 'PUT',
      body: { model: '@cf/zai-org/glm-5.3' },
      bindings: env,
    });
    expect(off.status).toBe(501);
    expect(await json(off)).toMatchObject({
      error: 'platform capability unavailable',
      capability: 'securityAudits',
    });
    expect(await env.db.select().from(projectSecuritySettings)).toEqual([]);
  });

  it('picks, clears, and refuses unknown, blocked and unnoticed models', async () => {
    await savePolicy({
      blockedModels: ['openai/gpt-6.1-sol'],
      entitlement: entitled,
      thirdPartyNotice: notice,
    });
    const { project, people } = await setup();
    const path = `/projects/${project.id}/security/model`;
    const put = (body: unknown) => call(path, people.admin.jwt, { method: 'PUT', body });

    const picked = await put({ model: '@cf/zai-org/glm-5.3' });
    expect(picked.status).toBe(200);
    expect((await json(picked)).model).toMatchObject({
      id: '@cf/zai-org/glm-5.3',
      source: 'project',
      thirdParty: false,
    });

    const unknown = await put({ model: 'gpt-9' });
    expect(unknown.status).toBe(422);
    expect((await json(unknown)).error).toBe('security model not allowed');
    expect((await json(await put({ model: 'openai/gpt-6.1-sol' }))).error).toBe(
      'security model not allowed',
    );
    expect((await json(await put({ model: 'anthropic/claude-sonnet-5.5' }))).error).toBe(
      'security model not allowed',
    );
    // No credits for Anthropic on this platform.
    expect((await json(await put({ model: 'anthropic/claude-opus-5.5' }))).error).toBe(
      'security model not allowed',
    );
    expect((await put({})).status).toBe(400);
    expect((await put({ model: 5 })).status).toBe(400);

    const needsNotice = await put({ model: FOREIGN });
    expect(needsNotice.status).toBe(422);
    const refusal = await json(needsNotice);
    expect(refusal).toMatchObject({ error: 'provider notice not accepted', version: 1 });
    expect(refusal.notice[0]).toContain('run by OpenAI');
    expect((await json(await put({ model: FOREIGN, acceptProviderNoticeVersion: 7 }))).error).toBe(
      'provider notice not accepted',
    );
    const [unchanged] = await env.db.select().from(projectSecuritySettings);
    expect(unchanged).toMatchObject({
      model: '@cf/zai-org/glm-5.3',
      provider_notice_version: null,
    });

    const accepted = await put({ model: FOREIGN, acceptProviderNoticeVersion: 1 });
    expect(accepted.status).toBe(200);
    expect((await json(accepted)).model).toMatchObject({
      id: FOREIGN,
      thirdParty: true,
      noticeAccepted: true,
    });
    const [row] = await env.db.select().from(projectSecuritySettings);
    expect(row).toMatchObject({
      model: FOREIGN,
      provider_notice_version: 1,
      provider_notice_by_user_id: people.admin.id,
    });
    // Accepted once: a later pick of a third-party model needs no new accept.
    expect((await put({ model: FOREIGN })).status).toBe(200);

    const cleared = await put({ model: null });
    expect(cleared.status).toBe(200);
    expect((await json(cleared)).model).toMatchObject({
      source: 'default',
      requested: expect.any(String),
    });
    const [after] = await env.db.select().from(projectSecuritySettings);
    expect(after!.model).toBeNull();
  });

  it('keeps a project on Cloudflare until it accepts a third-party default', async () => {
    await savePolicy({
      defaultModel: FOREIGN,
      entitlement: entitled,
      thirdPartyNotice: notice,
    });
    const { project, people } = await setup();
    const status = await json(await call(`/projects/${project.id}/security`, people.admin.jwt));
    expect(status.model).toMatchObject({
      id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      source: 'fallback',
      pendingDefault: FOREIGN,
    });
    const accept = await call(`/projects/${project.id}/security/model`, people.admin.jwt, {
      method: 'PUT',
      body: { model: null, acceptProviderNoticeVersion: 1 },
    });
    expect(accept.status).toBe(200);
    expect((await json(accept)).model).toMatchObject({
      id: FOREIGN,
      source: 'default',
      pendingDefault: null,
    });
  });
});

describe('budget', () => {
  it('needs settings, honors the ceiling, records the change, and clears', async () => {
    await savePolicy({
      budgets: {
        ...defaultSecurityPolicy().budgets,
        projectCapsOn: true,
        projectDefaultMonthlyUsd: 100,
      },
    });
    const { project, people } = await setup('acme-web');
    const path = `/projects/${project.id}/security/budget`;
    const put = (body: unknown, role: Role = 'admin', bindings?: TestEnv) =>
      call(path, people[role].jwt, { method: 'PUT', body, bindings });

    for (const role of ['reader', 'collaborator'] as const) {
      expect((await put({ monthlyUsd: 10 }, role)).status, role).toBe(403);
    }
    expect((await put({ monthlyUsd: 10 }, 'admin', env)).status).toBe(501);

    const above = await put({ monthlyUsd: 150 });
    expect(above.status).toBe(422);
    const refusal = await json(above);
    expect(refusal).toMatchObject({
      error: 'security budget above platform limit',
      ceilingUsd: 100,
    });
    expect(refusal.message).toContain('void platform security budget --project acme-web --usd 150');
    for (const bad of [{}, { monthlyUsd: -1 }, { monthlyUsd: 'ten' }, { monthlyUsd: 1.234 }]) {
      expect((await put(bad)).status).toBe(400);
    }

    const set = await put({ monthlyUsd: 40 });
    expect(set.status).toBe(200);
    expect((await json(set)).budget).toMatchObject({
      capUsd: 40,
      capSource: 'own',
      ceilingUsd: 100,
      spentUsd: 0,
    });
    // The same value again writes no second event.
    expect((await put({ monthlyUsd: 40 })).status).toBe(200);
    const zero = await put({ monthlyUsd: 0 });
    expect((await json(zero)).budget).toMatchObject({ capUsd: 0, capSource: 'own' });
    const cleared = await json(await put({ monthlyUsd: null }));
    expect(cleared.budget).toMatchObject({ capUsd: 100, capSource: 'limit', ceilingUsd: 100 });

    const events = await env.db
      .select()
      .from(securityProjectEvents)
      .orderBy(securityProjectEvents.created_at);
    expect(
      events.map((event) => [event.action, event.cap_kind, event.old_cents, event.new_cents]),
    ).toEqual([
      ['cap_changed', 'own', null, 4000],
      ['cap_changed', 'own', 4000, 0],
      ['cap_changed', 'own', 0, null],
    ]);
    expect(events[0]).toMatchObject({ actor_kind: 'user', actor_role: 'admin' });
  });

  it('lets a project admin set any amount when no limit applies', async () => {
    await savePolicy();
    const { project, people } = await setup();
    const response = await call(`/projects/${project.id}/security/budget`, people.owner.jwt, {
      method: 'PUT',
      body: { monthlyUsd: 5000 },
    });
    expect(response.status).toBe(200);
    expect((await json(response)).budget).toMatchObject({ capUsd: 5000, ceilingUsd: null });
  });
});

describe('page link', () => {
  it('gives every role a 15 minute link bound to the user and the project', async () => {
    await savePolicy();
    const { project, people } = await setup('acme-web');
    for (const role of ROLES) {
      const response = await call(`/projects/${project.id}/security/page-link`, people[role].jwt, {
        method: 'POST',
      });
      expect(response.status, role).toBe(200);
      const body = await json(response);
      const url = new URL(body.url);
      expect(url.pathname).toBe('/security/projects/acme-web');
      const payload = await verifySecurityPageToken(url.searchParams.get('t')!, env.JWT_SECRET);
      expect(payload).toMatchObject({ uid: people[role].id, pid: project.id });
      expect(payload!.exp - payload!.iat).toBe(15 * 60);
      expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
      // Never valid later, for another secret, or when cut.
      expect(
        await verifySecurityPageToken(
          url.searchParams.get('t')!,
          env.JWT_SECRET,
          Date.now() + 16 * 60_000,
        ),
      ).toBeNull();
      expect(await verifySecurityPageToken(url.searchParams.get('t')!, 'other')).toBeNull();
      expect(
        await verifySecurityPageToken(url.searchParams.get('t')!.slice(0, -2), env.JWT_SECRET),
      ).toBeNull();
    }
    const outsider = await createTestUser(env.db, 'outsider-link');
    expect(
      (await call(`/projects/${project.id}/security/page-link`, outsider.jwt, { method: 'POST' }))
        .status,
    ).toBe(403);
  });
});

// PRD §3, every project API row: who may call which route (200/201 = allowed, 403 = denied).
describe('role matrix', () => {
  type Row = Readonly<{
    name: string;
    allowed: ReadonlyArray<Role>;
    request: (projectId: string) => Readonly<{ path: string; method: string; body?: unknown }>;
  }>;
  const finding = (id: string, rest = '') => `/projects/${id}/security/findings/F-1${rest}`;
  const rows: ReadonlyArray<Row> = [
    {
      name: 'status',
      allowed: ['owner', 'admin', 'collaborator', 'reader'],
      request: (id) => ({ path: `/projects/${id}/security`, method: 'GET' }),
    },
    {
      name: 'finding list',
      allowed: ['owner', 'admin', 'collaborator', 'reader'],
      request: (id) => ({ path: `/projects/${id}/security/findings`, method: 'GET' }),
    },
    {
      name: 'finding show',
      allowed: ['owner', 'admin', 'collaborator', 'reader'],
      request: (id) => ({ path: finding(id), method: 'GET' }),
    },
    {
      name: 'comment',
      allowed: ['owner', 'admin', 'collaborator'],
      request: (id) => ({ path: finding(id, '/comments'), method: 'POST', body: { text: 'hi' } }),
    },
    {
      name: 'resolve',
      allowed: ['owner', 'admin'],
      request: (id) => ({
        path: finding(id, '/resolve'),
        method: 'POST',
        body: { reason: 'accepted_risk', comment: 'ok', expectedRevision: 1 },
      }),
    },
    {
      name: 'reopen',
      allowed: ['owner', 'admin'],
      request: (id) => ({
        path: finding(id, '/reopen'),
        method: 'POST',
        body: { comment: 'again', expectedRevision: 2 },
      }),
    },
    {
      name: 'scan history',
      allowed: ['owner', 'admin', 'collaborator'],
      request: (id) => ({ path: `/projects/${id}/security/scans`, method: 'GET' }),
    },
    {
      name: 'model',
      allowed: ['owner', 'admin'],
      request: (id) => ({
        path: `/projects/${id}/security/model`,
        method: 'PUT',
        body: { model: null },
      }),
    },
    {
      name: 'budget',
      allowed: ['owner', 'admin'],
      request: (id) => ({
        path: `/projects/${id}/security/budget`,
        method: 'PUT',
        body: { monthlyUsd: 20 },
      }),
    },
    {
      name: 'page link',
      allowed: ['owner', 'admin', 'collaborator', 'reader'],
      request: (id) => ({ path: `/projects/${id}/security/page-link`, method: 'POST' }),
    },
  ];

  it.each(rows.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    await savePolicy();
    const { project, people, outsider } = await setup();
    const deployment = await createTestDeployment(env.db, project.id);
    await addScan(project.id, deployment.id);
    await addFinding(project.id, { number: 1 });
    for (const role of ROLES) {
      // The reopen row needs a resolved finding at revision 2.
      await env.db
        .update(securityFindings)
        .set(
          row.name === 'reopen'
            ? {
                state: 'resolved',
                resolution: 'fixed',
                resolved_at: new Date().toISOString(),
                revision: 2,
              }
            : { state: 'open', resolution: null, resolved_at: null, revision: 1 },
        )
        .where(eq(securityFindings.project_id, project.id));
      const request = row.request(project.id);
      const response = await call(request.path, people[role].jwt, request);
      const allowed = row.allowed.includes(role);
      expect(allowed ? response.status < 300 : response.status, `${row.name} as ${role}`).toBe(
        allowed ? true : 403,
      );
    }
    const request = row.request(project.id);
    expect((await call(request.path, outsider.jwt, request)).status, 'outsider').toBe(403);
    const missing = row.request('proj_missing');
    expect((await call(missing.path, outsider.jwt, missing)).status, 'missing project').toBe(404);
  });
});
