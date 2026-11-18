import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { SecurityScanScheduler } = await import('../../src/security/scheduler.ts');

function createScheduler() {
  const storage = {
    alarm: null as number | null,
    getAlarm: vi.fn(async () => storage.alarm),
    setAlarm: vi.fn(async (time: number) => {
      storage.alarm = time;
    }),
  };
  // An empty env: the stub must not reach the database or any other binding.
  const env = new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error(`unexpected binding ${String(key)}`);
      },
    },
  );
  const scheduler = new SecurityScanScheduler(
    { storage } as unknown as DurableObjectState,
    env as never,
  );
  return { scheduler, storage };
}

describe('SecurityScanScheduler stub', () => {
  it('answers a poke by arming a near-immediate alarm', async () => {
    const { scheduler, storage } = createScheduler();
    const before = Date.now();
    const response = await scheduler.fetch(
      new Request('https://scheduler.internal/poke', { method: 'POST' }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(storage.setAlarm).toHaveBeenCalledTimes(1);
    expect(storage.alarm).toBeGreaterThanOrEqual(before);
    expect(storage.alarm).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it.each([
    ['GET', '/poke'],
    ['POST', '/scan'],
    ['GET', '/status'],
  ])('refuses %s %s', async (method, path) => {
    const { scheduler, storage } = createScheduler();
    const response = await scheduler.fetch(
      new Request(`https://scheduler.internal${path}`, { method }),
    );
    expect(response.status).toBe(404);
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it('does no work when the alarm fires', async () => {
    const { scheduler, storage } = createScheduler();
    await expect(scheduler.alarm()).resolves.toBeUndefined();
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });
});
