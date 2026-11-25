import type { SecurityPolicy } from '@void/platform/security-policy';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { securityPlatformSpend, securityScans } from '../../src/schema.ts';
import type { StartScanRequest } from '../../src/security-scanner-controller-runtime.ts';
import { checkScanFence } from '../../src/security/control.ts';
import { readSecurityPolicyLenient } from '../../src/security/policy.ts';
import { claimSecurityScan, reapExpiredSecurityScans } from '../../src/security/queue.ts';
import { runSecurityScanQueue, securityScanQueueStore } from '../../src/security/scheduler.ts';
import type { SchedulerStorage, SecurityScanController } from '../../src/security/scheduler.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
} from './helpers.ts';
import type { TestEnv } from './helpers.ts';
import { saveSecurityPolicy } from './security-fixtures.ts';

const CF = '@cf/zai-org/glm-5.3';
/** glm-5.3 at 600k in + 60k out: $1.104. */
const RESERVE_NANO = 2_208_000_000;

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
});

function savePolicy(overrides: Partial<SecurityPolicy> = {}) {
  // These tests price a glm-5.3 reserve; the product default is deepseek flash.
  return saveSecurityPolicy(env, { defaultModel: CF, ...overrides });
}

async function setup() {
  const user = await createTestUser(env.db, `owner-${crypto.randomUUID()}`);
  return createTestProject(env.db, user.id);
}

async function queueScan(
  id: string,
  projectId: string,
  overrides: Partial<typeof securityScans.$inferInsert> = {},
) {
  const queuedAt = new Date(Date.now() - 60_000).toISOString();
  await env.db.insert(securityScans).values({
    id,
    project_id: projectId,
    deployment_id: `dpl_${id}`,
    status: 'queued',
    trigger: 'deploy',
    first_queued_at: queuedAt,
    queued_at: queuedAt,
    ...overrides,
  });
}

async function scan(id: string) {
  const [row] = await env.db.select().from(securityScans).where(eq(securityScans.id, id));
  return row;
}

async function platformReserved(): Promise<number> {
  const rows = await env.db
    .select({ reserved: securityPlatformSpend.reserved_nano_usd })
    .from(securityPlatformSpend);
  return rows.reduce((sum, row) => sum + row.reserved, 0);
}

function queueDeps() {
  const map = new Map<string, unknown>();
  const starts: Array<StartScanRequest> = [];
  const controller: SecurityScanController = {
    start: async (request) => {
      starts.push(request);
      return { ok: true };
    },
    cancel: async () => {},
  };
  const storage = {
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => void map.set(key, value),
    delete: async (key: string) => map.delete(key),
    list: async () => new Map(),
    getAlarm: async () => null,
    setAlarm: async () => {},
  } as unknown as SchedulerStorage;
  return {
    starts,
    deps: {
      now: () => Date.now(),
      storage,
      readPolicy: () => readSecurityPolicyLenient(env.db),
      store: securityScanQueueStore(env.db),
      controller,
    },
  };
}

describe('scheduler on real SQL', () => {
  it('drives queued → running → timed_out, fenced by attempt (I4)', async () => {
    await savePolicy();
    const project = await setup();
    await queueScan('ss_drive', project.id);
    const { deps, starts } = queueDeps();

    expect((await runSecurityScanQueue(deps)).started).toEqual(['ss_drive']);
    expect(starts).toMatchObject([{ scanId: 'ss_drive', attempt: 1, engine: 'void_loop' }]);
    const running = await scan('ss_drive');
    expect(running).toMatchObject({
      status: 'running',
      attempt: 1,
      reserved_nano_usd: RESERVE_NANO,
    });
    expect(await platformReserved()).toBe(RESERVE_NANO);
    await expect(checkScanFence(env.db, 'ss_drive', 1)).resolves.toMatchObject({ ok: true });

    // The lease passes: the reaper ends the attempt, gives the reserve back, and fences it.
    const later = Date.parse(running.lease_until!) + 1000;
    expect(await reapExpiredSecurityScans(env.db, later)).toEqual([
      { scanId: 'ss_drive', attempt: 1 },
    ]);
    expect(await scan('ss_drive')).toMatchObject({ status: 'timed_out', reserved_nano_usd: 0 });
    expect(await platformReserved()).toBe(0);
    await expect(checkScanFence(env.db, 'ss_drive', 1, later)).resolves.toEqual({
      ok: false,
      reason: 'canceled',
    });
  });

  it('a claim with a stale attempt is gone, and the old attempt is fenced off (I4)', async () => {
    await savePolicy();
    const project = await setup();
    await queueScan('ss_old', project.id, { attempt: 1 });
    const claim = (attempt: number) =>
      claimSecurityScan(env.db, {
        scanId: 'ss_old',
        attempt,
        model: { requested: CF, used: CF, engine: 'void_loop' },
        limits: { timeoutMinutes: 20 },
        now: Date.now(),
      });
    await expect(claim(0)).resolves.toEqual({ kind: 'gone' });
    await expect(claim(1)).resolves.toMatchObject({ kind: 'claimed', attempt: 2 });
    await expect(claim(1)).resolves.toEqual({ kind: 'gone' });
    await expect(checkScanFence(env.db, 'ss_old', 1)).resolves.toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('skips a scan the platform cap cannot cover, reserving nothing (I7)', async () => {
    await savePolicy({
      budgets: {
        platformCapOn: true,
        platformMonthlyUsd: 1,
        projectCapsOn: false,
        projectDefaultMonthlyUsd: 100,
      },
    });
    const project = await setup();
    await queueScan('ss_budget', project.id);
    const { deps, starts } = queueDeps();
    expect((await runSecurityScanQueue(deps)).started).toEqual([]);
    expect(starts).toEqual([]);
    expect(await scan('ss_budget')).toMatchObject({
      status: 'skipped',
      status_reason: 'budget',
      reserved_nano_usd: 0,
    });
    expect(await platformReserved()).toBe(0);
  });
});
