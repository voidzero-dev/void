import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vite-plus/test';
import { getPlatformCapabilities } from '../../src/capabilities.ts';
import { app } from '../../src/index.ts';
import { operatorEvents, projects } from '../../src/schema.ts';
import {
  clearTables,
  createOperatorToken,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

let env: TestEnv;
let token: string;
let adminToken: string;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  const user = await createTestUser(env.db, 'audit-admin', 'github', undefined, 'free', 'admin');
  token = await createOperatorToken(env.db, user);
  adminToken = user.adminJwt;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function request(path: string, body?: unknown, bindings: TestEnv = env) {
  return app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    bindings,
  );
}

function adminRequest(path: string, body = new URLSearchParams()) {
  return app.fetch(
    new Request(`http://localhost/admin${path}`, {
      method: 'POST',
      headers: {
        Cookie: `admin_token=${adminToken}`,
        Origin: 'http://localhost',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'manual',
    }),
    env,
  );
}

function cloudflareWorkerStub(failScript?: string) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const script = /\/scripts\/([^/]+)/.exec(url)?.[1];
    if (init?.method === 'POST') {
      if (script === failScript) {
        return Response.json(
          { success: false, errors: [{ message: 'Permission denied' }] },
          { status: 403 },
        );
      }
      return Response.json({
        success: true,
        result: { id: 'new-deployment', versions: JSON.parse(String(init.body)).versions },
      });
    }
    if (url.endsWith('/versions')) {
      return Response.json({
        success: true,
        result: { items: [{ id: 'previous' }, { id: 'current' }] },
      });
    }
    if (url.endsWith('/deployments')) {
      return Response.json({
        success: true,
        result: {
          deployments: [
            { id: 'current-deploy', versions: [{ version_id: 'current', percentage: 100 }] },
            { id: 'previous-deploy', versions: [{ version_id: 'previous', percentage: 100 }] },
          ],
        },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
}

test('previews and reads produce no audit or configuration writes', async () => {
  await env.ROUTING.put('signup:enabled', 'false');
  const res = await request('/signup/restrict', { dryRun: true });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ dryRun: true, action: 'signup.restrict' });
  expect(await env.ROUTING.get('signup:enabled')).toBe('false');
  expect((await request('/signup')).status).toBe(200);
  expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
});

test('previews Zero Trust configuration without returning or auditing the API token', async () => {
  const secret = 'access-management-secret';
  const res = await request('/zero-trust/configure', {
    dryRun: true,
    apiToken: secret,
    identityProviderIds: ['idp-1'],
    policyIds: ['policy-1'],
    protectNewProjects: true,
    existingProjects: 'public',
  });

  expect(res.status).toBe(200);
  const body = await res.text();
  expect(JSON.parse(body)).toMatchObject({
    dryRun: true,
    action: 'zero-trust.configure',
    target: 'platform',
    accountId: env.CF_ACCOUNT_ID,
    credential: 'replace-encrypted',
    protectNewProjects: true,
    existingProjects: 'public',
  });
  expect(body).not.toContain(secret);
  expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
});

test('validates operator project Zero Trust targets', async () => {
  expect((await request('/zero-trust/projects/missing')).status).toBe(404);
  expect(
    (await request('/zero-trust/projects/missing', { protected: true, dryRun: true })).status,
  ).toBe(404);

  const owner = await createTestUser(env.db, 'zero-trust-target-owner');
  const project = await createTestProject(env.db, owner.id, 'zero-trust-target');
  await env.db.update(projects).set({ status: 'deleting' }).where(eq(projects.id, project.id));

  const status = await request(`/zero-trust/projects/${project.id}`);
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ project: null });
  expect(
    (
      await request(`/zero-trust/projects/${project.id}`, {
        protected: true,
        dryRun: true,
      })
    ).status,
  ).toBe(409);
});

test('records actor, target, and success without recording credentials', async () => {
  const res = await request('/signup/restrict', { credential: 'must-not-be-audited' });
  expect(res.status).toBe(200);
  expect(res.headers.get('X-Void-Audit-Id')).toBeTruthy();
  const events = await env.db.select().from(operatorEvents);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    login: 'audit-admin',
    action: 'signup/restrict',
    target: JSON.stringify({ restrictionsEnabled: true }),
    status: 'success',
    http_status: 200,
  });
  expect(JSON.stringify(events)).not.toContain(token);
  expect(JSON.stringify(events)).not.toContain('must-not-be-audited');
  const page = await request('/system/events?limit=1');
  expect(await page.json()).toMatchObject({ total: 1, limit: 1, page: 1 });
});

test('records failed validation as a failed mutation attempt', async () => {
  const res = await request('/signup/allow', { type: 'invalid', pattern: 'anything' });
  expect(res.status).toBe(400);
  const events = await env.db.select().from(operatorEvents);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    target: JSON.stringify({ type: 'invalid', pattern: 'anything' }),
    status: 'failed',
    http_status: 400,
  });
});

test('records complete and partial 207 mutation outcomes as failed', async () => {
  cloudflareWorkerStub('void-api');
  const failed = await request('/workers/api/rollback', {
    environment: 'production',
    versionId: 'previous',
  });
  expect(failed.status).toBe(207);
  expect(await failed.json()).toMatchObject({ ok: false, partial: false });

  vi.restoreAllMocks();
  cloudflareWorkerStub('void-api-staging');
  const partial = await request('/workers/rollback-all', {
    environment: 'staging',
    versions: {
      dispatch: 'previous',
      'email-gateway': 'previous',
      dashboard: 'previous',
      api: 'previous',
      tail: 'previous',
      proxy: 'previous',
    },
  });
  expect(partial.status).toBe(207);
  expect(await partial.json()).toMatchObject({ ok: false, partial: true });

  const events = await env.db.select().from(operatorEvents);
  expect(events).toHaveLength(2);
  expect(
    JSON.parse(events.find((event) => event.action === 'workers/rollback-all')!.target),
  ).toMatchObject({ versions: { 'email-gateway': 'previous' } });
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: 'workers/api/rollback',
        status: 'failed',
        http_status: 207,
      }),
      expect.objectContaining({
        action: 'workers/rollback-all',
        status: 'failed',
        http_status: 207,
      }),
    ]),
  );
});

test('records a successful 200 mutation outcome as successful', async () => {
  cloudflareWorkerStub();
  const response = await request('/workers/api/rollback', {
    environment: 'production',
    versionId: 'previous',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, partial: false });
  expect(await env.db.select().from(operatorEvents)).toEqual([
    expect.objectContaining({
      action: 'workers/api/rollback',
      status: 'success',
      http_status: 200,
    }),
  ]);
});

test('browser mutations record canonical targets and explicit redirect outcomes', async () => {
  const target = await createTestUser(env.db, 'browser-audit-target');
  const response = await adminRequest(
    `/users/${target.id}/plan`,
    new URLSearchParams({ plan: 'pro', credential: 'must-not-be-audited' }),
  );

  expect(response.status).toBe(302);
  expect(response.headers.get('Location')).toBe(`/admin/users/${target.id}`);
  expect(response.headers.get('X-Void-Audit-Id')).toBeTruthy();
  expect(await env.db.select().from(operatorEvents)).toEqual([
    expect.objectContaining({
      login: 'audit-admin',
      action: `users/${target.id}/plan`,
      target: JSON.stringify({ userId: target.id, plan: 'pro' }),
      status: 'success',
      http_status: 302,
    }),
  ]);
  expect(JSON.stringify(await env.db.select().from(operatorEvents))).not.toContain(
    'must-not-be-audited',
  );
});

test('browser backfill records a failed outcome when its 200 response reports errors', async () => {
  await env.ROUTING.put(
    'queue:audit-backfill',
    JSON.stringify({
      workerName: 'user-audit-backfill',
      projectId: 'proj_audit',
      queueName: 'jobs',
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ success: false, errors: [{ message: 'rate limited' }] }, { status: 429 }),
  );

  const response = await adminRequest('/backfill-queue-tokens');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ updated: 0, errored: 1 });
  expect(await env.db.select().from(operatorEvents)).toEqual([
    expect.objectContaining({
      action: 'system/backfill-queue-tokens',
      target: JSON.stringify({ entries: 'queue:*' }),
      status: 'failed',
      http_status: 200,
    }),
  ]);
});

test('records the effective worker environment for implicit and explicit rollbacks', async () => {
  cloudflareWorkerStub();
  const staging = { ...env, PLATFORM_ENV: 'staging' };
  const versions = {
    dispatch: 'previous',
    'email-gateway': 'previous',
    dashboard: 'previous',
    api: 'previous',
    tail: 'previous',
    proxy: 'previous',
  };

  const implicitWorker = await request('/workers/api/rollback', { versionId: 'previous' }, staging);
  expect(await implicitWorker.json()).toMatchObject({ environment: 'staging' });
  const implicitAll = await request('/workers/rollback-all', { versions }, staging);
  expect(await implicitAll.json()).toMatchObject({ environment: 'staging' });
  const explicitWorker = await request(
    '/workers/api/rollback',
    { environment: 'production', versionId: 'previous' },
    staging,
  );
  expect(await explicitWorker.json()).toMatchObject({ environment: 'production' });

  // Read in target order to exercise results returned in a different order from the requests.
  const events = await env.db.select().from(operatorEvents).orderBy(operatorEvents.target);
  expect(
    Object.fromEntries(events.map((event) => [event.id, JSON.parse(event.target).environment])),
  ).toEqual({
    [implicitWorker.headers.get('X-Void-Audit-Id')!]: 'staging',
    [implicitAll.headers.get('X-Void-Audit-Id')!]: 'staging',
    [explicitWorker.headers.get('X-Void-Audit-Id')!]: 'production',
  });
});

test('records sanitized action targets and change arguments', async () => {
  await request('/signup/allow', {
    type: 'email',
    pattern: 'Alice@Example.com',
    note: 'First cohort',
  });
  await request('/signup/allow', { type: 'email', pattern: 'Bob@Example.com' });
  await env.db.delete(operatorEvents);

  expect(
    (await request('/signup/remove', { type: 'email', pattern: 'Alice@Example.com' })).status,
  ).toBe(200);
  expect(
    (await request('/signup/remove', { type: 'email', pattern: 'Bob@Example.com' })).status,
  ).toBe(200);
  expect(
    (
      await request('/invitations/send', {
        emails: ['Invite-One@Example.com', 'invite-two@example.com'],
      })
    ).status,
  ).toBe(200);

  const user = await createTestUser(env.db, 'audit-target-user');
  expect((await request(`/users/${user.id}/plan`, { plan: 'pro' })).status).toBe(200);
  expect(
    (await request(`/users/${user.id}/suspend`, { reason: 'abuse investigation' })).status,
  ).toBe(200);

  const events = await env.db.select().from(operatorEvents);
  const targets = Object.fromEntries(
    events
      .filter((event) => event.action !== 'signup/remove')
      .map((event) => [event.action, JSON.parse(event.target)]),
  );
  expect(targets).toMatchObject({
    'invitations/send': {
      emails: ['invite-one@example.com', 'invite-two@example.com'],
    },
    [`users/${user.id}/plan`]: { userId: user.id, plan: 'pro' },
    [`users/${user.id}/suspend`]: {
      userId: user.id,
      reason: 'abuse investigation',
    },
  });
  expect(
    events
      .filter((event) => event.action === 'signup/remove')
      .map((event) => JSON.parse(event.target) as { type: string; pattern: string })
      .sort((a, b) => a.pattern.localeCompare(b.pattern)),
  ).toEqual([
    { type: 'email', pattern: 'alice@example.com' },
    { type: 'email', pattern: 'bob@example.com' },
  ]);
});

test('records only the project and registered user IDs for ownership transfer', async () => {
  const owner = await createTestUser(env.db, 'audit-transfer-owner');
  const target = await createTestUser(env.db, 'audit-transfer-target');
  const project = await createTestProject(env.db, owner.id, 'audit-transfer-project');

  const response = await request(`/projects/${project.id}/owner`, {
    userId: target.id,
    credential: 'must-not-be-audited',
  });

  expect(response.status).toBe(200);
  expect(await env.db.select().from(operatorEvents)).toEqual([
    expect.objectContaining({
      action: `projects/${project.id}/owner`,
      target: JSON.stringify({ projectId: project.id, userId: target.id }),
      status: 'success',
      http_status: 200,
    }),
  ]);
  expect(JSON.stringify(await env.db.select().from(operatorEvents))).not.toContain(
    'must-not-be-audited',
  );
});

test('records the project scope of a proxy token rotation and nothing for its preview', async () => {
  const owner = await createTestUser(env.db, 'audit-rotation-owner');
  const project = await createTestProject(env.db, owner.id, 'audit-rotation-project');

  expect(
    (await request('/system/rotate-proxy-tokens', { dryRun: true, project: project.id })).status,
  ).toBe(200);
  expect(await env.db.select().from(operatorEvents)).toHaveLength(0);

  expect((await request('/system/rotate-proxy-tokens', { project: project.id })).status).toBe(207);
  expect((await request('/system/rotate-proxy-tokens', { all: true })).status).toBe(207);

  const events = await env.db.select().from(operatorEvents);
  expect(
    events.map((event) => [event.action, JSON.parse(event.target) as unknown, event.status]),
  ).toEqual(
    expect.arrayContaining([
      ['system/rotate-proxy-tokens', { projects: project.id }, 'success'],
      ['system/rotate-proxy-tokens', { projects: 'all' }, 'success'],
    ]),
  );
  expect(events).toHaveLength(2);
});

test('records security policy changes as known ids and new state, nothing for previews', async () => {
  const bindings = {
    ...env,
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
  };
  expect(
    (await request('/security/policy', { dryRun: true, limits: { concurrency: 3 } }, bindings))
      .status,
  ).toBe(200);
  expect(await env.db.select().from(operatorEvents)).toHaveLength(0);

  const response = await request(
    '/security/policy',
    {
      expectedRevision: 0,
      block: ['openai/gpt-6.1-sol', 'not-a-model'],
      limits: { concurrency: 3, retries: 9 },
      note: 'must-not-be-audited',
    },
    bindings,
  );
  // The unknown field is refused, and the attempt is still recorded.
  expect(response.status).toBe(400);
  const accepted = await request(
    '/security/policy',
    { expectedRevision: 0, block: ['openai/gpt-6.1-sol'], limits: { concurrency: 3 } },
    bindings,
  );
  expect(accepted.status).toBe(200);
  const sweeps = await request(
    '/security/policy',
    { expectedRevision: 1, sweeps: { on: true, everyDays: 14, note: 'must-not-be-audited' } },
    bindings,
  );
  // The unknown sweeps field is refused; the attempt keeps only the known values.
  expect(sweeps.status).toBe(400);

  const events = await env.db.select().from(operatorEvents);
  expect(events.map((event) => [event.action, JSON.parse(event.target), event.status])).toEqual(
    expect.arrayContaining([
      [
        'security/policy',
        { expectedRevision: 0, block: ['openai/gpt-6.1-sol'], limits: { concurrency: 3 } },
        'failed',
      ],
      [
        'security/policy',
        { expectedRevision: 0, block: ['openai/gpt-6.1-sol'], limits: { concurrency: 3 } },
        'success',
      ],
      ['security/policy', { expectedRevision: 1, sweeps: { on: true, everyDays: 14 } }, 'failed'],
    ]),
  );
  expect(JSON.stringify(events)).not.toContain('must-not-be-audited');
});

test('records every operator security write as ids and known values, never text', async () => {
  const bindings = {
    ...env,
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
  } as TestEnv;
  const owner = await createTestUser(env.db, 'security-owner');
  const project = await createTestProject(env.db, owner.id, 'audited');
  const base = `/projects/${project.id}/security`;
  const secret = 'must-not-be-audited';
  const calls: Array<[string, Record<string, unknown>]> = [
    ['/security/budget', { expectedRevision: 2, platformMonthlyUsd: 50, note: secret }],
    ['/security/probe', { note: secret }],
    ['/security/backfill', { note: secret }],
    ['/security/scans/ss_one/cancel', { note: secret }],
    [
      `${base}/findings/F-3/resolve`,
      { reason: 'accepted_risk', comment: secret, expectedRevision: 4 },
    ],
    [`${base}/findings/F-3/reopen`, { comment: secret, expectedRevision: 5 }],
    [`${base}/findings/F-3/comments`, { text: secret }],
    [`${base}/scans`, { note: secret }],
    [`${base}/model`, { model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', note: secret }],
    [`${base}/budget`, { monthlyUsd: 25, note: secret }],
    [`${base}/public-request/bypass`, { reason: secret }],
  ];
  for (const [path, body] of calls) {
    // The outcome does not matter here (most are refused); the attempt is what is recorded.
    await request(path, { dryRun: true, ...body }, bindings);
  }
  expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
  for (const [path, body] of calls) {
    await request(path, body, bindings);
  }
  const events = await env.db.select().from(operatorEvents);
  const targets = new Map(events.map((event) => [event.action, JSON.parse(event.target)]));
  expect([...targets.keys()].sort()).toEqual(calls.map(([path]) => path.replace(/^\//, '')).sort());
  expect(targets.get('security/budget')).toEqual({ expectedRevision: 2, platformMonthlyUsd: 50 });
  expect(targets.get('security/probe')).toEqual({ installation: 'platform' });
  expect(targets.get('security/backfill')).toEqual({ installation: 'platform', backfill: true });
  expect(targets.get('security/scans/ss_one/cancel')).toEqual({ scanId: 'ss_one' });
  expect(targets.get(`projects/${project.id}/security/findings/F-3/resolve`)).toEqual({
    projectId: project.id,
    finding: 'F-3',
    action: 'resolve',
    reason: 'accepted_risk',
    expectedRevision: 4,
  });
  expect(targets.get(`projects/${project.id}/security/findings/F-3/comments`)).toEqual({
    projectId: project.id,
    finding: 'F-3',
    action: 'comments',
  });
  expect(targets.get(`projects/${project.id}/security/scans`)).toEqual({
    projectId: project.id,
    rescan: true,
  });
  expect(targets.get(`projects/${project.id}/security/model`)).toEqual({
    projectId: project.id,
    model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  });
  expect(targets.get(`projects/${project.id}/security/budget`)).toEqual({
    projectId: project.id,
    monthlyUsd: 25,
  });
  expect(targets.get(`projects/${project.id}/security/public-request/bypass`)).toEqual({
    projectId: project.id,
  });
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(events.every((event) => event.status !== 'pending')).toBe(true);
});
