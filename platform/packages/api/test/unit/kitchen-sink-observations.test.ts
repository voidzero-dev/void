import { describe, expect, it, vi } from 'vite-plus/test';
import {
  resetKitchenSink,
  waitForChangedRender,
  waitForFreshHeartbeat,
  waitForIsrCacheHit,
} from '../../../../scripts/kitchen-sink-observations.ts';

function clock() {
  let time = Date.parse('2026-10-01T00:00:00Z');
  return {
    now: () => time,
    wait: async (milliseconds: number) => {
      time += milliseconds;
    },
    timeoutMs: 10_000,
    intervalMs: 3000,
  };
}

describe('kitchen-sink acceptance observations', () => {
  it('stops acceptance when resetting the fixture returns a provider error', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('failure', { status: 503 }));
    await expect(resetKitchenSink('https://fixture.test', {}, fetcher)).rejects.toThrow(
      'Fixture reset failed (HTTP 503)',
    );
  });

  it.each([Response.json({ ok: false }), new Response('<html>wrong app</html>')])(
    'rejects a successful HTTP response without a confirmed fixture reset',
    async (response) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(resetKitchenSink('https://fixture.test', {}, fetcher)).rejects.toThrow(
        'verify that SMOKE_URL selects the disposable kitchen-sink app',
      );
    },
  );

  it('starts the freshness window only after the reset confirms success', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const now = vi.fn(() => 12_345);
    await expect(resetKitchenSink('https://fixture.test', {}, fetcher, now)).resolves.toBe(12_345);
    expect(fetcher).toHaveBeenCalledWith(
      'https://fixture.test/api/reset',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(now).toHaveBeenCalledOnce();
  });

  it('fails with provider and fixture diagnostics when a heartbeat never arrives', async () => {
    const options = clock();
    const started = options.now();
    const read = vi.fn().mockResolvedValue(null);
    await expect(waitForFreshHeartbeat(read, options)).rejects.toThrow(
      'check cron registration and dispatch logs, then the fixture KV binding',
    );
    expect(options.now() - started).toBe(10_000);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it('waits through missing, malformed, stale, and future values before accepting a fresh heartbeat', async () => {
    const options = { ...clock(), timeoutMs: 20_000 };
    const read = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('invalid')
      .mockResolvedValueOnce('2026-09-30T23:54:00Z')
      .mockResolvedValueOnce('2026-10-01T00:10:00Z')
      .mockResolvedValueOnce('2026-10-01T00:00:10Z');
    await expect(waitForFreshHeartbeat(read, options)).resolves.toBe('2026-10-01T00:00:10Z');
    expect(read).toHaveBeenCalledTimes(5);
  });

  it('rejects a recent heartbeat from before the fixture reset', async () => {
    const options = clock();
    const read = vi
      .fn()
      .mockResolvedValueOnce('2026-09-30T23:59:59Z')
      .mockResolvedValueOnce('2026-10-01T00:00:01Z');
    await expect(
      waitForFreshHeartbeat(read, { ...options, notBefore: options.now() }),
    ).resolves.toBe('2026-10-01T00:00:01Z');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not accept an unchanged render or a non-date label as proof of a purge', async () => {
    const options = clock();
    const previous = '2026-10-01T00:00:00Z';
    const read = vi
      .fn()
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce('void/isr')
      .mockResolvedValueOnce('2026-10-01T00:00:02Z');
    await expect(waitForChangedRender(read, previous, options)).resolves.toBe(
      '2026-10-01T00:00:02Z',
    );
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('fails when the cached render remains unchanged after an accepted purge', async () => {
    const options = clock();
    const previous = '2026-10-01T00:00:00Z';
    await expect(waitForChangedRender(async () => previous, previous, options)).rejects.toThrow(
      'check the purge outcome, ISR cache configuration, and fixture loader',
    );
  });

  it('requires an actual cache hit before testing a purge on a public target', async () => {
    const options = clock();
    const read = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('MISS')
      .mockResolvedValueOnce('HIT');
    await expect(waitForIsrCacheHit(read, options)).resolves.toBe('HIT');
    expect(read).toHaveBeenCalledTimes(3);
  });
});
