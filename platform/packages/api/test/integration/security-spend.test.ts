import { securityModelCostNanoUsd } from '@void/platform/security-models';
import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
} from '@void/platform/security-policy';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import {
  projectSecuritySettings,
  securityPlatformSpend,
  securityProjectSpend,
  securityScans,
} from '../../src/schema.ts';
import {
  holdSecurityModelCall,
  releaseSecurityScanReserve,
  reserveSecurityScanBudget,
  settleSecurityModelCall,
} from '../../src/security/budget.ts';
import {
  handleSecurityModelRequest,
  loadSecurityModelScan,
  SECURITY_STOP_HEADER,
} from '../../src/security/model-proxy.ts';
import type { SecurityModelProxyDeps } from '../../src/security/model-proxy.ts';
import { readSecurityPolicyLenient } from '../../src/security/policy.ts';
import {
  clearTables,
  createTestDeployment,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';

const CF = '@cf/zai-org/glm-5.3';
const NOV = '2026-11-01';
const DEC = '2026-12-01';
const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const LEASE = '2026-11-18T13:00:00.000Z';
const USD = 1_000_000_000;

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});

afterAll(async () => {
  await teardownEnv();
});

beforeEach(async () => {
  await clearTables(env.db);
});

async function project(slug: string) {
  const user = await createTestUser(env.db, `owner-${slug}`);
  const created = await createTestProject(env.db, user.id, slug);
  const deployment = await createTestDeployment(env.db, created.id);
  return { ...created, deploymentId: deployment.id };
}

async function scan(
  projectId: string,
  deploymentId: string,
  id: string,
  overrides: Partial<typeof securityScans.$inferInsert> = {},
) {
  await env.db.insert(securityScans).values({
    id,
    project_id: projectId,
    deployment_id: deploymentId,
    status: 'running',
    trigger: 'deploy',
    attempt: 1,
    lease_until: LEASE,
    model_used: CF,
    engine: 'void_loop',
    ...overrides,
  });
}

async function projectSpend(projectId: string, month = NOV) {
  const [row] = await env.db
    .select()
    .from(securityProjectSpend)
    .where(
      and(eq(securityProjectSpend.project_id, projectId), eq(securityProjectSpend.month, month)),
    );
  return row;
}

async function platformSpend(month = NOV) {
  const [row] = await env.db
    .select()
    .from(securityPlatformSpend)
    .where(eq(securityPlatformSpend.month, month));
  return row;
}

async function scanRow(id: string) {
  const [row] = await env.db.select().from(securityScans).where(eq(securityScans.id, id));
  return row;
}

const noCaps = { projectNano: null, platformNano: null };

describe('scan start reserve', () => {
  test('two scans near the platform cap: both reserve, only one fits (edge #51)', async () => {
    const a = await project('spend-a');
    const b = await project('spend-b');
    await scan(a.id, a.deploymentId, 'ss_a');
    await scan(b.id, b.deploymentId, 'ss_b');
    await env.db.insert(securityPlatformSpend).values({ month: NOV, spent_nano_usd: 8 * USD });
    const caps = { projectNano: null, platformNano: 10 * USD };
    const results = await Promise.all([
      reserveSecurityScanBudget(env.db, {
        scanId: 'ss_a',
        attempt: 1,
        projectId: a.id,
        reserveNano: 1.5 * USD,
        caps,
        now: NOW,
      }),
      reserveSecurityScanBudget(env.db, {
        scanId: 'ss_b',
        attempt: 1,
        projectId: b.id,
        reserveNano: 1.5 * USD,
        caps,
        now: NOW,
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({
      ok: false,
      cap: 'platform',
      capNano: 10 * USD,
      spentNano: 8 * USD,
    });
    expect((await platformSpend()).reserved_nano_usd).toBe(1.5 * USD);
    const reserved = [await scanRow('ss_a'), await scanRow('ss_b')].map(
      (row) => row.reserved_nano_usd,
    );
    expect(reserved.sort((a, b) => a - b)).toEqual([0, 1.5 * USD]);
    // The refused scan left no trace on its project row either.
    const loser = results[0].ok ? b : a;
    expect((await projectSpend(loser.id))?.reserved_nano_usd ?? 0).toBe(0);
    expect((await projectSpend(loser.id))?.scans ?? 0).toBe(0);
  });

  test('a project cap counts spent and other running reserves', async () => {
    const p = await project('spend-project');
    await scan(p.id, p.deploymentId, 'ss_1');
    await scan(p.id, p.deploymentId, 'ss_2', { status: 'queued', lease_until: null });
    await env.db.insert(securityProjectSpend).values({
      project_id: p.id,
      month: NOV,
      spent_nano_usd: 2 * USD,
      reserved_nano_usd: 1 * USD,
    });
    const caps = { projectNano: 4 * USD, platformNano: null };
    await expect(
      reserveSecurityScanBudget(env.db, {
        scanId: 'ss_1',
        attempt: 1,
        projectId: p.id,
        reserveNano: 1.5 * USD,
        caps,
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, cap: 'project', capNano: 4 * USD, spentNano: 2 * USD });
    await expect(
      reserveSecurityScanBudget(env.db, {
        scanId: 'ss_1',
        attempt: 1,
        projectId: p.id,
        reserveNano: 1 * USD,
        caps,
        now: NOW,
      }),
    ).resolves.toEqual({ ok: true, month: NOV, reserveNano: 1 * USD });
    expect(await projectSpend(p.id)).toMatchObject({ reserved_nano_usd: 2 * USD, scans: 1 });
    expect((await scanRow('ss_1')).started_at).not.toBeNull();
    // Only the row running at that attempt takes a reserve: a queued (canceled,
    // reaped) row or an older attempt writes nothing.
    for (const [scanId, attempt] of [
      ['ss_2', 0],
      ['ss_1', 2],
    ] as const) {
      await expect(
        reserveSecurityScanBudget(env.db, {
          scanId,
          attempt,
          projectId: p.id,
          reserveNano: 1,
          caps: noCaps,
          now: NOW,
        }),
      ).resolves.toEqual({ ok: false, gone: true });
    }
    expect((await scanRow('ss_2')).reserved_nano_usd).toBe(0);
    // A second reserve for the same scan is refused, so a retry cannot hold two.
    await expect(
      reserveSecurityScanBudget(env.db, {
        scanId: 'ss_1',
        attempt: 1,
        projectId: p.id,
        reserveNano: 1,
        caps: noCaps,
        now: NOW,
      }),
    ).rejects.toThrow('already holds a reserve');
    expect(await projectSpend(p.id)).toMatchObject({ reserved_nano_usd: 2 * USD, scans: 1 });
  });

  test('a scan across midnight on the 1st: calls count in their month, the reserve goes back to its own (edge #52)', async () => {
    const p = await project('spend-midnight');
    await scan(p.id, p.deploymentId, 'ss_1', { lease_until: '2026-12-01T01:00:00.000Z' });
    const start = Date.parse('2026-11-30T23:50:00.000Z');
    await reserveSecurityScanBudget(env.db, {
      scanId: 'ss_1',
      attempt: 1,
      projectId: p.id,
      reserveNano: 1 * USD,
      caps: noCaps,
      now: start,
    });
    const after = Date.parse('2026-12-01T00:05:00.000Z');
    const hold = await holdSecurityModelCall(env.db, {
      scanId: 'ss_1',
      attempt: 1,
      projectId: p.id,
      worstNano: 300_000,
      maxCalls: 80,
      maxInputTokens: 600_000,
      maxOutputTokens: 60_000,
      caps: noCaps,
      now: after,
    });
    expect(hold).toMatchObject({ ok: true, month: DEC });
    await settleSecurityModelCall(env.db, {
      scanId: 'ss_1',
      projectId: p.id,
      month: DEC,
      holdNano: 300_000,
      actualNano: 100_000,
      inputTokens: 50,
      outputTokens: 5,
    });
    await expect(releaseSecurityScanReserve(env.db, 'ss_1')).resolves.toBe(1 * USD);
    await expect(releaseSecurityScanReserve(env.db, 'ss_1')).resolves.toBe(0);
    expect(await projectSpend(p.id, NOV)).toMatchObject({
      spent_nano_usd: 0,
      reserved_nano_usd: 0,
    });
    expect(await projectSpend(p.id, DEC)).toMatchObject({
      spent_nano_usd: 100_000,
      reserved_nano_usd: 0,
    });
    expect(await platformSpend(DEC)).toMatchObject({ spent_nano_usd: 100_000 });
    expect(await scanRow('ss_1')).toMatchObject({
      reserved_nano_usd: 0,
      metered_nano_usd: 100_000,
      tokens_in: 50,
      tokens_out: 5,
      model_calls: 1,
    });
  });
});

describe('per-call hold and settle', () => {
  test('a cap lowered below spent stops the next call; nothing is written (edge #50)', async () => {
    const p = await project('spend-lowered');
    await scan(p.id, p.deploymentId, 'ss_1');
    await env.db
      .insert(securityProjectSpend)
      .values({ project_id: p.id, month: NOV, spent_nano_usd: 50 * USD });
    const result = await holdSecurityModelCall(env.db, {
      scanId: 'ss_1',
      attempt: 1,
      projectId: p.id,
      worstNano: 1,
      maxCalls: 80,
      maxInputTokens: 600_000,
      maxOutputTokens: 60_000,
      caps: { projectNano: 40 * USD, platformNano: null },
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'budget',
      cap: 'project',
      capNano: 40 * USD,
      spentNano: 50 * USD,
    });
    expect(await scanRow('ss_1')).toMatchObject({ model_calls: 0, metered_nano_usd: 0 });
    expect(await platformSpend()).toBeUndefined();
  });

  test('call cap, token cap and a stale attempt are refused in the same statement', async () => {
    const p = await project('spend-caps');
    await scan(p.id, p.deploymentId, 'ss_1', { model_calls: 80 });
    await scan(p.id, p.deploymentId, 'ss_2', { status: 'succeeded', lease_until: null });
    // One running scan per project, so the token case gets its own project.
    const q = await project('spend-caps-tokens');
    await scan(q.id, q.deploymentId, 'ss_3', { tokens_out: 60_000 });
    const input = {
      attempt: 1,
      projectId: p.id,
      worstNano: 1,
      maxCalls: 80,
      maxInputTokens: 600_000,
      maxOutputTokens: 60_000,
      caps: noCaps,
      now: NOW,
    };
    await expect(holdSecurityModelCall(env.db, { ...input, scanId: 'ss_1' })).resolves.toEqual({
      ok: false,
      reason: 'scan_calls',
    });
    await expect(holdSecurityModelCall(env.db, { ...input, scanId: 'ss_2' })).resolves.toEqual({
      ok: false,
      reason: 'fence',
    });
    await expect(
      holdSecurityModelCall(env.db, { ...input, scanId: 'ss_1', attempt: 2 }),
    ).resolves.toEqual({ ok: false, reason: 'fence' });
    await expect(
      holdSecurityModelCall(env.db, { ...input, scanId: 'ss_3', projectId: q.id }),
    ).resolves.toEqual({
      ok: false,
      reason: 'tokens',
    });
  });
});

describe('model proxy on real SQL', () => {
  function deps(overrides: Partial<SecurityModelProxyDeps>): SecurityModelProxyDeps {
    return {
      now: () => NOW,
      sleep: async () => {},
      loadScan: (scanId) => loadSecurityModelScan(env.db, scanId),
      readPolicy: () => readSecurityPolicyLenient(env.db),
      admit: async () => ({ ok: true, sessionCalls: null }),
      recordFailure: async () => {},
      lastFailure: async () => null,
      rateLimited: async () => {},
      hold: (input) => holdSecurityModelCall(env.db, input),
      settle: (input) => settleSecurityModelCall(env.db, input),
      scanTag: async (scanId) => `${scanId}.tag`,
      gatewayId: 'void',
      accountId: 'acct',
      apiToken: 'token',
      ai: undefined,
      fetch: async () => Response.json({}),
      ...overrides,
    };
  }

  async function savePolicy(changes: Partial<SecurityPolicy>) {
    await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
      ...defaultSecurityPolicy(),
      mode: 'all',
      revision: 1,
      ...changes,
    });
  }

  function chat(): Request {
    return new Request('http://model.void.internal/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: CF, messages: [{ role: 'user', content: 'scan' }] }),
    });
  }

  test('metered spend equals tokens × list price on the scan and both month rows', async () => {
    const p = await project('spend-meter');
    await scan(p.id, p.deploymentId, 'ss_1');
    await savePolicy({});
    const run = vi.fn(async () => ({
      response: 'ok',
      usage: { prompt_tokens: 12_345, completion_tokens: 678 },
    }));
    const proxy = deps({ ai: { run } as unknown as Ai });
    for (let index = 0; index < 3; index++) {
      expect((await handleSecurityModelRequest(proxy, 'ss_1', 1, chat())).status).toBe(200);
    }
    const expected = 3 * securityModelCostNanoUsd(CF, 12_345, 678)!;
    expect(expected).toBe(3 * (12_345 * 1400 + 678 * 4400));
    expect(await scanRow('ss_1')).toMatchObject({
      model_calls: 3,
      tokens_in: 3 * 12_345,
      tokens_out: 3 * 678,
      metered_nano_usd: expected,
    });
    expect((await projectSpend(p.id)).spent_nano_usd).toBe(expected);
    expect((await platformSpend()).spent_nano_usd).toBe(expected);
  });

  test('a project cap stops the scan at the next call that could cross it', async () => {
    const p = await project('spend-proxy-cap');
    await scan(p.id, p.deploymentId, 'ss_1');
    await savePolicy({});
    await env.db
      .insert(projectSecuritySettings)
      .values({ project_id: p.id, monthly_cap_cents: 100 });
    // $0.9999 spent of a $1.00 cap: the next call's worst case does not fit.
    await env.db
      .insert(securityProjectSpend)
      .values({ project_id: p.id, month: NOV, spent_nano_usd: 999_900_000 });
    const run = vi.fn();
    const response = await handleSecurityModelRequest(
      deps({ ai: { run } as unknown as Ai }),
      'ss_1',
      1,
      chat(),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get(SECURITY_STOP_HEADER)).toBe('budget');
    expect(run).not.toHaveBeenCalled();
    expect(await scanRow('ss_1')).toMatchObject({ model_calls: 0, metered_nano_usd: 0 });
  });

  test('a failed upstream call gives its hold back', async () => {
    const p = await project('spend-proxy-fail');
    await scan(p.id, p.deploymentId, 'ss_1');
    await savePolicy({});
    const run = vi.fn(async () => {
      throw Object.assign(new Error('upstream down'), { status: 500 });
    });
    const response = await handleSecurityModelRequest(
      deps({ ai: { run } as unknown as Ai }),
      'ss_1',
      1,
      chat(),
    );
    expect(response.status).toBe(500);
    expect(await scanRow('ss_1')).toMatchObject({ model_calls: 1, metered_nano_usd: 0 });
    expect((await projectSpend(p.id)).spent_nano_usd).toBe(0);
    expect((await platformSpend()).spent_nano_usd).toBe(0);
  });
});
