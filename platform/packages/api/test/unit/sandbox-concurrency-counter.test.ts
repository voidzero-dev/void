import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { SandboxConcurrencyCounter } from '../../src/sandbox-concurrency-counter.ts';
import type { SandboxUsageAttribution } from '../../src/sandbox-concurrency-counter.ts';
import { verifyUsageEnvelope } from '../../src/usage-auth.ts';
import type { UsageEvent } from '../../src/usage-counter.ts';

const SIGNING_KEY = 'sandbox-counter-test-key';
const ATTRIBUTION: SandboxUsageAttribution = { projectId: 'p', userId: 'u', slug: 'project' };
const START = 1_800_000_000_000;

function makeCounter(options?: { send?: () => Promise<void> }) {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: vi.fn(
      async <T>(key: string): Promise<T | undefined> =>
        structuredClone(data.get(key)) as T | undefined,
    ),
    put: vi.fn(async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    }),
    getAlarm: async () => alarm,
    setAlarm: async (time: number) => {
      alarm = time;
    },
  };
  const sent: Array<unknown> = [];
  const env = {
    JWT_SECRET: 'jwt-secret',
    ROUTING: { get: async () => SIGNING_KEY, put: async () => {} },
    USAGE_EVENTS_QUEUE: {
      send: async (message: unknown) => {
        await options?.send?.();
        sent.push(message);
      },
    },
  };
  const ctx = { storage };
  const counter = new SandboxConcurrencyCounter(ctx as never, env as never);
  Object.assign(counter, { ctx, env });
  const reserve = (id = 'instance', generation = 'run', limit = 1) =>
    counter.reserve(id, generation, limit, ATTRIBUTION);
  const frames = async () =>
    Promise.all(
      sent.map(
        async (message) => (await verifyUsageEnvelope<UsageEvent>(message, SIGNING_KEY))?.event,
      ),
    );
  return { counter, reserve, storage, data, sent, frames };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

describe('trusted Sandbox capacity and metering', () => {
  it('reserves capacity before start without billing idle reservations', async () => {
    const { counter, reserve, sent } = makeCounter();
    expect(await reserve()).toEqual({ ok: true });
    expect(await reserve('other')).toEqual({ ok: false, reason: 'concurrency' });
    vi.setSystemTime(START + 60_000);
    expect(await reserve()).toEqual({ ok: true });
    await counter.heartbeat('instance', 'run', 1);
    await counter.stopped('instance', 'run');
    expect(sent).toEqual([]);
    expect(await reserve('other')).toEqual({ ok: true });
  });

  it('bills only confirmed container time, preserving the original start on retry', async () => {
    const { counter, reserve, frames } = makeCounter();
    await reserve();
    vi.setSystemTime(START + 60_000);
    await counter.started('instance', 'run', 1);
    vi.setSystemTime(START + 65_000);
    await counter.started('instance', 'run', 1);
    await counter.heartbeat('instance', 'run', 1);
    vi.setSystemTime(START + 72_999);
    await counter.stopped('instance', 'run');
    expect(await frames()).toMatchObject([
      { ...ATTRIBUTION, sandboxMeteredFrom: START + 60_000, sandboxMeteredThrough: START + 65_000 },
      { ...ATTRIBUTION, sandboxMeteredFrom: START + 60_000, sandboxMeteredThrough: START + 72_000 },
    ]);
  });

  it('does not recover unknown starts or heartbeats by bypassing capacity', async () => {
    const { counter } = makeCounter();
    expect(await counter.started('unknown', 'run', 1)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await counter.heartbeat('unknown', 'run', 1)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('protects a new generation against a delayed release or heartbeat', async () => {
    const { counter, reserve } = makeCounter();
    await reserve();
    await counter.stopped('instance', 'run');
    expect(await reserve('instance', 'next')).toEqual({ ok: true });
    await counter.stopped('instance', 'run');
    expect(await counter.heartbeat('instance', 'run', 1)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await reserve('other')).toEqual({ ok: false, reason: 'concurrency' });
    expect(await counter.started('instance', 'next', 1)).toEqual({ ok: true });
  });

  it('fences a reserve that arrives after its confirmed stop', async () => {
    const { counter, reserve } = makeCounter();
    await counter.stopped('instance', 'run');
    expect(await reserve()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('rejects delayed reserve retries for a completed generation', async () => {
    const { counter, reserve } = makeCounter();
    await reserve();
    await counter.stopped('instance', 'run');
    expect(await reserve()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('uses different metering identities for starts in the same millisecond', async () => {
    const first = makeCounter();
    const second = makeCounter();
    await first.reserve('instance', 'run-a');
    await second.reserve('instance', 'run-b');
    await first.counter.started('instance', 'run-a', 1);
    await second.counter.started('instance', 'run-b', 1);
    vi.setSystemTime(START + 10_000);
    await first.counter.stopped('instance', 'run-a');
    await second.counter.stopped('instance', 'run-b');
    expect((await first.frames())[0]?.sandboxInstanceId).not.toBe(
      (await second.frames())[0]?.sandboxInstanceId,
    );
  });

  it('never expires a reservation or live container from elapsed age', async () => {
    const { counter, reserve, sent } = makeCounter();
    await reserve('pending', 'run', 2);
    await reserve('running', 'run', 2);
    await counter.started('running', 'run', 2);
    vi.setSystemTime(START + 30 * 24 * 3_600_000);
    await counter.alarm();
    expect(await reserve('third', 'run', 2)).toEqual({ ok: false, reason: 'concurrency' });
    expect(sent).toEqual([]);
  });

  it('enforces the current concurrency cap after a plan downgrade', async () => {
    const { counter, reserve } = makeCounter();
    await reserve('a', 'run', 2);
    await reserve('b', 'run', 2);
    expect(await counter.heartbeat('a', 'run', 1)).toEqual({ ok: true });
    expect(await counter.heartbeat('b', 'run', 1)).toEqual({ ok: false, reason: 'concurrency' });
  });

  it('supports unlimited account capacity', async () => {
    const { reserve } = makeCounter();
    for (let n = 0; n < 20; n++) {
      expect(await reserve(`instance-${n}`, 'run', 0)).toEqual({ ok: true });
    }
  });

  it('revokes every confirmed-gone container for one deployment without touching another', async () => {
    const { counter, reserve, frames } = makeCounter();
    const first = JSON.stringify(['p', 'deployment-a', 'instance-a']);
    const second = JSON.stringify(['p', 'deployment-a', 'instance-b']);
    const retained = JSON.stringify(['p', 'deployment-b', 'instance']);
    await reserve(first, 'run-a', 3);
    await reserve(second, 'run-b', 3);
    await reserve(retained, 'run-c', 3);
    await counter.started(first, 'run-a', 3);
    await counter.started(retained, 'run-c', 3);
    vi.setSystemTime(START + 10_000);

    await counter.revokeDeployment('p', 'deployment-a');

    expect(await frames()).toMatchObject([
      { sandboxMeteredFrom: START, sandboxMeteredThrough: START + 10_000 },
    ]);
    expect(await reserve(first, 'run-a', 3)).toEqual({ ok: false, reason: 'unavailable' });
    expect(await counter.heartbeat(retained, 'run-c', 3)).toEqual({ ok: true });
    expect(await reserve('replacement', 'run', 3)).toEqual({ ok: true });
  });

  it('does not adopt legacy tenant-controlled leases', async () => {
    const { data, reserve } = makeCounter();
    data.set('entries', { untrusted: { acquiredAt: START } });
    expect(await reserve()).toEqual({ ok: true });
  });
});

describe('Sandbox stop recovery', () => {
  it('persists confirmed stop before publishing and never bills retry delay', async () => {
    let fail = true;
    const { counter, reserve, frames } = makeCounter({
      send: async () => {
        if (fail) {
          throw new Error('queue unavailable');
        }
      },
    });
    await reserve();
    await counter.started('instance', 'run', 1);
    vi.setSystemTime(START + 10_000);
    await expect(counter.stopped('instance', 'run')).rejects.toThrow('queue unavailable');
    expect(await reserve('other')).toEqual({ ok: false, reason: 'concurrency' });
    vi.setSystemTime(START + 60_000);
    fail = false;
    await counter.alarm();
    expect(await frames()).toMatchObject([
      { sandboxMeteredFrom: START, sandboxMeteredThrough: START + 10_000 },
    ]);
    expect(await reserve('other')).toEqual({ ok: true });
  });

  it('keeps capacity held when the final capacity release cannot persist', async () => {
    const { counter, reserve, storage, frames } = makeCounter();
    await reserve();
    await counter.started('instance', 'run', 1);
    vi.setSystemTime(START + 10_000);
    const put = storage.put.getMockImplementation()!;
    storage.put.mockImplementation(async (key, value) => {
      if (key === 'controlled-entries-v1' && Object.keys(value as object).length === 0) {
        throw new Error('storage unavailable');
      }
      await put(key, value);
    });
    await expect(counter.stopped('instance', 'run')).rejects.toThrow('storage unavailable');
    expect(await reserve('other')).toEqual({ ok: false, reason: 'concurrency' });
    storage.put.mockImplementation(put);
    vi.setSystemTime(START + 60_000);
    await counter.stopped('instance', 'run');
    const messages = await frames();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(messages[1]);
  });

  it('does not cache a failed reservation write', async () => {
    const { reserve, storage } = makeCounter();
    storage.put.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(reserve()).rejects.toThrow('storage unavailable');
    expect(await reserve('other')).toEqual({ ok: true });
  });

  it('serializes release behind a heartbeat blocked on the usage queue', async () => {
    let unblock!: () => void;
    let publishing!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      publishing = resolve;
    });
    const { counter, reserve, frames } = makeCounter({
      send: async () => {
        publishing();
        await blocked;
      },
    });
    await reserve();
    await counter.started('instance', 'run', 1);
    vi.setSystemTime(START + 10_000);
    const heartbeat = counter.heartbeat('instance', 'run', 1);
    await started;
    vi.setSystemTime(START + 15_000);
    const stopped = counter.stopped('instance', 'run');
    const next = reserve('other');
    unblock();
    await heartbeat;
    await stopped;
    expect(await next).toEqual({ ok: true });
    expect(await frames()).toMatchObject([
      { sandboxMeteredThrough: START + 10_000 },
      { sandboxMeteredThrough: START + 15_000 },
    ]);
  });

  it('recovers the run and final timestamp after a cold start', async () => {
    const first = makeCounter({
      send: async () => {
        throw new Error('queue unavailable');
      },
    });
    await first.reserve();
    await first.counter.started('instance', 'run', 1);
    vi.setSystemTime(START + 10_000);
    await expect(first.counter.stopped('instance', 'run')).rejects.toThrow();
    const recovered = makeCounter();
    for (const [key, value] of first.data) {
      recovered.data.set(key, structuredClone(value));
    }
    vi.setSystemTime(START + 60_000);
    await recovered.counter.alarm();
    expect(await recovered.frames()).toMatchObject([
      { sandboxMeteredFrom: START, sandboxMeteredThrough: START + 10_000 },
    ]);
    expect(await recovered.reserve()).toEqual({ ok: false, reason: 'unavailable' });
  });
});
