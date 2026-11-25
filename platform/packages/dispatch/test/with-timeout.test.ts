import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  DispatchTimeoutError,
  resolveTimeoutMs,
  withDelayedHedge,
  withTimeout,
} from '../src/with-timeout.ts';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the same value on a fast resolve and clears the timer', async () => {
    const p = withTimeout(Promise.resolve('ok'), 1000, 'fast-resolve');

    await expect(p).resolves.toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates the ORIGINAL rejection on a fast reject and clears the timer', async () => {
    const original = new Error('boom');
    const p = withTimeout(Promise.reject(original), 1000, 'fast-reject');

    const caught = await p.catch((e: unknown) => e);
    expect(caught).toBe(original);
    expect(caught).not.toBeInstanceOf(DispatchTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with DispatchTimeoutError carrying the label when the timer wins', async () => {
    const neverSettles = new Promise<never>(() => {});
    const p = withTimeout(neverSettles, 1000, 'slow-op');
    // Attach the handler up front so the eventual rejection is never "unhandled".
    const caught = p.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1000);

    const err = await caught;
    expect(err).toBeInstanceOf(DispatchTimeoutError);
    expect((err as DispatchTimeoutError).label).toBe('slow-op');
    expect((err as DispatchTimeoutError).name).toBe('DispatchTimeoutError');
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('escape hatch (no timer scheduled)', () => {
    for (const ms of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      it(`returns the same promise instance for ms=${String(ms)}`, async () => {
        const inner = Promise.resolve('passthrough');
        const p = withTimeout(inner, ms, 'escape');

        expect(p).toBe(inner);
        expect(vi.getTimerCount()).toBe(0);
        await expect(p).resolves.toBe('passthrough');
        expect(vi.getTimerCount()).toBe(0);
      });
    }
  });

  it('resolves normally when the promise settles slightly before the deadline', async () => {
    const inner = new Promise<string>((resolve) => {
      setTimeout(() => resolve('done'), 999);
    });
    const p = withTimeout(inner, 1000, 'near-miss');

    await vi.advanceTimersByTimeAsync(999);

    await expect(p).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('withDelayedHedge', () => {
  const options = (
    overrides: Partial<{
      delayMs: number;
      timeoutMs: number;
      label: string;
    }> = {},
  ) => ({
    delayMs: 1000,
    timeoutMs: 10_000,
    label: 'hedged-read',
    ...overrides,
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the fast path to one read and clears the hedge timer', async () => {
    const operation = vi.fn(async () => 'first');

    await expect(withDelayedHedge(operation, options())).resolves.toBe('first');
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('launches one hedge after the delay and lets attempt two recover', async () => {
    const first = new Promise<string | null>(() => {});
    const operation = vi
      .fn<() => Promise<string | null>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce('second');
    const result = withDelayedHedge(operation, options());

    await vi.advanceTimersByTimeAsync(999);
    expect(operation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe('second');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a fast binding rejection immediately', async () => {
    const original = new Error('temporary R2 failure');
    const operation = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(original)
      .mockResolvedValueOnce('retry');

    await expect(withDelayedHedge(operation, options())).resolves.toBe('retry');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let a hedged miss beat a pending usable result', async () => {
    let resolveFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const operation = vi
      .fn<() => Promise<string | null>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(null);
    const result = withDelayedHedge(operation, options());

    await vi.advanceTimersByTimeAsync(1000);
    resolveFirst('first');

    await expect(result).resolves.toBe('first');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('preserves a fast miss without launching a hedge', async () => {
    const operation = vi.fn(async () => null);

    await expect(withDelayedHedge(operation, options())).resolves.toBeNull();
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a late successful loser and never cancels the winner', async () => {
    let resolveFirst!: (value: { id: string }) => void;
    const first = new Promise<{ id: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const winner = { id: 'winner' };
    const loser = { id: 'loser' };
    const operation = vi
      .fn<() => Promise<{ id: string } | null>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(winner);
    const discard = vi.fn();
    const result = withDelayedHedge(operation, {
      ...options(),
      discard,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe(winner);
    expect(discard).not.toHaveBeenCalled();

    resolveFirst(loser);
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).toHaveBeenCalledWith(loser);
  });

  it('shares one absolute timeout instead of granting each attempt a full budget', async () => {
    const operation = vi.fn(() => new Promise<never>(() => {}));
    const result = withDelayedHedge(operation, options());
    const caught = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1000);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(caught).resolves.toBeInstanceOf(DispatchTimeoutError);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disables hedging for a non-positive delay', async () => {
    const operation = vi.fn(async () => 'only');

    await expect(withDelayedHedge(operation, options({ delayMs: 0, timeoutMs: 0 }))).resolves.toBe(
      'only',
    );
    expect(operation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards a simultaneously resolved loser', async () => {
    let resolveFirst!: (value: { id: string }) => void;
    let resolveSecond!: (value: { id: string }) => void;
    const first = new Promise<{ id: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<{ id: string }>((resolve) => {
      resolveSecond = resolve;
    });
    const operation = vi
      .fn<() => Promise<{ id: string } | null>>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const discard = vi.fn();
    const result = withDelayedHedge(operation, { ...options(), discard });

    await vi.advanceTimersByTimeAsync(1000);
    resolveFirst({ id: 'first' });
    resolveSecond({ id: 'second' });

    const winner = await result;
    await Promise.resolve();
    expect(winner).not.toBeNull();
    expect(discard).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalledWith(winner);
  });

  it('discards every successful result that arrives after the deadline', async () => {
    let resolveFirst!: (value: { id: string }) => void;
    let resolveSecond!: (value: { id: string }) => void;
    const operation = vi
      .fn<() => Promise<{ id: string } | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const discard = vi.fn();
    const result = withDelayedHedge(operation, { ...options(), discard });
    const caught = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(caught).resolves.toBeInstanceOf(DispatchTimeoutError);

    const lateFirst = { id: 'late-first' };
    const lateSecond = { id: 'late-second' };
    resolveFirst(lateFirst);
    resolveSecond(lateSecond);
    await Promise.resolve();
    await Promise.resolve();
    expect(discard).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledWith(lateFirst);
    expect(discard).toHaveBeenCalledWith(lateSecond);
  });
});

describe('resolveTimeoutMs', () => {
  it('returns the 10s default when the env var is unset', () => {
    expect(resolveTimeoutMs(undefined)).toBe(10_000);
  });

  it('parses a valid numeric override', () => {
    expect(resolveTimeoutMs('5000')).toBe(5000);
  });

  it('passes an explicit "0" through (the disable escape hatch, not the default)', () => {
    expect(resolveTimeoutMs('0')).toBe(0);
  });

  it('treats an empty string as 0 (disabled)', () => {
    expect(resolveTimeoutMs('')).toBe(0);
  });

  it('passes a negative override through unchanged', () => {
    expect(resolveTimeoutMs('-5')).toBe(-5);
  });

  it('passes a non-numeric override through as NaN', () => {
    expect(Number.isNaN(resolveTimeoutMs('abc'))).toBe(true);
  });

  it('passes "Infinity" through as Infinity', () => {
    expect(resolveTimeoutMs('Infinity')).toBe(Number.POSITIVE_INFINITY);
  });

  describe('feeds withTimeout escape hatch (no timer scheduled)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('disables the timer for a "0" budget', async () => {
      const ms = resolveTimeoutMs('0');
      const p = withTimeout(Promise.resolve('x'), ms, 'off');

      await expect(p).resolves.toBe('x');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('disables the timer for a non-numeric (NaN) budget', async () => {
      const ms = resolveTimeoutMs('abc');
      const p = withTimeout(Promise.resolve('x'), ms, 'off');

      await expect(p).resolves.toBe('x');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
