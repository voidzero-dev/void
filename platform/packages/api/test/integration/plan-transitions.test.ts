import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vite-plus/test';
import { getUser } from '../../src/db.ts';
import type { ApiEnv } from '../../src/env.ts';
import { app } from '../../src/index.ts';
import { readPlanCatalog } from '../../src/plans.ts';
import { domains, users } from '../../src/schema.ts';
import { getCurrentBillingPeriodStart } from '../../src/tiers.ts';
import type { CounterState } from '../../src/usage-counter.ts';
import {
  clearTables,
  createOperatorToken,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { createUsageCounterFixture } from './usage-counter-fixture.ts';

let env: TestEnv;
let token: string;
let counters: DurableObjectNamespace;
beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
  const admin = await createTestUser(env.db, 'plans-admin', 'github', undefined, 'custom', 'admin');
  token = await createOperatorToken(env.db, admin);
  counters = createUsageCounterFixture(env as unknown as ApiEnv['Bindings']);
});

async function change(path: string, body: Record<string, unknown>) {
  const catalog = await readPlanCatalog(env.db);
  const response = await app.fetch(
    new Request(`http://localhost/operator/v1/config/plans${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, expectedRevision: catalog.revision }),
    }),
    { ...env, USAGE_COUNTER: counters },
  );
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, reconciliation: { complete: true } });
}

describe('live plan transitions using the production quota counter', () => {
  test.each(['requests_exceeded', 'operator_review'])(
    'advances a prior billing period during plan reconciliation while preserving %s policy',
    async (reason) => {
      const owner = await createTestUser(env.db, 'rollover-owner');
      const project = await createTestProject(env.db, owner.id, 'rollover-project');
      const original = (await getUser(env.db, owner.id))!;
      const currentPeriod = getCurrentBillingPeriodStart(
        original.billing_cycle_start,
      ).toISOString();
      const priorPeriod = new Date(
        Date.parse(currentPeriod) - 40 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await env.db.update(users).set({ suspended_reason: reason }).where(eq(users.id, owner.id));
      await env.ROUTING.put(
        project.slug,
        JSON.stringify({
          projectId: project.id,
          userId: owner.id,
          workerName: 'existing-worker',
          suspended: reason,
        }),
      );
      await env.ROUTING.put('ai-block:' + project.id, '1');
      await env.ROUTING.put('sandbox-block:' + owner.id, '1');
      counters = createUsageCounterFixture(env as unknown as ApiEnv['Bindings'], {
        [owner.id]: {
          ownerUserId: owner.id,
          plan: 'free',
          billingPeriodStart: priorPeriod,
          billingPeriodInitialized: true,
          totalRequests: 9000,
          totalNeurons: 120_000,
          totalSandboxSeconds: 100,
          requestsSuspended: true,
          aiSuspended: true,
          sandboxRuntimeSuspended: true,
          projectSlugs: { [project.id]: project.slug },
        },
      });
      await change('/free/set', { limits: { requestsPerMonth: 10 } });
      const counter = counters.get(counters.idFromName(owner.id));
      const state = await (await counter.fetch(new Request('https://do/state'))).json();
      expect(state).toMatchObject({
        billingPeriodStart: currentPeriod,
        totalRequests: 0,
        totalNeurons: 0,
        totalSandboxSeconds: 0,
        requestsSuspended: false,
        aiSuspended: false,
        sandboxRuntimeSuspended: false,
      });
      expect(await getUser(env.db, owner.id)).toMatchObject({
        billing_cycle_start: original.billing_cycle_start,
        suspended_reason: reason === 'operator_review' ? reason : null,
      });
      expect(JSON.parse((await env.ROUTING.get(project.slug))!)).toMatchObject({
        workerName: 'existing-worker',
        ...(reason === 'operator_review' ? { suspended: reason } : {}),
      });
      expect(await env.ROUTING.get('ai-block:' + project.id)).toBeNull();
      expect(await env.ROUTING.get('sandbox-block:' + owner.id)).toBeNull();
      await counter.fetch(
        new Request('https://do/record', {
          method: 'POST',
          body: JSON.stringify({
            userId: owner.id,
            events: [
              {
                projectId: project.id,
                userId: owner.id,
                slug: project.slug,
                requests: 3,
                responseBytes: 0,
              },
            ],
          }),
        }),
      );
      await change('/free/set', { limits: { requestsPerMonth: 5 } });
      expect(await (await counter.fetch(new Request('https://do/state'))).json()).toMatchObject({
        totalRequests: 3,
        billingPeriodStart: currentPeriod,
        requestsSuspended: false,
      });
    },
  );

  test('retains capped and unlimited usage, updates both routes, and preserves manual suspension', async () => {
    const owner = await createTestUser(env.db, 'transition-owner');
    const project = await createTestProject(env.db, owner.id, 'transition-project');
    const hostname = 'plans.example.test';
    await env.db.insert(domains).values({
      id: 'domain_plans',
      project_id: project.id,
      hostname,
      status: 'active',
      cf_hostname_id: 'cf-plans',
    });
    for (const key of [project.slug, `domain:${hostname}`]) {
      await env.ROUTING.put(
        key,
        JSON.stringify({ projectId: project.id, userId: owner.id, workerName: 'existing-worker' }),
      );
    }
    const original = (await getUser(env.db, owner.id))!;
    await change('/free/set', { limits: { requestsPerMonth: 5, cpuMsPerRequest: 8 } });
    const counter = counters.get(counters.idFromName(owner.id));
    const record = async (requests: number) => {
      const response = await counter.fetch(
        new Request('https://do/record', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: owner.id,
            events: [
              {
                projectId: project.id,
                userId: owner.id,
                slug: project.slug,
                requests,
                responseBytes: 0,
              },
            ],
          }),
        }),
      );
      expect(response.status).toBe(200);
    };
    const state = async () =>
      (await (await counter.fetch(new Request('https://do/state'))).json()) as CounterState;
    await record(3);
    const period = (await state()).billingPeriodStart;
    await change('/free/set', { limits: { requestsPerMonth: 2 } });
    expect(await state()).toMatchObject({ totalRequests: 3, requestsSuspended: true });
    expect(await getUser(env.db, owner.id)).toMatchObject({
      suspended_reason: 'requests_exceeded',
    });
    for (const key of [project.slug, `domain:${hostname}`]) {
      expect(JSON.parse((await env.ROUTING.get(key))!)).toMatchObject({
        suspended: 'requests_exceeded',
        limits: { cpuMs: 8, subRequests: 50 },
      });
    }

    await change('/free/set', { limits: { requestsPerMonth: 0 } });
    expect(await state()).toMatchObject({ totalRequests: 3, requestsSuspended: false });
    await record(2);
    await change('/free/set', { limits: { requestsPerMonth: 4 } });
    expect(await state()).toMatchObject({
      totalRequests: 5,
      requestsSuspended: true,
      billingPeriodStart: period,
    });

    await env.db
      .update(users)
      .set({ suspended_reason: 'operator_review' })
      .where(eq(users.id, owner.id));
    await change('/free/set', { limits: { requestsPerMonth: 100 } });
    expect(await getUser(env.db, owner.id)).toMatchObject({
      suspended_reason: 'operator_review',
      billing_cycle_start: original.billing_cycle_start,
    });
    for (const key of [project.slug, `domain:${hostname}`]) {
      expect(JSON.parse((await env.ROUTING.get(key))!)).toMatchObject({
        suspended: 'operator_review',
        workerName: 'existing-worker',
      });
    }
    expect(await state()).toMatchObject({
      totalRequests: 5,
      requestsSuspended: false,
      billingPeriodStart: period,
    });

    await change('/add', { id: 'team', name: 'Team', copyFrom: 'custom' });
    await change('/free/remove', { replacementPlanId: 'team' });
    expect(await getUser(env.db, owner.id)).toMatchObject({
      plan: 'team',
      suspended_reason: 'operator_review',
    });
    expect(await state()).toMatchObject({
      plan: 'team',
      totalRequests: 5,
      billingPeriodStart: period,
    });
    expect((await readPlanCatalog(env.db)).defaultPlanId).toBe('team');
  });
});
