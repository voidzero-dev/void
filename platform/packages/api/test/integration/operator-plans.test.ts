import { defaultSecurityPolicy } from '@void/platform/security-policy';
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
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import {
  PLAN_CATALOG_SETTING,
  readPlanCatalog,
  requireAssignablePlan,
  resolvePlan,
} from '../../src/plans.ts';
import { getPlatformSetting } from '../../src/platform-settings.ts';
import {
  operatorEvents,
  platformSettings,
  projectOwnershipPeriods,
  users,
} from '../../src/schema.ts';
import { PLAN_SECURITY_CAPS_SETTING, readSecurityPlanCap } from '../../src/security/plan-caps.ts';
import {
  readSecurityProjectSettings,
  securityProjectBudgetView,
} from '../../src/security/project-view.ts';
import { projectSecuritySettings } from '../../src/security/schema.ts';
import { getCurrentBillingPeriodStart } from '../../src/tiers.ts';
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
const calls: Array<{ id: string; path: string; body: Record<string, unknown> }> = [];
let failId: string | undefined;
let totals: Record<string, number> = {};
const counter = {
  idFromName: (id: string) => id,
  get: (id: string) => ({
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json<Record<string, unknown>>() : {};
      calls.push({ id, path, body });
      if (path === '/state') {
        const [account] = await env.db
          .select({ billingCycleStart: users.billing_cycle_start })
          .from(users)
          .where(eq(users.id, id));
        return Response.json({
          ownerUserId: id,
          totalRequests: totals[id] ?? 0,
          totalNeurons: 0,
          totalSandboxSeconds: 0,
          billingPeriodStart: getCurrentBillingPeriodStart(
            account?.billingCycleStart,
          ).toISOString(),
        });
      }
      if (failId === id && path === '/reevaluate-limits') {
        return new Response('unavailable', { status: 503 });
      }
      return Response.json({ ok: true });
    },
  }),
} as unknown as DurableObjectNamespace;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await clearTables(env.db);
  calls.length = 0;
  failId = undefined;
  totals = {};
  const admin = await createTestUser(
    env.db,
    'operator-admin',
    'github',
    undefined,
    'custom',
    'admin',
  );
  token = await createOperatorToken(env.db, admin);
});
function req(
  path: string,
  body?: Record<string, unknown>,
  overrides?: Partial<ApiEnv['Bindings']>,
) {
  return app.fetch(
    new Request(`http://localhost/operator/v1/config/plans${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    { ...env, USAGE_COUNTER: counter, ...overrides },
  );
}
async function change(path: string, body: Record<string, unknown>) {
  const catalog = await readPlanCatalog(env.db);
  return req(path, { ...body, expectedRevision: catalog.revision });
}

describe('operator installation plans', () => {
  test('preserves legacy unknown-plan quotas and short slugs without allowing new assignments', async () => {
    const historic = await resolvePlan(env.db, 'historic-tier');
    expect(historic.limits.requestsPerMonth).toBe(3_000_000);
    expect(historic.buildInstanceType).toBe('standard-3');
    expect(historic.allowShortSlugs).toBe(true);
    expect((await resolvePlan(env.db, 'free')).allowShortSlugs).toBe(false);
    await expect(requireAssignablePlan(env.db, 'historic-tier')).rejects.toThrow('Unknown plan');
  });

  test('warns that pre-upgrade unlimited requests may not be present in quota counters', async () => {
    const preview = await req('/custom/set', { dryRun: true, limits: { requestsPerMonth: 10 } });
    expect(await preview.json()).toMatchObject({
      affectedAccounts: 1,
      warnings: expect.arrayContaining([expect.stringContaining('pre-upgrade requests')]),
    });
  });

  test('allows live reads and previews but fences writes until the API rollout drains', async () => {
    const live = { PLATFORM_ENV: 'production' };
    expect((await req('', undefined, live)).status).toBe(200);
    expect((await req('/free/set', { dryRun: true, name: 'Starter' }, live)).status).toBe(200);
    expect((await req('/free/set', { expectedRevision: 0, name: 'Starter' }, live)).status).toBe(
      503,
    );
    const recent = {
      ...live,
      VERSION_METADATA: { id: 'fresh', tag: '', timestamp: new Date().toISOString() },
    };
    expect((await req('/sync', { expectedRevision: 0 }, recent)).status).toBe(503);
    const mature = {
      ...live,
      VERSION_METADATA: {
        id: 'mature',
        tag: '',
        timestamp: new Date(Date.now() - 16 * 60_000).toISOString(),
      },
    };
    expect((await req('/free/set', { expectedRevision: 0, name: 'Starter' }, mature)).status).toBe(
      200,
    );
    expect((await req('/sync', { expectedRevision: 1 }, mature)).status).toBe(200);
  });

  test('preserves hosted and installed signup defaults without writing settings on reads', async () => {
    expect(await (await req('')).json()).toMatchObject({
      catalog: { revision: 0, defaultPlanId: 'free' },
    });
    expect(
      await (await req('', undefined, { PLATFORM_INSTALLATION_ID: 'team' })).json(),
    ).toMatchObject({ catalog: { revision: 0, defaultPlanId: 'custom' } });
    expect(
      await env.db
        .select()
        .from(platformSettings)
        .where(eq(platformSettings.key, PLAN_CATALOG_SETTING)),
    ).toHaveLength(0);
    const result = await req(
      '/add',
      { id: 'team', name: 'Team', copyFrom: 'pro', expectedRevision: 0 },
      { PLATFORM_INSTALLATION_ID: 'team' },
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ catalog: { defaultPlanId: 'custom' } });
  });

  test('copies complete limits and build size, changes names without changing IDs and sets the signup default', async () => {
    const add = await change('/add', {
      id: 'team',
      name: 'Team',
      copyFrom: 'pro',
      limits: { requestsPerMonth: 25_000_000 },
    });
    expect(add.status).toBe(200);
    const shown = await (
      await req('/team')
    ).json<{
      plan: {
        id: string;
        name: string;
        buildInstanceType: string;
        limits: { requestsPerMonth: number; retainedDeployments: number };
      };
    }>();
    expect(shown.plan).toMatchObject({
      id: 'team',
      name: 'Team',
      buildInstanceType: 'standard-4',
      limits: { requestsPerMonth: 25_000_000, retainedDeployments: 25 },
    });
    expect((await change('/team/set', { name: 'Team Plus' })).status).toBe(200);
    expect((await change('/default', { planId: 'team' })).status).toBe(200);
    expect(await (await req('/team')).json()).toMatchObject({
      default: true,
      plan: { id: 'team', name: 'Team Plus' },
    });
  });

  test('previews exact affected accounts and sampled current overages without mutating the catalog or audit', async () => {
    const owner = await createTestUser(env.db, 'owner');
    await env.db
      .update(users)
      .set({ billing_cycle_start: '2025-01-15T00:00:00.000Z' })
      .where(eq(users.id, owner.id));
    totals[owner.id] = 300;
    const preview = await req('/free/set', { dryRun: true, limits: { requestsPerMonth: 100 } });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      dryRun: true,
      expectedRevision: 0,
      affectedAccounts: 1,
      loweredLimits: ['requestsPerMonth'],
      overLimitAccounts: [{ id: owner.id, login: 'owner', reasons: ['requestsPerMonth'] }],
      warnings: [expect.stringContaining('existing usage')],
    });
    expect((await readPlanCatalog(env.db)).revision).toBe(0);
    expect(calls.map((call) => call.path)).toEqual(['/state']);
    expect(await env.db.select().from(operatorEvents)).toHaveLength(0);
  });

  test('rejects stale writes, invalid numeric limits and unenforced storage edits', async () => {
    expect((await req('/free/set', { limits: { requestsPerMonth: 100 } })).status).toBe(400);
    expect((await change('/free/set', { name: 'Free' })).status).toBe(200);
    expect(
      (await req('/free/set', { expectedRevision: 0, limits: { requestsPerMonth: 100 } })).status,
    ).toBe(409);
    for (const limits of [
      { d1StorageBytes: 2 },
      { requestsPerMonth: -1 },
      { requestsPerMonth: 0.5 },
      { cpuMsPerRequest: 11 },
    ]) {
      expect((await change('/free/set', { limits })).status).toBe(400);
    }
    expect((await readPlanCatalog(env.db)).revision).toBe(1);
  });

  test('refreshes existing routes and quota decisions while retaining administrator suspensions and billing anchors', async () => {
    const owner = await createTestUser(env.db, 'owner');
    const project = await createTestProject(env.db, owner.id, 'plan-policy-project');
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin_suspended' })
      .where(eq(users.id, owner.id));
    await env.ROUTING.put(
      project.slug,
      JSON.stringify({ workerName: 'worker', projectId: project.id, userId: owner.id }),
    );
    const before = (await env.db.select().from(users).where(eq(users.id, owner.id)))[0];
    const response = await change('/free/set', {
      limits: { cpuMsPerRequest: 20, maxCpuMsPerRequest: 20, requestsPerMonth: 10_000_000 },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      reconciliation: { complete: true, processed: 1 },
    });
    const after = (await env.db.select().from(users).where(eq(users.id, owner.id)))[0];
    expect(after.billing_cycle_start).toBe(before.billing_cycle_start);
    expect(after.suspended_reason).toBe('admin_suspended');
    expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({
      limits: { cpuMs: 20 },
      suspended: 'admin_suspended',
    });
    expect(calls.map((call) => call.path)).toEqual(['/init', '/reevaluate-limits']);
    expect(calls[0].body).toMatchObject({
      userId: owner.id,
      plan: 'free',
      billingPeriodStart: expect.any(String),
    });
    expect(await env.db.select().from(operatorEvents)).toMatchObject([
      {
        action: 'config/plans/free/set',
        status: 'success',
        target: expect.stringContaining('requestsPerMonth'),
      },
    ]);
  });

  test('archives without moving accounts and restores assignability; protects the default', async () => {
    await createTestUser(env.db, 'paid-owner', 'github', undefined, 'pro');
    expect((await change('/pro/archive', {})).status).toBe(200);
    expect(await (await req('/pro')).json()).toMatchObject({
      plan: { archived: true },
      accounts: 1,
    });
    expect((await change('/default', { planId: 'pro' })).status).toBe(409);
    expect((await change('/free/archive', {})).status).toBe(409);
    expect((await change('/pro/archive', { archived: false })).status).toBe(200);
    expect((await change('/default', { planId: 'pro' })).status).toBe(200);
  });

  test('requires a replacement for assigned plans and atomically moves accounts without touching usage ownership', async () => {
    const owner = await createTestUser(env.db, 'paid-owner', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, owner.id, 'plan-removal');
    await env.db
      .update(projectOwnershipPeriods)
      .set({ starts_at: '2026-01-01T00:00:00Z' })
      .where(eq(projectOwnershipPeriods.project_id, project.id));
    const before = (await env.db.select().from(users).where(eq(users.id, owner.id)))[0];
    const periods = await env.db.select().from(projectOwnershipPeriods);
    expect((await change('/pro/remove', {})).status).toBe(409);
    expect((await change('/pro/remove', { replacementPlanId: 'pro' })).status).toBe(400);
    const preview = await req('/pro/remove', { dryRun: true, replacementPlanId: 'solo' });
    expect(await preview.json()).toMatchObject({ removedPlanId: 'pro', replacementPlanId: 'solo' });
    const response = await change('/pro/remove', { replacementPlanId: 'solo' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ affectedAccounts: 1, ok: true });
    expect((await req('/pro')).status).toBe(404);
    const after = (await env.db.select().from(users).where(eq(users.id, owner.id)))[0];
    expect(after).toMatchObject({
      plan: 'solo',
      billing_cycle_start: before.billing_cycle_start,
      created_at: before.created_at,
    });
    expect(await env.db.select().from(projectOwnershipPeriods)).toEqual(periods);
    expect(calls.find((call) => call.path === '/init')?.body).toMatchObject({
      userId: owner.id,
      plan: 'solo',
    });
  });

  test('resets built-in enforced settings but keeps names and blocks default removal without a replacement', async () => {
    await change('/free/set', {
      name: 'Starter',
      limits: { requestsPerMonth: 1 },
      buildInstanceType: 'standard-4',
    });
    expect((await change('/free/reset', {})).status).toBe(200);
    expect(await (await req('/free')).json()).toMatchObject({
      plan: {
        name: 'Starter',
        limits: { requestsPerMonth: 3_000_000 },
        buildInstanceType: 'standard-3',
      },
    });
    expect((await change('/free/remove', {})).status).toBe(409);
    expect((await change('/free/remove', { replacementPlanId: 'solo' })).status).toBe(200);
    expect((await readPlanCatalog(env.db)).defaultPlanId).toBe('solo');
  });

  test('keeps partial updates discoverable, blocks edits and retries durable reconciliation without losing usage', async () => {
    const owner = await createTestUser(env.db, 'retry-owner');
    failId = owner.id;
    const response = await change('/free/set', { limits: { requestsPerMonth: 10 } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      reconciliation: { complete: false, error: { accountId: owner.id } },
    });
    expect((await readPlanCatalog(env.db)).plans[0].limits.requestsPerMonth).toBe(10);
    expect((await change('/free/set', { name: 'Starter' })).status).toBe(409);
    const dry = await req('/sync', { dryRun: true });
    expect(await dry.json()).toMatchObject({
      affectedAccounts: 1,
      reconciliation: { complete: false },
    });
    failId = undefined;
    expect(await (await change('/sync', {})).json()).toMatchObject({
      ok: true,
      reconciliation: { complete: true, processed: 1 },
    });
    expect((await change('/free/set', { name: 'Starter' })).status).toBe(200);
    expect(
      calls.every(
        (call) => !['/reset', '/reset-billing-period', '/reevaluate-sandbox'].includes(call.path),
      ),
    ).toBe(true);
  });

  test('bounds reconciliation pages and continues through the saved keyset cursor', async () => {
    for (let index = 0; index < 26; index++) {
      await createTestUser(env.db, `owner-${index}`);
    }
    const first = await change('/free/set', { limits: { requestsPerMonth: 10 } });
    expect(await first.json()).toMatchObject({
      ok: true,
      affectedAccounts: 26,
      reconciliation: { complete: false, processed: 25 },
    });
    const cursor = (await readPlanCatalog(env.db)).reconciliation!.cursor;
    expect(cursor).not.toBeNull();
    const second = await change('/sync', {});
    expect(await second.json()).toMatchObject({
      ok: true,
      reconciliation: { complete: true, processed: 1 },
    });
    const initialized = calls.flatMap((call) => (call.path === '/init' ? [call.id] : []));
    expect(initialized).toHaveLength(26);
    expect(new Set(initialized).size).toBe(26);
  });

  test('a late failed retry cannot overwrite a completed reconciliation', async () => {
    const owner = await createTestUser(env.db, 'concurrent-owner');
    let started!: () => void;
    let resume!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resumePromise = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const stalledCounter = {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname === '/reevaluate-limits') {
            started();
            await resumePromise;
            return new Response('unavailable', { status: 503 });
          }
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;
    const first = req(
      '/free/set',
      { expectedRevision: 0, limits: { requestsPerMonth: 10 } },
      { USAGE_COUNTER: stalledCounter },
    );
    await startedPromise;
    const retry = await change('/sync', {});
    expect(await retry.json()).toMatchObject({ ok: true, reconciliation: { complete: true } });
    resume();
    expect(await (await first).json()).toMatchObject({
      ok: true,
      reconciliation: { complete: true },
    });
    const catalog = await readPlanCatalog(env.db);
    expect(catalog.reconciliation).toMatchObject({ complete: true, cursor: owner.id });
    expect(catalog.reconciliation?.error).toBeUndefined();
    expect((await change('/free/set', { name: 'Starter' })).status).toBe(200);
  });
});

describe('operator plan security scan caps (M27)', () => {
  async function caps() {
    return getPlatformSetting(env.db, PLAN_SECURITY_CAPS_SETTING);
  }

  test('sets, shows, previews and clears a plan cap in its own setting', async () => {
    const preview = await req('/pro/set', { dryRun: true, securityCap: 50 });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      securityCaps: { caps: { pro: 5000 }, capsBefore: {} },
    });
    expect(await caps()).toBeNull();
    expect((await change('/pro/set', { securityCap: 50 })).status).toBe(200);
    expect(await caps()).toEqual({ pro: 5000 });
    // The catalog keeps the exact limit keys: the cap is not a plan limit.
    const catalog = await readPlanCatalog(env.db);
    expect(Object.keys(catalog.plans.find((plan) => plan.id === 'pro')!.limits)).not.toContain(
      'securityCap',
    );
    expect(await (await req('/pro')).json()).toMatchObject({ securityCap: 5000 });
    expect(await (await req('')).json()).toMatchObject({ securityCaps: { pro: 5000 } });
    expect((await change('/pro/set', { securityCap: 'none' })).status).toBe(200);
    expect(await caps()).toEqual({ pro: null });
    expect(await (await req('/pro')).json()).toMatchObject({ securityCap: 'none' });
    expect((await change('/pro/set', { securityCap: 'inherit' })).status).toBe(200);
    expect(await caps()).toEqual({});
    expect(await (await req('/pro')).json()).toMatchObject({ securityCap: 'inherit' });
    // Other plan edits keep the cap.
    expect((await change('/pro/set', { securityCap: 12.5 })).status).toBe(200);
    expect((await change('/pro/set', { name: 'Pro Plus' })).status).toBe(200);
    expect(await caps()).toEqual({ pro: 1250 });
  });

  test('copies the cap on add and drops it with the removed plan', async () => {
    expect((await change('/pro/set', { securityCap: 30 })).status).toBe(200);
    expect((await change('/add', { id: 'team', name: 'Team', copyFrom: 'pro' })).status).toBe(200);
    expect(await caps()).toEqual({ pro: 3000, team: 3000 });
    expect(
      (await change('/add', { id: 'lab', name: 'Lab', copyFrom: 'pro', securityCap: 'none' }))
        .status,
    ).toBe(200);
    expect(await caps()).toEqual({ pro: 3000, team: 3000, lab: null });
    expect((await change('/team/remove', {})).status).toBe(200);
    expect(await caps()).toEqual({ pro: 3000, lab: null });
  });

  test('refuses a bad cap and a cap on other actions, writing nothing', async () => {
    for (const securityCap of [12.345, -1, 2_000_000, '50', null]) {
      const response = await change('/pro/set', { securityCap });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_argument' });
    }
    const archive = await change('/pro/archive', { securityCap: 5 });
    expect(archive.status).toBe(400);
    expect(await caps()).toBeNull();
    expect((await readPlanCatalog(env.db)).revision).toBe(0);
  });

  test("a project's budget follows its owner's plan cap, after a per-project limit", async () => {
    const owner = await createTestUser(env.db, 'cap-owner', 'github', undefined, 'pro');
    const project = await createTestProject(env.db, owner.id);
    const other = await createTestProject(
      env.db,
      (await createTestUser(env.db, 'free-owner', 'github', undefined, 'free')).id,
    );
    const policy = defaultSecurityPolicy();
    const budget = async (id: string) => {
      const settings = await readSecurityProjectSettings(env.db, id);
      return securityProjectBudgetView(env.db, id, policy, settings.caps);
    };
    expect(await readSecurityPlanCap(env.db, project.id)).toBe('inherit');
    expect(await budget(project.id)).toMatchObject({ ceilingUsd: null, ceilingSource: null });
    expect((await change('/pro/set', { securityCap: 40 })).status).toBe(200);
    expect(await readSecurityPlanCap(env.db, project.id)).toBe(4000);
    expect(await readSecurityPlanCap(env.db, other.id)).toBe('inherit');
    expect(await budget(project.id)).toMatchObject({
      capUsd: 40,
      capSource: 'limit',
      ceilingUsd: 40,
      ceilingSource: 'plan',
    });
    // A stored JSON null is "no cap", not a missing entry.
    expect((await change('/pro/set', { securityCap: 'none' })).status).toBe(200);
    expect(await readSecurityPlanCap(env.db, project.id)).toBe('none');
    // The installation admin's per-project limit still comes first.
    expect((await change('/pro/set', { securityCap: 40 })).status).toBe(200);
    await env.db
      .insert(projectSecuritySettings)
      .values({ project_id: project.id, cap_ceiling_cents: 9000 });
    expect(await budget(project.id)).toMatchObject({
      capUsd: 90,
      ceilingUsd: 90,
      ceilingSource: 'project',
    });
    // A bad stored entry reads as the policy default.
    await env.db
      .update(platformSettings)
      .set({ value: { pro: 'lots', free: 100 } })
      .where(eq(platformSettings.key, PLAN_SECURITY_CAPS_SETTING));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await readSecurityPlanCap(env.db, project.id)).toBe('inherit');
    expect(await readSecurityPlanCap(env.db, other.id)).toBe(100);
    expect(await (await req('')).json()).toMatchObject({ securityCaps: { free: 100 } });
  });
});
