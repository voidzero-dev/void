import { type ChildProcess, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';

// Claim a PRIVATE work dir before the agent module is imported anywhere in this
// file — `WORK_DIR` is read once, at import. build-manager.test.ts wipes and
// rewrites the default `/tmp/build/src` in its own `beforeEach`, and vitest runs
// the two files in parallel workers, so sharing that path is a cross-file race.
process.env.VOID_BUILD_WORK_DIR = join(tmpdir(), `void-source-download-${process.pid}`);

// The source download needs its own deadlines: a GitHub tarball stream can
// degrade to short bursts separated by dead minutes, and undici's `bodyTimeout`
// resets on every chunk, so a trickle defeats it.
//
// These tests pin the retry POLICY, which is the part that has to be right:
// what retries, what does not, that a retry starts from an empty tree, and that
// the whole phase is bounded. Timers are real, so every value here is in
// milliseconds and tiny.
describe('build-agent source download bounds', () => {
  let agent: typeof import('../../container/build-agent.mjs');

  beforeEach(async () => {
    process.env.SOURCE_TARBALL_URL = 'https://api.github.com/repos/acme/site/tarball/deadbeef';
    process.env.SOURCE_TOKEN = 'ghs_test_token';
    agent = await import('../../container/build-agent.mjs');
    agent.clearBufferedLogLines();
  });

  afterEach(() => {
    delete process.env.SOURCE_TARBALL_URL;
    delete process.env.SOURCE_TOKEN;
  });

  /** Log lines recorded so far, agent prefix stripped. */
  const lines = () =>
    agent.getBufferedLogLines().map((entry) => entry.line.replace('[build-agent] ', ''));

  /** A fetch stub that answers `statuses[n]` for attempt n, then 200 forever. */
  const fetchStub = (statuses: Array<number>) => {
    let call = 0;
    return (() => {
      const status = statuses[call++] ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        body: status >= 200 && status < 300 ? {} : null,
      });
    }) as unknown as typeof fetch;
  };

  const okFetch = fetchStub([]);

  /** Like `fetchStub`, but the first answer carries headers. */
  const fetchStubWithHeaders = (status: number, headers: Record<string, string>) => {
    let call = 0;
    return (() => {
      if (call++ === 0) {
        return Promise.resolve({ ok: false, status, headers: new Headers(headers), body: null });
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), body: {} });
    }) as unknown as typeof fetch;
  };

  it('aborts an attempt that stops delivering bytes, then retries', async () => {
    let attempts = 0;
    const resets: Array<number> = [];

    await agent.downloadSource({
      fetchImpl: okFetch,
      resetWorkDir: () => {
        resets.push(Date.now());
      },
      sleep: () => Promise.resolve(),
      stallTimeoutMs: 40,
      phaseBudgetMs: 5000,
      maxAttempts: 2,
      backoffMs: [0],
      extract: (_body, options) => {
        attempts++;
        if (attempts === 1) {
          // A dead stream: never delivers a byte, never settles on its own.
          // If broken: with no stall guard this promise hangs forever and
          // the test times out.
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('stream aborted')));
          });
        }
        options?.onBytes?.(1024);
        return Promise.resolve();
      },
    });

    expect(attempts).toBe(2);
    expect(resets).toHaveLength(2);
    expect(lines()).toContainEqual(
      expect.stringContaining('source download attempt 1 failed (source download aborted: no data'),
    );
    expect(lines()).toContainEqual(expect.stringContaining('source extracted'));
  });

  it('keeps a slow but steady stream alive — the stall guard is not a rate limit', async () => {
    let attempts = 0;

    await agent.downloadSource({
      fetchImpl: okFetch,
      resetWorkDir: () => {},
      sleep: () => Promise.resolve(),
      stallTimeoutMs: 60,
      phaseBudgetMs: 5000,
      maxAttempts: 2,
      extract: async (_body, options) => {
        attempts++;
        // Ten chunks, each well inside the stall window but slow overall. A
        // per-attempt wall clock or a throughput floor would kill this; the stall
        // guard must not, or every large repo on a slow link starts failing.
        for (let i = 0; i < 10; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          options?.onBytes?.(4096);
        }
      },
    });

    expect(attempts).toBe(1);
  });

  it('retries a raw network failure from fetch', async () => {
    // `fetch` rejecting with `TypeError: fetch failed` is the most ordinary
    // transient failure there is. It carries no classification of its own, so an
    // untagged error MUST default to retryable — otherwise the retry loop breaks
    // on the single most common thing it exists to survive.
    let calls = 0;
    const flakyFetch = (() => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve({ ok: true, status: 200, body: {} });
    }) as unknown as typeof fetch;

    await agent.downloadSource({
      fetchImpl: flakyFetch,
      resetWorkDir: () => {},
      sleep: () => Promise.resolve(),
      maxAttempts: 3,
      phaseBudgetMs: 5000,
      backoffMs: [0, 0],
      extract: (_body, options) => {
        options?.onBytes?.(4096);
        return Promise.resolve();
      },
    });

    expect(calls).toBe(2);
    expect(lines()).toContainEqual(
      expect.stringContaining('source download attempt 1 failed (fetch failed)'),
    );
  });

  it('retries a body stream that errors mid-transfer', async () => {
    // Bytes flow, then the socket errors. `pipeline` rejects with the raw stream error, not an abort.
    let attempts = 0;

    await agent.downloadSource({
      fetchImpl: okFetch,
      resetWorkDir: () => {},
      sleep: () => Promise.resolve(),
      stallTimeoutMs: 5000,
      phaseBudgetMs: 5000,
      maxAttempts: 2,
      backoffMs: [0],
      extract: (_body, options) => {
        attempts++;
        options?.onBytes?.(64 * 1024);
        if (attempts === 1) {
          return Promise.reject(new Error('aborted'));
        }
        return Promise.resolve();
      },
    });

    expect(attempts).toBe(2);
  });

  it('fails immediately on a settled HTTP answer instead of burning the budget', async () => {
    let attempts = 0;

    await expect(
      agent.downloadSource({
        fetchImpl: fetchStub([404]),
        resetWorkDir: () => {},
        sleep: () => Promise.resolve(),
        maxAttempts: 3,
        phaseBudgetMs: 5000,
        extract: () => {
          attempts++;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow('source download failed: HTTP 404');

    // 401/403/404/410 mean a bad token or a missing ref. Retrying cannot change
    // that, and each retry costs budget the build still needs.
    expect(attempts).toBe(0);
    expect(lines()).not.toContainEqual(expect.stringContaining('retrying in'));
  });

  it('retries a transient HTTP status and succeeds on the next attempt', async () => {
    let attempts = 0;

    await agent.downloadSource({
      fetchImpl: fetchStub([503]),
      resetWorkDir: () => {},
      sleep: () => Promise.resolve(),
      maxAttempts: 3,
      phaseBudgetMs: 5000,
      backoffMs: [0, 0],
      extract: (_body, options) => {
        attempts++;
        options?.onBytes?.(2048);
        return Promise.resolve();
      },
    });

    expect(attempts).toBe(1);
    expect(lines()).toContainEqual(
      expect.stringContaining(
        'source download attempt 1 failed (source download failed: HTTP 503)',
      ),
    );
  });

  it('resets WORK_DIR before every attempt so a partial tree never survives', async () => {
    const order: Array<string> = [];

    await agent.downloadSource({
      fetchImpl: fetchStub([500]),
      resetWorkDir: () => {
        order.push('reset');
      },
      sleep: () => Promise.resolve(),
      maxAttempts: 2,
      phaseBudgetMs: 5000,
      backoffMs: [0],
      extract: (_body, options) => {
        order.push('extract');
        options?.onBytes?.(1);
        return Promise.resolve();
      },
    });

    // A stalled attempt leaves a half-extracted archive behind; the reset keeps the
    // next `tar` from unpacking on top of it.
    expect(order).toEqual(['reset', 'reset', 'extract']);
  });

  it('stops retrying once the phase budget is spent, with attempts still left', async () => {
    let attempts = 0;

    await expect(
      agent.downloadSource({
        fetchImpl: okFetch,
        resetWorkDir: () => {},
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        stallTimeoutMs: 30,
        phaseBudgetMs: 120,
        maxAttempts: 10,
        backoffMs: [10],
        extract: (_body, options) => {
          attempts++;
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('stream aborted')));
          });
        },
      }),
    ).rejects.toThrow(/source download/);

    // The point of the budget: a stream that never quite looks dead still cannot
    // hold the build. Far fewer than 10 attempts fit in 120ms.
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThan(10);
  });

  it('does not retry after a cancel', async () => {
    let attempts = 0;
    let cancelled = false;

    await expect(
      agent.downloadSource({
        fetchImpl: okFetch,
        resetWorkDir: () => {},
        sleep: () => Promise.resolve(),
        maxAttempts: 3,
        phaseBudgetMs: 5000,
        backoffMs: [0, 0],
        isCancelled: () => cancelled,
        extract: () => {
          attempts++;
          cancelled = true;
          return Promise.reject(new Error('stream aborted'));
        },
      }),
    ).rejects.toThrow('build cancelled');

    expect(attempts).toBe(1);
  });

  it('logs progress while the download runs, so a stall is visible in the tail', async () => {
    await agent.downloadSource({
      fetchImpl: okFetch,
      resetWorkDir: () => {},
      sleep: () => Promise.resolve(),
      stallTimeoutMs: 5000,
      phaseBudgetMs: 5000,
      progressIntervalMs: 10,
      extract: async (_body, options) => {
        for (let i = 0; i < 4; i++) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          options?.onBytes?.(512 * 1024);
        }
      },
    });

    // Periodic progress lines keep a stall distinguishable from a busy build in
    // both the live tail and the check-run tail.
    const progress = lines().filter((line) => line.startsWith('downloading source:'));
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0]).toMatch(/downloading source: [\d.]+ (B|KB|MB) in \d+m?s \(.+\/s\)/);
    expect(lines()).toContainEqual(
      expect.stringMatching(/source extracted \(2\.0 MB in \d+m?s, .+\/s\)/),
    );
  });

  it('counts a slow WORK_DIR reset against the phase budget', async () => {
    // The reset is real I/O on the timed path. Checking the deadline only BEFORE it
    // let a slow cleanup hand the next attempt a budget that was already spent, so
    // the phase quietly overran the ceiling it advertises.
    let attempts = 0;

    await expect(
      agent.downloadSource({
        fetchImpl: okFetch,
        // Slower than the whole budget.
        resetWorkDir: () => new Promise((resolve) => setTimeout(resolve, 80)),
        sleep: () => Promise.resolve(),
        stallTimeoutMs: 5000,
        phaseBudgetMs: 30,
        maxAttempts: 3,
        backoffMs: [0, 0],
        extract: (_body, options) => {
          attempts++;
          options?.onBytes?.(1024);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/budget/);

    // If broken: with the deadline checked only before the reset, the first
    // attempt runs after the budget is gone and the download "succeeds" late.
    expect(attempts).toBe(0);
  });

  it('classifies retryable HTTP statuses', () => {
    expect(agent.isRetryableSourceStatus(429)).toBe(true);
    expect(agent.isRetryableSourceStatus(408)).toBe(true);
    expect(agent.isRetryableSourceStatus(425)).toBe(true);
    expect(agent.isRetryableSourceStatus(500)).toBe(true);
    expect(agent.isRetryableSourceStatus(502)).toBe(true);
    expect(agent.isRetryableSourceStatus(401)).toBe(false);
    expect(agent.isRetryableSourceStatus(404)).toBe(false);
    expect(agent.isRetryableSourceStatus(410)).toBe(false);
  });

  // GitHub answers 403 for a permission failure AND for both kinds of rate limit.
  // Only the headers separate them, so status alone must not settle a 403.
  it('retries a rate-limited 403 but not a permission 403', () => {
    expect(agent.isRetryableSourceStatus(403)).toBe(false);
    expect(agent.isRetryableSourceStatus(403, new Headers())).toBe(false);
    // Secondary rate limit.
    expect(agent.isRetryableSourceStatus(403, new Headers({ 'retry-after': '60' }))).toBe(true);
    // Primary rate limit.
    expect(agent.isRetryableSourceStatus(403, new Headers({ 'x-ratelimit-remaining': '0' }))).toBe(
      true,
    );
    // Secondary rate limit, named only in the body.
    expect(
      agent.isRetryableSourceStatus(
        403,
        new Headers(),
        '{"message":"You have exceeded a secondary rate limit."}',
      ),
    ).toBe(true);
    // Quota left, no delay asked for: a real permission failure.
    expect(
      agent.isRetryableSourceStatus(403, new Headers({ 'x-ratelimit-remaining': '4999' })),
    ).toBe(false);
  });

  it('reads the retry delay the server asked for', () => {
    const now = Date.UTC(2026, 7, 20, 12, 0, 0);
    expect(agent.parseRetryAfterMs(new Headers({ 'retry-after': '30' }), now)).toBe(30_000);
    expect(
      agent.parseRetryAfterMs(new Headers({ 'retry-after': 'Thu, 20 Aug 2026 12:01:00 GMT' }), now),
    ).toBe(60_000);
    // Epoch SECONDS, not ms — and ONLY when the quota is actually spent.
    expect(
      agent.parseRetryAfterMs(
        new Headers({
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(now / 1000 + 45),
        }),
        now,
      ),
    ).toBe(45_000);
    // Quota left: a routine reset riding along on an ordinary error is NOT a
    // delay. If broken: this returns an hour and kills the retry.
    expect(
      agent.parseRetryAfterMs(
        new Headers({
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': String(now / 1000 + 3600),
        }),
        now,
      ),
    ).toBe(null);
    // A reset already in the past means retry now, never a negative sleep.
    expect(
      agent.parseRetryAfterMs(
        new Headers({
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(now / 1000 - 45),
        }),
        now,
      ),
    ).toBe(0);
    expect(agent.parseRetryAfterMs(new Headers(), now)).toBe(null);
    expect(agent.parseRetryAfterMs(null, now)).toBe(null);
  });

  it('retries a rate-limited 403 and waits exactly as long as it was told', async () => {
    const slept: Array<number> = [];
    let extracts = 0;

    await agent.downloadSource({
      fetchImpl: fetchStubWithHeaders(403, { 'retry-after': '3' }),
      resetWorkDir: () => {},
      sleep: (ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      },
      stallTimeoutMs: 1000,
      phaseBudgetMs: 60_000,
      maxAttempts: 2,
      backoffMs: [50],
      extract: (_body, options) => {
        extracts++;
        options?.onBytes?.(1024);
        return Promise.resolve();
      },
    });

    expect(extracts).toBe(1);
    // The server's 3s, NOT the 50ms fixed backoff. Retrying sooner deepens a
    // secondary rate limit rather than clearing it.
    expect(slept).toEqual([3000]);
  });

  it('gives up rather than sleeping a retry-after past the phase budget', async () => {
    const slept: Array<number> = [];

    await expect(
      agent.downloadSource({
        fetchImpl: fetchStubWithHeaders(403, { 'retry-after': '600' }),
        resetWorkDir: () => {},
        sleep: (ms: number) => {
          slept.push(ms);
          return Promise.resolve();
        },
        stallTimeoutMs: 1000,
        phaseBudgetMs: 5000,
        maxAttempts: 3,
        backoffMs: [50],
        extract: () => Promise.resolve(),
      }),
    ).rejects.toThrow('source download failed: HTTP 403');

    // A ten-minute wait does not fit a five-second phase; the build fails fast
    // instead of parking a container on a rate limit it cannot outlast.
    expect(slept).toEqual([]);
  });

  it('does not let a routine rate-limit header turn a 500 into a fatal error', async () => {
    // GitHub sends x-ratelimit-* on EVERY response, quota spent or not. Honouring
    // a reset an hour out makes the backoff overshoot the phase budget, so the
    // loop breaks — failing a plainly retryable 500 on its first attempt.
    let calls = 0;
    const slept: Array<number> = [];
    const now = Date.now();
    const fetchImpl = (() => {
      if (calls++ === 0) {
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: new Headers({
            'x-ratelimit-remaining': '4999',
            'x-ratelimit-reset': String(Math.floor(now / 1000) + 3600),
          }),
          body: null,
        });
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), body: {} });
    }) as unknown as typeof fetch;

    await agent.downloadSource({
      fetchImpl,
      resetWorkDir: () => {},
      sleep: (ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      },
      stallTimeoutMs: 1000,
      phaseBudgetMs: 60_000,
      maxAttempts: 2,
      backoffMs: [50],
      extract: (_body, options) => {
        options?.onBytes?.(1024);
        return Promise.resolve();
      },
    });

    expect(calls).toBe(2);
    // The FIXED backoff, not the hour-away routine reset.
    expect(slept).toEqual([50]);
  });

  it('retries a secondary rate limit that carries no rate-limit headers', async () => {
    // Documented GitHub behaviour: a 403 whose BODY names the secondary limit,
    // with neither retry-after nor remaining: 0.
    const message =
      '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes."}';
    let calls = 0;
    const slept: Array<number> = [];
    const fetchImpl = (() => {
      if (calls++ === 0) {
        return Promise.resolve({
          ok: false,
          status: 403,
          headers: new Headers({ 'x-ratelimit-remaining': '4999' }),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(message));
              controller.close();
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), body: {} });
    }) as unknown as typeof fetch;

    await agent.downloadSource({
      fetchImpl,
      resetWorkDir: () => {},
      sleep: (ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      },
      stallTimeoutMs: 1000,
      phaseBudgetMs: 300_000,
      maxAttempts: 2,
      backoffMs: [50],
      extract: (_body, options) => {
        options?.onBytes?.(1024);
        return Promise.resolve();
      },
    });

    expect(calls).toBe(2);
    // GitHub advises at least a minute when it names no delay itself.
    expect(slept).toEqual([agent.SECONDARY_RATE_LIMIT_DELAY_MS]);
  });

  it('reads only a bounded prefix of a huge 403 body', async () => {
    // The marker sits PAST the sniff window, in ONE enormous chunk. If the reader
    // decodes the whole chunk instead of the sliced prefix, it finds the marker,
    // classifies the 403 as a secondary rate limit, and retries — so this asserts
    // the bound behaviourally instead of asserting the fixture's own size.
    // If broken: `decode(value)` makes calls 2 and the delay 60s.
    const filler = 'x'.repeat(agent.ERROR_BODY_SNIFF_BYTES * 4);
    const payload = `${filler}You have exceeded a secondary rate limit.`;
    let calls = 0;
    const slept: Array<number> = [];
    const fetchImpl = (() => {
      calls++;
      return Promise.resolve({
        ok: false,
        status: 403,
        headers: new Headers({ 'x-ratelimit-remaining': '4999' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
      });
    }) as unknown as typeof fetch;

    await expect(
      agent.downloadSource({
        fetchImpl,
        resetWorkDir: () => {},
        sleep: (ms: number) => {
          slept.push(ms);
          return Promise.resolve();
        },
        stallTimeoutMs: 1000,
        phaseBudgetMs: 300_000,
        maxAttempts: 3,
        backoffMs: [50],
        extract: () => Promise.resolve(),
      }),
    ).rejects.toThrow('source download failed: HTTP 403');
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it('applies the documented minimum wait to a 429 that names no delay', async () => {
    // A 429 IS a rate limit. Retrying in two seconds is what escalates a
    // recoverable limit into a banned integration.
    let calls = 0;
    const slept: Array<number> = [];
    const fetchImpl = (() => {
      if (calls++ === 0) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: new Headers(),
          body: null,
        });
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), body: {} });
    }) as unknown as typeof fetch;

    await agent.downloadSource({
      fetchImpl,
      resetWorkDir: () => {},
      sleep: (ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      },
      stallTimeoutMs: 1000,
      phaseBudgetMs: 300_000,
      maxAttempts: 2,
      backoffMs: [50],
      extract: (_body, options) => {
        options?.onBytes?.(1024);
        return Promise.resolve();
      },
    });

    expect(calls).toBe(2);
    // Not the configured 50ms backoff.
    expect(slept).toEqual([agent.SECONDARY_RATE_LIMIT_DELAY_MS]);
  });

  it('still treats a plain permission 403 as terminal', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls++;
      return Promise.resolve({
        ok: false,
        status: 403,
        headers: new Headers({ 'x-ratelimit-remaining': '4999' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('{"message":"Resource not accessible by integration"}'),
            );
            controller.close();
          },
        }),
      });
    }) as unknown as typeof fetch;

    await expect(
      agent.downloadSource({
        fetchImpl,
        resetWorkDir: () => {},
        sleep: () => Promise.resolve(),
        stallTimeoutMs: 1000,
        phaseBudgetMs: 60_000,
        maxAttempts: 3,
        backoffMs: [50],
        extract: () => Promise.resolve(),
      }),
    ).rejects.toThrow('source download failed: HTTP 403');
    // Body sniffing must not make every 403 retryable.
    expect(calls).toBe(1);
  });

  it('waits the documented minimum for a header-only primary rate limit', async () => {
    // 403 + remaining: 0 with NO usable reset. Retryable, but the fixed 2s backoff
    // is exactly the behaviour GitHub warns gets an integration banned.
    let calls = 0;
    const slept: Array<number> = [];
    const fetchImpl = (() => {
      if (calls++ === 0) {
        return Promise.resolve({
          ok: false,
          status: 403,
          headers: new Headers({ 'x-ratelimit-remaining': '0' }),
          body: null,
        });
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), body: {} });
    }) as unknown as typeof fetch;

    await agent.downloadSource({
      fetchImpl,
      resetWorkDir: () => {},
      sleep: (ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      },
      stallTimeoutMs: 1000,
      phaseBudgetMs: 300_000,
      maxAttempts: 2,
      backoffMs: [50],
      extract: (_body, options) => {
        options?.onBytes?.(1024);
        return Promise.resolve();
      },
    });

    expect(calls).toBe(2);
    // If broken: 50ms.
    expect(slept).toEqual([agent.SECONDARY_RATE_LIMIT_DELAY_MS]);
  });

  it('cancels the body of an error response it does not read', async () => {
    // undici keeps the socket for a body that is neither consumed NOR cancelled,
    // so an abandoned 5xx would compete with its own retry for the pool.
    const cancelled: Array<string> = [];
    let calls = 0;
    const fetchImpl = (() => {
      if (calls++ === 0) {
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('upstream is unwell'));
            },
            cancel() {
              cancelled.push('503');
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), body: {} });
    }) as unknown as typeof fetch;

    await agent.downloadSource({
      fetchImpl,
      resetWorkDir: () => {},
      sleep: () => Promise.resolve(),
      stallTimeoutMs: 1000,
      phaseBudgetMs: 60_000,
      maxAttempts: 2,
      backoffMs: [0],
      extract: (_body, options) => {
        options?.onBytes?.(1024);
        return Promise.resolve();
      },
    });

    // If broken: the 5xx body is thrown past, never released.
    expect(cancelled).toEqual(['503']);
  });

  it('keeps a header-named delay when the error body stalls', async () => {
    // Headers already said `retry-after: 1`. Reading the body can only LOSE that:
    // a body that stalls trips the stall watchdog, and the abort would replace a
    // known rate-limit delay with a generic retryable error.
    let calls = 0;
    const slept: Array<number> = [];
    const fetchImpl = (() => {
      if (calls++ === 0) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: new Headers({ 'retry-after': '1' }),
          // Never enqueues, never closes.
          body: new ReadableStream({ start() {} }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers(), body: {} });
    }) as unknown as typeof fetch;

    await agent.downloadSource({
      fetchImpl,
      resetWorkDir: () => {},
      sleep: (ms: number) => {
        slept.push(ms);
        return Promise.resolve();
      },
      stallTimeoutMs: 60,
      phaseBudgetMs: 300_000,
      maxAttempts: 2,
      backoffMs: [50],
      extract: (_body, options) => {
        options?.onBytes?.(1024);
        return Promise.resolve();
      },
    });

    expect(calls).toBe(2);
    // If broken: the stalled sniff aborts and this is the 50ms backoff.
    expect(slept).toEqual([1000]);
  });

  it('keeps the shipped bounds inside the smallest plan build budget', () => {
    // Free tier is 10 minutes (tiers.ts buildTimeoutMinutes). The download phase
    // must leave most of that for the build it exists to feed.
    expect(agent.SOURCE_PHASE_BUDGET_MS).toBeLessThanOrEqual(4 * 60 * 1000);
    expect(agent.SOURCE_STALL_TIMEOUT_MS).toBeLessThan(agent.SOURCE_PHASE_BUDGET_MS);
    expect(agent.SOURCE_RETRY_BACKOFF_MS.length).toBeGreaterThanOrEqual(
      agent.SOURCE_DOWNLOAD_MAX_ATTEMPTS - 1,
    );
  });
});

// The unit tests above pin the retry POLICY with `extract` injected. This one runs
// the REAL wiring — real `fetch`, real `Readable.fromWeb`, the real metering
// pipeline stage, a real `tar` child, and the real WORK_DIR reset — against a
// server that hands over a few KB and then simply stops writing without closing
// the socket.
//
// That combination is what has to work. A stall guard that never reaches the
// stream, or an abort that leaves `pipeline` hanging or crashes the process with
// an unhandled 'error', would pass every injected-dep test above and still let a
// build hang.
describe('build-agent source download, real stream + tar', () => {
  const WORK_DIR = process.env.VOID_BUILD_WORK_DIR!;
  const fixtureRoot = join(tmpdir(), 'void-source-download-fixture');
  /** Bytes the stalling first response hands over before going silent. */
  const TRUNCATE_AT = 2048;
  let archive: Buffer;
  let server: Server;
  let origin = '';
  let requests = 0;
  /**
   * How the server should break the FIRST response.
   *  - 'stall'  : write a prefix and then go silent (no FIN, no error)
   *  - 'destroy': write a prefix and then kill the socket (a real stream error)
   * Every later response is the complete archive.
   */
  let firstResponse: 'stall' | 'destroy' = 'stall';

  beforeAll(async () => {
    // `--strip-components=1` expects a single top-level `<repo>-<sha>/` directory,
    // which is what GitHub's tarball endpoint produces.
    rmSync(fixtureRoot, { recursive: true, force: true });
    mkdirSync(join(fixtureRoot, 'acme-site-deadbeef'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'acme-site-deadbeef', 'package.json'), '{"name":"acme"}\n');
    // INCOMPRESSIBLE padding. Repeated bytes gzip down to a few hundred, so the
    // "truncated" first response would carry the whole archive and the test would
    // prove nothing about a partial stream.
    writeFileSync(join(fixtureRoot, 'acme-site-deadbeef', 'big.bin'), randomBytes(2 * 1024 * 1024));
    execFileSync('tar', [
      'czf',
      join(fixtureRoot, 'src.tgz'),
      '-C',
      fixtureRoot,
      'acme-site-deadbeef',
    ]);
    archive = readFileSync(join(fixtureRoot, 'src.tgz'));

    server = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { 'content-type': 'application/gzip' });
      if (requests === 1) {
        res.write(archive.subarray(0, TRUNCATE_AT));
        if (firstResponse === 'stall') {
          // Some bytes, then silence. No FIN, no error — the socket
          // just goes quiet, which is precisely what undici's chunk-resetting
          // `bodyTimeout` cannot see.
          return;
        }
        // A real mid-body connection reset: `pipeline` rejects with a stream
        // error while `tar` is still alive and writing into WORK_DIR.
        res.socket?.destroy();
        return;
      }
      res.end(archive);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests = 0;
    firstResponse = 'stall';
    rmSync(WORK_DIR, { recursive: true, force: true });
  });

  it('aborts the stalled stream, retries, and extracts the archive', async () => {
    process.env.SOURCE_TARBALL_URL = `${origin}/tarball/deadbeef`;
    process.env.SOURCE_TOKEN = 'ghs_test_token';
    const agent = await import('../../container/build-agent.mjs');
    agent.clearBufferedLogLines();

    await agent.downloadSource({
      stallTimeoutMs: 400,
      phaseBudgetMs: 20_000,
      maxAttempts: 2,
      backoffMs: [0],
      progressIntervalMs: 50,
    });

    expect(requests).toBe(2);
    // Guard the fixture itself: if the archive ever shrinks below the truncation
    // point, the first response carries the whole thing and this test silently
    // stops exercising a partial stream.
    expect(archive.length).toBeGreaterThan(TRUNCATE_AT * 4);
    // Extracted, and from the SECOND attempt's complete archive — the reset means
    // the truncated first attempt left nothing behind to mix in.
    expect(existsSync(join(WORK_DIR, 'package.json'))).toBe(true);
    expect(readFileSync(join(WORK_DIR, 'package.json'), 'utf8')).toBe('{"name":"acme"}\n');
    expect(readFileSync(join(WORK_DIR, 'big.bin'))).toHaveLength(2 * 1024 * 1024);

    const lines = agent.getBufferedLogLines().map((entry) => entry.line);
    expect(lines).toContainEqual(
      expect.stringContaining('source download attempt 1 failed (source download aborted: no data'),
    );
    expect(lines).toContainEqual(expect.stringContaining('[build-agent] source extracted ('));
  }, 30_000);

  it("reaps the failed attempt's tar before resetting, leaving no mixed tree", async () => {
    // A mid-body reset makes `pipeline` reject while `tar` is STILL RUNNING and
    // writing into WORK_DIR. If the attempt settles on that rejection instead of
    // on the child's 'close', the retry loop deletes WORK_DIR under a live
    // extraction and the old child's later 'close' clears `activeChild` out from
    // under the new attempt's child.
    firstResponse = 'destroy';
    process.env.SOURCE_TARBALL_URL = `${origin}/tarball/deadbeef`;
    process.env.SOURCE_TOKEN = 'ghs_test_token';
    const agent = await import('../../container/build-agent.mjs');
    agent.clearBufferedLogLines();

    await agent.downloadSource({
      stallTimeoutMs: 10_000,
      phaseBudgetMs: 20_000,
      maxAttempts: 2,
      backoffMs: [0],
      progressIntervalMs: 50,
    });

    expect(requests).toBe(2);
    // Exactly the fixture, nothing else: a zombie tar writing after the reset
    // would leave extra or truncated entries behind.
    expect(readdirSync(WORK_DIR).sort()).toEqual(['big.bin', 'package.json']);
    expect(readFileSync(join(WORK_DIR, 'big.bin'))).toHaveLength(2 * 1024 * 1024);

    // Give any surviving child a window to write; the tree must not move.
    const before = readdirSync(WORK_DIR).sort();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readdirSync(WORK_DIR).sort()).toEqual(before);
    expect(readFileSync(join(WORK_DIR, 'big.bin'))).toHaveLength(2 * 1024 * 1024);
  }, 30_000);
});

// The child's LIFECYCLE, which the harness test above cannot pin. A real `tar`
// dies on SIGTERM far too promptly to distinguish "settles on the pipeline's
// rejection" from "settles on the child's close" — restoring the old
// `.catch(reject)` still passed every assertion there. So these tests supply a
// child that deliberately outlives the rejection.
describe('build-agent extractTarball child lifecycle', () => {
  let agent: typeof import('../../container/build-agent.mjs');

  // `downloadSource` calls `requireEnv` for both of these. Setting them HERE
  // rather than relying on an earlier describe having left them behind is what
  // makes this block runnable on its own (`-t 'child lifecycle'`).
  beforeEach(async () => {
    process.env.SOURCE_TARBALL_URL = 'https://api.github.com/repos/acme/site/tarball/deadbeef';
    process.env.SOURCE_TOKEN = 'ghs_test_token';
    agent = await import('../../container/build-agent.mjs');
    agent.clearBufferedLogLines();
  });

  afterEach(() => {
    delete process.env.SOURCE_TARBALL_URL;
    delete process.env.SOURCE_TOKEN;
  });

  /**
   * Deliberately NOT `ChildProcess`: the real type pins `signalCode`/`kill` to
   * Node's signal union, and this stand-in only needs the handful of members
   * `extractTarball` touches. It is cast at the `spawnImpl` boundary.
   */
  interface FakeTar {
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    stdin: PassThrough;
    stderr: PassThrough;
    signals: Array<string>;
    kill: (signal: string) => boolean;
    settle: (code: number, signal?: string | null) => void;
    on: (event: string, listener: (...args: Array<unknown>) => void) => unknown;
    emit: (event: string, ...args: Array<unknown>) => boolean;
  }

  /**
   * A `tar` stand-in. It exits only when told to: on a delayed SIGTERM, on
   * SIGKILL, or when its stdin finishes cleanly (a successful extraction).
   */
  function createFakeTar(opts: { sigtermDelayMs?: number; onClose?: () => void } = {}): FakeTar {
    const child = new EventEmitter() as unknown as FakeTar;
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    // Discard whatever the pipeline writes; an unread destination would stall it.
    child.stdin.resume();
    child.signals = [];
    child.settle = (code: number, signal: string | null = null) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.exitCode = code;
      child.signalCode = signal;
      opts.onClose?.();
      child.emit('close', code);
    };
    child.kill = (signal: string) => {
      child.signals.push(signal);
      if (signal === 'SIGTERM' && opts.sigtermDelayMs !== undefined) {
        setTimeout(() => child.settle(143, 'SIGTERM'), opts.sigtermDelayMs);
      }
      if (signal === 'SIGKILL') {
        child.settle(137, 'SIGKILL');
      }
      return true;
    };
    // A clean extraction: the writer finished, so the child exits 0.
    child.stdin.on('finish', () => child.settle(0));
    return child;
  }

  /** A web stream that delivers one chunk and then fails, like a reset socket. */
  const brokenBody = () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
        controller.error(new Error('connection reset'));
      },
    });

  /** A web stream that delivers one chunk and ends cleanly. */
  const goodBody = () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
    });

  const settled = async (promise: Promise<unknown>) => {
    const pending = Symbol('pending');
    const result = await Promise.race([
      promise.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((resolve) => setTimeout(() => resolve(pending), 60)),
    ]);
    return result === pending ? null : (result as string);
  };

  it('stays pending while the killed child is still alive, and settles from its close', async () => {
    const child = createFakeTar();
    const promise = agent.extractTarball(brokenBody(), {
      spawnImpl: () => child as unknown as ChildProcess,
      killGraceMs: 100_000,
    });
    const rejected = promise.then(
      () => null,
      (err: Error) => err,
    );

    // If broken: `.catch(reject)` settles here, while the child still runs.
    expect(await settled(promise)).toBe(null);
    expect(child.signals).toEqual(['SIGTERM']);

    child.settle(143, 'SIGTERM');
    expect((await rejected)?.message).toBe('connection reset');
  });

  it('escalates SIGTERM to SIGKILL when the child ignores it', async () => {
    const child = createFakeTar();
    const promise = agent.extractTarball(brokenBody(), {
      spawnImpl: () => child as unknown as ChildProcess,
      killGraceMs: 20,
    });
    const rejected = promise.then(
      () => null,
      (err: Error) => err,
    );

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    // The fake exits on SIGKILL, which is what finally settles the promise.
    expect((await rejected)?.message).toBe('connection reset');
  });

  it('clears the kill timer on close, so no SIGKILL follows a cooperative exit', async () => {
    const child = createFakeTar({ sigtermDelayMs: 5 });
    const promise = agent.extractTarball(brokenBody(), {
      spawnImpl: () => child as unknown as ChildProcess,
      killGraceMs: 25,
    });
    await promise.catch(() => {});

    // Past the grace: a timer left armed would have fired by now.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('reaps the failed attempt before the retry resets WORK_DIR', async () => {
    const order: Array<string> = [];
    let attempt = 0;
    const fetchImpl = (() => {
      attempt++;
      return Promise.resolve({
        ok: true,
        status: 200,
        body: attempt === 1 ? brokenBody() : goodBody(),
      });
    }) as unknown as typeof fetch;

    await agent.downloadSource({
      fetchImpl,
      resetWorkDir: () => {
        order.push('reset');
      },
      sleep: () => Promise.resolve(),
      stallTimeoutMs: 5000,
      phaseBudgetMs: 5000,
      maxAttempts: 2,
      backoffMs: [0],
      extract: (body, options) =>
        agent.extractTarball(body, {
          ...options,
          // 25ms of deliberate overlap: long enough that a promise settling on
          // the pipeline's rejection would reach the reset first.
          spawnImpl: () =>
            createFakeTar({
              sigtermDelayMs: 25,
              onClose: () => order.push('close'),
            }) as unknown as ChildProcess,
          killGraceMs: 5000,
        }),
    });

    // If broken: early settlement gives ['reset', 'reset', 'close'] —
    // WORK_DIR wiped under a live extraction.
    expect(order).toEqual(['reset', 'close', 'reset', 'close']);
  });
});
