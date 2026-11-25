import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  CopyOutbound,
  DenyAll,
  EXEC_ENV,
  FINDINGS_PATH,
  MANAGED_IMAGE,
  MODEL_HOST,
  RUNNER_PATH,
  ScanModelOutbound,
  ScannerController,
  STATUS_PATH,
} from '../../src/security-scanner-controller-runtime.ts';
import { COPY_HOST } from '../../src/security/runtime-copy-names.ts';
import { createFakeContainer } from '../__mocks__/container.ts';
import type { FakeContainer } from '../__mocks__/container.ts';
import { memoryDurableStorage } from '../helpers/memory-storage.ts';

function fixture(
  options: Parameters<typeof createFakeContainer>[0] = {},
  Controller: typeof ScannerController = ScannerController,
) {
  const fake: FakeContainer = createFakeContainer(options);
  const { storage, map: data, alarms } = memoryDurableStorage();
  const control = {
    heartbeat: vi.fn(async () => ({ ok: true as const, leaseUntil: '2099-01-01T00:00:00.000Z' })),
    input: vi.fn(async () => new Blob(['TAR-BYTES']).stream()),
    model: vi.fn(async () => new Response('model answer')),
    result: vi.fn(async () => ({ ok: true })),
  };
  const ctx = {
    container: fake.container,
    exports: {
      ScanModelOutbound: (init: { props: unknown }) => ({ outbound: 'model', props: init.props }),
      CopyOutbound: (init: { props: unknown }) => ({ outbound: 'copy', props: init.props }),
      DenyAll: () => ({ outbound: 'deny' }),
    },
    storage,
  };
  const env = { SCANNER: { getByName: vi.fn() }, __VOID_SECURITY_SCAN_CONTROL: control };
  const controller = new Controller(ctx as never, env as never);
  return { fake, data, alarms, control, ctx, env, controller };
}

const START = {
  scanId: 'ss_abc',
  attempt: 2,
  engine: 'void_loop',
  wallClockMs: 20 * 60_000,
  hardCapMs: 45 * 60_000,
};

type State = { phase: string; wallDeadline: number; hardDeadline: number; stopDeadline?: number };

async function startedScan(options: Parameters<typeof createFakeContainer>[0] = {}) {
  const setup = fixture(options);
  expect(await setup.controller.start(START)).toEqual({ ok: true });
  await setup.controller.alarm();
  return setup;
}

function patchState(data: Map<string, unknown>, patch: Partial<State>) {
  data.set('state', { ...(data.get('state') as State), ...patch });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// I2/I3: no internet, no credential, identity only in binding props.
describe('ScannerController scan attempt', () => {
  it('locks egress before start, then runs with no internet and no secret env, as the scanner user', async () => {
    const { fake, control } = await startedScan();
    expect(fake.calls.slice(0, 5)).toEqual([
      `interceptOutboundHttp:${MODEL_HOST}`,
      `interceptOutboundHttp:${COPY_HOST}`,
      'interceptAllOutboundHttp',
      'interceptOutboundHttps:*',
      'start',
    ]);
    expect(fake.intercepts[0]).toMatchObject({
      binding: { outbound: 'model', props: { scanId: 'ss_abc', attempt: 2 } },
    });
    expect(fake.intercepts[2]?.binding).toEqual({ outbound: 'deny' });
    expect(fake.intercepts[3]?.binding).toEqual({ outbound: 'deny' });
    expect(fake.started()).toMatchObject({ image: MANAGED_IMAGE, enableInternet: false, env: {} });
    expect(EXEC_ENV).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/scan',
    });
    for (const call of fake.execs) {
      if (call.argv[0] !== 'true') {
        expect(call.options?.env).toEqual(EXEC_ENV);
      }
    }
    const runner = fake.execs.find((call) => call.argv[1] === RUNNER_PATH);
    expect(runner?.options).toMatchObject({ user: 'scanner', cwd: '/scan' });
    expect(await runner!.stdin()).toBe('TAR-BYTES');
    expect(control.input).toHaveBeenCalledWith('ss_abc', 2);
  });

  it('starts no container for a stale attempt, starts once, and only for Engine B', async () => {
    const { fake, control, controller, data } = fixture();
    control.heartbeat.mockResolvedValueOnce({ ok: false, reason: 'stale' } as never);
    expect(await controller.start(START)).toEqual({ ok: true });
    expect(await controller.start(START)).toEqual({ ok: false, reason: 'already_started' });
    await controller.alarm();
    expect(fake.calls).not.toContain('start');
    expect((data.get('state') as State).phase).toBe('done');
    expect(control.input).not.toHaveBeenCalled();
    expect(await fixture().controller.start({ ...START, engine: 'codex_sdk' })).toEqual({
      ok: false,
      reason: 'engine_unavailable',
    });
  });

  it('reports the result files once, refuses a linked status.json, then destroys the container', async () => {
    const { fake, control, controller } = await startedScan();
    fake.files.set(STATUS_PATH, JSON.stringify({ status: 'succeeded', reason: null }));
    fake.files.set(FINDINGS_PATH, '{"schema_version":1}');
    await controller.alarm();
    expect(control.result).toHaveBeenCalledWith('ss_abc', 2, {
      status: { status: 'succeeded', reason: null },
      findings: '{"schema_version":1}',
    });
    expect(fake.container.running).toBe(false);

    // Scanned code owns /scan: it links status.json to a file only root should read.
    const linked = await startedScan();
    linked.fake.unsafe.add(STATUS_PATH);
    linked.fake.files.set(STATUS_PATH, 'SECRET FROM /proc/1/environ');
    await linked.controller.alarm();
    expect(linked.control.result).toHaveBeenCalledWith('ss_abc', 2, {
      status: { status: 'failed', reason: 'bad_output', error_class: 'status_unreadable' },
      findings: null,
    });
  });

  it('sends SIGTERM at the wall clock and kills the container after the grace period', async () => {
    const { fake, control, controller, data } = await startedScan();
    patchState(data, { wallDeadline: Date.now() - 1 });
    await controller.alarm();
    expect(fake.execs.find((call) => call.argv[0] === 'kill')?.argv.slice(0, 2)).toEqual([
      'kill',
      '-TERM',
    ]);
    expect(fake.container.running).toBe(true);
    patchState(data, { stopDeadline: Date.now() - 1 });
    await controller.alarm();
    expect(control.result).toHaveBeenCalledWith('ss_abc', 2, {
      status: { status: 'timed_out', reason: 'wall_clock' },
      findings: null,
    });
    expect(fake.container.running).toBe(false);
  });

  it('stops without reporting when a later heartbeat says the scan was canceled', async () => {
    const { fake, control, controller } = await startedScan();
    control.heartbeat.mockResolvedValueOnce({ ok: false, reason: 'canceled' } as never);
    fake.files.set(STATUS_PATH, JSON.stringify({ status: 'succeeded' }));
    await controller.alarm();
    expect(control.result).not.toHaveBeenCalled();
    expect(fake.container.running).toBe(false);
  });
});

describe('outbound handlers', () => {
  it('sends model calls with the identity from props, not the request, and denies other hosts', async () => {
    const model = vi.fn(async () => new Response('ok'));
    const outbound = new ScanModelOutbound(
      { props: { scanId: 'ss_1', attempt: 3 } } as never,
      { __VOID_SECURITY_SCAN_CONTROL: { model } } as never,
    );
    const request = new Request('http://model.void.internal/v1/chat/completions', {
      method: 'POST',
      headers: { 'x-void-scan-id': 'ss_other' },
      body: '{}',
    });
    await outbound.fetch(request);
    expect(model).toHaveBeenCalledWith('ss_1', 3, request);
    const denied = new DenyAll({} as never, {} as never).fetch(new Request('https://example.com/'));
    expect(denied.status).toBe(403);
  });

  it('sends copy requests to the copy of this attempt only (M30)', async () => {
    const scripts: Array<string> = [];
    const namespace = {
      get: (script: string) => {
        scripts.push(script);
        return { fetch: async () => new Response('from the copy', { status: 201 }) };
      },
    };
    const outbound = new CopyOutbound(
      { props: { scanId: 'scan_abc123', attempt: 2 } } as never,
      {
        __VOID_SECURITY_COPIES: namespace,
        __VOID_SECURITY_COPY_PREFIX: 'void-sec-copy-0123456789ab-',
      } as never,
    );
    const response = await outbound.fetch(
      new Request('http://copy.void.internal/api/items', {
        headers: { 'x-void-copy': 'forged', 'x-void-scan-id': 'scan_other' },
      }),
    );
    expect(response.headers.get('x-void-copy')).toBe('dispatched');
    expect(scripts).toEqual(['void-sec-copy-0123456789ab-scanabc123-a2']);
  });
});
