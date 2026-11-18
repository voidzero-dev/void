import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const mocks = vi.hoisted(() => ({
  row: vi.fn(),
  capability: vi.fn(),
  prepare: vi.fn(),
  ingest: vi.fn(),
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
vi.mock('../../src/security/input/prepare.ts', () => ({ prepareSecurityScanInput: mocks.prepare }));
vi.mock('../../src/security/ingest.ts', () => ({ ingestSecurityScanResult: mocks.ingest }));

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

  it('builds the input only for the fenced, running attempt', async () => {
    const stream = new Blob(['tar']).stream();
    mocks.prepare.mockResolvedValue(stream);
    expect(await control().input('ss_1', 2)).toBe(stream);
    expect(mocks.prepare).toHaveBeenCalledWith(env, expect.anything(), 'ss_1', 2);

    mocks.prepare.mockClear();
    expect(await control().input('ss_1', 1)).toBeNull();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('answers null when the input cannot be built, so the controller stops', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.prepare.mockRejectedValue(new Error('R2 down'));
    expect(await control().input('ss_1', 2)).toBeNull();
  });

  it('hands model calls to the model proxy', async () => {
    // An unknown model route is refused by the proxy before any read.
    const model = await control().model('ss_1', 2, new Request('http://model/'));
    expect(model.status).toBe(404);
    expect(model.headers.get('x-void-scan-stop')).toBeNull();
    expect(mocks.row).not.toHaveBeenCalled();
  });

  it('hands a result to ingest and answers whether it was taken', async () => {
    mocks.ingest.mockResolvedValue({ ok: true, kind: 'retried' });
    const report = { status: { status: 'succeeded' }, findings: '{}' };
    expect(await control().result('ss_1', 2, report)).toEqual({ ok: true });
    expect(mocks.ingest).toHaveBeenCalledWith(env, expect.anything(), 'ss_1', 2, report);

    mocks.ingest.mockResolvedValue({ ok: false });
    expect(await control().result('ss_1', 2, report)).toEqual({ ok: false });
  });

  it('answers not taken when ingest throws or the caller is not trusted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.ingest.mockRejectedValue(new Error('database down'));
    expect(await control().result('ss_1', 2, { status: {}, findings: null })).toEqual({
      ok: false,
    });
    mocks.ingest.mockClear();
    expect(await control({}).result('ss_1', 2, { status: {}, findings: null })).toEqual({
      ok: false,
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
