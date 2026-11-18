import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  row: vi.fn(),
  capability: vi.fn(),
}));
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
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

describe('judgeScanFence', () => {
  it('passes only the current attempt of a running scan inside its lease', () => {
    expect(judgeScanFence(running(), 2, NOW)).toEqual({ ok: true, leaseUntil: LEASE });
  });

  it('refuses an older or newer attempt as stale (T10)', () => {
    expect(judgeScanFence(running(), 1, NOW)).toEqual({ ok: false, reason: 'stale' });
    expect(judgeScanFence(running(), 3, NOW)).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuses a scan past its lease as stale, even while the row still says running', () => {
    expect(judgeScanFence(running({ leaseUntil: '2026-11-18T11:59:59.000Z' }), 2, NOW)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(judgeScanFence(running({ leaseUntil: null }), 2, NOW)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('tells the controller to stop for a finished, canceled or missing scan or a deleting project', () => {
    for (const status of ['canceled', 'timed_out', 'succeeded', 'queued']) {
      expect(judgeScanFence(running({ status }), 2, NOW)).toEqual({
        ok: false,
        reason: 'canceled',
      });
    }
    expect(judgeScanFence(undefined, 2, NOW)).toEqual({ ok: false, reason: 'canceled' });
    expect(judgeScanFence(running({ projectStatus: 'deleting' }), 2, NOW)).toEqual({
      ok: false,
      reason: 'canceled',
    });
  });
});

describe('SecurityScanControl', () => {
  it('answers a heartbeat from this installation scanner from the scan row', async () => {
    expect(await control().heartbeat('ss_1', 2)).toEqual({
      ok: true,
      leaseUntil: '2999-01-01T00:00:00.000Z',
    });
    expect(mocks.row).toHaveBeenCalledTimes(1);
  });

  it('refuses callers whose binding props do not name this installation', async () => {
    for (const props of [
      null,
      {},
      { protocol: 2, installation: 'inst_1' },
      { protocol: 1, installation: 'inst_2' },
    ]) {
      expect(await control(props).heartbeat('ss_1', 2)).toEqual({
        ok: false,
        reason: 'unavailable',
      });
    }
    expect(mocks.row).not.toHaveBeenCalled();
  });

  it('refuses everything while the capability is off', async () => {
    mocks.capability.mockReturnValue({ securityAudits: false });
    expect(await control().heartbeat('ss_1', 2)).toEqual({ ok: false, reason: 'unavailable' });
    expect(await control().input('ss_1', 2)).toBeNull();
    expect((await control().model('ss_1', 2, new Request('http://model/'))).status).toBe(403);
    expect(mocks.row).not.toHaveBeenCalled();
  });

  it('refuses bad scan ids and attempts without a database read', async () => {
    expect(await control().heartbeat('', 2)).toMatchObject({ ok: false });
    expect(await control().heartbeat('ss_1', 0)).toMatchObject({ ok: false });
    expect(await control().heartbeat('ss_1', 1.5)).toMatchObject({ ok: false });
    expect(mocks.row).not.toHaveBeenCalled();
  });

  it('has no input, model proxy or ingest before their milestones', async () => {
    expect(await control().input('ss_1', 2)).toBeNull();
    const model = await control().model('ss_1', 2, new Request('http://model/'));
    expect(model.status).toBe(503);
    expect(model.headers.get('x-void-scan-stop')).toBeNull();
    expect(await control().result('ss_1', 2, { status: {}, findings: null })).toEqual({
      ok: false,
    });
  });
});
