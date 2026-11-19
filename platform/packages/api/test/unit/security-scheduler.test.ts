import {
  defaultSecurityPolicy,
  SECURITY_ENTITLEMENT_MAX_AGE_MS,
  type SecurityPolicy,
} from '@void/platform/security-policy';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { StartScanRequest } from '../../src/security-scanner-controller-runtime.ts';
import type { SecurityReserveResult } from '../../src/security/budget.ts';
import {
  admitModelCall,
  backOffModelRate,
  modelRateWaitMs,
  SECURITY_CF_BACKOFF_TOKENS,
  SECURITY_CF_CALLS_PER_MINUTE,
} from '../../src/security/call-ledger.ts';
import { securityProbeDue } from '../../src/security/maintenance.ts';
import { resolveSecurityScanModel } from '../../src/security/models.ts';
import type {
  SecurityClaimOutcome,
  SecurityScanCandidate,
  SecurityScanEnd,
} from '../../src/security/queue.ts';
import { securityScanTimes } from '../../src/security/queue.ts';
import {
  orderSecurityScansByOwner,
  runSecurityScanQueue,
  SECURITY_CF_RUNNING_PER_MODEL,
  SECURITY_SCAN_RETRY_BACKOFF_MS,
  SECURITY_SCHEDULER_RESCAN_MS,
  type SchedulerStorage,
  type SecurityScanQueueDeps,
} from '../../src/security/scheduler.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const CF = '@cf/zai-org/glm-5.3';
const FLASH = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const OPUS = 'anthropic/claude-opus-5.5';

function memoryStorage() {
  const map = new Map<string, unknown>();
  const alarms: Array<number> = [];
  const alarm: { at: number | null } = { at: null };
  const storage = {
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      map.set(key, structuredClone(value));
    },
    async delete(keys: string | Array<string>) {
      if (Array.isArray(keys)) {
        let count = 0;
        for (const key of keys) {
          count += map.delete(key) ? 1 : 0;
        }
        return count;
      }
      return map.delete(keys);
    },
    async list<T>(options: { prefix?: string } = {}) {
      return new Map(
        [...map].filter(([key]) => key.startsWith(options.prefix ?? '')) as Array<[string, T]>,
      );
    },
    async getAlarm() {
      return alarm.at;
    },
    async setAlarm(time: number | Date) {
      alarms.push(Number(time));
      alarm.at = Number(time);
    },
  } as unknown as SchedulerStorage;
  return { storage, map, alarms, alarm };
}

function onPolicy(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
  return {
    ...defaultSecurityPolicy(),
    mode: 'all',
    // These cases are written around glm; the product default is deepseek flash.
    defaultModel: CF,
    entitlement: {
      checkedAt: '2026-11-18T11:00:00.000Z',
      ok: true,
      missing: [],
      hosts: { openai: true, anthropic: true },
    },
    ...overrides,
  };
}

function candidate(
  scanId: string,
  ownerId: string,
  overrides: Partial<SecurityScanCandidate> = {},
): SecurityScanCandidate {
  return {
    scanId,
    projectId: `proj_${scanId}`,
    ownerId,
    trigger: 'deploy',
    attempt: 0,
    firstQueuedAt: '2026-11-18T11:00:00.000Z',
    reservedNano: 0,
    model: null,
    noticeVersion: null,
    monthlyCapCents: null,
    capCeilingCents: null,
    ...overrides,
  };
}

type Harness = {
  deps: SecurityScanQueueDeps;
  storage: ReturnType<typeof memoryStorage>;
  policy: { value: SecurityPolicy };
  queue: {
    running: Array<{ scanId: string; projectId: string; modelUsed: string | null }>;
    candidates: Array<SecurityScanCandidate>;
    queued: number;
  };
  starts: Array<StartScanRequest>;
  cancels: Array<[string, number]>;
  ends: Array<[string, number, SecurityScanEnd]>;
  requeues: Array<[string, number]>;
  claim: ReturnType<typeof vi.fn>;
  reserve: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  isRunning: ReturnType<typeof vi.fn>;
  requeue: ReturnType<typeof vi.fn>;
  clock: { now: number };
};

function harness(): Harness {
  const storage = memoryStorage();
  const policy = { value: onPolicy() };
  const queue: Harness['queue'] = { running: [], candidates: [], queued: 0 };
  const starts: Harness['starts'] = [];
  const cancels: Harness['cancels'] = [];
  const ends: Harness['ends'] = [];
  const requeues: Harness['requeues'] = [];
  const clock = { now: NOW };
  const attempts = new Map<string, number>();
  const claim = vi.fn(async (input: { scanId: string; attempt: number }) => {
    const attempt = input.attempt + 1;
    attempts.set(input.scanId, attempt);
    return {
      kind: 'claimed',
      attempt,
      times: securityScanTimes({ timeoutMinutes: 20 }, clock.now),
    } as SecurityClaimOutcome;
  });
  const reserve = vi.fn(async (): Promise<SecurityReserveResult> => ({
    ok: true,
    month: '2026-11-01',
    reserveNano: 1,
  }));
  const start = vi.fn(async (request: StartScanRequest) => {
    starts.push(request);
    return { ok: true } as const;
  });
  const isRunning = vi.fn(async () => true);
  const requeue = vi.fn(async (scanId: string, attempt: number) => {
    requeues.push([scanId, attempt]);
    return true;
  });
  const deps: SecurityScanQueueDeps = {
    now: () => clock.now,
    storage: storage.storage,
    readPolicy: async () => policy.value,
    store: {
      read: async () => ({ ...queue, queued: queue.queued || queue.candidates.length }),
      claim,
      reserve,
      end: async (scanId, attempt, end) => {
        ends.push([scanId, attempt, end]);
        return true;
      },
      endQueued: async (scanId, attempt, end) => {
        ends.push([scanId, attempt, end]);
        return true;
      },
      requeue,
      isRunning,
    },
    controller: {
      start,
      cancel: async (scanId, attempt) => {
        cancels.push([scanId, attempt]);
      },
    },
  };
  return {
    deps,
    storage,
    policy,
    queue,
    starts,
    cancels,
    ends,
    requeues,
    claim,
    reserve,
    start,
    isRunning,
    requeue,
    clock,
  };
}

describe('round-robin by owner (spec §6.2)', () => {
  it('takes one scan per owner per round, oldest first inside each owner', () => {
    const ordered = orderSecurityScansByOwner(
      [
        candidate('a1', 'alice'),
        candidate('a2', 'alice'),
        candidate('a3', 'alice'),
        candidate('b1', 'bob'),
        candidate('c1', 'carol'),
        candidate('b2', 'bob'),
      ],
      {},
    );
    expect(ordered.map((entry) => entry.scanId)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
  });

  it('puts the owner served last at the back, even with the oldest scans (edge #37)', () => {
    const ordered = orderSecurityScansByOwner(
      [candidate('a1', 'alice'), candidate('a2', 'alice'), candidate('b1', 'bob')],
      { alice: NOW - 1_000, bob: NOW - 60_000 },
    );
    expect(ordered.map((entry) => entry.scanId)).toEqual(['b1', 'a1', 'a2']);
  });

  it('serves a busy owner and a quiet one in turn across passes', async () => {
    const h = harness();
    h.policy.value = onPolicy({ limits: { ...onPolicy().limits, concurrency: 1 } });
    h.queue.candidates = [
      candidate('a1', 'alice', { model: FLASH }),
      candidate('a2', 'alice', { model: FLASH }),
      candidate('b1', 'bob', { model: FLASH }),
    ];
    await runSecurityScanQueue(h.deps);
    expect(h.starts.map((entry) => entry.scanId)).toEqual(['a1']);
    h.queue.candidates = h.queue.candidates.filter((entry) => entry.scanId !== 'a1');
    h.clock.now += 1_000;
    await runSecurityScanQueue(h.deps);
    expect(h.starts.map((entry) => entry.scanId)).toEqual(['a1', 'b1']);
  });
});

describe('runSecurityScanQueue', () => {
  it('starts a scan: claim, reserve, then the controller with the policy times', async () => {
    const h = harness();
    h.queue.candidates = [candidate('s1', 'alice')];
    const run = await runSecurityScanQueue(h.deps);
    expect(run.started).toEqual(['s1']);
    expect(h.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        scanId: 's1',
        attempt: 0,
        model: { requested: CF, used: CF, engine: 'void_loop' },
      }),
    );
    expect(h.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ scanId: 's1', projectId: 'proj_s1', reserveNano: 2_208_000_000 }),
    );
    expect(h.starts).toEqual([
      {
        scanId: 's1',
        attempt: 1,
        engine: 'void_loop',
        wallClockMs: 20 * 60_000,
        hardCapMs: 40 * 60_000,
      },
    ]);
    // Nothing left: the alarm is not re-armed.
    expect(run.nextAlarm).toBeNull();
    expect(h.storage.alarms).toEqual([]);
  });

  it('keeps installation concurrency, one per project, and re-arms while work remains', async () => {
    const h = harness();
    h.queue.running = [{ scanId: 'r1', projectId: 'proj_busy', modelUsed: OPUS }];
    h.queue.candidates = [
      candidate('busy', 'alice', { projectId: 'proj_busy' }),
      candidate('s1', 'bob', { model: FLASH }),
      candidate('s2', 'carol', { model: OPUS, noticeVersion: 1 }),
    ];
    h.policy.value = onPolicy({
      thirdPartyNotice: { acceptedByUserId: 'u', acceptedAt: '2026-11-01T00:00:00Z', version: 1 },
    });
    const run = await runSecurityScanQueue(h.deps);
    // Concurrency 2, one running: one slot.
    expect(run.started).toEqual(['s1']);
    expect(run.nextAlarm).toBe(NOW + SECURITY_SCHEDULER_RESCAN_MS);
    expect(h.storage.alarms).toEqual([NOW + SECURITY_SCHEDULER_RESCAN_MS]);
  });

  it(`runs at most ${SECURITY_CF_RUNNING_PER_MODEL} scan per @cf model; other models still start`, async () => {
    const h = harness();
    h.policy.value = onPolicy({ limits: { ...onPolicy().limits, concurrency: 5 } });
    h.queue.running = [{ scanId: 'r1', projectId: 'proj_r1', modelUsed: CF }];
    h.queue.candidates = [candidate('s1', 'alice'), candidate('s2', 'bob', { model: FLASH })];
    const run = await runSecurityScanQueue(h.deps);
    expect(run.started).toEqual(['s2']);
    expect(run.nextAlarm).toBe(NOW + SECURITY_SCHEDULER_RESCAN_MS);
  });

  it('starts no new scan on a @cf model backing off after a 429, and wakes when it recovers', async () => {
    const h = harness();
    const wait = await backOffModelRate(h.storage.storage, CF, NOW);
    h.queue.candidates = [candidate('s1', 'alice')];
    const run = await runSecurityScanQueue(h.deps);
    expect(run.started).toEqual([]);
    expect(h.claim).not.toHaveBeenCalled();
    expect(run.nextAlarm).toBe(NOW + Math.min(wait, SECURITY_SCHEDULER_RESCAN_MS));

    h.clock.now = NOW + wait;
    expect((await runSecurityScanQueue(h.deps)).started).toEqual(['s1']);
  });

  it('skips the scan when the budget refuses the reserve (skipped:budget)', async () => {
    const h = harness();
    h.reserve.mockResolvedValue({ ok: false, cap: 'platform', capNano: 1, spentNano: 1 });
    h.queue.candidates = [candidate('s1', 'alice')];
    const run = await runSecurityScanQueue(h.deps);
    expect(run.started).toEqual([]);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.ends).toEqual([
      ['s1', 1, { status: 'skipped', reason: 'budget', errorClass: 'platform_cap' }],
    ]);
    expect(run.nextAlarm).toBeNull();
  });

  it('tells the cap alert which cap refused the scan, and survives its failure', async () => {
    const h = harness();
    const refused = vi.fn(async () => {
      throw new Error('db down');
    });
    h.reserve.mockResolvedValue({ ok: false, cap: 'project', capNano: 1, spentNano: 1 });
    h.queue.candidates = [candidate('s1', 'alice')];
    await runSecurityScanQueue({ ...h.deps, onBudgetRefused: refused });
    expect(refused).toHaveBeenCalledWith({ projectId: 'proj_s1', cap: 'project' });
    expect(h.ends).toEqual([
      ['s1', 1, { status: 'skipped', reason: 'budget', errorClass: 'project_cap' }],
    ]);
  });

  it('retries a failed start once after a back-off, then fails it (infrastructure)', async () => {
    const h = harness();
    h.start.mockRejectedValue(new Error('gate unreachable'));
    h.queue.candidates = [candidate('s1', 'alice')];
    const first = await runSecurityScanQueue(h.deps);
    expect(first.started).toEqual([]);
    expect(h.cancels).toEqual([['s1', 1]]);
    expect(h.requeues).toEqual([['s1', 1]]);
    // A failed start: nothing starts again before the retry is due.
    expect(first.nextAlarm).toBe(NOW + SECURITY_SCAN_RETRY_BACKOFF_MS);

    // Too early: the retry waits for its back-off.
    h.clock.now = NOW + SECURITY_SCHEDULER_RESCAN_MS;
    await runSecurityScanQueue(h.deps);
    expect(h.claim).toHaveBeenCalledTimes(1);

    h.clock.now = NOW + SECURITY_SCAN_RETRY_BACKOFF_MS;
    h.queue.candidates = [candidate('s1', 'alice', { attempt: 1 })];
    await runSecurityScanQueue(h.deps);
    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.requeues).toHaveLength(1);
    expect(h.ends).toEqual([
      [
        's1',
        2,
        {
          status: 'failed',
          reason: 'infrastructure',
          errorClass: 'start_failed',
          failureCause: 'installation',
        },
      ],
    ]);
  });

  it('treats an { ok: false } start like a failed one', async () => {
    const h = harness();
    h.start.mockResolvedValue({ ok: false, reason: 'http_503' });
    h.queue.candidates = [candidate('s1', 'alice', { attempt: 1 })];
    await runSecurityScanQueue(h.deps);
    expect(h.requeues).toEqual([]);
    expect(h.ends.map(([scanId, , end]) => [scanId, end.status])).toEqual([['s1', 'failed']]);
  });

  it('does not count a busy or vanished claim as started', async () => {
    const h = harness();
    h.claim.mockResolvedValueOnce({ kind: 'busy' }).mockResolvedValueOnce({ kind: 'gone' });
    h.queue.candidates = [candidate('s1', 'alice'), candidate('s2', 'bob', { model: FLASH })];
    const run = await runSecurityScanQueue(h.deps);
    expect(run.started).toEqual([]);
    expect(h.reserve).not.toHaveBeenCalled();
    expect(run.nextAlarm).toBe(NOW + SECURITY_SCHEDULER_RESCAN_MS);
  });

  it('neither starts nor ends a scan canceled between claim and reserve', async () => {
    const h = harness();
    h.reserve.mockResolvedValue({ ok: false, gone: true });
    h.queue.candidates = [candidate('s1', 'alice')];
    const run = await runSecurityScanQueue(h.deps);
    expect(h.reserve).toHaveBeenCalledWith(expect.objectContaining({ scanId: 's1', attempt: 1 }));
    expect(run.started).toEqual([]);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.ends).toEqual([]);
  });

  it('stops the new container when the scan was canceled while it started', async () => {
    const h = harness();
    h.isRunning.mockResolvedValue(false);
    h.queue.candidates = [candidate('s1', 'alice')];
    const run = await runSecurityScanQueue(h.deps);
    expect(h.starts).toHaveLength(1);
    expect(h.cancels).toEqual([['s1', 1]]);
    expect(run.started).toEqual([]);
    expect(h.ends).toEqual([]);
  });

  it('stops the pass at the first failed start, so an outage costs one retry, not the queue', async () => {
    const h = harness();
    h.policy.value = onPolicy({ limits: { ...onPolicy().limits, concurrency: 5 } });
    h.start.mockRejectedValue(new Error('gate unreachable'));
    h.queue.candidates = [
      candidate('s1', 'alice'),
      candidate('s2', 'bob', { model: FLASH }),
      candidate('s3', 'carol', { model: OPUS }),
    ];
    const run = await runSecurityScanQueue(h.deps);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.requeues).toEqual([['s1', 1]]);
    expect(run.nextAlarm).toBe(NOW + SECURITY_SCAN_RETRY_BACKOFF_MS);
  });

  it('ends only the claimed candidate an error hit, and goes on with the others', async () => {
    const h = harness();
    h.policy.value = onPolicy({ limits: { ...onPolicy().limits, concurrency: 5 } });
    h.reserve.mockRejectedValueOnce(new Error('connection reset'));
    h.claim.mockImplementationOnce(async () => {
      throw new Error('connection reset');
    });
    h.queue.candidates = [
      candidate('s1', 'alice', { model: FLASH }),
      candidate('s2', 'bob', { model: FLASH }),
      candidate('s3', 'carol'),
    ];
    // s1: the claim throws (still queued). s2: the reserve throws after the claim.
    const run = await runSecurityScanQueue(h.deps);
    expect(h.ends).toEqual([
      [
        's2',
        1,
        {
          status: 'failed',
          reason: 'infrastructure',
          errorClass: 'scheduler_error',
          failureCause: 'installation',
        },
      ],
    ]);
    expect(h.cancels).toEqual([['s2', 1]]);
    expect(run.started).toEqual(['s3']);
  });

  it('keeps an earlier alarm a poke set during the pass', async () => {
    const h = harness();
    h.queue.running = [{ scanId: 'r1', projectId: 'proj_r1', modelUsed: OPUS }];
    h.policy.value = onPolicy({ limits: { ...onPolicy().limits, concurrency: 1 } });
    h.queue.candidates = [candidate('s1', 'alice')];
    h.storage.alarm.at = NOW + 50;
    const run = await runSecurityScanQueue(h.deps);
    expect(run.nextAlarm).toBe(NOW + SECURITY_SCHEDULER_RESCAN_MS);
    expect(h.storage.alarms).toEqual([]);
    expect(h.storage.alarm.at).toBe(NOW + 50);

    // The alarm that is running now (at or before the pass) is replaced.
    h.storage.alarm.at = NOW;
    await runSecurityScanQueue(h.deps);
    expect(h.storage.alarm.at).toBe(NOW + SECURITY_SCHEDULER_RESCAN_MS);
  });

  it('does nothing while the policy is Off', async () => {
    const h = harness();
    h.policy.value = defaultSecurityPolicy();
    h.queue.candidates = [candidate('s1', 'alice')];
    const run = await runSecurityScanQueue(h.deps);
    expect(run).toEqual({ started: [], nextAlarm: null });
    expect(h.claim).not.toHaveBeenCalled();
  });
});

describe('@cf rate bucket back-off', () => {
  it('puts the bucket into debt on a 429, deeper on each one, capped at a minute', async () => {
    const { storage } = memoryStorage();
    const first = await backOffModelRate(storage, CF, NOW);
    expect(first).toBe(((1 + SECURITY_CF_BACKOFF_TOKENS) * 60_000) / SECURITY_CF_CALLS_PER_MINUTE);
    const second = await backOffModelRate(storage, CF, NOW);
    expect(second).toBeGreaterThan(first);
    for (let index = 0; index < 5; index++) {
      await backOffModelRate(storage, CF, NOW);
    }
    expect(await modelRateWaitMs(storage, CF, NOW)).toBe(
      ((1 + SECURITY_CF_CALLS_PER_MINUTE) * 60_000) / SECURITY_CF_CALLS_PER_MINUTE,
    );
    // Other models keep their own bucket.
    expect(await modelRateWaitMs(storage, FLASH, NOW)).toBe(0);
  });

  it('makes the proxy wait for the refill, then admits again', async () => {
    const { storage } = memoryStorage();
    const wait = await backOffModelRate(storage, CF, NOW);
    const input = { scanId: 's1', attempt: 1, session: null, rateModel: CF };
    await expect(admitModelCall(storage, { ...input, now: NOW })).resolves.toEqual({
      ok: false,
      reason: 'rate',
      waitMs: wait,
    });
    await expect(admitModelCall(storage, { ...input, now: NOW + wait })).resolves.toEqual({
      ok: true,
      sessionCalls: null,
    });
  });
});

describe('which model runs', () => {
  const notice = { acceptedByUserId: 'u', acceptedAt: '2026-11-01T00:00:00Z', version: 1 };

  it('uses the project model, else the installation default', () => {
    expect(resolveSecurityScanModel(onPolicy(), { model: null, noticeVersion: null })).toEqual({
      requested: CF,
      used: CF,
      engine: 'void_loop',
    });
    expect(resolveSecurityScanModel(onPolicy(), { model: FLASH, noticeVersion: null })?.used).toBe(
      FLASH,
    );
  });

  it('falls back to the default for a blocked, unknown or unpriced project model (edge #23)', () => {
    const policy = onPolicy({ blockedModels: [FLASH] });
    for (const model of [FLASH, 'retired/model', 'anthropic/claude-sonnet-5.5']) {
      expect(resolveSecurityScanModel(policy, { model, noticeVersion: 1 })).toMatchObject({
        requested: model,
        used: CF,
      });
    }
  });

  it('keeps code on @cf until the project accepts the notice (edges #44, #84)', () => {
    const policy = onPolicy({ defaultModel: OPUS, thirdPartyNotice: notice });
    expect(resolveSecurityScanModel(policy, { model: null, noticeVersion: null })).toEqual({
      requested: OPUS,
      used: FLASH,
      engine: 'void_loop',
    });
    expect(resolveSecurityScanModel(policy, { model: null, noticeVersion: 1 })).toEqual({
      requested: OPUS,
      used: OPUS,
      engine: 'agent_sdk',
    });
    const noCredits = onPolicy({
      defaultModel: OPUS,
      thirdPartyNotice: notice,
      entitlement: { ...onPolicy().entitlement!, hosts: { openai: true, anthropic: false } },
    });
    expect(resolveSecurityScanModel(noCredits, { model: null, noticeVersion: 1 })?.used).toBe(
      FLASH,
    );
  });

  it('has no model when every @cf model is blocked and the third-party one is not allowed', () => {
    const policy = onPolicy({
      defaultModel: OPUS,
      thirdPartyNotice: notice,
      blockedModels: [CF, FLASH],
    });
    expect(resolveSecurityScanModel(policy, { model: null, noticeVersion: null })).toBeNull();
  });

  it('fails a scan no model can run instead of starting it', async () => {
    const h = harness();
    h.policy.value = onPolicy({
      defaultModel: OPUS,
      thirdPartyNotice: notice,
      blockedModels: [CF, FLASH],
    });
    h.queue.candidates = [candidate('s1', 'alice')];
    await runSecurityScanQueue(h.deps);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.ends).toEqual([
      [
        's1',
        0,
        {
          status: 'failed',
          reason: 'infrastructure',
          errorClass: 'no_model',
          failureCause: 'installation',
        },
      ],
    ]);
  });
});

describe('lease and daily probe', () => {
  it('sets the hard cap to 2× the wall clock and the lease 5 min past it', () => {
    expect(securityScanTimes({ timeoutMinutes: 30 }, NOW)).toEqual({
      wallClockMs: 30 * 60_000,
      hardCapMs: 60 * 60_000,
      leaseUntil: new Date(NOW + 65 * 60_000).toISOString(),
    });
  });

  it('probes daily while the policy is on, never while Off', () => {
    const fresh = onPolicy();
    expect(securityProbeDue(fresh, NOW)).toBe(false);
    expect(
      securityProbeDue(
        fresh,
        Date.parse(fresh.entitlement!.checkedAt) + SECURITY_ENTITLEMENT_MAX_AGE_MS,
      ),
    ).toBe(true);
    expect(securityProbeDue(onPolicy({ entitlement: null }), NOW)).toBe(true);
    expect(securityProbeDue({ ...fresh, mode: 'disabled', entitlement: null }, NOW)).toBe(false);
  });
});
