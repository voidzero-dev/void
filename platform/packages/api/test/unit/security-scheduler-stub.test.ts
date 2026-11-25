import { expect, it, vi } from 'vite-plus/test';
import { SecurityScanScheduler } from '../../src/security/scheduler.ts';

// I13: with the capability off the scheduler class ships idle and reads no binding.
it('does no work and reads no binding when the alarm fires with the capability off', async () => {
  const storage = { getAlarm: vi.fn(async () => null), setAlarm: vi.fn(async () => {}) };
  const env = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, key) {
        if (key !== 'PLATFORM_CAPABILITIES') {
          throw new Error(`unexpected binding ${String(key)}`);
        }
        return undefined;
      },
    },
  );
  const scheduler = new SecurityScanScheduler(
    { storage } as unknown as DurableObjectState,
    env as never,
  );
  await expect(scheduler.alarm()).resolves.toBeUndefined();
  expect(storage.setAlarm).not.toHaveBeenCalled();
});
