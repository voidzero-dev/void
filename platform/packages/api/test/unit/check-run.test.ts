import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ApiEnv } from '../../src/env.ts';
import { completeCheckRun, createCheckRun } from '../../src/github/check-run.ts';

// Real RS256 PKCS#8 key so the REAL getInstallationToken -> createAppJwt ->
// importPKCS8/sign path runs (the integration suite vi.mock's that module, so
// only a real-module unit test can exercise the real mint + retry behavior).
let PRIVATE_KEY_PEM: string;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  PRIVATE_KEY_PEM = await exportPKCS8(pair.privateKey);
});

function makeEnv(): ApiEnv['Bindings'] {
  return {
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
  } as unknown as ApiEnv['Bindings'];
}

const REPO = 'octocat/hello-world';
const HEAD_SHA = 'a'.repeat(40);
const BUILD_ID = 'build-123';
const CHECK_RUN_ID = '99001';

function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  if (input instanceof Request) {
    return input.method;
  }
  return (init?.method ?? 'GET').toUpperCase();
}

function isTokenMint(url: string): boolean {
  return url.includes('/access_tokens');
}

function isCheckRun(url: string): boolean {
  return url.includes('/check-runs');
}

// A valid access-token POST response so the check-run path is reached.
function accessTokenOk(): Response {
  return Response.json({
    token: 'minted-installation-token',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

// Parse the structured `console.warn` JSON lines this module emits (non-JSON
// fallback lines, if any, are ignored).
function warnObjects(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    const arg = call[0];
    if (typeof arg !== 'string') {
      continue;
    }
    try {
      out.push(JSON.parse(arg) as Record<string, unknown>);
    } catch {
      // non-JSON fallback line — skip
    }
  }
  return out;
}

function reasonsOf(spy: ReturnType<typeof vi.spyOn>, phase: string): Array<unknown> {
  return warnObjects(spy)
    .filter((o) => o.area === 'github' && o.phase === phase)
    .map((o) => o.reason);
}

/** Keep every retry attempt but run its backoff timer at once. */
function skipRetryDelay(): void {
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    schedule(callback, delay === 250 ? 0 : delay, ...args),
  );
}

describe('createCheckRun', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  // Unique installation id per test — getInstallationToken caches the
  // installation-wide token per id for the isolate, so a shared id would let a
  // minted token from one test satisfy the mint in another.
  let installId = 0;
  function nextInstallId(): string {
    installId += 1;
    return `inst-create-${installId}`;
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    skipRetryDelay();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function callCreate(installationId: string): Promise<string | null> {
    return createCheckRun(makeEnv(), installationId, REPO, {
      name: 'Void Build',
      headSha: HEAD_SHA,
      externalId: BUILD_ID,
      detailsUrl: 'https://example.com/build/123',
      title: 'Building',
      summary: 'Build in progress',
    });
  }

  // create: POST -> 201 {id: 99001} => returns '99001', POST body has the
  // expected in_progress shape.
  it('returns the id as a string and POSTs the in_progress body', async () => {
    const installationId = nextInstallId();
    let postBody: Record<string, unknown> | undefined;
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          expect(methodOf(input, init)).toBe('POST');
          postCount += 1;
          postBody = JSON.parse(init!.body as string) as Record<string, unknown>;
          return Response.json({ id: 99001 }, { status: 201 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callCreate(installationId);

    expect(result).toBe('99001');
    expect(postCount).toBe(1);
    expect(postBody).toBeDefined();
    expect(postBody!.status).toBe('in_progress');
    expect(postBody!.head_sha).toBe(HEAD_SHA);
    expect(postBody!.external_id).toBe(BUILD_ID);
    expect(postBody!.name).toBe('Void Build');
    expect(postBody!.details_url).toBe('https://example.com/build/123');
    expect(postBody!.output).toEqual({ title: 'Building', summary: 'Build in progress' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // create: POST -> 404 => returns null, exactly ONE POST (no retry on 4xx), one
  // check-run-create warn.
  it('returns null with no retry on a 4xx and logs one failure', async () => {
    const installationId = nextInstallId();
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          postCount += 1;
          return new Response('Not Found', { status: 404, statusText: 'Not Found' });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callCreate(installationId);

    expect(result).toBeNull();
    expect(postCount).toBe(1);
    const reasons = reasonsOf(warnSpy, 'check-run-create');
    expect(reasons.filter((r) => r === 'http-4xx')).toHaveLength(1);
    expect(reasons).not.toContain('exhausted');
  });

  // create: POST -> 500 => returns null WITHOUT retrying. The create POST is
  // SINGLE-SHOT (not idempotent — a retry on an ambiguous 5xx could duplicate the run
  // and orphan the first `in_progress`). Exactly ONE POST, one http-5xx warn, and NO
  // `exhausted` warn (the loop returns immediately, it does not run out of attempts).
  it('does NOT retry on a 5xx — returns null after exactly one POST', async () => {
    const installationId = nextInstallId();
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          postCount += 1;
          return new Response('boom', { status: 500 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callCreate(installationId);

    expect(result).toBeNull();
    expect(postCount).toBe(1); // single-shot — no retry on 5xx
    const reasons = reasonsOf(warnSpy, 'check-run-create');
    expect(reasons.filter((r) => r === 'http-5xx')).toHaveLength(1);
    expect(reasons).not.toContain('exhausted'); // returns, never loops to exhaustion
  });

  // create: POST rejects (network error) => returns null WITHOUT retrying.
  // A network failure on the POST is ambiguous (GitHub may have created the run), so
  // a retry risks a duplicate — single-shot. Exactly ONE POST attempt, one
  // network-error warn, no `exhausted`.
  it('does NOT retry on a network error — returns null after exactly one POST', async () => {
    const installationId = nextInstallId();
    let postCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          postCount += 1;
          throw new TypeError('network error');
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callCreate(installationId);

    expect(result).toBeNull();
    expect(postCount).toBe(1); // single-shot — no retry on a network failure
    const reasons = reasonsOf(warnSpy, 'check-run-create');
    expect(reasons.filter((r) => r === 'network-error')).toHaveLength(1);
    expect(reasons).not.toContain('exhausted');
  });

  // token-mint throws (e.g. missing App key) => returns null, never throws.
  it('returns null without throwing when token mint fails', async () => {
    const installationId = nextInstallId();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return new Response('bad creds', { status: 401 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callCreate(installationId);

    expect(result).toBeNull();
    const reasons = reasonsOf(warnSpy, 'check-run-create');
    expect(reasons).toContain('token-mint-failed');
    expect(reasons).toContain('exhausted');
  });
});

describe('completeCheckRun', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let installId = 0;
  function nextInstallId(): string {
    installId += 1;
    return `inst-complete-${installId}`;
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    skipRetryDelay();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function callComplete(installationId: string, extra?: { text?: string }): Promise<boolean> {
    return completeCheckRun(makeEnv(), installationId, REPO, CHECK_RUN_ID, {
      conclusion: 'success',
      detailsUrl: 'https://example.com/build/123',
      title: 'Done',
      summary: 'Build succeeded',
      ...extra,
    });
  }

  // complete: PATCH -> 200 => returns true, body has completed + conclusion.
  it('returns true and PATCHes the completed body', async () => {
    const installationId = nextInstallId();
    let patchBody: Record<string, unknown> | undefined;
    let patchUrl: string | undefined;
    let patchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          expect(methodOf(input, init)).toBe('PATCH');
          patchCount += 1;
          patchUrl = url;
          patchBody = JSON.parse(init!.body as string) as Record<string, unknown>;
          return Response.json({ id: 99001 }, { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId);

    expect(result).toBe(true);
    expect(patchCount).toBe(1);
    expect(patchUrl).toContain(`/check-runs/${CHECK_RUN_ID}`);
    expect(patchBody).toBeDefined();
    expect(patchBody!.status).toBe('completed');
    expect(patchBody!.conclusion).toBe('success');
    expect(patchBody!.output).toEqual({ title: 'Done', summary: 'Build succeeded' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // complete with `text` => PATCH body's output.text is the given string
  // verbatim, title/summary unchanged.
  it('includes output.text in the PATCH body when text is provided', async () => {
    const installationId = nextInstallId();
    const logTail = '```\nlog line 1\nlog line 2\n```';
    let patchBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchBody = JSON.parse(init!.body as string) as Record<string, unknown>;
          return Response.json({ id: 99001 }, { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId, { text: logTail });

    expect(result).toBe(true);
    expect(patchBody).toBeDefined();
    expect(patchBody!.output).toEqual({
      title: 'Done',
      summary: 'Build succeeded',
      text: logTail,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // complete without `text` => PATCH body's output has NO `text` key at all
  // (assert key absence, not just an undefined value).
  it('omits the text key from output when text is not provided', async () => {
    const installationId = nextInstallId();
    let patchBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchBody = JSON.parse(init!.body as string) as Record<string, unknown>;
          return Response.json({ id: 99001 }, { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId);

    expect(result).toBe(true);
    expect(patchBody).toBeDefined();
    const output = patchBody!.output as Record<string, unknown>;
    expect('text' in output).toBe(false);
    expect(output).toEqual({ title: 'Done', summary: 'Build succeeded' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // complete: PATCH -> 500 x3 => returns false, one exhausted warn.
  it('retries a persistent 5xx then returns false with an exhausted warn', async () => {
    const installationId = nextInstallId();
    let patchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchCount += 1;
          return new Response('boom', { status: 500 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId);

    expect(result).toBe(false);
    expect(patchCount).toBe(3);
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons.filter((r) => r === 'http-5xx')).toHaveLength(3);
    expect(reasons.filter((r) => r === 'exhausted')).toHaveLength(1);
  });

  // token-mint throws => returns false, never throws.
  it('returns false without throwing when token mint fails', async () => {
    const installationId = nextInstallId();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return new Response('bad creds', { status: 401 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId);

    expect(result).toBe(false);
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons).toContain('token-mint-failed');
    expect(reasons).toContain('exhausted');
  });

  // 422 fallback: GitHub validates output.text server-side (65535 UTF-8 BYTES
  // and content checks beyond size). The complete PATCH is idempotent, so a
  // 422 on a body that included `text` is retried ONCE without `output.text` —
  // a rejected tail must never cost the completion itself.
  it('retries ONCE without output.text when a 422 rejects a body that included text', async () => {
    const installationId = nextInstallId();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          const body = JSON.parse(init!.body as string) as Record<string, unknown>;
          bodies.push(body);
          if ('text' in (body.output as Record<string, unknown>)) {
            return new Response(
              '{"message":"Validation Failed: text maximum bytesize of 65535 exceeded"}',
              { status: 422, statusText: 'Unprocessable Entity' },
            );
          }
          return Response.json({ id: 99001 }, { status: 200 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId, { text: 'some rejected log tail' });

    expect(result).toBe(true);
    expect(bodies).toHaveLength(2);
    expect('text' in (bodies[0].output as Record<string, unknown>)).toBe(true);
    // Fallback body: identical minus output.text.
    expect('text' in (bodies[1].output as Record<string, unknown>)).toBe(false);
    expect(bodies[1].output).toEqual({ title: 'Done', summary: 'Build succeeded' });
    expect(bodies[1].status).toBe('completed');
    expect(bodies[1].conclusion).toBe('success');
    expect(bodies[1].details_url).toBe('https://example.com/build/123');
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons).toEqual(['text-rejected-retry']);
  });

  // Non-422 4xx stays definitive even when text was included — no fallback.
  it('keeps a non-422 4xx single-shot even when text was included', async () => {
    const installationId = nextInstallId();
    let patchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchCount += 1;
          return new Response('Forbidden', { status: 403, statusText: 'Forbidden' });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId, { text: 'a log tail' });

    expect(result).toBe(false);
    expect(patchCount).toBe(1);
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons).toEqual(['http-4xx']);
  });

  // 422 on a body that never had text => nothing to strip, no retry.
  it('does not retry a 422 when the body never included text', async () => {
    const installationId = nextInstallId();
    let patchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchCount += 1;
          return new Response('{"message":"Validation Failed"}', {
            status: 422,
            statusText: 'Unprocessable Entity',
          });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId);

    expect(result).toBe(false);
    expect(patchCount).toBe(1);
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons).toEqual(['http-4xx']);
  });

  // The fallback follows the existing definitive-4xx handling when it ALSO
  // fails: exactly two PATCHes (strip once, then definitive), returns false.
  it('returns false after exactly two PATCHes when the text-less fallback also 422s', async () => {
    const installationId = nextInstallId();
    let patchCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCheckRun(url)) {
          patchCount += 1;
          return new Response('{"message":"Validation Failed"}', {
            status: 422,
            statusText: 'Unprocessable Entity',
          });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await callComplete(installationId, { text: 'a log tail' });

    expect(result).toBe(false);
    expect(patchCount).toBe(2);
    const reasons = reasonsOf(warnSpy, 'check-run-complete');
    expect(reasons).toEqual(['text-rejected-retry', 'http-4xx']);
  });
});
