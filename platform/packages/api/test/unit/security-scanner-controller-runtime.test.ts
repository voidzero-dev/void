import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import ScannerService, {
  CopyOutbound,
  DenyAll,
  EXEC_ENV,
  FINDINGS_PATH,
  MANAGED_IMAGE,
  MODEL_HOST,
  PROBE_READY_TIMEOUT_MS,
  RUNNER_PATH,
  SELF_TEST_RUN_TIMEOUT_MS,
  SETUP_TIMEOUT_MS,
  ScanModelOutbound,
  ScannerController,
  ScannerControllerEngineA,
  ScannerControllerEngineC,
  STATUS_PATH,
  scanInstanceName,
  probeInstanceName,
} from '../../src/security-scanner-controller-runtime.ts';
import { SECURITY_SELF_TEST_TIMEOUT_MS } from '../../src/security/probe.ts';
import { COPY_HOST } from '../../src/security/runtime-copy-names.ts';
import { createFakeContainer } from '../__mocks__/container.ts';
import type { FakeContainer } from '../__mocks__/container.ts';
import { memoryDurableStorage } from '../helpers/memory-storage.ts';

const RUNNER = '// fake scanner runner\n';

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

describe('ScannerController scan attempt', () => {
  it('locks egress before the container starts: model host, copy host, then all HTTP, then all HTTPS', async () => {
    const { fake } = await startedScan();
    expect(fake.calls.slice(0, 5)).toEqual([
      `interceptOutboundHttp:${MODEL_HOST}`,
      // M30: the scan's own copy, registered before the catch-alls.
      `interceptOutboundHttp:${COPY_HOST}`,
      'interceptAllOutboundHttp',
      'interceptOutboundHttps:*',
      'start',
    ]);
    expect(fake.intercepts[0]).toMatchObject({
      binding: { outbound: 'model', props: { scanId: 'ss_abc', attempt: 2 } },
    });
    expect(fake.intercepts[1]).toMatchObject({
      binding: { outbound: 'copy', props: { scanId: 'ss_abc', attempt: 2 } },
    });
    expect(fake.intercepts[2]?.binding).toEqual({ outbound: 'deny' });
    expect(fake.intercepts[3]?.binding).toEqual({ outbound: 'deny' });
  });

  it('starts with no internet and no secret env, and runs the runner as the scanner user', async () => {
    const { fake, control } = await startedScan();
    expect(fake.started()).toMatchObject({
      image: MANAGED_IMAGE,
      enableInternet: false,
      env: {},
      entrypoint: ['sleep', 'infinity'],
    });
    // No token reaches the container: every exec but the readiness check gets exactly
    // PATH and HOME, so `node` is found without inheriting anything.
    expect(EXEC_ENV).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/scan',
    });
    for (const call of fake.execs) {
      if (call.argv[0] === 'true') {
        continue;
      }
      expect(call.options?.env).toEqual(EXEC_ENV);
    }
    const setup = fake.execs.find((call) => call.argv[0] === 'node' && call.argv[1] === '-e');
    expect(setup?.options?.user).toBeUndefined();
    expect(setup?.options?.signal).toBeInstanceOf(AbortSignal);
    expect(await setup!.stdin()).toBe(RUNNER);
    const runner = fake.execs.find((call) => call.argv[1] === RUNNER_PATH);
    expect(runner?.argv).toEqual(['node', RUNNER_PATH, '--stdin-tar']);
    expect(runner?.options).toMatchObject({ user: 'scanner', cwd: '/scan' });
    expect(await runner!.stdin()).toBe('TAR-BYTES');
    expect(control.heartbeat).toHaveBeenCalledWith('ss_abc', 2);
    expect(control.input).toHaveBeenCalledWith('ss_abc', 2);
  });

  it('refuses a stale attempt before any container starts', async () => {
    const { fake, control, controller, data } = fixture();
    control.heartbeat.mockResolvedValueOnce({ ok: false, reason: 'stale' } as never);
    await controller.start(START);
    await controller.alarm();
    expect(fake.calls).not.toContain('start');
    expect(fake.calls).not.toContain('interceptOutboundHttp:model.void.internal');
    expect((data.get('state') as State).phase).toBe('done');
    expect(control.input).not.toHaveBeenCalled();
  });

  it('starts at most once and only for Engine B', async () => {
    const { controller } = fixture();
    expect(await controller.start(START)).toEqual({ ok: true });
    expect(await controller.start(START)).toEqual({ ok: false, reason: 'already_started' });
    expect(await fixture().controller.start({ ...START, engine: 'codex_sdk' })).toEqual({
      ok: false,
      reason: 'engine_unavailable',
    });
  });

  it('asks for the runtime copy once the runner has its input (M30)', async () => {
    const setup = fixture();
    const order: Array<string> = [];
    setup.control.input.mockImplementationOnce(async () => {
      order.push('input');
      return new Blob(['TAR']).stream();
    });
    const copy = vi.fn(async () => {
      order.push('copy');
      return { ok: true as const, script: 's', ms: 1 };
    });
    Object.assign(setup.control, { copy });
    await setup.controller.start(START);
    await setup.controller.alarm();
    expect(copy).toHaveBeenCalledWith('ss_abc', 2);
    expect(order).toEqual(['input', 'copy']);
    expect((setup.data.get('state') as State).phase).toBe('running');
  });

  it('keeps scanning when the copy fails or the API has no copy call', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const copy of [
      vi.fn(async () => {
        throw new Error('cloudflare down');
      }),
      vi.fn(async () => ({ ok: false as const, reason: 'static' })),
      undefined,
    ]) {
      const setup = fixture();
      if (copy) {
        Object.assign(setup.control, { copy });
      }
      await setup.controller.start(START);
      await setup.controller.alarm();
      expect((setup.data.get('state') as State).phase).toBe('running');
      expect(setup.control.result).not.toHaveBeenCalled();
      expect(setup.fake.container.running).toBe(true);
    }
  });

  it('reports a missing input as an infrastructure failure and destroys the container', async () => {
    const setup = fixture();
    setup.control.input.mockResolvedValueOnce(null as never);
    await setup.controller.start(START);
    await setup.controller.alarm();
    expect(setup.control.result).toHaveBeenCalledWith('ss_abc', 2, {
      status: { status: 'failed', reason: 'infrastructure', error_class: 'input_unavailable' },
      findings: null,
    });
    expect(setup.fake.container.running).toBe(false);
  });

  it('polls the result files, reports them once, then destroys the container', async () => {
    const { fake, control, controller, data } = await startedScan();
    await controller.alarm();
    expect(control.result).not.toHaveBeenCalled();
    fake.files.set(STATUS_PATH, JSON.stringify({ status: 'succeeded', reason: null }));
    fake.files.set(FINDINGS_PATH, '{"schema_version":1}');
    await controller.alarm();
    expect(control.result).toHaveBeenCalledWith('ss_abc', 2, {
      status: { status: 'succeeded', reason: null },
      findings: '{"schema_version":1}',
    });
    expect(fake.container.running).toBe(false);
    expect((data.get('state') as State).phase).toBe('done');
    // The read runs as scanner (never root) and has a time limit.
    const read = fake.execs.find((call) => call.argv[1] === '-e' && call.argv[3] === STATUS_PATH);
    expect(read?.options).toMatchObject({ user: 'scanner', env: EXEC_ENV });
    expect(read?.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a status.json that is a symlink and sends no file content', async () => {
    const { fake, control, controller } = await startedScan();
    // Scanned code owns /scan: it links status.json to a file only root should read.
    fake.unsafe.add(STATUS_PATH);
    fake.files.set(STATUS_PATH, 'SECRET FROM /proc/1/environ');
    fake.files.set(FINDINGS_PATH, '{"schema_version":1}');
    await controller.alarm();
    expect(control.result).toHaveBeenCalledWith('ss_abc', 2, {
      status: { status: 'failed', reason: 'bad_output', error_class: 'status_unreadable' },
      findings: null,
    });
    expect(fake.execs.some((call) => call.argv[3] === FINDINGS_PATH)).toBe(false);
    expect(fake.container.running).toBe(false);
  });

  it('sends no findings when findings.json is not a regular file', async () => {
    const { fake, control, controller } = await startedScan();
    fake.files.set(STATUS_PATH, JSON.stringify({ status: 'succeeded' }));
    fake.unsafe.add(FINDINGS_PATH);
    await controller.alarm();
    expect(control.result).toHaveBeenCalledWith('ss_abc', 2, {
      status: { status: 'succeeded' },
      findings: null,
    });
  });

  it('keeps the container while the API refuses the result, until the hard cap', async () => {
    const { fake, control, controller, data, alarms } = await startedScan();
    control.result.mockResolvedValue({ ok: false });
    fake.files.set(STATUS_PATH, JSON.stringify({ status: 'succeeded' }));
    const armed = alarms.length;
    await controller.alarm();
    expect(fake.container.running).toBe(true);
    expect(alarms.length).toBe(armed + 1);
    patchState(data, { hardDeadline: Date.now() - 1 });
    await controller.alarm();
    expect(control.result).toHaveBeenLastCalledWith('ss_abc', 2, {
      status: { status: 'timed_out', reason: 'hard_cap' },
      findings: null,
    });
    expect(fake.container.running).toBe(false);
  });

  it('sends SIGTERM at the wall clock, then kills the container after the grace period', async () => {
    const { fake, control, controller, data } = await startedScan();
    patchState(data, { wallDeadline: Date.now() - 1 });
    await controller.alarm();
    const kill = fake.execs.find((call) => call.argv[0] === 'kill');
    expect(kill?.argv.slice(0, 2)).toEqual(['kill', '-TERM']);
    expect(kill?.options).toMatchObject({ user: 'scanner', env: EXEC_ENV });
    expect(kill?.options?.signal).toBeInstanceOf(AbortSignal);
    expect((data.get('state') as State).phase).toBe('stopping');
    expect(fake.container.running).toBe(true);

    patchState(data, { stopDeadline: Date.now() - 1 });
    await controller.alarm();
    expect(control.result).toHaveBeenCalledWith('ss_abc', 2, {
      status: { status: 'timed_out', reason: 'wall_clock' },
      findings: null,
    });
    expect(fake.container.running).toBe(false);
  });

  it('collects the timed_out status the runner writes after SIGTERM', async () => {
    const { fake, control, controller, data } = await startedScan();
    patchState(data, { wallDeadline: Date.now() - 1 });
    await controller.alarm();
    fake.files.set(STATUS_PATH, JSON.stringify({ status: 'timed_out', reason: 'wall_clock' }));
    await controller.alarm();
    expect(control.result).toHaveBeenCalledWith('ss_abc', 2, {
      status: { status: 'timed_out', reason: 'wall_clock' },
      findings: null,
    });
  });

  it('stops when a later heartbeat says the scan was canceled', async () => {
    const { fake, control, controller } = await startedScan();
    control.heartbeat.mockResolvedValueOnce({ ok: false, reason: 'canceled' } as never);
    fake.files.set(STATUS_PATH, JSON.stringify({ status: 'succeeded' }));
    await controller.alarm();
    expect(control.result).not.toHaveBeenCalled();
    expect(fake.container.running).toBe(false);
  });

  it('cancel destroys the container and reports nothing', async () => {
    const { fake, control, controller } = await startedScan();
    await controller.cancel();
    expect(fake.container.running).toBe(false);
    expect(control.result).not.toHaveBeenCalled();
  });
});

describe('engine image classes (M13b)', () => {
  const REF = `registry.cloudflare.com/acct/void-security-scanner-engine-a-x@sha256:${'a'.repeat(64)}`;

  it('run the copied image, prepare /scan as root and use the runner the image ships', async () => {
    const setup = fixture({}, ScannerControllerEngineA);
    setup.fake.container.images.default = REF;
    expect(await setup.controller.start({ ...START, engine: 'agent_sdk' })).toEqual({ ok: true });
    await setup.controller.alarm();
    const { fake, control } = setup;
    // The same egress lock, before the container starts.
    expect(fake.calls.slice(0, 5)).toEqual([
      `interceptOutboundHttp:${MODEL_HOST}`,
      `interceptOutboundHttp:${COPY_HOST}`,
      'interceptAllOutboundHttp',
      'interceptOutboundHttps:*',
      'start',
    ]);
    expect(fake.started()).toMatchObject({
      image: REF,
      enableInternet: false,
      env: {},
      entrypoint: ['sleep', 'infinity'],
    });
    const prepare = fake.execs.find((call) => call.argv[0] === 'node' && call.argv[1] === '-e');
    // The image runs as `scanner` by default; only this step is root, and no runner is streamed.
    expect(prepare?.options).toMatchObject({ user: 'root', env: EXEC_ENV });
    expect(prepare?.options?.stdin).toBeUndefined();
    expect(prepare?.argv[2]).toContain('chown');
    const runner = fake.execs.find((call) => call.argv[1] === RUNNER_PATH);
    expect(runner?.argv).toEqual(['node', RUNNER_PATH, '--stdin-tar']);
    expect(runner?.options).toMatchObject({ user: 'scanner', cwd: '/scan', env: EXEC_ENV });
    expect(control.input).toHaveBeenCalledWith('ss_abc', 2);
  });

  it('refuse another engine, and fail the attempt when the class has no image', async () => {
    expect(
      await fixture({}, ScannerControllerEngineC).controller.start({
        ...START,
        engine: 'agent_sdk',
      }),
    ).toEqual({ ok: false, reason: 'engine_unavailable' });
    expect(await fixture({}, ScannerControllerEngineA).controller.start(START)).toEqual({
      ok: false,
      reason: 'engine_unavailable',
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = fixture({}, ScannerControllerEngineC);
    expect(await missing.controller.start({ ...START, engine: 'codex_sdk' })).toEqual({ ok: true });
    await missing.controller.alarm();
    expect(missing.fake.calls).not.toContain('start');
    expect(missing.control.result).toHaveBeenCalledWith('ss_abc', 2, {
      status: { status: 'failed', reason: 'infrastructure', error_class: 'controller_error' },
      findings: null,
    });
  });

  it('refuse an image without the scanner user or runner before the runner starts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setup = fixture(
      {
        exec: (call) =>
          call.argv[0] === 'node' && call.argv[1] === '-e' && call.options?.user === 'root'
            ? { exitCode: 2 }
            : undefined,
      },
      ScannerControllerEngineA,
    );
    setup.fake.container.images.default = REF;
    await setup.controller.start({ ...START, engine: 'agent_sdk' });
    await setup.controller.alarm();
    expect(setup.fake.execs.some((call) => call.argv[1] === RUNNER_PATH)).toBe(false);
    expect(setup.control.input).not.toHaveBeenCalled();
    expect(setup.control.result).toHaveBeenCalledWith(
      'ss_abc',
      2,
      expect.objectContaining({
        status: expect.objectContaining({ error_class: 'controller_error' }),
      }),
    );
    expect(setup.fake.container.running).toBe(false);
  });

  it('self-test in the engine image the same way', async () => {
    const report = { selfTest: 1, uid: 10_001 };
    const setup = fixture(
      {
        exec: (call) =>
          call.argv[2] === '--self-test'
            ? { exitCode: 0, stdout: `${JSON.stringify(report)}\n` }
            : undefined,
      },
      ScannerControllerEngineC,
    );
    setup.fake.container.images.default = REF;
    expect(await setup.controller.selfTest('pr_c')).toMatchObject({ started: true, report });
    expect(setup.fake.started()).toMatchObject({ image: REF, enableInternet: false, env: {} });
    expect(setup.fake.intercepts[0]?.binding).toEqual({
      outbound: 'model',
      props: { probeId: 'pr_c' },
    });
  });
});

describe('ScannerController self-test', () => {
  it('runs the runner self-test as scanner behind the same egress lock and destroys the container', async () => {
    const report = { selfTest: 1, uid: 999, model: { ok: true, probe: 'pr_x' } };
    const { fake, controller } = fixture({
      exec: (call) =>
        call.argv[2] === '--self-test'
          ? { exitCode: 0, stdout: `${JSON.stringify(report)}\n` }
          : undefined,
    });
    const result = await controller.selfTest('pr_x');
    expect(result).toMatchObject({ started: true, report });
    expect(fake.calls.slice(0, 4)).toEqual([
      `interceptOutboundHttp:${MODEL_HOST}`,
      'interceptAllOutboundHttp',
      'interceptOutboundHttps:*',
      'start',
    ]);
    expect(fake.intercepts[0]?.binding).toEqual({ outbound: 'model', props: { probeId: 'pr_x' } });
    expect(fake.started()).toMatchObject({ enableInternet: false, env: {} });
    const run = fake.execs.find((call) => call.argv[2] === '--self-test');
    expect(run?.options).toMatchObject({ user: 'scanner', env: EXEC_ENV });
    expect(fake.container.running).toBe(false);
    expect(await controller.selfTest('pr_x')).toMatchObject({ started: false });
  });

  it('ends before the API stops waiting, so a slow start reports its own error', () => {
    const controllerMs = PROBE_READY_TIMEOUT_MS + SETUP_TIMEOUT_MS + SELF_TEST_RUN_TIMEOUT_MS;
    expect(controllerMs).toBeLessThanOrEqual(SECURITY_SELF_TEST_TIMEOUT_MS - 30_000);
  });

  it('reports a container that never becomes ready', async () => {
    const { controller, fake } = fixture({
      exec: (call) => (call.argv[0] === 'true' ? { exitCode: 1 } : undefined),
    });
    // Each clock read moves a minute on, so the 90-second probe ready wait ends after one try.
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 60_000));
    // The 250 ms pause between ready checks runs on a fake timer.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const pending = controller.selfTest('pr_y');
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.started).toBe(false);
    expect(result.error).toContain('did not start');
    expect(fake.container.running).toBe(false);
  });
});

describe('outbound handlers', () => {
  it('answers the self-test route with the probe id from props', async () => {
    const outbound = new ScanModelOutbound(
      { props: { probeId: 'pr_z' } } as never,
      { __VOID_SECURITY_SCAN_CONTROL: {} } as never,
    );
    const response = await outbound.fetch(new Request('http://model.void.internal/v1/self-test'));
    expect(await response.json()).toEqual({ probe: 'pr_z' });
  });

  it('sends scan model calls to the API with the identity from props, not the request', async () => {
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
  });

  it('sends copy requests to the copy of this attempt only, marked dispatched (M30)', async () => {
    const seen: Array<{ script: string; url: string; method: string; body: string }> = [];
    const namespace = {
      get: vi.fn((script: string) => ({
        fetch: async (request: Request) => {
          seen.push({
            script,
            url: request.url,
            method: request.method,
            body: await request.text(),
          });
          return new Response('from the copy', { status: 201, headers: { 'x-app': '1' } });
        },
      })),
    };
    const outbound = new CopyOutbound(
      { props: { scanId: 'scan_abc123', attempt: 2 } } as never,
      {
        __VOID_SECURITY_COPIES: namespace,
        __VOID_SECURITY_COPY_PREFIX: 'void-sec-copy-0123456789ab-',
      } as never,
    );
    const response = await outbound.fetch(
      new Request('http://copy.void.internal/api/items?id=2', {
        method: 'POST',
        headers: { 'x-void-copy': 'forged', 'x-void-scan-id': 'scan_other' },
        body: '{"a":1}',
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('x-void-copy')).toBe('dispatched');
    expect(response.headers.get('x-app')).toBe('1');
    expect(await response.text()).toBe('from the copy');
    // The name comes from the props: a header from the container picks nothing.
    expect(seen).toEqual([
      {
        script: 'void-sec-copy-0123456789ab-scanabc123-a2',
        url: 'https://copy.void.internal/api/items?id=2',
        method: 'POST',
        body: '{"a":1}',
      },
    ]);
  });

  it('answers unavailable when there is no copy, or no copy namespace', async () => {
    const missing = new CopyOutbound(
      { props: { scanId: 'scan_abc', attempt: 1 } } as never,
      {
        __VOID_SECURITY_COPIES: {
          get: () => ({
            fetch: async () => {
              throw new Error('Worker not found.');
            },
          }),
        },
        __VOID_SECURITY_COPY_PREFIX: 'void-sec-copy-x-',
      } as never,
    );
    const gone = await missing.fetch(new Request('http://copy.void.internal/__void_copy/ready'));
    expect(gone.status).toBe(503);
    expect(gone.headers.get('x-void-copy')).toBe('unavailable');
    const old = new CopyOutbound(
      { props: { scanId: 'scan_abc', attempt: 1 } } as never,
      {} as never,
    );
    const none = await old.fetch(new Request('http://copy.void.internal/'));
    expect(none.status).toBe(503);
    expect(none.headers.get('x-void-copy')).toBe('unavailable');
  });

  it('denies every other host', async () => {
    const deny = new DenyAll({} as never, {} as never);
    const response = deny.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('egress denied: example.com');
  });
});

describe('ScannerService', () => {
  function service() {
    const stubs = new Map<
      string,
      {
        start: ReturnType<typeof vi.fn>;
        cancel: ReturnType<typeof vi.fn>;
        selfTest: ReturnType<typeof vi.fn>;
      }
    >();
    const namespace = (label: string) => ({
      getByName: vi.fn((name: string) => {
        const stub = {
          start: vi.fn(async () => ({ ok: true })),
          cancel: vi.fn(async () => {}),
          selfTest: vi.fn(async () => ({ started: true })),
        };
        stubs.set(`${label}:${name}`, stub);
        return stub;
      }),
    });
    const env = {
      SCANNER: namespace('b'),
      SCANNER_ENGINE_A: namespace('a'),
      SCANNER_ENGINE_C: namespace('c'),
      __VOID_SECURITY_SCANNER_IMAGES: JSON.stringify({
        agent_sdk: 'registry.cloudflare.com/x/a@sha256:1',
      }),
    };
    return { service: new ScannerService({} as never, env as never), env, stubs };
  }

  it('sends each engine to its own class, and refuses an engine with no ready image', async () => {
    const { service: scanner, env } = service();
    const started = await scanner.fetch(post('/v1/scans/start', { ...START, engine: 'agent_sdk' }));
    expect(await started.json()).toEqual({ ok: true });
    expect(env.SCANNER_ENGINE_A.getByName).toHaveBeenCalledWith(scanInstanceName('ss_abc', 2));
    expect(env.SCANNER.getByName).not.toHaveBeenCalled();

    for (const engine of ['codex_sdk', 'some_engine']) {
      const refused = await scanner.fetch(post('/v1/scans/start', { ...START, engine }));
      expect(await refused.json()).toEqual({ ok: false, reason: 'engine_unavailable' });
    }
    expect(env.SCANNER_ENGINE_C.getByName).not.toHaveBeenCalled();

    const probe = await scanner.fetch(
      post('/v1/self-test', { probeId: 'pr_1', engine: 'codex_sdk' }),
    );
    expect(await probe.json()).toMatchObject({ started: false, error: 'engine_unavailable' });
    await scanner.fetch(post('/v1/self-test', { probeId: 'pr_1', engine: 'agent_sdk' }));
    expect(env.SCANNER_ENGINE_A.getByName).toHaveBeenLastCalledWith(probeInstanceName('pr_1'));
  });

  it('reads unreadable images data as no engine image', async () => {
    const { service: scanner, env } = service();
    env.__VOID_SECURITY_SCANNER_IMAGES = 'not json';
    const refused = await scanner.fetch(post('/v1/scans/start', { ...START, engine: 'agent_sdk' }));
    expect(await refused.json()).toEqual({ ok: false, reason: 'engine_unavailable' });
  });

  it('cancels an attempt in every class when the engine is not named', async () => {
    const { service: scanner, stubs } = service();
    await scanner.fetch(post('/v1/scans/cancel', { scanId: 'ss_abc', attempt: 2 }));
    const name = scanInstanceName('ss_abc', 2);
    for (const label of ['a', 'b', 'c']) {
      expect(stubs.get(`${label}:${name}`)?.cancel).toHaveBeenCalledTimes(1);
    }
  });

  it('still cancels the other classes when one class fails, then fails the request', async () => {
    const { service: scanner, env, stubs } = service();
    env.SCANNER_ENGINE_A.getByName.mockImplementationOnce(() => ({
      start: vi.fn(),
      cancel: vi.fn(async () => {
        throw new Error('Durable Object busy');
      }),
      selfTest: vi.fn(),
    }));
    const response = await scanner.fetch(
      post('/v1/scans/cancel', { scanId: 'ss_abc', attempt: 2 }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, reason: 'cancel_failed' });
    const name = scanInstanceName('ss_abc', 2);
    for (const label of ['b', 'c']) {
      expect(stubs.get(`${label}:${name}`)?.cancel).toHaveBeenCalledTimes(1);
    }
  });

  const post = (path: string, body: unknown) =>
    new Request(`https://security-scanner.internal${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

  it('gives every scan attempt and every probe its own instance (edge #42)', async () => {
    const { service: scanner, env } = service();
    await scanner.fetch(post('/v1/scans/start', { ...START, scanId: 'ss_a' }));
    await scanner.fetch(post('/v1/scans/start', { ...START, scanId: 'ss_b' }));
    await scanner.fetch(post('/v1/scans/start', { ...START, scanId: 'ss_a', attempt: 3 }));
    await scanner.fetch(post('/v1/self-test', { probeId: 'pr_1' }));
    const names = env.SCANNER.getByName.mock.calls.map(([name]) => name);
    expect(names).toEqual([
      scanInstanceName('ss_a', 2),
      scanInstanceName('ss_b', 2),
      scanInstanceName('ss_a', 3),
      probeInstanceName('pr_1'),
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('refuses malformed requests before touching a Durable Object', async () => {
    const { service: scanner, env } = service();
    for (const body of [
      { ...START, scanId: '../x' },
      { ...START, attempt: 0 },
      { ...START, hardCapMs: 1000 },
      { probeId: 'pr 1' },
    ]) {
      const path = 'probeId' in body ? '/v1/self-test' : '/v1/scans/start';
      expect((await scanner.fetch(post(path, body))).status).toBe(400);
    }
    expect((await scanner.fetch(new Request('https://x/v1/scans/start'))).status).toBe(404);
    expect(env.SCANNER.getByName).not.toHaveBeenCalled();
  });
});
