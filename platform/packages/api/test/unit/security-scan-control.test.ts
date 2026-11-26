import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  row: vi.fn(),
  capability: vi.fn(),
  prepare: vi.fn(),
  ingest: vi.fn(),
  recheck: vi.fn(),
  github: vi.fn(),
  copy: vi.fn(),
  deleteCopy: vi.fn(),
  noteCopy: vi.fn(),
}));
vi.mock('../../src/db.ts', () => ({
  createDb: () => {
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      limit: mocks.row,
    };
    return { select: () => query };
  },
}));
vi.mock('../../src/capabilities.ts', () => ({ getPlatformCapabilities: mocks.capability }));
vi.mock('../../src/security/input/prepare.ts', () => ({ prepareSecurityScanInput: mocks.prepare }));
vi.mock('../../src/security/ingest.ts', () => ({ ingestSecurityScanResult: mocks.ingest }));
vi.mock('../../src/security/public-gate-flow.ts', () => ({
  recheckPublicRequestForScan: mocks.recheck,
}));
vi.mock('../../src/security/github-check.ts', () => ({
  reportSecurityScanToGitHub: mocks.github,
}));
vi.mock('../../src/security/runtime-copy.ts', () => ({
  prepareSecurityRuntimeCopy: mocks.copy,
  deleteSecurityRuntimeCopyForScan: mocks.deleteCopy,
  noteSecurityRuntimeCopyOutcome: mocks.noteCopy,
}));

import { judgeScanFence, SecurityScanControl } from '../../src/security/control.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const LEASE = '2026-11-18T12:30:00.000Z';
const env = {
  HYPERDRIVE: { connectionString: 'test' },
  PLATFORM_INSTALLATION_ID: 'inst_1',
  SANDBOX_CONTROL_SERVICE: 'void-api-inst',
  CF_ACCOUNT_ID: 'account',
  CF_API_TOKEN: 'token',
};
const identity = { protocol: 1, installation: 'inst_1' };

function control(props: unknown = identity) {
  return new SecurityScanControl({ props } as never, env as never);
}

function running(overrides: Record<string, unknown> = {}) {
  return {
    status: 'running',
    attempt: 2,
    leaseUntil: LEASE,
    projectStatus: 'active',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capability.mockReturnValue({ securityAudits: true });
  mocks.row.mockResolvedValue([running({ leaseUntil: '2999-01-01T00:00:00.000Z' })]);
});

// I4: every controller call carries (scan, attempt); an ended or reaped attempt is refused.
it('judgeScanFence passes only the current attempt of a running scan inside its lease', () => {
  expect(judgeScanFence(running(), 2, NOW)).toEqual({ ok: true, leaseUntil: LEASE });
  const stale = { ok: false, reason: 'stale' };
  const canceled = { ok: false, reason: 'canceled' };
  expect(judgeScanFence(running(), 1, NOW)).toEqual(stale);
  expect(judgeScanFence(running(), 3, NOW)).toEqual(stale);
  expect(judgeScanFence(running({ leaseUntil: '2026-11-18T11:59:59.000Z' }), 2, NOW)).toEqual(
    stale,
  );
  expect(judgeScanFence(running({ status: 'succeeded' }), 2, NOW)).toEqual(canceled);
  expect(judgeScanFence(undefined, 2, NOW)).toEqual(canceled);
  expect(judgeScanFence(running({ projectStatus: 'deleting' }), 2, NOW)).toEqual(canceled);
});

describe('SecurityScanControl', () => {
  it('refuses an untrusted caller, a bad attempt, or any call while the capability is off', async () => {
    const unavailable = { ok: false, reason: 'unavailable' };
    for (const props of [null, {}, { protocol: 1, installation: 'inst_2' }]) {
      expect(await control(props).heartbeat('ss_1', 2)).toEqual(unavailable);
    }
    expect(await control().heartbeat('ss_1', 1.5)).toMatchObject({ ok: false });
    expect(await control({}).result('ss_1', 2, { status: {}, findings: null })).toEqual({
      ok: false,
    });
    expect(await control({}).copy('ss_1', 2)).toEqual({ ok: false, reason: 'fence' });
    mocks.capability.mockReturnValue({ securityAudits: false });
    expect(await control().heartbeat('ss_1', 2)).toEqual(unavailable);
    expect(await control().input('ss_1', 2)).toBeNull();
    expect((await control().model('ss_1', 2, new Request('http://model/'))).status).toBe(403);
    expect(mocks.row).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it('builds the input and takes a result only for the fenced, running attempt', async () => {
    const stream = new Blob(['tar']).stream();
    mocks.prepare.mockResolvedValue(stream);
    expect(await control().input('ss_1', 2)).toBe(stream);
    expect(mocks.prepare).toHaveBeenCalledWith(env, expect.anything(), 'ss_1', 2);
    mocks.prepare.mockClear();
    expect(await control().input('ss_1', 1)).toBeNull();
    expect(mocks.prepare).not.toHaveBeenCalled();

    const report = { status: { status: 'succeeded' }, findings: '{}' };
    mocks.ingest.mockResolvedValue({ ok: true, kind: 'retried' });
    expect(await control().result('ss_1', 2, report)).toEqual({ ok: true });
    expect(mocks.ingest).toHaveBeenCalledWith(env, expect.anything(), 'ss_1', 2, report);
    mocks.ingest.mockResolvedValue({ ok: false });
    expect(await control().result('ss_1', 2, report)).toEqual({ ok: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.ingest.mockRejectedValue(new Error('database down'));
    expect(await control().result('ss_1', 2, report)).toEqual({ ok: false });
  });
});
