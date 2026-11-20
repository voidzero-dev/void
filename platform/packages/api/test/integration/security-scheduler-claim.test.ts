import {
  defaultSecurityPolicy,
  SECURITY_POLICY_SETTINGS_KEY,
  type SecurityPolicy,
} from '@void/platform/security-policy';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { setPlatformSetting } from '../../src/platform-settings.ts';
import {
  platformSettings,
  projects,
  projectSecuritySettings,
  projectZeroTrust,
  securityPlatformSpend,
  securityProjectSpend,
  securityScans,
  users,
} from '../../src/schema.ts';
import type { StartScanRequest } from '../../src/security-scanner-controller-runtime.ts';
import { checkScanFence } from '../../src/security/control.ts';
import { readSecurityPolicyLenient } from '../../src/security/policy.ts';
import {
  cancelSecurityScanRows,
  claimSecurityScan,
  reapExpiredSecurityScans,
  readSecurityScanQueue,
  releaseStrandedSecurityScanReserves,
} from '../../src/security/queue.ts';
import {
  cancelSecurityScans,
  runSecurityScanQueue,
  SECURITY_SCAN_RETRY_BACKOFF_MS,
  securityScanQueueStore,
  type SchedulerStorage,
  type SecurityScanController,
} from '../../src/security/scheduler.ts';
import {
  clearTables,
  createTestProject,
  createTestUser,
  setupEnv,
  teardownEnv,
  type TestEnv,
} from './helpers.ts';

const CF = '@cf/zai-org/glm-5.3';
const FLASH = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
/** glm-5.3 at 600k in + 60k out: $1.104. */
const RESERVE_NANO = 2_208_000_000;
/** deepseek flash at 600k in + 60k out: $0.252. */
const FLASH_RESERVE_NANO = 504_000_000;

let env: TestEnv;

beforeAll(async () => {
  env = await setupEnv();
});
afterAll(teardownEnv);
beforeEach(async () => {
  await clearTables(env.db);
});

async function savePolicy(overrides: Partial<SecurityPolicy> = {}) {
  await setPlatformSetting(env.db, SECURITY_POLICY_SETTINGS_KEY, {
    ...defaultSecurityPolicy(),
    mode: 'all',
    revision: 1,
    // These tests price a glm-5.3 reserve; the product default is deepseek flash.
    defaultModel: CF,
    ...overrides,
  });
}

async function protect(projectId: string) {
  await env.db
    .insert(platformSettings)
    .values({
      key: 'zeroTrust.configuration',
      value: {
        version: 1,
        revision: 1,
        enabled: true,
        protectNewProjects: true,
        accountId: env.CF_ACCOUNT_ID,
        teamDomain: 'https://company.cloudflareaccess.com',
        identityProviderIds: ['idp-1'],
        policyIds: ['policy-1'],
        credential: { ciphertext: 'unused', iv: 'unused', keyVersion: 'v1' },
        wildcardApplicationName: 'void-test-projects',
        wildcardApplication: {
          id: 'access-wildcard',
          name: 'void-test-projects',
          audience: 'access-audience',
          destinations: ['*.void.app'],
        },
        operation: null,
        lastError: null,
        updatedAt: new Date().toISOString(),
      },
    })
    .onConflictDoNothing();
  await env.db.insert(projectZeroTrust).values({
    project_id: projectId,
    desired_protected: true,
    effective_protected: true,
    status: 'ready',
  });
}

async function setup(login: string) {
  const user = await createTestUser(env.db, `${login}-${crypto.randomUUID()}`);
  const project = await createTestProject(env.db, user.id);
  return { user, project };
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

/** One running scan per `@cf` model: give a second project its own model. */
async function useFlash(projectId: string) {
  await env.db.insert(projectSecuritySettings).values({ project_id: projectId, model: FLASH });
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

function memoryStorage(): SchedulerStorage {
  const map = new Map<string, unknown>();
  return {
    get: async (key: string) => map.get(key),
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (keys: string | Array<string>) =>
      Array.isArray(keys) ? keys.filter((key) => map.delete(key)).length : map.delete(keys),
    list: async (options: { prefix?: string } = {}) =>
      new Map([...map].filter(([key]) => key.startsWith(options.prefix ?? ''))),
    getAlarm: async () => null,
    setAlarm: async () => {},
  } as unknown as SchedulerStorage;
}

/** A controller that records starts and cancels; `fail` makes each start throw. */
function fakeController(fail = false) {
  const starts: Array<StartScanRequest> = [];
  const cancels: Array<[string, number]> = [];
  const controller: SecurityScanController = {
    start: async (request) => {
      starts.push(request);
      if (fail) {
        throw new Error('container start failed');
      }
      return { ok: true };
    },
    cancel: async (scanId, attempt) => {
      cancels.push([scanId, attempt]);
    },
  };
  return { controller, starts, cancels };
}

function queueDeps(
  controller: SecurityScanController,
  storage = memoryStorage(),
  now = () => Date.now(),
) {
  return {
    now,
    storage,
    readPolicy: () => readSecurityPolicyLenient(env.db),
    store: securityScanQueueStore(env.db),
    controller,
  };
}

describe('scheduler on real SQL', () => {
  it('drives queued → running → timed_out, fenced by attempt (edge #33)', async () => {
    await savePolicy();
    const { project } = await setup('owner');
    await queueScan('ss_drive', project.id);
    const fake = fakeController();

    const run = await runSecurityScanQueue(queueDeps(fake.controller));
    expect(run.started).toEqual(['ss_drive']);
    expect(fake.starts).toEqual([
      {
        scanId: 'ss_drive',
        attempt: 1,
        engine: 'void_loop',
        wallClockMs: 20 * 60_000,
        hardCapMs: 40 * 60_000,
      },
    ]);
    const running = await scan('ss_drive');
    expect(running).toMatchObject({
      status: 'running',
      attempt: 1,
      model_requested: CF,
      model_used: CF,
      engine: 'void_loop',
      reserved_nano_usd: RESERVE_NANO,
    });
    expect(running?.started_at).not.toBeNull();
    // Lease = hard cap (40 min) + 5 min.
    const lease = Date.parse(running!.lease_until!) - Date.parse(running!.started_at!);
    expect(Math.abs(lease - 45 * 60_000)).toBeLessThan(5_000);
    expect(await platformReserved()).toBe(RESERVE_NANO);
    await expect(checkScanFence(env.db, 'ss_drive', 1)).resolves.toMatchObject({ ok: true });

    // The lease passes: the reaper ends the attempt and gives the reserve back.
    const later = Date.parse(running!.lease_until!) + 1_000;
    expect(await reapExpiredSecurityScans(env.db, later)).toEqual([
      { scanId: 'ss_drive', attempt: 1 },
    ]);
    expect(await scan('ss_drive')).toMatchObject({
      status: 'timed_out',
      status_reason: 'lease_expired',
      failure_cause: 'installation',
      reserved_nano_usd: 0,
    });
    expect(await platformReserved()).toBe(0);
    // A late write of the reaped attempt is refused.
    await expect(checkScanFence(env.db, 'ss_drive', 1, later)).resolves.toEqual({
      ok: false,
      reason: 'canceled',
    });
    expect(await reapExpiredSecurityScans(env.db, later)).toEqual([]);
  });

  it('keeps one running scan per project: a racing claim stays queued', async () => {
    await savePolicy();
    const { project } = await setup('owner');
    await queueScan('ss_running', project.id, {
      status: 'running',
      attempt: 1,
      lease_until: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await queueScan('ss_waiting', project.id);

    // The queue read leaves the project out while it has a running scan.
    const view = await readSecurityScanQueue(env.db);
    expect(view.candidates).toEqual([]);
    expect(view.queued).toBe(1);

    // A claim that read the queue earlier hits the unique index and changes nothing.
    await expect(
      claimSecurityScan(env.db, {
        scanId: 'ss_waiting',
        attempt: 0,
        model: { requested: CF, used: CF, engine: 'void_loop' },
        limits: { timeoutMinutes: 20 },
        now: Date.now(),
      }),
    ).resolves.toEqual({ kind: 'busy' });
    expect(await scan('ss_waiting')).toMatchObject({ status: 'queued', attempt: 0 });
  });

  it('a claim with a stale attempt or of a row no longer queued is gone', async () => {
    await savePolicy();
    const { project } = await setup('owner');
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
    // The first attempt is fenced off once the second runs.
    await expect(checkScanFence(env.db, 'ss_old', 1)).resolves.toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('under public, skips a queued non-gate scan of a now-protected project; a gate scan runs', async () => {
    await savePolicy({ mode: 'public' });
    const { project } = await setup('owner');
    const gated = await setup('gated');
    await protect(project.id);
    await protect(gated.project.id);
    await queueScan('ss_protected', project.id);
    await queueScan('ss_gate', gated.project.id, { trigger: 'gate' });
    await useFlash(gated.project.id);
    const fake = fakeController();

    const run = await runSecurityScanQueue(queueDeps(fake.controller));
    expect(run.started).toEqual(['ss_gate']);
    expect(await scan('ss_protected')).toMatchObject({
      status: 'skipped',
      status_reason: 'protected',
      attempt: 0,
    });
    expect((await scan('ss_protected'))?.finished_at).not.toBeNull();
    expect(await scan('ss_gate')).toMatchObject({ status: 'running', attempt: 1 });
  });

  it('under all, still runs a protected project', async () => {
    await savePolicy({ mode: 'all' });
    const { project } = await setup('owner');
    await protect(project.id);
    await queueScan('ss_all', project.id);
    const run = await runSecurityScanQueue(queueDeps(fakeController().controller));
    expect(run.started).toEqual(['ss_all']);
  });

  it('cancels at claim for a deleting project or a suspended owner; skips a 24 h wait', async () => {
    await savePolicy();
    const deleting = await setup('deleting');
    const suspended = await setup('suspended');
    const late = await setup('late');
    await env.db
      .update(projects)
      .set({ status: 'deleting' })
      .where(eq(projects.id, deleting.project.id));
    await env.db
      .update(users)
      .set({ suspended_reason: 'admin' })
      .where(eq(users.id, suspended.user.id));
    await queueScan('ss_deleting', deleting.project.id);
    await queueScan('ss_suspended', suspended.project.id);
    await queueScan('ss_late', late.project.id, {
      first_queued_at: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    });
    const fake = fakeController();
    await runSecurityScanQueue(queueDeps(fake.controller, memoryStorage(), () => Date.now()));
    expect(fake.starts).toEqual([]);
    expect(await scan('ss_deleting')).toMatchObject({
      status: 'canceled',
      status_reason: 'project_deleted',
    });
    expect(await scan('ss_suspended')).toMatchObject({
      status: 'canceled',
      status_reason: 'owner_suspended',
    });
    expect(await scan('ss_late')).toMatchObject({ status: 'skipped', status_reason: 'backlog' });
  });

  it('skips a scan the platform cap cannot cover (skipped:budget), reserving nothing', async () => {
    await savePolicy({
      budgets: {
        platformCapOn: true,
        platformMonthlyUsd: 1,
        projectCapsOn: false,
        projectDefaultMonthlyUsd: 100,
      },
    });
    const { project } = await setup('owner');
    await queueScan('ss_budget', project.id);
    const fake = fakeController();
    const run = await runSecurityScanQueue(queueDeps(fake.controller));
    expect(run.started).toEqual([]);
    expect(fake.starts).toEqual([]);
    expect(await scan('ss_budget')).toMatchObject({
      status: 'skipped',
      status_reason: 'budget',
      error_class: 'platform_cap',
      reserved_nano_usd: 0,
    });
    expect(await platformReserved()).toBe(0);
    const [projectRow] = await env.db
      .select({ reserved: securityProjectSpend.reserved_nano_usd })
      .from(securityProjectSpend)
      .where(eq(securityProjectSpend.project_id, project.id));
    expect(projectRow?.reserved ?? 0).toBe(0);
  });

  it('retries a failed start once with its reserve given back, then fails it', async () => {
    await savePolicy();
    const { project } = await setup('owner');
    await queueScan('ss_retry', project.id);
    const fake = fakeController(true);
    const storage = memoryStorage();
    const start = Date.now();

    await runSecurityScanQueue(queueDeps(fake.controller, storage, () => start));
    expect(await scan('ss_retry')).toMatchObject({
      status: 'queued',
      attempt: 1,
      lease_until: null,
      started_at: null,
      reserved_nano_usd: 0,
    });
    expect(await platformReserved()).toBe(0);
    expect(fake.cancels).toEqual([['ss_retry', 1]]);

    await runSecurityScanQueue(
      queueDeps(fake.controller, storage, () => start + SECURITY_SCAN_RETRY_BACKOFF_MS),
    );
    expect(fake.starts.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(await scan('ss_retry')).toMatchObject({
      status: 'failed',
      status_reason: 'infrastructure',
      error_class: 'start_failed',
      failure_cause: 'installation',
      attempt: 2,
      reserved_nano_usd: 0,
    });
    expect(await platformReserved()).toBe(0);
  });

  it('cancels a project’s waiting and running scans and gives the reserve back', async () => {
    await savePolicy();
    const { project } = await setup('owner');
    const other = await setup('other');
    await queueScan('ss_cancel_run', project.id);
    await queueScan('ss_other', other.project.id);
    await useFlash(other.project.id);
    const fake = fakeController();
    await runSecurityScanQueue(queueDeps(fake.controller));
    expect(await platformReserved()).toBe(RESERVE_NANO + FLASH_RESERVE_NANO);
    await queueScan('ss_cancel_wait', project.id, { status: 'pending_input' });

    const forgotten: Array<[string, number]> = [];
    const canceled = await cancelSecurityScans(
      {
        db: env.db,
        controller: fake.controller,
        forget: async (scanId, attempt) => forgotten.push([scanId, attempt]),
      },
      { projectId: project.id },
      'project_deleted',
    );
    expect(canceled).toEqual([
      { scanId: 'ss_cancel_run', runningAttempt: 1 },
      { scanId: 'ss_cancel_wait', runningAttempt: null },
    ]);
    expect(fake.cancels).toEqual([['ss_cancel_run', 1]]);
    expect(forgotten).toEqual([['ss_cancel_run', 1]]);
    expect(await scan('ss_cancel_run')).toMatchObject({
      status: 'canceled',
      status_reason: 'project_deleted',
      reserved_nano_usd: 0,
    });
    expect(await scan('ss_cancel_wait')).toMatchObject({ status: 'canceled' });
    expect(await scan('ss_other')).toMatchObject({ status: 'running' });
    expect(await platformReserved()).toBe(FLASH_RESERVE_NANO);
  });

  it('reserves nothing for a scan canceled between claim and reserve', async () => {
    await savePolicy();
    const { project } = await setup('owner');
    await queueScan('ss_late_cancel', project.id);
    const fake = fakeController();
    const real = securityScanQueueStore(env.db);
    const run = await runSecurityScanQueue({
      ...queueDeps(fake.controller),
      store: {
        ...real,
        claim: async (input) => {
          const outcome = await real.claim(input);
          await cancelSecurityScanRows(env.db, { scanIds: [input.scanId] }, 'operator');
          return outcome;
        },
      },
    });
    expect(run.started).toEqual([]);
    expect(fake.starts).toEqual([]);
    expect(await scan('ss_late_cancel')).toMatchObject({
      status: 'canceled',
      status_reason: 'operator',
      reserved_nano_usd: 0,
    });
    expect(await platformReserved()).toBe(0);
  });

  it('stops the container of a scan canceled while its start was in flight', async () => {
    await savePolicy();
    const { project } = await setup('owner');
    await queueScan('ss_start_cancel', project.id);
    const fake = fakeController();
    const run = await runSecurityScanQueue(
      queueDeps({
        start: async (request) => {
          await cancelSecurityScanRows(env.db, { scanIds: [request.scanId] }, 'operator');
          return fake.controller.start(request);
        },
        cancel: fake.controller.cancel,
      }),
    );
    expect(run.started).toEqual([]);
    expect(fake.cancels).toEqual([['ss_start_cancel', 1]]);
    expect(await scan('ss_start_cancel')).toMatchObject({
      status: 'canceled',
      reserved_nano_usd: 0,
    });
    expect(await platformReserved()).toBe(0);
  });

  it('an operator cancel waits for a claim in flight and cancels the claimed row', async () => {
    await savePolicy();
    const { project } = await setup('owner');
    await queueScan('ss_race', project.id);
    let commit!: () => void;
    const held = new Promise<void>((resolve) => (commit = resolve));
    let updated!: () => void;
    const claimed = new Promise<void>((resolve) => (updated = resolve));
    // What the claim writes, held open so the cancel runs while it is in flight.
    const claim = env.db.transaction(async (tx) => {
      await tx
        .update(securityScans)
        .set({
          status: 'running',
          attempt: 1,
          lease_until: new Date(Date.now() + 3_600_000).toISOString(),
        })
        .where(eq(securityScans.id, 'ss_race'));
      updated();
      await held;
    });
    await claimed;
    const cancel = cancelSecurityScanRows(env.db, { scanIds: ['ss_race'] }, 'operator');
    await new Promise((resolve) => setTimeout(resolve, 100));
    commit();
    await claim;
    await expect(cancel).resolves.toEqual([{ scanId: 'ss_race', runningAttempt: 1 }]);
    expect(await scan('ss_race')).toMatchObject({ status: 'canceled', attempt: 1 });
  });

  it('gives back the reserve an ended scan still holds, never a running one', async () => {
    await savePolicy();
    const { project } = await setup('owner');
    const other = await setup('other');
    await queueScan('ss_stranded', project.id);
    await queueScan('ss_live', other.project.id);
    await useFlash(other.project.id);
    await runSecurityScanQueue(queueDeps(fakeController().controller));
    expect(await platformReserved()).toBe(RESERVE_NANO + FLASH_RESERVE_NANO);
    // An end that never released (an older write path, a lost isolate).
    await env.db
      .update(securityScans)
      .set({ status: 'failed', status_reason: 'infrastructure' })
      .where(eq(securityScans.id, 'ss_stranded'));

    await expect(releaseStrandedSecurityScanReserves(env.db)).resolves.toBe(1);
    expect(await scan('ss_stranded')).toMatchObject({ reserved_nano_usd: 0 });
    expect(await scan('ss_live')).toMatchObject({
      status: 'running',
      reserved_nano_usd: FLASH_RESERVE_NANO,
    });
    expect(await platformReserved()).toBe(FLASH_RESERVE_NANO);
    await expect(releaseStrandedSecurityScanReserves(env.db)).resolves.toBe(0);
  });

  it('starts nothing while the policy is Off', async () => {
    await savePolicy({ mode: 'disabled' });
    const { project } = await setup('owner');
    await queueScan('ss_off', project.id);
    const fake = fakeController();
    expect((await runSecurityScanQueue(queueDeps(fake.controller))).started).toEqual([]);
    expect(await scan('ss_off')).toMatchObject({ status: 'queued' });
  });
});
