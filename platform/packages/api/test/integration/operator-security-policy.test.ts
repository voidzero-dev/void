import { SECURITY_PROVIDER_NOTICE_VERSION } from '@void/platform/security-models';
import { SECURITY_POLICY_SETTINGS_KEY } from '@void/platform/security-policy';
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

// Turning the policy on re-runs the probe (M6). Its own route and checks are covered in
// operator-security-probe.test.ts; here it is a stand-in that passes unless a test
// says otherwise.
const probe = vi.hoisted(() => ({
  result: null as Record<string, unknown> | null,
  checks: [] as Array<Record<string, unknown>>,
  runs: 0,
}));
vi.mock('../../src/security/probe.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/security/probe.ts')>();
  return {
    ...actual,
    runSecurityProbe: async () => {
      probe.runs++;
      const entitlement = probe.result ?? {
        checkedAt: new Date().toISOString(),
        ok: true,
        missing: [],
        hosts: { openai: false, anthropic: true },
      };
      return {
        probeId: 'pr_test',
        checkedAt: entitlement.checkedAt,
        ok: entitlement.ok,
        checks: probe.checks,
        entitlement,
        coldStartMs: null,
      };
    },
  };
});

import {
  operatorEvents,
  platformSettings,
  projectSecuritySettings,
  projectZeroTrust,
  securityFindings,
  securityPlatformSpend,
  securityScans,
} from '../../src/schema.ts';
import { readSecurityPolicyLenient, securitySpendMonth } from '../../src/security/policy.ts';
import { operatorFetch } from './ai-logging-helpers.ts';
import {
  clearTables,
  createOperatorToken,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import {
  securityOn,
  seedZeroTrustConfiguration,
  storedSecurityPolicy,
} from './security-fixtures.ts';

let env: TestEnv;
let onEnv: TestEnv;
let token: string;
let adminId: string;

beforeAll(async () => {
  env = await setupEnv();
  onEnv = securityOn(env);
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
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
  probe.result = null;
  probe.checks = [];
  probe.runs = 0;
});

function request(path: string, body?: Record<string, unknown>, bindings: TestEnv = onEnv) {
  return operatorFetch(bindings, token, `/security${path}`, body);
}

function entitlement(hoursAgo: number, overrides: Record<string, unknown> = {}) {
  return {
    checkedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    ok: true,
    missing: [],
    hosts: { openai: false, anthropic: true },
    ...overrides,
  };
}

/** A stored policy as the probe (M6) leaves it: Off, with a probe result. */
async function seedPolicy(overrides: Record<string, unknown> = {}) {
  const policy = {
    mode: 'disabled',
    defaultModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    blockedModels: [],
    thirdPartyNotice: null,
    limits: {
      concurrency: 2,
      timeoutMinutes: 20,
      maxInputTokens: 600_000,
      maxOutputTokens: 60_000,
      modelCallsPerScan: 80,
    },
    budgets: {
      platformCapOn: false,
      platformMonthlyUsd: 1000,
      projectCapsOn: false,
      projectDefaultMonthlyUsd: 100,
    },
    entitlement: entitlement(1),
    publicGate: false,
    revision: 3,
    ...overrides,
  };
  await env.db
    .insert(platformSettings)
    .values({ key: SECURITY_POLICY_SETTINGS_KEY, value: policy });
  return policy;
}

describe('operator security policy', () => {
  test('reads the default policy without writing it, and reports the capability', async () => {
    const off = await request('/policy', undefined, env);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({
      capability: false,
      unreadable: null,
      entitlementFresh: false,
      policy: {
        mode: 'disabled',
        defaultModel: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
        revision: 0,
      },
      providerNotice: { version: SECURITY_PROVIDER_NOTICE_VERSION, accepted: false },
    });
    const on = await (
      await request('/policy')
    ).json<{
      capability: boolean;
      models: Array<{ id: string; pickable: boolean; priced: boolean }>;
    }>();
    expect(on.capability).toBe(true);
    expect(on.models.find((model) => model.id === 'anthropic/claude-sonnet-5.5')).toMatchObject({
      priced: false,
      pickable: false,
    });
    expect(await storedSecurityPolicy(env)).toBeUndefined();
  });

  test('returns 501 for writes when the capability is off and audits the failed attempt', async () => {
    await seedPolicy();
    const response = await request('/policy', { mode: 'all', expectedRevision: 3 }, env);
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      error: 'platform capability unavailable',
      capability: 'securityAudits',
    });
    expect((await storedSecurityPolicy(env))?.mode).toBe('disabled');
    expect(await env.db.select().from(operatorEvents)).toEqual([
      expect.objectContaining({ action: 'security/policy', status: 'failed', http_status: 501 }),
    ]);
  });

  test('round-trips a change and bumps the revision', async () => {
    await seedPolicy();
    const response = await request('/policy', {
      expectedRevision: 3,
      mode: 'all',
      block: ['openai/gpt-6.1-sol'],
      limits: { concurrency: 4 },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      canceledScans: 0,
      policy: { mode: 'all', blockedModels: ['openai/gpt-6.1-sol'], revision: 4 },
      changes: {
        mode: { from: 'disabled', to: 'all' },
        blocked: ['openai/gpt-6.1-sol'],
        limits: [{ key: 'concurrency', from: 2, to: 4 }],
      },
    });
    const read = await (await request('/policy')).json<Record<string, unknown>>();
    expect(read).toMatchObject({
      policy: { mode: 'all', revision: 4, limits: { concurrency: 4 } },
      entitlementFresh: true,
    });
    expect(await readSecurityPolicyLenient(env.db)).toMatchObject({ mode: 'all', revision: 4 });
    const [event] = await env.db.select().from(operatorEvents);
    expect(event).toMatchObject({ action: 'security/policy', status: 'success' });
    expect(JSON.parse(event.target)).toEqual({
      expectedRevision: 3,
      mode: 'all',
      block: ['openai/gpt-6.1-sol'],
      limits: { concurrency: 4 },
    });
  });

  test('refuses a stale revision with 409 and a missing one with 400', async () => {
    await seedPolicy();
    const stale = await request('/policy', { expectedRevision: 2, mode: 'all' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: 'revision_conflict',
      details: { expectedRevision: 2, currentRevision: 3 },
    });
    expect((await request('/policy', { mode: 'all' })).status).toBe(400);
    expect((await storedSecurityPolicy(env))?.revision).toBe(3);
  });

  test('two writes from the same preview: only the first lands', async () => {
    await seedPolicy();
    const [first, second] = await Promise.all([
      request('/policy', { expectedRevision: 3, limits: { concurrency: 3 } }),
      request('/policy', { expectedRevision: 3, limits: { concurrency: 5 } }),
    ]);
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 409]);
    expect((await storedSecurityPolicy(env))?.revision).toBe(4);
  });

  test('turning on re-runs the probe: a pass replaces the stored result, a failure refuses', async () => {
    // No stored probe: the fresh one is what counts.
    await seedPolicy({ entitlement: null });
    const on = await request('/policy', { expectedRevision: 3, mode: 'public' });
    expect(on.status).toBe(200);
    expect(probe.runs).toBe(1);
    expect(await storedSecurityPolicy(env)).toMatchObject({
      mode: 'public',
      revision: 4,
      entitlement: { ok: true, hosts: { anthropic: true } },
    });

    await env.db.delete(platformSettings);
    await seedPolicy({ entitlement: entitlement(1) });
    probe.result = entitlement(0, { ok: false, missing: ['egress'] });
    const egressCopy =
      'Scanner network lock failed (probe pr_test). The scanner could reach the internet, so scans stay off to keep code private.';
    probe.checks = [
      { check: 1, name: 'capability', label: 'Capability securityAudits', status: 'ok' },
      { check: 3, name: 'egress', label: 'Egress lock', status: 'fail', message: egressCopy },
      {
        check: 5,
        name: 'credits',
        label: 'Credits     openai/*',
        status: 'fail',
        message: 'No AI Gateway credits for openai/*.',
        link: 'https://dash.cloudflare.com/?to=/:account/ai/ai-gateway',
      },
    ];
    const failed = await request('/policy', { expectedRevision: 3, mode: 'all' });
    expect(failed.status).toBe(409);
    const failedBody = await failed.json<{ message: string; details: unknown }>();
    expect(failedBody).toMatchObject({
      error: 'security entitlement missing',
      // Each refusing check's copy and the probe id reach the operator; a host
      // without credits does not refuse the change, so it is not listed.
      details: {
        missing: ['egress'],
        probeId: 'pr_test',
        checks: [{ name: 'egress', message: egressCopy }],
      },
    });
    expect(failedBody.message).toContain('probe pr_test');
    expect(failedBody.message).toContain(`Egress lock: ${egressCopy}`);
    // The failing result is stored (revision + 1); the mode is not.
    expect(await storedSecurityPolicy(env)).toMatchObject({
      mode: 'disabled',
      revision: 4,
      entitlement: { ok: false, missing: ['egress'] },
    });

    // A stale revision is refused without running the probe.
    probe.runs = 0;
    expect((await request('/policy', { expectedRevision: 3, mode: 'all' })).status).toBe(409);
    expect(probe.runs).toBe(0);
    // Moving between on modes, and other settings while Off, never run it.
    expect(
      (await request('/policy', { expectedRevision: 4, limits: { timeoutMinutes: 30 } })).status,
    ).toBe(200);
    expect(probe.runs).toBe(0);
  });

  test('a turn-on that is refused anyway never runs the probe', async () => {
    await seedPolicy({ entitlement: null });
    // Blocked default, unpriced default, missing provider notice, public gate.
    for (const body of [
      { block: ['@cf/deepseek-ai/deepseek-v4.1-flash-1017'] },
      { defaultModel: 'anthropic/claude-sonnet-5.5' },
      { defaultModel: 'anthropic/claude-opus-5.5' },
      { publicGate: true },
    ]) {
      const response = await request('/policy', { expectedRevision: 3, mode: 'public', ...body });
      expect(response.status).not.toBe(200);
    }
    expect(probe.runs).toBe(0);
    expect(await storedSecurityPolicy(env)).toMatchObject({ mode: 'disabled', revision: 3 });
  });

  test('turning on with a third-party default checks its host against the fresh probe', async () => {
    // The stored probe says anthropic has no credits; the fresh one says it has.
    await seedPolicy({
      entitlement: entitlement(30, { hosts: { openai: false, anthropic: false } }),
    });
    const change = {
      expectedRevision: 3,
      mode: 'public',
      defaultModel: 'anthropic/claude-opus-5.5',
      acceptProviderNoticeVersion: SECURITY_PROVIDER_NOTICE_VERSION,
    };
    const preview = await request('/policy', { ...change, dryRun: true });
    expect(preview.status).toBe(200);
    expect(probe.runs).toBe(0);
    const applied = await request('/policy', change);
    expect(applied.status).toBe(200);
    expect(probe.runs).toBe(1);
    expect(await storedSecurityPolicy(env)).toMatchObject({
      mode: 'public',
      defaultModel: 'anthropic/claude-opus-5.5',
    });

    // A fresh probe without anthropic credits refuses it.
    await env.db.delete(platformSettings);
    await seedPolicy({ entitlement: null });
    probe.result = entitlement(0, { hosts: { openai: false, anthropic: false } });
    const refused = await request('/policy', change);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: 'security model not allowed' });
  });

  test('a preview of turning on reads no stored probe and says the probe runs on apply', async () => {
    await seedPolicy({ entitlement: entitlement(30, { ok: false, missing: ['egress'] }) });
    const preview = await request('/policy', { expectedRevision: 3, dryRun: true, mode: 'all' });
    expect(preview.status).toBe(200);
    const body = await preview.json<{ preview: Array<string> }>();
    expect(body.preview).toContain(
      '  The entitlement probe runs again when you apply. A failing check refuses the change.',
    );
    expect(probe.runs).toBe(0);
  });

  // The model rules (unpriced, host credits, old notice) are in unit/security-policy-store.
  test('checks the default model: blocked and provider notice', async () => {
    await seedPolicy();
    const blockDefault = await request('/policy', {
      expectedRevision: 3,
      block: ['@cf/deepseek-ai/deepseek-v4.1-flash-1017'],
    });
    expect(blockDefault.status).toBe(422);
    expect(await blockDefault.json()).toMatchObject({ error: 'security model not allowed' });

    const noNotice = await request('/policy', {
      expectedRevision: 3,
      defaultModel: 'anthropic/claude-opus-5.5',
    });
    expect(noNotice.status).toBe(422);
    expect(await noNotice.json()).toMatchObject({
      error: 'provider notice not accepted',
      details: { version: SECURITY_PROVIDER_NOTICE_VERSION },
    });

    const accepted = await request('/policy', {
      expectedRevision: 3,
      defaultModel: 'anthropic/claude-opus-5.5',
      acceptProviderNoticeVersion: SECURITY_PROVIDER_NOTICE_VERSION,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      policy: {
        defaultModel: 'anthropic/claude-opus-5.5',
        thirdPartyNotice: { acceptedByUserId: adminId, version: SECURITY_PROVIDER_NOTICE_VERSION },
      },
    });
  });

  test('previews turning the policy on with project counts and writes nothing', async () => {
    await seedPolicy();
    await seedZeroTrustConfiguration(env, { protectNewProjects: false });
    const owner = await createTestUser(env.db, 'security-owner');
    const fresh = await createTestProject(env.db, owner.id, 'sec-fresh');
    const scanned = await createTestProject(env.db, owner.id, 'sec-scanned');
    const guarded = await createTestProject(env.db, owner.id, 'sec-guarded');
    await createTestProject(env.db, owner.id, 'preview-0123456789abcdef0123');
    await env.db.insert(projectZeroTrust).values({
      project_id: guarded.id,
      desired_protected: true,
      effective_protected: true,
      status: 'ready',
    });
    await env.db.insert(securityScans).values({
      id: 'ss_scanned',
      project_id: scanned.id,
      deployment_id: 'dpl_scanned',
      status: 'succeeded',
      trigger: 'deploy',
    });
    await env.db.insert(securityFindings).values({
      id: 'sf_urgent',
      project_id: fresh.id,
      number: 1,
      fingerprint_key: 'key',
      verdict: 'confirmed',
      severity: 'high',
      title: 'Missing auth check',
      category: 'auth',
      first_scan_id: 'ss_old',
      last_seen_scan_id: 'ss_old',
    });

    const publicPreview = await request('/policy', { dryRun: true, mode: 'public' });
    expect(publicPreview.status).toBe(200);
    const body = await publicPreview.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      dryRun: true,
      action: 'security.policy',
      expectedRevision: 3,
      policy: { mode: 'public', revision: 4 },
      counts: { scannedProjects: 2, firstFullScan: 1, urgentProjects: 1 },
    });
    expect(body.preview).toEqual([
      'Change policy: Off → Public projects only',
      '  2 projects will be scanned at their next deploy.',
      '  1 of them has no earlier scan: their first scan reviews the whole app.',
      "  1 project still has open urgent findings from before. They show in those projects' deploy output again.",
      '  Monthly scan budgets are off (no money limit). Set them with: void platform security budget',
      '  The entitlement probe runs again when you apply. A failing check refuses the change.',
    ]);

    const allPreview = await (
      await request('/policy', { dryRun: true, mode: 'all' })
    ).json<{
      counts: Record<string, number>;
    }>();
    expect(allPreview.counts).toMatchObject({ scannedProjects: 3, firstFullScan: 2 });

    await env.db
      .insert(platformSettings)
      .values({ key: 'plans:security-caps', value: { pro: 5000, lab: null } });
    const cappedPreview = await (
      await request('/policy', { dryRun: true, mode: 'all' })
    ).json<{ preview: Array<string> }>();
    expect(cappedPreview.preview).toContain(
      '  Monthly scan budgets are off: only plans with a scan cap have a money limit. Set them with: void platform security budget',
    );
    expect((await storedSecurityPolicy(env))?.revision).toBe(3);
    expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
  });

  test('the preview counts follow the project rules (M34)', async () => {
    await seedPolicy();
    await seedZeroTrustConfiguration(env, { protectNewProjects: false });
    const owner = await createTestUser(env.db, 'security-rule-owner');
    await createTestProject(env.db, owner.id, 'sec-plain');
    const never = await createTestProject(env.db, owner.id, 'sec-never');
    const always = await createTestProject(env.db, owner.id, 'sec-always');
    const guarded = await createTestProject(env.db, owner.id, 'sec-guarded');
    await env.db.insert(projectZeroTrust).values(
      [never, always, guarded].map((project) => ({
        project_id: project.id,
        desired_protected: true,
        effective_protected: true,
        status: 'ready' as const,
      })),
    );
    await env.db.insert(projectSecuritySettings).values([
      { project_id: never.id, policy_override: 'never' },
      { project_id: always.id, policy_override: 'always' },
    ]);

    // Off → Public: the plain project and the protected `always` one.
    const publicPreview = await (
      await request('/policy', { dryRun: true, mode: 'public' })
    ).json<{ counts: Record<string, number> }>();
    expect(publicPreview.counts).toMatchObject({ scannedProjects: 2, firstFullScan: 2 });
    // Off → All: every project but the `never` one.
    const allPreview = await (
      await request('/policy', { dryRun: true, mode: 'all' })
    ).json<{
      counts: Record<string, number>;
    }>();
    expect(allPreview.counts).toMatchObject({ scannedProjects: 3, firstFullScan: 3 });

    // All → Public moves only the protected project that follows the mode.
    await env.db
      .delete(platformSettings)
      .where(eq(platformSettings.key, SECURITY_POLICY_SETTINGS_KEY));
    await seedPolicy({ mode: 'all' });
    const toPublic = await (
      await request('/policy', { dryRun: true, mode: 'public' })
    ).json<{
      counts: Record<string, number>;
      preview: Array<string>;
    }>();
    expect(toPublic.counts).toMatchObject({ protectedProjects: 1 });
    expect(toPublic.preview).toContain(
      '  1 protected project is no longer scanned at deploy. Running scans finish.',
    );
  });

  test('previews a third-party default for projects without their own model', async () => {
    await seedPolicy({ blockedModels: ['openai/gpt-6.1-sol'] });
    const owner = await createTestUser(env.db, 'security-model-owner');
    const own = await createTestProject(env.db, owner.id, 'sec-own-model');
    const ownAccepted = await createTestProject(env.db, owner.id, 'sec-own-accepted');
    const accepted = await createTestProject(env.db, owner.id, 'sec-accepted');
    await createTestProject(env.db, owner.id, 'sec-plain');
    await env.db.insert(projectSecuritySettings).values([
      { project_id: own.id, model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017' },
      {
        project_id: ownAccepted.id,
        model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
        provider_notice_version: SECURITY_PROVIDER_NOTICE_VERSION,
        provider_notice_at: new Date().toISOString(),
      },
      {
        project_id: accepted.id,
        provider_notice_version: SECURITY_PROVIDER_NOTICE_VERSION,
        provider_notice_at: new Date().toISOString(),
      },
    ]);
    const response = await request('/policy', {
      dryRun: true,
      defaultModel: 'anthropic/claude-opus-5.5',
      acceptProviderNoticeVersion: SECURITY_PROVIDER_NOTICE_VERSION,
      block: ['@cf/deepseek-ai/deepseek-v4.1-flash-1017'],
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ preview: Array<string> }>();
    expect(body.preview).toEqual([
      `Provider notice accepted (version ${SECURITY_PROVIDER_NOTICE_VERSION}).`,
      'Change default model: @cf/deepseek-ai/deepseek-v4.1-flash-1017 → anthropic/claude-opus-5.5',
      '  2 projects have no model of their own. 1 of them accepted the provider notice and use anthropic/claude-opus-5.5 from their next scan; the other 1 stays on @cf/zai-org/glm-5.3 until a project owner or admin accepts the Anthropic notice.',
      // Spec §8.3: a project without the notice stays on the first non-blocked @cf model.
      'Block @cf/deepseek-ai/deepseek-v4.1-flash-1017: 2 projects picked it. 1 of them accepted the provider notice and use the default model (anthropic/claude-opus-5.5) from their next scan; the other 1 stays on @cf/zai-org/glm-5.3 until a project owner or admin accepts the Anthropic notice.',
    ]);
  });

  test('turning the policy Off cancels queued scans and leaves running ones', async () => {
    await seedPolicy({ mode: 'all' });
    const owner = await createTestUser(env.db, 'security-off-owner');
    const project = await createTestProject(env.db, owner.id, 'sec-off');
    const other = await createTestProject(env.db, owner.id, 'sec-off-other');
    await env.db.insert(securityScans).values([
      {
        id: 'ss_pending',
        project_id: project.id,
        deployment_id: 'dpl_1',
        status: 'pending_input',
        trigger: 'deploy',
      },
      {
        id: 'ss_queued',
        project_id: other.id,
        deployment_id: 'dpl_2',
        status: 'queued',
        trigger: 'deploy',
      },
      {
        id: 'ss_running',
        project_id: project.id,
        deployment_id: 'dpl_3',
        status: 'running',
        trigger: 'deploy',
        lease_until: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);
    const preview = await (
      await request('/policy', { dryRun: true, mode: 'disabled' })
    ).json<{
      preview: Array<string>;
    }>();
    expect(preview.preview).toEqual([
      'Change policy: All projects → Off',
      '  New deploys are not scanned.',
      '  2 queued scans are canceled.',
      '  1 running scan finishes and is stored, with no email.',
      '  Open findings stay listed and can still be read, commented on and resolved. Only the deploy-time notice stops.',
    ]);
    const response = await request('/policy', { expectedRevision: 3, mode: 'disabled' });
    expect(await response.json()).toMatchObject({ ok: true, canceledScans: 2 });
    const scans = await env.db
      .select({ id: securityScans.id, status: securityScans.status })
      .from(securityScans);
    expect(Object.fromEntries(scans.map((scan) => [scan.id, scan.status]))).toEqual({
      ss_pending: 'canceled',
      ss_queued: 'canceled',
      ss_running: 'running',
    });
  });

  test('reads bad policy data as Off and lets an operator replace it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.db.insert(platformSettings).values({
      key: SECURITY_POLICY_SETTINGS_KEY,
      value: { mode: 'sometimes', revision: 7 },
    });
    const read = await (await request('/policy')).json<Record<string, unknown>>();
    expect(read).toMatchObject({
      policy: { mode: 'disabled', revision: 7 },
      unreadable: expect.any(String),
    });
    expect(error).toHaveBeenCalled();
    const preview = await (
      await request('/policy', { dryRun: true, limits: { concurrency: 3 } })
    ).json<{ preview: Array<string> }>();
    expect(preview.preview[0]).toBe(
      'The saved policy could not be read. Saving replaces it, starting from Off.',
    );
    const repaired = await request('/policy', { expectedRevision: 7, limits: { concurrency: 3 } });
    expect(repaired.status).toBe(200);
    expect(await storedSecurityPolicy(env)).toMatchObject({ mode: 'disabled', revision: 8 });
  });

  test('refuses unknown fields and the public gate while the policy is Off', async () => {
    await seedPolicy();
    expect((await request('/policy', { expectedRevision: 3, modes: 'all' })).status).toBe(400);
    const gate = await request('/policy', { expectedRevision: 3, publicGate: true });
    expect(gate.status).toBe(409);
    expect(await gate.json()).toMatchObject({ error: 'security public gate needs policy' });
    expect((await request('/policy', { expectedRevision: 3 })).status).toBe(400);
  });
});

describe('operator security status', () => {
  test('reports the probe, queue, month spend and 24 h failure rate', async () => {
    await seedPolicy({
      mode: 'all',
      budgets: {
        platformCapOn: true,
        platformMonthlyUsd: 500,
        projectCapsOn: false,
        projectDefaultMonthlyUsd: 100,
      },
    });
    const owner = await createTestUser(env.db, 'security-status-owner');
    const project = await createTestProject(env.db, owner.id, 'sec-status');
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const scan = (id: string, status: string, finishedAt: string | null = null) => ({
      id,
      project_id: project.id,
      deployment_id: `dpl_${id}`,
      status: status as 'queued',
      trigger: 'deploy' as const,
      finished_at: finishedAt,
      ...(status === 'running' ? { lease_until: new Date(Date.now() + 60_000).toISOString() } : {}),
    });
    await env.db
      .insert(securityScans)
      .values([
        scan('a', 'queued'),
        scan('b', 'pending_input'),
        scan('c', 'running'),
        scan('d', 'succeeded', recent),
        scan('e', 'succeeded', recent),
        scan('f', 'failed', recent),
        scan('g', 'timed_out', recent),
        scan('h', 'failed', old),
        scan('i', 'canceled', recent),
        scan('j', 'refused', recent),
        scan('k', 'incomplete', recent),
      ]);
    await env.db.insert(securityPlatformSpend).values({
      month: securitySpendMonth(Date.now()),
      spent_nano_usd: 41_200_000_000,
      reserved_nano_usd: 1_100_000_000,
    });
    const response = await request('/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      capability: true,
      mode: 'all',
      revision: 3,
      probe: { ok: true, fresh: true },
      queue: { pendingInput: 1, queued: 1, running: 1 },
      month: { spentUsd: 41.2, reservedUsd: 1.1, platformCapOn: true, platformCapUsd: 500 },
      // An incomplete scan is finished but not failed, as in the Scans month totals.
      last24h: { finished: 6, failed: 2, refused: 1, incomplete: 1, failureRate: 0.5 },
    });
    const off = await request('/status', undefined, env);
    expect(await off.json()).toMatchObject({ capability: false });
  });
});
