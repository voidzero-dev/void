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
  projectZeroTrust,
  securityFindingEvents,
  securityFindings,
  securityPublicRequests,
  securityScanBypasses,
} from '../../src/schema.ts';
import { cancelSecurityScanRows } from '../../src/security/queue.ts';
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

describe('operator security routes', () => {
  it('writes the budget by revision after a preview; writes answer 501 with the capability off', async () => {
    await saveSecurityPolicy(env, { revision: 4 });
    const body = { expectedRevision: 4, platformMonthlyUsd: 250 };
    const preview = await call('/security/budget', { body: { ...body, dryRun: true } });
    expect(preview.body).toMatchObject({ dryRun: true, to: { platformMonthlyUsd: 250 } });
    expect((await call('/security/budget')).body.platform.capOn).toBe(false);
    expect(
      (await call('/security/budget', { body: { ...body, expectedRevision: 3 } })).status,
    ).toBe(409);
    const written = await call('/security/budget', { body });
    expect(written.body).toMatchObject({ ok: true, revision: 5 });
    expect((await call('/security/budget', { body, bindings: env })).status).toBe(501);
  });

  it('resolves and reopens a finding as the installation admin, with a preview first', async () => {
    await saveSecurityPolicy(env);
    const { project } = await liveProject(env);
    await insertSecurityFinding(env, project.id, { number: 1 });
    const base = `/projects/${project.id}/security/findings/F-1`;
    const resolve = { reason: 'accepted_risk', comment: 'internal tool', expectedRevision: 1 };
    const preview = await call(`${base}/resolve`, { body: { ...resolve, dryRun: true } });
    expect(preview.body).toMatchObject({ dryRun: true, action: 'security.finding-resolve' });
    expect(await env.db.select().from(securityFindingEvents)).toHaveLength(0);

    const resolved = await call(`${base}/resolve`, { body: resolve });
    expect(resolved.body).toMatchObject({ state: 'resolved', revision: 2 });
    const reopened = await call(`${base}/reopen`, {
      body: { comment: 'owner changed their mind', expectedRevision: 2 },
    });
    expect(reopened.body).toMatchObject({ state: 'open', revision: 3 });
    const events = await env.db.select().from(securityFindingEvents);
    expect(events.map((event) => [event.action, event.actor_kind])).toEqual(
      expect.arrayContaining([
        ['resolved', 'installation_admin'],
        ['reopened', 'installation_admin'],
      ]),
    );
    expect(events.every((event) => event.actor_user_id === adminId)).toBe(true);
  });

  it('bypasses an open request with a reason, never while an urgent finding blocks it (I6)', async () => {
    const s = await setupGate(env);
    await askPublic(s);
    const path = `/projects/${s.project.id}/security/public-request/bypass`;

    // Held by an urgent finding: refused, nothing recorded.
    await insertSecurityScan(env, s.project.id, s.deployment.id);
    await insertSecurityFinding(env, s.project.id, { number: 7 });
    await env.db
      .update(securityPublicRequests)
      .set({ state: 'held_findings', blockers: 1, blocker_ids: ['F-7'] })
      .where(eq(securityPublicRequests.project_id, s.project.id));
    const refused = await call(path, { body: { reason: 'ship it' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('security public request has urgent findings');
    expect(await env.db.select().from(securityScanBypasses)).toHaveLength(0);

    // The finding closed: the bypass goes through and is recorded.
    await env.db
      .update(securityPublicRequests)
      .set({ state: 'needs_deploy', blockers: 0, blocker_ids: [] })
      .where(eq(securityPublicRequests.project_id, s.project.id));
    await env.db.delete(securityFindings);
    const done = await call(path, { body: { reason: 'launch day' } });
    expect(done.body).toMatchObject({ ok: true, publicRequest: { state: 'bypassed' } });
    const [row] = await env.db
      .select()
      .from(projectZeroTrust)
      .where(eq(projectZeroTrust.project_id, s.project.id));
    expect(row?.desired_protected).toBe(false);
    expect(await env.db.select().from(securityScanBypasses)).toMatchObject([
      { actor_kind: 'installation_admin', reason: 'launch day' },
    ]);
  });
});
