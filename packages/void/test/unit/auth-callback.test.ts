import { describe, expect, it, vi } from 'vite-plus/test';
import { awaitBrowserCallback } from '../../src/cli/auth.ts';

// A no-op stand-in for node:child_process.execFile so the helper never tries
// to launch a real browser during tests.
const noopExecFile = vi.fn() as unknown as typeof import('node:child_process').execFile;

/**
 * Start awaitBrowserCallback and resolve once it hands us the authorize URL
 * (built from the localhost callback). Returns the callback URL so the test can
 * drive the localhost server directly.
 */
function startCallback<T = URLSearchParams>(options?: {
  describeError?: (params: URLSearchParams) => string | null;
  finalize?: (params: URLSearchParams) => Promise<T>;
  state?: string;
}): {
  resultPromise: Promise<T>;
  callbackPromise: Promise<URL>;
  state: string;
} {
  const state = options?.state ?? 'test-state-123';
  let resolveCallback!: (url: URL) => void;
  const callbackPromise = new Promise<URL>((resolve) => {
    resolveCallback = resolve;
  });

  const finalize =
    options?.finalize ?? ((params: URLSearchParams) => Promise.resolve(params as unknown as T));

  const resultPromise = awaitBrowserCallback<T>({
    state,
    execFile: noopExecFile,
    describeError: options?.describeError,
    finalize,
    buildAuthUrl: (callback) => {
      resolveCallback(callback);
      return 'https://example.test/authorize';
    },
  });

  return { resultPromise, callbackPromise, state };
}

describe('awaitBrowserCallback', () => {
  it('escapes callback error text without altering the failure reported to the CLI', async () => {
    const message = '<script>alert("callback")</script>';
    const { resultPromise, callbackPromise } = startCallback({ describeError: () => message });
    const rejection = expect(resultPromise).rejects.toThrow(message);
    const response = await fetch(await callbackPromise);
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).not.toContain(message);
    expect(html).toContain('&lt;script&gt;');
    await rejection;
  });

  it('runs finalize in the request path and resolves with its return value', async () => {
    const finalize = vi.fn(async (params: URLSearchParams) => ({
      linked: params.get('link_code'),
    }));
    const { resultPromise, callbackPromise, state } = startCallback({ finalize });
    const callback = await callbackPromise;

    // The helper appends the caller-supplied state to the callback URL.
    expect(callback.pathname).toBe('/callback');
    expect(callback.searchParams.get('state')).toBe(state);
    expect(callback.protocol).toBe('http:');
    expect(callback.hostname).toBe('localhost');

    const hit = new URL(callback);
    hit.searchParams.set('link_code', 'abc');

    const res = await fetch(hit);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Signed in to Void');
    expect(html).toContain('aria-label="Success"');

    // finalize ran inside the request handler with the callback params, and the
    // outer promise resolves with finalize's return value.
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize.mock.calls[0][0].get('link_code')).toBe('abc');
    expect(finalize.mock.calls[0][0].get('state')).toBe(state);

    await expect(resultPromise).resolves.toEqual({ linked: 'abc' });
  });

  it('renders the failure page and rejects when finalize throws', async () => {
    const finalizeError = new Error('exchange blew up');
    const finalize = vi.fn(async () => {
      throw finalizeError;
    });
    const { resultPromise, callbackPromise, state } = startCallback({ finalize });
    const callback = await callbackPromise;

    // Attach the rejection assertion before triggering the request so the
    // handler is in place when the promise settles (no unhandled rejection).
    const rejection = expect(resultPromise).rejects.toBe(finalizeError);

    const hit = new URL(callback);
    hit.searchParams.set('state', state);
    hit.searchParams.set('link_code', 'abc');

    const res = await fetch(hit);
    // The browser must NOT see the success page when finalize fails.
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain('successful');
    expect(body).toContain('Could not complete');

    expect(finalize).toHaveBeenCalledTimes(1);
    await rejection;
  });

  it('returns 400 and keeps listening on a state mismatch (does not call finalize)', async () => {
    const finalize = vi.fn(async (params: URLSearchParams) => params);
    const { resultPromise, callbackPromise, state } = startCallback({ finalize });
    const callback = await callbackPromise;

    const bad = new URL(callback);
    bad.searchParams.set('state', 'wrong-state');
    bad.searchParams.set('link_code', 'attacker');

    const badRes = await fetch(bad);
    expect(badRes.status).toBe(400);

    // A state mismatch is rejected before finalize runs.
    expect(finalize).not.toHaveBeenCalled();

    // The genuine callback still completes — the server stayed open.
    const good = new URL(callback);
    good.searchParams.set('state', state);
    good.searchParams.set('link_code', 'real');

    const goodRes = await fetch(good);
    expect(goodRes.status).toBe(200);

    const params = await resultPromise;
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(params.get('link_code')).toBe('real');
  });

  it('rejects after the timeout elapses', async () => {
    const resultPromise = awaitBrowserCallback({
      state: 'timeout-state',
      execFile: noopExecFile,
      timeoutMs: 10,
      finalize: async (params) => params,
      buildAuthUrl: (callback) =>
        `https://example.test/authorize?cb=${encodeURIComponent(callback.href)}`,
    });

    await expect(resultPromise).rejects.toThrow(/timed out/);
  });

  it('does not open a real browser (execFile is injected)', async () => {
    const execFile = vi.fn() as unknown as typeof import('node:child_process').execFile;
    let resolveCallback!: (url: URL) => void;
    const callbackPromise = new Promise<URL>((resolve) => {
      resolveCallback = resolve;
    });

    const resultPromise = awaitBrowserCallback({
      state: 's',
      execFile,
      finalize: async (params) => params,
      buildAuthUrl: (callback) => {
        resolveCallback(callback);
        return 'https://example.test/authorize';
      },
    });

    const callback = await callbackPromise;
    const hit = new URL(callback);
    hit.searchParams.set('state', 's');
    await fetch(hit);
    await resultPromise;

    // By the time the flow completes, the injected execFile (never a real
    // browser) was invoked with the authorize URL as a single argv element.
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['https://example.test/authorize']),
      expect.any(Function),
    );
  });
});
