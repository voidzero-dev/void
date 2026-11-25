import { describe, expect, it, vi } from 'vite-plus/test';

const { getPlatformCapabilities } = await import('../../src/capabilities.ts');
const { SecurityScanScheduler } = await import('../../src/security/scheduler.ts');

function createScheduler(vars: Record<string, unknown> = {}) {
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
    expect(storage.alarm).toBeLessThanOrEqual(Date.now() + 1000);
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

describe('SecurityScanScheduler while the platform is disabled (C2, C10)', () => {
  const capabilityOn = JSON.stringify({ ...getPlatformCapabilities({}), securityAudits: true });

  it('starts no scan and changes nothing, then looks again later', async () => {
    const { PLATFORM_DISABLED_KEY, PLATFORM_DISABLED_VALUE } = await import('@void/platform');
    const { SECURITY_SCHEDULER_PAUSED_RECHECK_MS } =
      await import('../../src/security/scheduler.ts');
    const disabledRouting = {
      get: async (key: string) => (key === PLATFORM_DISABLED_KEY ? PLATFORM_DISABLED_VALUE : null),
    };
    for (const vars of [
      { PLATFORM_TRAFFIC_STATE: 'staging' },
      { PLATFORM_TRAFFIC_STATE: 'sandbox-drain' },
      {
        PLATFORM_TRAFFIC_STATE: undefined,
        PLATFORM_INSTALLATION_ID: 'inst_1',
        ROUTING: disabledRouting,
      },
    ]) {
      // No HYPERDRIVE binding: reaching the database (or the scanner) throws.
      const { scheduler, storage } = createScheduler({
        PLATFORM_CAPABILITIES: capabilityOn,
        ...vars,
      });
      const before = Date.now();
      await expect(scheduler.alarm()).resolves.toBeUndefined();
      expect(storage.setAlarm).toHaveBeenCalledTimes(1);
      expect(storage.alarm).toBeGreaterThanOrEqual(before + SECURITY_SCHEDULER_PAUSED_RECHECK_MS);
    }
  });

  it('runs the pass once the platform is enabled again', async () => {
    const { scheduler } = createScheduler({
      PLATFORM_CAPABILITIES: capabilityOn,
      PLATFORM_TRAFFIC_STATE: undefined,
      PLATFORM_INSTALLATION_ID: 'inst_1',
      ROUTING: { get: async () => null },
    });
    // It goes on to the database, which this stub does not have.
    await expect(scheduler.alarm()).rejects.toThrow('unexpected binding HYPERDRIVE');
  });
});
