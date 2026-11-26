import { securityModelCostNanoUsd } from '@void/platform/security-models';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import {
  projectSecuritySettings,
  securityPlatformSpend,
  securityProjectSpend,
  securityScans,
} from '../../src/schema.ts';
import {
  holdSecurityModelCall,
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
import { saveSecurityPolicy } from './security-fixtures.ts';

const CF = '@cf/zai-org/glm-5.3';
const NOV = '2026-11-01';
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

  const savePolicy = (changes: Partial<SecurityPolicy>) => saveSecurityPolicy(env, changes);

  function chat(): Request {
    return new Request('http://model.void.internal/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: CF, messages: [{ role: 'user', content: 'scan' }] }),
    });
  }

  test('meters tokens × list price, and a project cap stops the next call that could cross it', async () => {
    const p = await project('spend-meter');
    await scan(p.id, p.deploymentId, 'ss_1');
    await savePolicy({});
    const run = vi.fn(async () => ({
      response: 'ok',
      usage: { prompt_tokens: 12_345, completion_tokens: 678 },
    }));
    const proxy = deps({ ai: { run } as unknown as Ai });
    expect((await handleSecurityModelRequest(proxy, 'ss_1', 1, chat())).status).toBe(200);
    const expected = securityModelCostNanoUsd(CF, 12_345, 678)!;
    expect(await scanRow('ss_1')).toMatchObject({ model_calls: 1, metered_nano_usd: expected });
    expect((await projectSpend(p.id)).spent_nano_usd).toBe(expected);
    expect((await platformSpend()).spent_nano_usd).toBe(expected);

    // $0.9999 spent of a $1.00 cap: the next call's worst case does not fit.
    await env.db
      .insert(projectSecuritySettings)
      .values({ project_id: p.id, monthly_cap_cents: 100 });
    await env.db
      .update(securityProjectSpend)
      .set({ spent_nano_usd: 999_900_000 })
      .where(eq(securityProjectSpend.project_id, p.id));
    const stopped = await handleSecurityModelRequest(proxy, 'ss_1', 1, chat());
    expect(stopped.status).toBe(429);
    expect(stopped.headers.get(SECURITY_STOP_HEADER)).toBe('budget');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
