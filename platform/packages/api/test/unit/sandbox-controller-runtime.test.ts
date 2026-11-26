import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
vi.mock('@cloudflare/sandbox', () => ({
  Files: class {},
  DirectoryBackup: class {},
  DirectoryBackupGateway: class {},
  S3Mount: class {},
  S3Gateway: class {},
}));
vi.mock('cloudflare:workers', () => ({
  RpcTarget: class {},
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkerEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock('../../src/sandbox-shim.ts', () => ({ getSandboxShim: vi.fn() }));
import SandboxService, { SandboxController } from '../../src/sandbox-controller-runtime.ts';
import { getSandboxShim } from '../../src/sandbox-shim.ts';

function fixture() {
  const data = new Map<string, unknown>();
  const process = {
    pid: 42,
    stdin: null,
    stdout: new Blob(['ok']).stream(),
    stderr: null,
    exitCode: Promise.resolve(0),
    output: vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0) }),
    kill: vi.fn(),
    resize: vi.fn(),
  };
  const container = {
    running: false,
    images: { default: 'registry.cloudflare.com/account/sandbox@sha256:digest' },
    start: vi.fn(() => {
      container.running = true;
    }),
    exec: vi.fn(async (_argv: Array<string>, _options?: { signal?: AbortSignal }) => ({
      ...process,
      stdout: new Blob(['ok']).stream(),
    })),
    setInactivityTimeout: vi.fn(),
    destroy: vi.fn(async () => {
      container.running = false;
    }),
  };
  const control = {
    reserve: vi.fn().mockResolvedValue({ ok: true }),
    started: vi.fn().mockResolvedValue({ ok: true }),
    heartbeat: vi.fn().mockResolvedValue({ ok: true }),
    stopped: vi.fn(),
  };
  const ctx = {
    blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
    id: { toString: () => 'namespace-instance' },
    container,
    storage: {
      get: async (key: string) => structuredClone(data.get(key)),
      put: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
      delete: async (key: string) => data.delete(key),
      setAlarm: vi.fn(),
      deleteAlarm: vi.fn(),
    },
  };
  const env = { SANDBOX: { getByName: vi.fn() }, __VOID_SANDBOX_CONTROL: control };
  const controller = new SandboxController(ctx as never, env as never);
  env.SANDBOX.getByName.mockReturnValue(controller);
  return {
    controller,
    ctx,
    env,
    container,
    control,
    data,
    process,
    start: () => controller.invoke('exec', [['true']]),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('trusted Sandbox lifecycle', () => {
  it('retains the VM before waiting for boot readiness', async () => {
    const f = fixture();
    f.container.exec.mockImplementation(async () => {
      expect(f.container.setInactivityTimeout).toHaveBeenCalledWith(10 * 60 * 1000);
      return f.process;
    });
    await f.start();
    expect(f.container.start.mock.invocationCallOrder[0]).toBeLessThan(
      f.container.setInactivityTimeout.mock.invocationCallOrder[0],
    );
    expect(f.container.setInactivityTimeout.mock.invocationCallOrder[0]).toBeLessThan(
      f.container.exec.mock.invocationCallOrder[0],
    );
  });
  it('reserves before boot and confirms readiness before billing', async () => {
    const f = fixture();
    f.control.reserve.mockImplementation(async () => {
      expect(f.container.running).toBe(false);
      return { ok: true };
    });
    f.control.started.mockImplementation(async () => {
      expect(f.process.output).toHaveBeenCalled();
      return { ok: true };
    });
    await f.start();
    expect(f.container.start).toHaveBeenCalledWith(
      expect.objectContaining({
        image: f.container.images.default,
        enableInternet: false,
        instance: 'lite',
      }),
    );
    expect(f.control.reserve).toHaveBeenCalledOnce();
    expect(f.control.started).toHaveBeenCalledWith('namespace-instance', expect.any(String));
    expect(f.data.get('__voidSandboxLease')).toMatchObject({ phase: 'running' });
  });
  it('installs the matching helper into the managed Node image before admitting operations', async () => {
    const f = fixture();
    Object.assign(f.env, { __VOID_SANDBOX_IMAGE: 'cloudflare/debian-trixie' });
    vi.mocked(getSandboxShim).mockResolvedValue(new Uint8Array([127, 69, 76, 70]));
    await f.start();
    expect(f.container.start).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'cloudflare/debian-trixie',
        entrypoint: ['sleep', 'infinity'],
      }),
    );
    expect(f.container.exec).toHaveBeenCalledWith(
      ['node', '-e', expect.any(String)],
      expect.objectContaining({ stdin: expect.any(ReadableStream) }),
    );
  });
  it('stops before billing when helper preparation fails', async () => {
    const f = fixture();
    Object.assign(f.env, { __VOID_SANDBOX_IMAGE: 'cloudflare/debian-trixie' });
    vi.mocked(getSandboxShim).mockRejectedValue(new Error('integrity check failed'));
    await expect(f.start()).rejects.toThrow('integrity check failed');
    expect(f.container.running).toBe(false);
    expect(f.control.started).not.toHaveBeenCalled();
  });
  it('never boots on failed admission', async () => {
    const f = fixture();
    f.control.reserve.mockResolvedValue({ ok: false, reason: 'concurrency' });
    await expect(f.start()).rejects.toThrow('VOID_SANDBOX_concurrency');
    expect(f.container.start).not.toHaveBeenCalled();
    expect(f.control.started).not.toHaveBeenCalled();
  });
  it('coalesces starts while admission is pending', async () => {
    const f = fixture();
    await Promise.all([f.start(), f.start(), f.start()]);
    expect(f.control.reserve).toHaveBeenCalledOnce();
    expect(f.container.start).toHaveBeenCalledOnce();
  });
  it('cancels pending startup before it can boot after destroy', async () => {
    const f = fixture();
    let admitted!: () => void;
    f.control.reserve.mockImplementation(
      () =>
        new Promise((resolve) => {
          admitted = () => resolve({ ok: true });
        }),
    );
    const start = f.start();
    const rejected = expect(start).rejects.toThrow('startup was cancelled');
    await vi.waitFor(() => expect(f.control.reserve).toHaveBeenCalled());
    await f.controller.destroy();
    const second = expect(f.start()).rejects.toThrow('startup was cancelled');
    admitted();
    await Promise.all([rejected, second]);
    expect(f.container.start).not.toHaveBeenCalled();
    expect(f.control.reserve).toHaveBeenCalledOnce();
  });
  it('kills a container whose workspace preparation fails before confirming billing', async () => {
    const f = fixture();
    f.process.output.mockResolvedValue({
      exitCode: 1,
      stdout: new ArrayBuffer(0),
      stderr: new ArrayBuffer(0),
    });
    await expect(f.start()).rejects.toThrow('workspace initialization failed');
    expect(f.container.running).toBe(false);
    expect(f.control.started).not.toHaveBeenCalled();
  });
  it('hard-kills a booted container when startup confirmation fails', async () => {
    const f = fixture();
    f.control.started.mockResolvedValue({ ok: false, reason: 'runtime_budget' });
    await expect(f.start()).rejects.toThrow('VOID_SANDBOX_runtime_budget');
    expect(f.container.destroy).toHaveBeenCalledOnce();
    expect(f.control.stopped).toHaveBeenCalledOnce();
  });
  it('hard-kills on heartbeat denial before releasing capacity', async () => {
    const f = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await f.start();
    f.control.heartbeat.mockResolvedValue({ ok: false, reason: 'runtime_budget' });
    f.control.stopped.mockImplementation(async () => {
      expect(f.container.running).toBe(false);
    });
    await f.controller.alarm();
    expect(f.container.destroy).toHaveBeenCalledOnce();
    expect(f.control.stopped).toHaveBeenCalledOnce();
    expect(f.data.size).toBe(0);
  });
  it('also gates each operation, rather than waiting for the next alarm', async () => {
    const f = fixture();
    await f.start();
    f.control.heartbeat.mockResolvedValue({ ok: false, reason: 'runtime_budget' });
    await expect(f.start()).rejects.toThrow('VOID_SANDBOX_runtime_budget');
    expect(f.container.running).toBe(false);
  });
  it('terminates after bounded control timeouts', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture();
    await f.start();
    f.control.heartbeat.mockImplementation(() => new Promise(() => {}));
    const alarm = f.controller.alarm();
    await vi.advanceTimersByTimeAsync(5000);
    await alarm;
    expect(f.container.running).toBe(false);
    expect(f.control.stopped).toHaveBeenCalledOnce();
  });
  it('persists a stopped generation until final accounting succeeds', async () => {
    const f = fixture();
    await f.start();
    const generation = (f.data.get('__voidSandboxLease') as { generation: string }).generation;
    f.container.running = false;
    f.control.stopped.mockRejectedValueOnce(new Error('unavailable'));
    await expect(f.controller.destroy()).rejects.toThrow('unavailable');
    expect(f.data.get('__voidSandboxLease')).toEqual({ generation, phase: 'stopped' });
    await f.controller.alarm();
    expect(f.control.stopped).toHaveBeenLastCalledWith('namespace-instance', generation);
    expect(f.data.size).toBe(0);
  });
  it('reconciles interrupted startup before granting another lease', async () => {
    const f = fixture();
    f.data.set('__voidSandboxLease', { generation: 'orphan', phase: 'pending' });
    f.container.running = true;
    await f.start();
    expect(f.container.destroy).toHaveBeenCalledOnce();
    expect(f.control.stopped).toHaveBeenCalledWith('namespace-instance', 'orphan');
    expect(f.container.running).toBe(true);
  });
  it('reapplies inactivity settings and retains the running lease after DO restart', async () => {
    const f = fixture();
    await f.controller.configure({ inactivityTimeoutMs: 2000 });
    await f.start();
    const resumed = new SandboxController(f.ctx as never, f.env as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.container.setInactivityTimeout).toHaveBeenLastCalledWith(2000);
    await resumed.invoke('exec', [['true']]);
    expect(f.control.reserve).toHaveBeenCalledOnce();
    expect(f.container.setInactivityTimeout).toHaveBeenLastCalledWith(2000);
  });
  it('does not use a long-running monitor that defeats inactivity expiration', async () => {
    const f = fixture();
    await f.start();
    f.container.running = false;
    await f.controller.alarm();
    expect(f.control.stopped).toHaveBeenCalledOnce();
    expect(f.ctx.storage.deleteAlarm).toHaveBeenCalled();
  });
  it('expires idle running containers even while accounting heartbeats continue', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.configure({ inactivityTimeoutMs: 120_000 });
    await f.start();
    const activity = structuredClone(f.data.get('__voidSandboxActivity'));
    for (let check = 0; check < 3; check++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await f.controller.alarm();
      expect(f.container.running).toBe(true);
      expect(f.data.get('__voidSandboxActivity')).toEqual(activity);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    await f.controller.alarm();
    expect(f.container.running).toBe(false);
    expect(f.control.stopped).toHaveBeenCalledOnce();
  });
  it('preserves the idle deadline across a controller restart', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.configure({ inactivityTimeoutMs: 120_000 });
    await f.start();
    await vi.advanceTimersByTimeAsync(90_000);
    const resumed = new SandboxController(f.ctx as never, f.env as never);
    await resumed.alarm();
    expect(f.container.running).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await resumed.alarm();
    expect(f.container.running).toBe(false);
  });
  it('keeps an active startup request alive and starts a fresh idle deadline after boot', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.configure({ inactivityTimeoutMs: 1000 });
    let resolve!: (value: { ok: true }) => void;
    f.control.reserve.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await f.controller.alarm();
    resolve({ ok: true });
    await pending;
    await f.controller.alarm();
    expect(f.container.running).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await f.controller.alarm();
    expect(f.container.running).toBe(false);
  });
  it('keeps explicit exit-code waiters active without adopting unattended background processes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.configure({ inactivityTimeoutMs: 1000 });
    let resolve!: (code: number) => void;
    f.process.exitCode = new Promise((done) => {
      resolve = done;
    });
    const wire = (await f.start()) as {
      capability: { invoke(operation: string, args: Array<unknown>): Promise<unknown> };
    };
    const waiting = wire.capability.invoke('exitCode', []);
    await vi.advanceTimersByTimeAsync(2000);
    await f.controller.alarm();
    expect(f.container.running).toBe(true);
    resolve(0);
    await waiting;
    await vi.advanceTimersByTimeAsync(1000);
    await f.controller.alarm();
    expect(f.container.running).toBe(false);

    const background = fixture();
    await background.controller.configure({ inactivityTimeoutMs: 1000 });
    background.process.exitCode = new Promise(() => {});
    await background.start();
    await vi.advanceTimersByTimeAsync(1000);
    await background.controller.alarm();
    expect(background.container.running).toBe(false);
  });
  it('keeps streamed port responses active until completion or cancellation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.configure({ inactivityTimeoutMs: 1000 });
    const cancel = vi.fn();
    Object.assign(f.container, {
      getTcpPort: () => ({ fetch: async () => new Response(new ReadableStream({ cancel })) }),
    });
    const response = (await f.controller.invoke('fetch', [
      8080,
      new Request('http://container/'),
    ])) as Response;
    await vi.advanceTimersByTimeAsync(2000);
    await f.controller.alarm();
    expect(f.container.running).toBe(true);
    await response.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await f.controller.alarm();
    expect(f.container.running).toBe(false);
  });
  it('refreshes the idle deadline when process output bytes arrive', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.configure({ inactivityTimeoutMs: 1000 });
    let source!: ReadableStreamDefaultController;
    f.container.exec.mockImplementation(async () => ({
      ...f.process,
      stdout: new ReadableStream({
        start(controller) {
          source = controller;
        },
      }),
    }));
    const wire = (await f.start()) as { stdout: ReadableStream };
    const reader = wire.stdout.getReader();
    const reading = reader.read();
    await vi.advanceTimersByTimeAsync(500);
    source.enqueue(new Uint8Array([1]));
    await reading;
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(500);
    await f.controller.alarm();
    expect(f.container.running).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    await f.controller.alarm();
    expect(f.container.running).toBe(false);
  });
  it('detaches initialization and command abort signals after their processes exit', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const abort = new AbortController();
    let forward!: () => void;
    const cancellation = new ReadableStream({
      start(controller) {
        forward = () => controller.close();
        abort.signal.addEventListener('abort', forward, { once: true });
      },
      cancel() {
        abort.signal.removeEventListener('abort', forward);
      },
    });
    await f.controller.invoke('exec', [['true'], { abort: cancellation }]);
    await vi.advanceTimersByTimeAsync(0);
    const signals = f.container.exec.mock.calls.map(([, options]) => options?.signal);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal && !signal.aborted)).toBe(true);
    abort.abort();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(signals.every((signal) => signal && !signal.aborted)).toBe(true);
  });
});

describe('Sandbox capability boundary', () => {
  function service() {
    const f = fixture();
    return { ...f, host: new SandboxService({} as never, f.env as never) };
  }
  it('resolving a capability does not acquire admission or expose the namespace', async () => {
    const f = service();
    const c = await f.host.getSandbox('default');
    expect(Object.keys(c)).toEqual([]);
    expect(f.control.reserve).not.toHaveBeenCalled();
    const result = (await c.invoke('exec', [['true']])) as {
      capability: { invoke(op: string, args: Array<unknown>): Promise<unknown> };
    };
    await expect(result.capability.invoke('destroy', [])).rejects.toThrow(
      'Unsupported Sandbox process operation',
    );
  });
  it.each([
    'onStart',
    'onStop',
    'alarm',
    'beforeStart',
    'beforeUse',
    'start',
    'schedule',
    'configure',
    'constructor',
    '__proto__',
    'ctx',
    'env',
    'container',
    'client',
    'createSession',
    'tunnels',
  ])('rejects %s', async (method) => {
    const f = service();
    await expect((await f.host.getSandbox('default')).invoke(method, [])).rejects.toThrow(
      'Unsupported Sandbox operation',
    );
  });
  it('validates new options and rejects removed SDK options', async () => {
    const f = service();
    await expect(f.host.getSandbox('default', { keepAlive: true } as never)).rejects.toThrow(
      'Unsupported Sandbox option',
    );
    await expect(f.host.getSandbox('default', { enableInternet: 'true' } as never)).rejects.toThrow(
      'boolean',
    );
    await expect(f.host.getSandbox('default', { inactivityTimeoutMs: Infinity })).rejects.toThrow(
      'inactivityTimeoutMs',
    );
    await expect(
      f.host.getSandbox('default', { inactivityTimeoutMs: 1000, enableInternet: true }),
    ).resolves.toBeDefined();
  });
  it('rejects arbitrary file methods before boot', async () => {
    const f = service();
    await expect(
      (await f.host.getSandbox('default')).invoke('files', ['constructor']),
    ).rejects.toThrow('Unsupported Sandbox file operation');
    expect(f.container.start).not.toHaveBeenCalled();
  });
});

it('preserves budget termination for an old process after a new generation starts', async () => {
  const f = fixture();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let finish!: (code: number) => void;
  f.process.exitCode = new Promise((resolve) => {
    finish = resolve;
  });
  f.container.destroy.mockImplementation(async () => {
    f.container.running = false;
    finish(137);
  });
  const process = (await f.start()) as {
    capability: { invoke(op: string, args: Array<unknown>): Promise<unknown> };
  };
  f.control.heartbeat.mockResolvedValue({ ok: false, reason: 'runtime_budget' });
  await f.controller.alarm();
  f.control.heartbeat.mockResolvedValue({ ok: true });
  f.process.exitCode = Promise.resolve(0);
  const next = (await f.start()) as typeof process;
  expect(await next.capability.invoke('exitCode', [])).toBe(0);
  await expect(process.capability.invoke('exitCode', [])).rejects.toThrow(
    'VOID_SANDBOX_runtime_budget',
  );
});

it('keeps a completed process successful when the account exhausts its budget later', async () => {
  const f = fixture();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const process = (await f.start()) as {
    capability: { invoke(op: string, args: Array<unknown>): Promise<unknown> };
  };
  f.control.heartbeat.mockResolvedValue({ ok: false, reason: 'runtime_budget' });
  await f.controller.alarm();
  expect(await process.capability.invoke('exitCode', [])).toBe(0);
});
