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

const { getPlatformCapabilities } = await import('../../src/capabilities.ts');
const { SecurityScanScheduler } = await import('../../src/security/scheduler.ts');

function createScheduler(vars: Record<string, string | undefined> = {}) {
  const storage = {
    alarm: null as number | null,
    getAlarm: vi.fn(async () => storage.alarm),
    setAlarm: vi.fn(async (time: number) => {
      storage.alarm = time;
    }),
  };
  // Only plain vars: the scheduler must not reach the database or any other binding.
  const env = new Proxy(vars, {
    get(target, key) {
      if (typeof key === 'string' && key in target) {
        return target[key];
      }
      if (key === 'PLATFORM_CAPABILITIES') {
        return undefined;
      }
      throw new Error(`unexpected binding ${String(key)}`);
    },
  });
  const scheduler = new SecurityScanScheduler(
    { storage } as unknown as DurableObjectState,
    env as never,
  );
  return { scheduler, storage };
}

describe('SecurityScanScheduler with the capability off', () => {
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

  it('does no work when the alarm fires with the capability off', async () => {
    for (const vars of [
      {},
      {
        PLATFORM_CAPABILITIES: JSON.stringify({
          ...getPlatformCapabilities({}),
          securityAudits: false,
        }),
      },
    ]) {
      const { scheduler, storage } = createScheduler(vars);
      await expect(scheduler.alarm()).resolves.toBeUndefined();
      expect(storage.setAlarm).not.toHaveBeenCalled();
    }
  });
});
