import { defaultSecurityPolicy } from '@void/platform/security-policy';
import type { SecurityPolicy } from '@void/platform/security-policy';
import { expect, it, vi } from 'vite-plus/test';
import type { StartScanRequest } from '../../src/security-scanner-controller-runtime.ts';
import type { SecurityReserveResult } from '../../src/security/budget.ts';
import { resolveSecurityScanModel } from '../../src/security/models.ts';
import type {
  SecurityClaimOutcome,
  SecurityScanCandidate,
  SecurityScanEnd,
} from '../../src/security/queue.ts';
import { securityScanTimes } from '../../src/security/queue.ts';
import { runSecurityScanQueue } from '../../src/security/scheduler.ts';
import type { SecurityScanQueueDeps } from '../../src/security/scheduler.ts';
import { memoryDurableStorage } from '../helpers/memory-storage.ts';
import { onPolicy as securityOn } from '../helpers/security-policy.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const CF = '@cf/zai-org/glm-5.3';
const FLASH = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const OPUS = 'anthropic/claude-opus-5.5';

// These cases are written around glm; the product default is deepseek flash.
const onPolicy = (overrides: Partial<SecurityPolicy> = {}) =>
  securityOn({ defaultModel: CF, ...overrides });

function candidate(
  scanId: string,
  overrides: Partial<SecurityScanCandidate> = {},
): SecurityScanCandidate {
  return {
    scanId,
    projectId: `proj_${scanId}`,
    ownerId: `owner_${scanId}`,
    trigger: 'deploy',
    attempt: 0,
    firstQueuedAt: '2026-11-18T11:00:00.000Z',
    reservedNano: 0,
    model: null,
    noticeVersion: null,
    monthlyCapCents: null,
    capCeilingCents: null,
    planCap: 'inherit',
    ...overrides,
  };
}

function harness(policy: SecurityPolicy = onPolicy()) {
  const queue = {
    running: [] as Array<{ scanId: string; projectId: string; modelUsed: string | null }>,
    candidates: [] as Array<SecurityScanCandidate>,
  };
  const starts: Array<StartScanRequest> = [];
  const ends: Array<[string, number, SecurityScanEnd]> = [];
  const claim = vi.fn(
    async (input: { scanId: string; attempt: number }): Promise<SecurityClaimOutcome> => ({
      kind: 'claimed',
      attempt: input.attempt + 1,
      times: securityScanTimes({ timeoutMinutes: 20 }, NOW),
    }),
  );
  const reserve = vi.fn(async (): Promise<SecurityReserveResult> => ({
    ok: true,
    month: '2026-11-01',
    reserveNano: 1,
  }));
  const end = async (scanId: string, attempt: number, result: SecurityScanEnd) => {
    ends.push([scanId, attempt, result]);
    return true;
  };
  const deps: SecurityScanQueueDeps = {
    now: () => NOW,
    storage: memoryDurableStorage().storage,
    readPolicy: async () => policy,
    store: {
      read: async () => ({ ...queue, queued: queue.candidates.length }),
      claim,
      reserve,
      end,
      endQueued: end,
      requeue: async () => true,
      isRunning: async () => true,
    },
    controller: {
      start: async (request) => {
        starts.push(request);
        return { ok: true } as const;
      },
      cancel: async () => {},
    },
  };
  return { deps, queue, starts, ends, claim, reserve };
}

// I7: a scan starts only after the budget took its worst case.
it('starts a scan after reserving its worst case, with the policy times', async () => {
  const h = harness();
  h.queue.candidates = [candidate('s1')];
  expect((await runSecurityScanQueue(h.deps)).started).toEqual(['s1']);
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
});

it('skips the scan when the budget refuses the reserve, and starts nothing while Off', async () => {
  const h = harness();
  h.reserve.mockResolvedValue({ ok: false, cap: 'platform', capNano: 1, spentNano: 1 });
  h.queue.candidates = [candidate('s1')];
  expect((await runSecurityScanQueue(h.deps)).started).toEqual([]);
  expect(h.starts).toEqual([]);
  expect(h.ends).toEqual([
    ['s1', 1, { status: 'skipped', reason: 'budget', errorClass: 'platform_cap' }],
  ]);

  const off = harness(defaultSecurityPolicy());
  off.queue.candidates = [candidate('s1')];
  expect(await runSecurityScanQueue(off.deps)).toEqual({ started: [], nextAlarm: null });
  expect(off.claim).not.toHaveBeenCalled();
});

it('keeps installation concurrency, one scan per project and one per @cf model', async () => {
  const h = harness();
  h.queue.running = [{ scanId: 'r1', projectId: 'proj_busy', modelUsed: OPUS }];
  h.queue.candidates = [
    candidate('busy', { projectId: 'proj_busy', model: FLASH }),
    candidate('s1', { model: FLASH }),
    candidate('s2', { model: FLASH }),
  ];
  // Concurrency 2, one running: one slot.
  expect((await runSecurityScanQueue(h.deps)).started).toEqual(['s1']);

  const wide = harness(onPolicy({ limits: { ...onPolicy().limits, concurrency: 5 } }));
  wide.queue.running = [{ scanId: 'r1', projectId: 'proj_r1', modelUsed: CF }];
  wide.queue.candidates = [candidate('s1'), candidate('s2', { model: FLASH })];
  expect((await runSecurityScanQueue(wide.deps)).started).toEqual(['s2']);
});

// I8: code stays on @cf until the project accepted the provider notice and the host check passed.
it('keeps code on @cf until the project accepts the notice', () => {
  const notice = { acceptedByUserId: 'u', acceptedAt: '2026-11-01T00:00:00Z', version: 1 };
  const policy = onPolicy({ defaultModel: OPUS, thirdPartyNotice: notice });
  expect(resolveSecurityScanModel(policy, { model: null, noticeVersion: null })?.used).toBe(FLASH);
  expect(resolveSecurityScanModel(policy, { model: null, noticeVersion: 1 })?.used).toBe(OPUS);
  const noHost = onPolicy({
    defaultModel: OPUS,
    thirdPartyNotice: notice,
    entitlement: { ...onPolicy().entitlement!, hosts: { openai: true, anthropic: false } },
  });
  expect(resolveSecurityScanModel(noHost, { model: null, noticeVersion: 1 })?.used).toBe(FLASH);
});
