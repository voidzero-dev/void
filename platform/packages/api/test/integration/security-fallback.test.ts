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
import { setPlatformSetting } from '../../src/platform-settings.ts';
import { deployments, projects, securityScans } from '../../src/schema.ts';
import { securityScanInputPrefix } from '../../src/security/enqueue.ts';
import {
  queueSecurityFallbackScans,
  SECURITY_FALLBACK_MAX_AGE_MS,
  securityScanWantsFallback,
} from '../../src/security/fallback.ts';
import { ingestSecurityScanResult } from '../../src/security/ingest.ts';
import { chooseSecurityTier, securityFallbackFullReason } from '../../src/security/input/tier.ts';
import { runSecurityMaintenance } from '../../src/security/maintenance.ts';
import { resolveSecurityScanModel, securityCfDefaultModel } from '../../src/security/models.ts';
import {
  parseSecurityPolicyChangeRequest,
  proposeSecurityPolicyChange,
  securityPolicyPreviewLines,
} from '../../src/security/policy.ts';
import { claimSecurityScan } from '../../src/security/queue.ts';
import { securityPublicRequests } from '../../src/security/schema.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';
import { askPublic, setupGate } from './security-gate-fixtures.ts';

const CF = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const CF_2 = '@cf/zai-org/glm-5.3';
const OPUS = 'anthropic/claude-opus-5.5';
const NOTICE = {
  acceptedByUserId: 'usr_admin',
  acceptedAt: '2026-11-01T00:00:00.000Z',
  version: 1,
};

let env: TestEnv;
let onEnv: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  onEnv = {
    ...env,
    PLATFORM_CAPABILITIES: JSON.stringify({
      ...getPlatformCapabilities(env),
      securityAudits: true,
    }),
    SECURITY_SCAN_SCHEDULER: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => Response.json({ ok: true }),
        forgetModelCalls: async () => 0,
      }),
    },
  } as unknown as TestEnv;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function policyWith(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
  return {
    ...defaultSecurityPolicy(),
    mode: 'all',
    fallbackToCf: true,
    thirdPartyNotice: NOTICE,
    revision: 1,
    ...overrides,
  };
}

async function savePolicy(overrides: Partial<SecurityPolicy> = {}) {
  const policy = policyWith(overrides);
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, policy);
  return policy;
}

/** A project with a live deployment whose code is stored (a snapshot in R2). */
async function liveProject(slug = `app-${crypto.randomUUID().slice(0, 8)}`) {
  const owner = await createTestUser(env.db, `owner-${slug}`);
  const project = await createTestProject(env.db, owner.id, slug);
  const deployment = await createTestDeployment(env.db, project.id, 'live');
  await env.db
    .update(deployments)
    .set({ bundle_stored: true })
    .where(eq(deployments.id, deployment.id));
  await env.STATIC_ASSETS_R2.put(
    `${securityScanInputPrefix(project.id, deployment.id)}modules.json`,
    '[]',
  );
  return { owner, project, deployment };
}

async function endedScan(
  projectId: string,
  deploymentId: string,
  overrides: Partial<typeof securityScans.$inferInsert> = {},
) {
  const id = overrides.id ?? `ss_${crypto.randomUUID().slice(0, 8)}`;
  await env.db.insert(securityScans).values({
    status: 'refused',
    failure_cause: 'project',
    trigger: 'deploy',
    tier: 'built_diff',
    model_requested: OPUS,
    model_used: OPUS,
    engine: 'agent_sdk',
    finished_at: new Date().toISOString(),
    ...overrides,
    id,
    project_id: projectId,
    deployment_id: deploymentId,
  });
  return id;
}

async function fallbackScans(projectId?: string) {
  const rows = await env.db
    .select()
    .from(securityScans)
    .where(eq(securityScans.trigger, 'fallback'));
  return projectId ? rows.filter((row) => row.project_id === projectId) : rows;
}

describe('which scans get a fallback (spec §8.5)', () => {
  const base = { trigger: 'deploy', modelUsed: OPUS, statusReason: null };

  it('re-scans a refused, bad-output or timed-out third-party scan', () => {
    expect(securityScanWantsFallback({ ...base, status: 'refused' })).toBe(true);
    expect(securityScanWantsFallback({ ...base, status: 'timed_out' })).toBe(true);
    expect(
      securityScanWantsFallback({ ...base, status: 'failed', statusReason: 'bad_output' }),
    ).toBe(true);
    expect(securityScanWantsFallback({ ...base, status: 'refused', trigger: 'gate' })).toBe(true);
  });

  it('never for other outcomes, a @cf scan, a fallback or a local check', () => {
    for (const status of ['succeeded', 'incomplete', 'skipped', 'canceled']) {
      expect(securityScanWantsFallback({ ...base, status })).toBe(false);
    }
    expect(
      securityScanWantsFallback({ ...base, status: 'failed', statusReason: 'infrastructure' }),
    ).toBe(false);
    expect(securityScanWantsFallback({ ...base, status: 'refused', modelUsed: CF })).toBe(false);
    expect(securityScanWantsFallback({ ...base, status: 'refused', modelUsed: null })).toBe(false);
    expect(securityScanWantsFallback({ ...base, status: 'refused', trigger: 'fallback' })).toBe(
      false,
    );
    expect(securityScanWantsFallback({ ...base, status: 'refused', trigger: 'local' })).toBe(false);
  });

  it('covers the same changes: the base rule, or the full scan a rescan or sweep was', () => {
    const base = { trigger: 'fallback', baseDeploymentId: 'dpl_1', baseSnapshot: true } as const;
    expect(chooseSecurityTier(base)).toEqual({ tier: 'built_diff', fullReason: null });
    expect(chooseSecurityTier({ ...base, fallbackOf: 'rescan' })).toEqual({
      tier: 'full',
      fullReason: 'rescan',
    });
    expect(chooseSecurityTier({ ...base, fallbackOf: 'sweep' })).toEqual({
      tier: 'full',
      fullReason: 'sweep',
    });
    expect(securityFallbackFullReason(['rescan'])).toBe('rescan');
    expect(securityFallbackFullReason(['sweep'])).toBe('sweep');
    expect(securityFallbackFullReason(['no-changes'])).toBeNull();
  });
});

describe('the @cf default a fallback runs on', () => {
  it('is the policy default when it is @cf, else the first usable @cf model', () => {
    expect(securityCfDefaultModel(policyWith({ defaultModel: CF_2 }))).toBe(CF_2);
    expect(securityCfDefaultModel(policyWith({ defaultModel: OPUS }))).toBe(CF);
    expect(securityCfDefaultModel(policyWith({ defaultModel: OPUS, blockedModels: [CF] }))).toBe(
      CF_2,
    );
  });

  it('is none when every @cf model is blocked: never a third-party model', () => {
    const policy = policyWith({ defaultModel: OPUS, blockedModels: [CF, CF_2] });
    expect(securityCfDefaultModel(policy)).toBeNull();
    expect(
      resolveSecurityScanModel(policy, { model: OPUS, noticeVersion: 1, trigger: 'fallback' }),
    ).toBeNull();
  });

  it('overrides the project model only for a fallback scan', () => {
    const policy = policyWith({
      defaultModel: OPUS,
      entitlement: {
        checkedAt: new Date().toISOString(),
        ok: true,
        missing: [],
        hosts: { openai: true, anthropic: true },
      },
    });
    const project = { model: OPUS, noticeVersion: 1 };
    expect(resolveSecurityScanModel(policy, { ...project, trigger: 'deploy' })?.used).toBe(OPUS);
    expect(resolveSecurityScanModel(policy, { ...project, trigger: 'fallback' })).toEqual({
      requested: CF,
      used: CF,
      engine: 'void_loop',
    });
  });
});

describe('queueing a fallback scan', () => {
  it('queues one fallback of the live deployment, and only one', async () => {
    const policy = await savePolicy();
    const { project, deployment } = await liveProject();
    const failed = await endedScan(project.id, deployment.id);

    const queued = await queueSecurityFallbackScans(onEnv, env.db, policy, { now: Date.now() });
    expect(queued).toEqual([
      { projectId: project.id, fromScanId: failed, scanId: expect.any(String) },
    ]);
    const [row] = await fallbackScans(project.id);
    expect(row).toMatchObject({
      status: 'queued',
      deployment_id: deployment.id,
      input_r2_key: securityScanInputPrefix(project.id, deployment.id),
      public_request_id: null,
      // A deploy scan's fallback follows the base rule.
      coverage_notes: [],
    });

    // The fallback is now the newest scan: no second one.
    expect(await queueSecurityFallbackScans(onEnv, env.db, policy, { now: Date.now() })).toEqual(
      [],
    );
    // Even once it ends badly itself (it ran on @cf).
    await env.db
      .update(securityScans)
      .set({
        status: 'failed',
        status_reason: 'bad_output',
        model_used: CF,
        finished_at: new Date().toISOString(),
      })
      .where(eq(securityScans.id, row!.id));
    expect(await queueSecurityFallbackScans(onEnv, env.db, policy, { now: Date.now() })).toEqual(
      [],
    );
    expect(await fallbackScans(project.id)).toHaveLength(1);
  });

  it('marks the fallback of a rescan or a sweep as that full scan', async () => {
    const policy = await savePolicy();
    for (const trigger of ['rescan', 'sweep'] as const) {
      const { project, deployment } = await liveProject();
      // The deployment was scanned before: the base rule alone would diff it against itself.
      await endedScan(project.id, deployment.id, {
        status: 'succeeded',
        failure_cause: null,
        created_at: new Date(Date.now() - 60_000).toISOString(),
      });
      await endedScan(project.id, deployment.id, { trigger, tier: 'full' });
      await queueSecurityFallbackScans(onEnv, env.db, policy, {
        now: Date.now(),
        projectId: project.id,
      });
      const [row] = await fallbackScans(project.id);
      expect(row?.coverage_notes).toEqual([trigger]);
    }
  });

  it('does nothing with the setting off, the policy Off or no @cf model left', async () => {
    const { project, deployment } = await liveProject();
    await endedScan(project.id, deployment.id);
    const settings: Array<Partial<SecurityPolicy>> = [
      { fallbackToCf: false },
      { mode: 'disabled' },
      { defaultModel: OPUS, blockedModels: [CF, CF_2] },
    ];
    for (const overrides of settings) {
      const policy = await savePolicy(overrides);
      expect(await queueSecurityFallbackScans(onEnv, env.db, policy, { now: Date.now() })).toEqual(
        [],
      );
    }
    expect(await fallbackScans()).toHaveLength(0);
  });

  it('skips a @cf failure, a deployment no longer live, an old failure and a newer scan', async () => {
    const policy = await savePolicy();
    const cf = await liveProject();
    await endedScan(cf.project.id, cf.deployment.id, { model_used: CF, model_requested: CF });

    const moved = await liveProject();
    await endedScan(moved.project.id, moved.deployment.id);
    const next = await createTestDeployment(env.db, moved.project.id, 'live');
    await env.db
      .update(projects)
      .set({ active_deployment_id: next.id })
      .where(eq(projects.id, moved.project.id));

    const old = await liveProject();
    await endedScan(old.project.id, old.deployment.id, {
      finished_at: new Date(Date.now() - SECURITY_FALLBACK_MAX_AGE_MS - 60_000).toISOString(),
    });

    const newer = await liveProject();
    await endedScan(newer.project.id, newer.deployment.id, {
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await endedScan(newer.project.id, newer.deployment.id, {
      status: 'succeeded',
      failure_cause: null,
    });

    expect(await queueSecurityFallbackScans(onEnv, env.db, policy, { now: Date.now() })).toEqual(
      [],
    );
  });

  it('logs and skips a project whose code is no longer stored', async () => {
    const policy = await savePolicy();
    const owner = await createTestUser(env.db, 'owner-gone');
    const project = await createTestProject(env.db, owner.id, 'gone');
    const deployment = await createTestDeployment(env.db, project.id, 'live');
    await endedScan(project.id, deployment.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await queueSecurityFallbackScans(onEnv, env.db, policy, { now: Date.now() })).toEqual(
      [],
    );
    expect(warn).toHaveBeenCalledWith(
      '[security-scan] fallback scan not queued',
      expect.objectContaining({ reason: 'security_input_unavailable' }),
    );
  });

  it('is queued by ingest as soon as a third-party scan is refused', async () => {
    await savePolicy();
    const { project, deployment } = await liveProject();
    await env.db.insert(securityScans).values({
      id: 'scan_refused',
      project_id: project.id,
      deployment_id: deployment.id,
      status: 'running',
      trigger: 'deploy',
      attempt: 1,
      lease_until: new Date(Date.now() + 60 * 60_000).toISOString(),
      model_requested: OPUS,
      model_used: OPUS,
      engine: 'agent_sdk',
      model_calls: 2,
      first_queued_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
    });
    const stored = await ingestSecurityScanResult(onEnv, env.db, 'scan_refused', 1, {
      status: {
        scan_id: 'scan_refused',
        attempt: 1,
        status: 'refused',
        reason: null,
        refusal_category: 'cyber',
      },
      findings: null,
    });
    expect(stored).toMatchObject({ ok: true, status: 'refused' });
    const [fallback] = await fallbackScans(project.id);
    expect(fallback).toMatchObject({ status: 'queued', deployment_id: deployment.id });
  });

  it('is queued by the hourly job for a scan the reaper timed out', async () => {
    await savePolicy();
    const { project, deployment } = await liveProject();
    await env.db.insert(securityScans).values({
      id: 'scan_stuck',
      project_id: project.id,
      deployment_id: deployment.id,
      status: 'running',
      trigger: 'deploy',
      attempt: 1,
      lease_until: new Date(Date.now() - 60_000).toISOString(),
      model_requested: OPUS,
      model_used: OPUS,
      engine: 'agent_sdk',
      first_queued_at: new Date().toISOString(),
      started_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    const report = await runSecurityMaintenance(onEnv as never, env.db, Date.now(), {
      controller: { start: async () => ({ ok: true }) as never, cancel: async () => {} },
      forget: async () => 0,
      poke: async () => {},
      probe: async () => {},
    });
    expect(report).toMatchObject({ reaped: 1, fallbacksQueued: 1 });
    expect(await fallbackScans(project.id)).toHaveLength(1);
  });
});

describe('a fallback of a gate scan', () => {
  it('carries the open request, so a protected project still runs it under public', async () => {
    const s = await setupGate(env);
    // Stored code, so asking for public queues a gate scan.
    await env.db
      .update(deployments)
      .set({ bundle_stored: true })
      .where(eq(deployments.id, s.deployment.id));
    await env.STATIC_ASSETS_R2.put(
      `${securityScanInputPrefix(s.project.id, s.deployment.id)}modules.json`,
      '[]',
    );
    await askPublic(s);
    const [request] = await env.db
      .select()
      .from(securityPublicRequests)
      .where(eq(securityPublicRequests.project_id, s.project.id));
    const [gate] = await env.db
      .select()
      .from(securityScans)
      .where(eq(securityScans.project_id, s.project.id));
    expect(gate).toMatchObject({ trigger: 'gate', public_request_id: request!.id });
    // The gate scan ended refused on a third-party model.
    await env.db
      .update(securityScans)
      .set({
        status: 'refused',
        failure_cause: 'project',
        model_used: OPUS,
        model_requested: OPUS,
        finished_at: new Date().toISOString(),
      })
      .where(eq(securityScans.id, gate!.id));
    const policy = await savePolicy({
      mode: 'public',
      publicGate: true,
      entitlement: {
        checkedAt: new Date().toISOString(),
        ok: true,
        missing: [],
        hosts: { openai: true, anthropic: true },
      },
    });
    const [queued] = await queueSecurityFallbackScans(s.platform, env.db, policy, {
      now: Date.now(),
    });
    expect(queued).toMatchObject({ fromScanId: gate!.id });
    const [row] = await fallbackScans(s.project.id);
    expect(row).toMatchObject({
      status: 'queued',
      public_request_id: request!.id,
      coverage_notes: [],
    });

    const claim = await claimSecurityScan(env.db, {
      scanId: row!.id,
      attempt: row!.attempt,
      model: { requested: CF, used: CF, engine: 'void_loop' },
      limits: policy.limits,
      now: Date.now(),
    });
    expect(claim.kind).toBe('claimed');
  });
});

describe('the policy change (operator preview)', () => {
  it('turns the fallback on and off with a preview line', () => {
    const current = policyWith({ fallbackToCf: false, defaultModel: CF });
    const stored = { policy: current, saved: true, unreadable: null };
    const on = proposeSecurityPolicyChange(
      stored,
      parseSecurityPolicyChangeRequest({ fallbackToCf: true }),
      { userId: 'usr_admin', now: Date.now() },
    );
    expect(on.changes.fallbackToCf).toBe(true);
    expect(on.next.fallbackToCf).toBe(true);
    const lines = securityPolicyPreviewLines(current, on.next, on.changes, {
      scannedProjects: 0,
      firstFullScan: 0,
      urgentProjects: 0,
      protectedProjects: 0,
      queuedScans: 0,
      runningScans: 0,
      noOwnModel: 0,
      noOwnModelAccepted: 0,
      pickedBlocked: {},
      pickedBlockedAccepted: {},
    });
    expect(lines[0]).toContain(`Turn on: re-scan once on the @cf default (${CF})`);
    expect(() =>
      proposeSecurityPolicyChange(
        { policy: on.next, saved: true, unreadable: null },
        parseSecurityPolicyChangeRequest({ fallbackToCf: true }),
        { userId: 'usr_admin', now: Date.now() },
      ),
    ).toThrow('Nothing to change');
    expect(() => parseSecurityPolicyChangeRequest({ fallbackToCf: 'yes' })).toThrow(
      'fallbackToCf must be true or false',
    );
  });
});
