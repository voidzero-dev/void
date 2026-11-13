import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  DirectR2PutError,
  uploadAssetsToR2,
  type DirectR2PutItem,
} from '../../src/cli/direct-r2-upload.ts';

function makeItem(
  path: string,
  hash: string,
  body = Buffer.from(`bytes-${path}`),
): DirectR2PutItem {
  return {
    path,
    hash,
    body,
    url: `https://r2/${hash}`,
    headers: { 'Content-Md5': 'aGVsbG8=', 'Content-Type': 'text/plain' },
  };
}

const cliLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  path: '/tmp/test.jsonl',
  close: vi.fn(),
} as const;

beforeEach(() => {
  cliLog.info.mockReset();
  cliLog.warn.mockReset();
  cliLog.error.mockReset();
  cliLog.debug.mockReset();
});

describe('uploadAssetsToR2', () => {
  it('PUTs each item once when all succeed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const items = [makeItem('/a.html', 'h1'), makeItem('/b.css', 'h2'), makeItem('/c.js', 'h3')];

    await uploadAssetsToR2(items, cliLog, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = new Set(fetchMock.mock.calls.map(([u]) => u));
    expect(urls).toEqual(new Set(['https://r2/h1', 'https://r2/h2', 'https://r2/h3']));

    // Per-asset start/end events.
    const startEvents = cliLog.info.mock.calls.filter(([msg]) => msg === 'r2_put_start');
    const endEvents = cliLog.info.mock.calls.filter(([msg]) => msg === 'r2_put_end');
    expect(startEvents).toHaveLength(3);
    expect(endEvents).toHaveLength(3);
  });

  it('passes presigned headers verbatim and uses PUT method', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await uploadAssetsToR2([makeItem('/a.html', 'h1')], cliLog, fetchMock);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(init.headers['Content-Md5']).toBe('aGVsbG8=');
    expect(init.headers['Content-Type']).toBe('text/plain');
    expect(init.body).toBeInstanceOf(Uint8Array);
  });

  it.each([429, 503])('retries transient HTTP %s responses then succeeds', async (status) => {
    vi.useFakeTimers();
    let attempts = 0;
    const attemptTimes: Array<number> = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      attemptTimes.push(Date.now());
      attempts++;
      if (attempts < 3) {
        return Promise.resolve(new Response('temporary failure', { status }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    try {
      const upload = uploadAssetsToR2([makeItem('/x.css', 'h-x')], cliLog, fetchMock).catch(
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      expect(await upload).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retries = cliLog.warn.mock.calls.filter(([msg]) => msg === 'r2_put_retry');
    expect(retries).toHaveLength(2);
    expect(retries[0][1]).toMatchObject({ attempt: 1, status });
    expect(retries[1][1]).toMatchObject({ attempt: 2, status });
    if (status === 429) {
      expect(attemptTimes[1] - attemptTimes[0]).toBeGreaterThanOrEqual(1000);
      expect(attemptTimes[2] - attemptTimes[1]).toBeGreaterThanOrEqual(1000);
    }
  });

  it('throws DirectR2PutError on 4xx without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('SignatureMismatch', { status: 403 }));

    await expect(
      uploadAssetsToR2([makeItem('/oops.html', 'h-oops')], cliLog, fetchMock),
    ).rejects.toMatchObject({
      name: 'DirectR2PutError',
      status: 403,
      hash: 'h-oops',
      path: '/oops.html',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500])(
    'throws DirectR2PutError when HTTP %s exceeds retry budget',
    async (status) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockImplementation(() => new Response('boom', { status }));

      try {
        const upload = expect(
          uploadAssetsToR2([makeItem('/x.html', 'h-x')], cliLog, fetchMock),
        ).rejects.toMatchObject({
          name: 'DirectR2PutError',
          status,
          hash: 'h-x',
          path: '/x.html',
        });
        await vi.runAllTimersAsync();
        await upload;
      } finally {
        vi.useRealTimers();
      }
      // 1 initial attempt + 3 retries = 4 calls.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    },
  );

  it('error message identifies the asset path and hash', () => {
    const err = new DirectR2PutError(403, 'h-bad', '/foo.html', 'SignatureMismatch');
    expect(err.message).toContain('/foo.html');
    expect(err.message).toContain('h-bad');
    expect(err.message).toContain('403');
    expect(err.message).toContain('SignatureMismatch');
  });

  it('respects bounded concurrency (max 10 in flight)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield once so concurrent requests stack up.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(null, { status: 200 });
    });

    const items = Array.from({ length: 25 }, (_, i) => makeItem(`/f${i}.html`, `h${i}`));
    await uploadAssetsToR2(items, cliLog, fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(25);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(10);
  });

  it('returns immediately when items is empty', async () => {
    const fetchMock = vi.fn();
    await uploadAssetsToR2([], cliLog, fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces network errors with retry exhaustion', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    try {
      const upload = expect(
        uploadAssetsToR2([makeItem('/n.html', 'h-n')], cliLog, fetchMock),
      ).rejects.toMatchObject({
        name: 'DirectR2PutError',
        status: 0,
        hash: 'h-n',
        path: '/n.html',
      });
      await vi.runAllTimersAsync();
      await upload;
    } finally {
      vi.useRealTimers();
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('clears item.body and invokes onAfterPut after each successful PUT', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const items = [makeItem('/a.html', 'h1'), makeItem('/b.css', 'h2'), makeItem('/c.js', 'h3')];
    const seen: Array<string> = [];

    await uploadAssetsToR2(items, cliLog, fetchMock, (item) => {
      // body must already be cleared by the time the callback runs so the
      // caller does not have to inspect it.
      expect(item.body).toBeUndefined();
      seen.push(item.path);
    });

    // Every item invoked the callback exactly once, with body cleared.
    expect(seen.sort()).toEqual(['/a.html', '/b.css', '/c.js']);
    for (const item of items) {
      expect(item.body).toBeUndefined();
    }
  });

  it('does not invoke onAfterPut when the PUT fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('SignatureMismatch', { status: 403 }));
    const item = makeItem('/oops.html', 'h-oops');
    const onAfterPut = vi.fn();

    await expect(uploadAssetsToR2([item], cliLog, fetchMock, onAfterPut)).rejects.toBeDefined();

    // Failed upload must not signal "done" via the cleanup hook — callers
    // depend on this to avoid prematurely dropping refs they may need to
    // re-presign / retry against in a future iteration.
    expect(onAfterPut).not.toHaveBeenCalled();
    expect(item.body).toBeDefined();
  });
});
