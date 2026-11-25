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
import { deployments, projects, securityScans } from '../../src/schema.ts';
import { securityScanInputPrefix } from '../../src/security/enqueue.ts';
import {
  queueSecurityFallbackScans,
  SECURITY_FALLBACK_MAX_AGE_MS,
} from '../../src/security/fallback.ts';
import { ingestSecurityScanResult } from '../../src/security/ingest.ts';
import { runSecurityMaintenance } from '../../src/security/maintenance.ts';
import { claimSecurityScan } from '../../src/security/queue.ts';
import { projectSecuritySettings, securityPublicRequests } from '../../src/security/schema.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import {
  freshEntitlement,
  insertSecurityScan,
  saveSecurityPolicy,
  securityBindings,
  storedLiveProject,
} from './security-fixtures.ts';
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
  onEnv = securityBindings(env, { scheduler: { forgetModelCalls: async () => 0 } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Fallback on, with the provider notice accepted. */
function savePolicy(overrides: Partial<SecurityPolicy> = {}) {
  return saveSecurityPolicy(env, { fallbackToCf: true, thirdPartyNotice: NOTICE, ...overrides });
}

function endedScan(
  projectId: string,
  deploymentId: string,
  overrides: Partial<typeof securityScans.$inferInsert> = {},
) {
  return insertSecurityScan(env, projectId, deploymentId, {
    status: 'refused',
    failure_cause: 'project',
    tier: 'built_diff',
    model_requested: OPUS,
    model_used: OPUS,
    engine: 'agent_sdk',
    ...overrides,
  });
}

async function fallbackScans(projectId?: string) {
  const rows = await env.db
    .select()
    .from(securityScans)
    .where(eq(securityScans.trigger, 'fallback'));
  return projectId ? rows.filter((row) => row.project_id === projectId) : rows;
}

describe('queueing a fallback scan', () => {
  it('queues one fallback of the live deployment, and only one', async () => {
    const policy = await savePolicy();
    const { project, deployment } = await storedLiveProject(env);
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
      .where(eq(securityScans.id, row.id));
    expect(await queueSecurityFallbackScans(onEnv, env.db, policy, { now: Date.now() })).toEqual(
      [],
    );
    expect(await fallbackScans(project.id)).toHaveLength(1);
  });

  it('is not hidden by a newer local check (M32)', async () => {
    const policy = await savePolicy();
    const { project, deployment } = await storedLiveProject(env);
    const failed = await endedScan(project.id, deployment.id, {
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    // A developer started a check after the deploy scan was queued; it scans no deployment.
    await env.db.insert(securityScans).values({
      id: 'scan_local_newer',
      project_id: project.id,
      deployment_id: null,
      status: 'refused',
      trigger: 'local',
      model_used: OPUS,
      finished_at: new Date().toISOString(),
    });
    const queued = await queueSecurityFallbackScans(onEnv, env.db, policy, {
      now: Date.now(),
      projectId: project.id,
    });
    expect(queued).toEqual([
      { projectId: project.id, fromScanId: failed, scanId: expect.any(String) },
    ]);
  });

  it('marks the fallback of a rescan or a sweep as that full scan', async () => {
    const policy = await savePolicy();
    for (const trigger of ['rescan', 'sweep'] as const) {
      const { project, deployment } = await storedLiveProject(env);
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

  it('keeps the client asset pass of the rescan it re-runs (M31)', async () => {
    const policy = await savePolicy();
    const { project, deployment } = await storedLiveProject(env);
    await endedScan(project.id, deployment.id, {
      trigger: 'rescan',
      tier: 'full',
      coverage_notes: ['rescan', 'client-assets', 'client-sources 3 files'],
    });
    await queueSecurityFallbackScans(onEnv, env.db, policy, {
      now: Date.now(),
      projectId: project.id,
    });
    const [row] = await fallbackScans(project.id);
    expect(row?.coverage_notes).toEqual(['rescan', 'client-assets']);
  });

  it('does nothing with the setting off, the policy Off or no @cf model left', async () => {
    const { project, deployment } = await storedLiveProject(env);
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
    const cf = await storedLiveProject(env);
    await endedScan(cf.project.id, cf.deployment.id, { model_used: CF, model_requested: CF });

    const moved = await storedLiveProject(env);
    await endedScan(moved.project.id, moved.deployment.id);
    const next = await createTestDeployment(env.db, moved.project.id, 'live');
    await env.db
      .update(projects)
      .set({ active_deployment_id: next.id })
      .where(eq(projects.id, moved.project.id));

    const old = await storedLiveProject(env);
    await endedScan(old.project.id, old.deployment.id, {
      finished_at: new Date(Date.now() - SECURITY_FALLBACK_MAX_AGE_MS - 60_000).toISOString(),
    });

    const newer = await storedLiveProject(env);
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
    const { project, deployment } = await storedLiveProject(env);
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
    const { project, deployment } = await storedLiveProject(env);
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
      reapCopies: async () => 0,
      gatewayCosts: async () => 0,
    });
    expect(report).toMatchObject({ reaped: 1, fallbacksQueued: 1 });
    expect(await fallbackScans(project.id)).toHaveLength(1);
  });
});

describe('a fallback of a gate scan', () => {
  /** A gate scan of an open public request that ended refused on a third-party model. */
  async function refusedGateScan() {
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
    expect(gate).toMatchObject({ trigger: 'gate', public_request_id: request.id });
    await env.db
      .update(securityScans)
      .set({
        status: 'refused',
        failure_cause: 'project',
        model_used: OPUS,
        model_requested: OPUS,
        finished_at: new Date().toISOString(),
      })
      .where(eq(securityScans.id, gate.id));
    const policy = await savePolicy({
      mode: 'public',
      publicGate: true,
      entitlement: freshEntitlement(),
    });
    return { s, request, gate, policy };
  }

  async function queueAndClaim({
    s,
    request,
    gate,
    policy,
  }: Awaited<ReturnType<typeof refusedGateScan>>) {
    const [queued] = await queueSecurityFallbackScans(s.platform, env.db, policy, {
      now: Date.now(),
    });
    expect(queued).toMatchObject({ fromScanId: gate.id });
    const [row] = await fallbackScans(s.project.id);
    expect(row).toMatchObject({
      status: 'queued',
      public_request_id: request.id,
      coverage_notes: [],
    });
    return claimSecurityScan(env.db, {
      scanId: row.id,
      attempt: row.attempt,
      model: { requested: CF, used: CF, engine: 'void_loop' },
      limits: policy.limits,
      now: Date.now(),
    });
  }

  it('carries the open request, so a protected project still runs it under public', async () => {
    const claim = await queueAndClaim(await refusedGateScan());
    expect(claim.kind).toBe('claimed');
  });

  it('still runs for a project whose rule is never (M34, D46)', async () => {
    const gate = await refusedGateScan();
    await env.db
      .insert(projectSecuritySettings)
      .values({ project_id: gate.s.project.id, policy_override: 'never' });
    const claim = await queueAndClaim(gate);
    expect(claim.kind).toBe('claimed');
  });
});
