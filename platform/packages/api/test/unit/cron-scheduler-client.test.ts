import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  clearCronScheduler,
  snapshotCronScheduler,
  syncCronScheduler,
} from '../../src/cron-scheduler-client.ts';

function cronNamespace(fetch: (request: Request) => Promise<Response>): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({ fetch }),
  } as unknown as DurableObjectNamespace;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('cron scheduler client', () => {
  it('retries non-success responses and propagates the final failure', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response('unavailable', { status: 503 }));

    const result = clearCronScheduler({ CRON_SCHEDULER: cronNamespace(fetch) }, 'proj_1');
    const rejection = expect(result).rejects.toThrow(/failed for proj_1 after 3 attempts/);
    await vi.runAllTimersAsync();

    await rejection;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries transport failures before synchronizing successfully', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockRejectedValueOnce(new Error('evicted'))
      .mockResolvedValueOnce(Response.json({ ok: true }));

    const result = syncCronScheduler({ CRON_SCHEDULER: cronNamespace(fetch) }, 'proj_2', {
      workerName: 'worker-2',
      schedules: [{ name: 'hourly', cron: '0 * * * *' }],
      proxyToken: 'secret',
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('captures the full internal state needed for compensation', async () => {
    const state = {
      workerName: 'worker-live',
      schedules: [{ name: 'hourly', cron: '0 * * * *' }],
      proxyToken: 'secret',
    };
    const fetch = vi.fn(async (_request: Request) => Response.json({ state }));

    await expect(
      snapshotCronScheduler({ CRON_SCHEDULER: cronNamespace(fetch) }, 'proj_3'),
    ).resolves.toEqual(state);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0].url).toBe('https://do/snapshot');
  });
});
