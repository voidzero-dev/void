import { eq } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vite-plus/test';
import {
  emailActionRecipients,
  emailActions,
  emailProjectControls,
  emailReceipts,
  emailUnresolvedAttempts,
} from '../../src/email/admission-schema.ts';
import {
  admitEmailAction,
  setProjectEmailLimits,
  transitionEmailRecipients,
} from '../../src/email/admission.ts';
import {
  EMAIL_DOMAIN_MANAGEMENT_SETTING,
  EMAIL_RECIPIENT_POLICY_MIRROR_KEY,
  EMAIL_RECIPIENT_POLICY_SETTING,
} from '../../src/email/settings.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { emailDestinations, operatorEvents, platformSettings, projects } from '../../src/schema.ts';
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

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(async () => {
  await teardownEnv();
});
beforeEach(async () => {
  await clearTables(env.db);
  await env.ROUTING.delete(EMAIL_RECIPIENT_POLICY_MIRROR_KEY);
  const admin = await createTestUser(env.db, 'email-admin', 'github', undefined, 'free', 'admin');
  token = await createOperatorToken(env.db, admin);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function req(
  path: string,
  body?: Record<string, unknown>,
  overrides?: Partial<ApiEnv['Bindings']>,
) {
  return app.fetch(
    new Request(`http://localhost/operator/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { ...env, ...overrides },
  );
}

async function setting(key: string): Promise<unknown> {
  const rows = await env.db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, key));
  return rows[0]?.value ?? null;
}

async function events() {
  return env.db.select().from(operatorEvents);
}

describe('operator email outcome logs', () => {
  test('paginates retained receipt and recipient outcomes, including after project deletion', async () => {
    const owner = await createTestUser(env.db, 'logs-owner');
    const project = await createTestProject(env.db, owner.id, 'logs-project');
    const other = await createTestProject(env.db, owner.id, 'other-logs');
    const createdAt = '2026-09-19T01:02:03Z';
    for (const [id, projectId] of [
      ['action-a', project.id],
      ['action-other', other.id],
    ] as const) {
      await env.db.insert(emailActions).values({
        id,
        project_id: projectId,
        sender_domain: 'mail.example.com',
        kind: 'direct',
        idempotency_key: 'private-request-key',
        payload_digest: 'd'.repeat(64),
        transport: 'binding',
        policy_version: 3,
        created_at: createdAt,
      });
    }
    await env.db.insert(emailActionRecipients).values([
      {
        id: 'recipient-a',
        action_id: 'action-a',
        project_id: project.id,
        recipient: 'one@example.com',
        state: 'provider_accepted',
        provider_reference: 'provider-1',
      },
      {
        id: 'recipient-b',
        action_id: 'action-a',
        project_id: project.id,
        recipient: 'two@example.com',
        state: 'failed',
        error_code: 'RATE_LIMIT',
      },
      {
        id: 'recipient-other',
        action_id: 'action-other',
        project_id: other.id,
        recipient: 'other@example.com',
        state: 'reserved',
      },
    ]);
    await env.db.insert(emailReceipts).values({
      id: 'receipt-a',
      project_id: project.id,
      status: 'handler_completed',
      created_at: createdAt,
    });
    const page1 = await req(`/email/projects/${project.slug}/logs?limit=2`);
    expect(page1.status).toBe(200);
    const first = (await page1.json()) as {
      projectId: string;
      logs: Array<Record<string, unknown>>;
    };
    expect(first.projectId).toBe(project.id);
    expect(first.logs).toHaveLength(2);
    const second = (await (
      await req(`/email/projects/${project.id}/logs?limit=2&page=2`)
    ).json()) as { logs: Array<Record<string, unknown>> };
    expect(second.logs).toHaveLength(1);
    const all = [...first.logs, ...second.logs];
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: 'action-a',
          recipient: 'one@example.com',
          status: 'provider_accepted',
          providerReference: 'provider-1',
          policyVersion: 3,
          timestamp: Date.parse(createdAt),
        }),
        expect.objectContaining({
          operationId: 'action-a',
          recipient: 'two@example.com',
          status: 'failed',
          errorCode: 'RATE_LIMIT',
        }),
        expect.objectContaining({
          operationId: 'receipt-a',
          receiptId: 'receipt-a',
          direction: 'received',
          recipient: null,
        }),
      ]),
    );
    for (const log of all) {
      expect(Object.keys(log).sort()).toEqual([
        'direction',
        'errorCode',
        'operationId',
        'policyVersion',
        'providerReference',
        'receiptId',
        'recipient',
        'status',
        'timestamp',
        'transport',
      ]);
    }
    await env.db.delete(projects).where(eq(projects.id, project.id));
    expect(await (await req(`/email/projects/${project.id}/logs?limit=2`)).json()).toMatchObject(
      first,
    );
    expect(await events()).toHaveLength(0);
  });

  test('requires operator authentication and bounds outcome log pages', async () => {
    for (const query of ['limit=101', 'page=0', 'page=1000001']) {
      expect((await req(`/email/projects/retained-project/logs?${query}`)).status).toBe(400);
    }
    token = 'invalid';
    expect((await req('/email/projects/retained-project/logs')).status).toBe(401);
  });
});

describe('operator email recipient policy', () => {
  test('defaults to verified-only and repairs a missing mirror on read', async () => {
    const response = await req('/email/policy');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ policy: { mode: 'verified', domains: [] } });
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'verified', domains: [] }),
    );
  });

  test('previews without writing, then applies to the database and the KV mirror', async () => {
    const preview = await req('/email/policy', {
      mode: 'domains',
      domains: 'Corp.Example, example.net corp.example',
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as Record<string, unknown>;
    expect(previewBody).toMatchObject({
      dryRun: true,
      action: 'email.policy.set',
      target: { mode: 'domains', domains: ['corp.example', 'example.net'] },
      previous: { mode: 'verified', domains: [] },
    });
    expect(String(previewBody.effect)).toContain("platform's own mail domain");
    const anyPreview = await req('/email/policy', { mode: 'any', dryRun: true });
    expect(String(((await anyPreview.json()) as Record<string, unknown>).effect)).toContain(
      "platform's own mail domain",
    );
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toBeNull();
    expect(await events()).toHaveLength(0);

    const response = await req('/email/policy', {
      mode: 'domains',
      domains: 'Corp.Example, example.net corp.example',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: 'email.policy.set',
      policy: { mode: 'domains', domains: ['corp.example', 'example.net'] },
    });
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toEqual({
      mode: 'domains',
      domains: ['corp.example', 'example.net'],
    });
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'domains', domains: ['corp.example', 'example.net'] }),
    );
    const recorded = await events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ action: 'email/policy', status: 'success' });
    expect(JSON.parse(recorded[0]!.target)).toEqual({
      mode: 'domains',
      domains: 'corp.example, example.net corp.example',
    });

    const read = await req('/email/policy');
    expect(await read.json()).toEqual({
      policy: { mode: 'domains', domains: ['corp.example', 'example.net'] },
    });
  });

  test('`any` and `verified` drop the domain list', async () => {
    await req('/email/policy', { mode: 'domains', domains: 'corp.example' });
    const response = await req('/email/policy', { mode: 'any', domains: 'ignored.example' });
    expect(response.status).toBe(200);
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toEqual({ mode: 'any', domains: [] });
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'any', domains: [] }),
    );
  });

  test.each([
    ['an unknown mode', { mode: 'open' }],
    ['`domains` without any domain', { mode: 'domains' }],
    ['`domains` with an invalid domain', { mode: 'domains', domains: 'not a domain' }],
  ])('rejects %s with 400 and records a failed event', async (_label, body) => {
    const response = await req('/email/policy', body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_argument' });
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toBeNull();
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBeNull();
    const recorded = await events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ action: 'email/policy', status: 'failed' });
  });

  test('a display mirror failure leaves committed policy authoritative and repairs on read', async () => {
    await req('/email/policy', { mode: 'domains', domains: 'corp.example' });
    const put = vi.spyOn(env.ROUTING, 'put').mockRejectedValueOnce(new Error('kv down'));
    const response = await req('/email/policy', { mode: 'any' });
    expect(response.status).toBe(200);
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toEqual({ mode: 'any', domains: [] });
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'domains', domains: ['corp.example'] }),
    );
    put.mockRestore();
    await req('/email/policy');
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'any', domains: [] }),
    );
  });

  test('a failed display mirror write does not undo a tighter policy', async () => {
    await req('/email/policy', { mode: 'any' });
    const put = vi.spyOn(env.ROUTING, 'put').mockRejectedValueOnce(new Error('kv down'));
    const response = await req('/email/policy', { mode: 'verified' });
    expect(response.status).toBe(200);
    expect(await setting(EMAIL_RECIPIENT_POLICY_SETTING)).toEqual({
      mode: 'verified',
      domains: [],
    });
    expect(await env.ROUTING.get(EMAIL_RECIPIENT_POLICY_MIRROR_KEY)).toBe(
      JSON.stringify({ mode: 'any', domains: [] }),
    );
    put.mockRestore();
  });

  test('is unavailable when the platform does not enable email', async () => {
    const response = await req('/email/policy', undefined, {
      PLATFORM_CAPABILITIES: JSON.stringify({
        ai: true,
        customDomains: true,
        email: false,
        githubActions: true,
        githubOAuth: true,
        googleOAuth: false,
        managedBuilds: false,
        sandbox: false,
      }),
    });
    expect(response.status).toBe(501);
  });
});

describe('operator email settings', () => {
  test('defaults to self-serve domain management', async () => {
    const response = await req('/email/settings');
    expect(await response.json()).toEqual({ domains: { management: 'self-serve' } });
  });

  test('previews and applies the admin mode', async () => {
    const preview = await req('/email/settings', { domains: 'admin', dryRun: true });
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      action: 'email.settings.set',
      target: { domains: 'admin' },
      previous: { domains: 'self-serve' },
    });
    expect(await setting(EMAIL_DOMAIN_MANAGEMENT_SETTING)).toBeNull();

    const response = await req('/email/settings', { domains: 'admin' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ domains: { management: 'admin' } });
    expect(await setting(EMAIL_DOMAIN_MANAGEMENT_SETTING)).toBe('admin');
    expect(await (await req('/email/settings')).json()).toEqual({
      domains: { management: 'admin' },
    });
    const recorded = await events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ action: 'email/settings', status: 'success' });
    expect(JSON.parse(recorded[0]!.target)).toEqual({ domains: 'admin' });
  });

  test('rejects an unknown management mode', async () => {
    const response = await req('/email/settings', { domains: 'nobody' });
    expect(response.status).toBe(400);
    expect(await setting(EMAIL_DOMAIN_MANAGEMENT_SETTING)).toBeNull();
  });
});

describe('operator email limits', () => {
  test('previews and commits both limits in authoritative project controls', async () => {
    const owner = await createTestUser(env.db, 'limit-owner');
    const project = await createTestProject(env.db, owner.id, 'limit-project');
    await setProjectEmailLimits(env.db, project.id, { monthly: 500 });
    const preview = await req(`/email/projects/${project.slug}/limit`, {
      monthly: '1000',
      burst: '25',
      dryRun: true,
    });
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      action: 'email.limit.set',
      target: { projectId: project.id, monthly: 1000, burst: 25 },
      previous: { monthly: 500, burst: 10 },
    });
    const response = await req(`/email/projects/${project.slug}/limit`, {
      monthly: '1000',
      burst: '25',
    });
    expect(response.status).toBe(200);
    const control = (
      await env.db
        .select()
        .from(emailProjectControls)
        .where(eq(emailProjectControls.project_id, project.id))
    )[0];
    expect(control).toMatchObject({ monthly_limit: 1000, burst_limit: 25 });
    expect((await events()).at(-1)).toMatchObject({
      action: `email/projects/${project.slug}/limit`,
      status: 'success',
    });
  });

  test('a KV failure cannot partially apply or undo database limits', async () => {
    const owner = await createTestUser(env.db, 'limit-kv-owner');
    const project = await createTestProject(env.db, owner.id, 'limit-kv');
    vi.spyOn(env.ROUTING, 'put').mockRejectedValue(new Error('storage down'));
    const response = await req(`/email/projects/${project.id}/limit`, {
      monthly: '1000',
      burst: '25',
    });
    expect(response.status).toBe(200);
    const control = (
      await env.db
        .select()
        .from(emailProjectControls)
        .where(eq(emailProjectControls.project_id, project.id))
    )[0];
    expect(control).toMatchObject({ monthly_limit: 1000, burst_limit: 25 });
  });

  test('sets one cap without changing the other', async () => {
    const owner = await createTestUser(env.db, 'limit-owner-2');
    const project = await createTestProject(env.db, owner.id, 'limit-project-2');
    await setProjectEmailLimits(env.db, project.id, { burst: 3 });
    const response = await req(`/email/projects/${project.id}/limit`, { monthly: '42' });
    expect(response.status).toBe(200);
    const control = (
      await env.db
        .select()
        .from(emailProjectControls)
        .where(eq(emailProjectControls.project_id, project.id))
    )[0];
    expect(control).toMatchObject({ monthly_limit: 42, burst_limit: 3 });
  });

  test.each([
    ['neither cap', {}],
    ['zero', { monthly: '0' }],
    ['a non-integer', { burst: '1.5' }],
    ['a negative', { monthly: '-5' }],
    ['a value over the cap', { monthly: '1000001' }],
  ])('rejects %s with 400', async (_label, body) => {
    const owner = await createTestUser(env.db, 'limit-invalid-owner');
    const project = await createTestProject(env.db, owner.id, 'limit-invalid');
    const response = await req(`/email/projects/${project.id}/limit`, body);
    expect(response.status).toBe(400);
    expect(
      await env.db
        .select()
        .from(emailProjectControls)
        .where(eq(emailProjectControls.project_id, project.id)),
    ).toHaveLength(0);
  });

  test('answers 404 for an unknown project', async () => {
    expect((await req('/email/projects/no-such-project/limit', { monthly: '10' })).status).toBe(
      404,
    );
  });
});

describe('operator email attempt recovery', () => {
  test('lists only PII-free fences and audits an explicitly attested resolution', async () => {
    const owner = await createTestUser(env.db, 'attempt-owner');
    const project = await createTestProject(env.db, owner.id, 'attempt-project');
    await env.db.insert(emailDestinations).values({
      id: 'attempt-destination',
      project_id: project.id,
      address: 'recipient@example.com',
      status: 'verified',
    });
    const action = await admitEmailAction(env.db, {
      projectId: project.id,
      kind: 'direct',
      key: 'attempt-key',
      digest: 'a'.repeat(64),
      from: 'attempt-project+news@mail.example.com',
      recipients: ['recipient@example.com'],
      transport: 'binding',
      sharedSenderDomain: 'mail.example.com',
    });
    await transitionEmailRecipients(
      env.db,
      action.operationId,
      ['recipient@example.com'],
      'attempt_started',
    );
    const [fence] = await env.db.select().from(emailUnresolvedAttempts);
    const list = await req(`/email/attempts?project=${project.slug}`);
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed).toMatchObject({
      total: 1,
      attempts: [{ id: fence!.id, projectId: project.id }],
    });
    expect(JSON.stringify(listed)).not.toContain('recipient@example.com');

    const tooRecent = await req(`/email/attempts/${fence!.id}/resolve`, {
      ended: true,
      reason: 'Original Worker execution ended',
      dryRun: true,
    });
    expect(tooRecent.status).toBe(409);
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    await env.db
      .update(emailUnresolvedAttempts)
      .set({ started_at: old })
      .where(eq(emailUnresolvedAttempts.id, fence!.id));
    await env.db
      .update(emailActionRecipients)
      .set({ attempt_started_at: old })
      .where(eq(emailActionRecipients.id, fence!.id));
    const missingAttestation = await req(`/email/attempts/${fence!.id}/resolve`, {
      reason: 'Original Worker execution ended',
      dryRun: true,
    });
    expect(missingAttestation.status).toBe(400);
    const preview = await req(`/email/attempts/${fence!.id}/resolve`, {
      ended: true,
      reason: 'Original Worker execution ended',
      dryRun: true,
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ dryRun: true, action: 'email.attempt.resolve' });
    expect(await events()).toHaveLength(0);
    const response = await req(`/email/attempts/${fence!.id}/resolve`, {
      ended: true,
      reason: 'Original Worker execution ended',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'outcome_unknown', charged: true });
    expect(((await (await req('/email/attempts')).json()) as { total: number }).total).toBe(0);
    const recorded = await events();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      action: `email/attempts/${fence!.id}/resolve`,
      status: 'success',
    });
    expect(JSON.parse(recorded[0]!.target)).toEqual({
      attemptId: fence!.id,
      ended: true,
      reason: 'Original Worker execution ended',
    });
  });
});
