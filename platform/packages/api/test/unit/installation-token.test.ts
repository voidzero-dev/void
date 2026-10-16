import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ApiEnv } from '../../src/env.ts';
import { getBranchHeadComparisonStatus } from '../../src/github/installation-token.ts';

// Real RS256 PKCS#8 key so the REAL getInstallationToken -> createAppJwt ->
// importPKCS8/sign path runs (the integration suite vi.mock's this whole module,
// so only a real-module unit test can exercise the new logging).
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
const BASE_SHA = 'a'.repeat(40);
const BRANCH = 'main';

function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function isTokenMint(url: string): boolean {
  return url.includes('/access_tokens');
}

function isCompare(url: string): boolean {
  return url.includes('/compare/');
}

// A valid access-token POST response so the compare GET path is reached.
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

function reasonsOf(spy: ReturnType<typeof vi.spyOn>): Array<unknown> {
  return warnObjects(spy)
    .filter((o) => o.area === 'github')
    .map((o) => (o.msg as string)?.replace('branch-head compare failed: ', ''));
}

// Assert every github failure log locks the shared schema fields.
function assertSchema(spy: ReturnType<typeof vi.spyOn>, installationId: string): void {
  for (const o of warnObjects(spy)) {
    if (o.area !== 'github') {
      continue;
    }
    // 'exhausted' carries `attempts` instead of `attempt`; all the per-attempt
    // failure logs carry `attempt`. Both always carry the identity fields.
    expect(o.installationId).toBe(installationId);
    expect(o.repoFullName).toBe(REPO);
    expect(o.baseSha).toBe(BASE_SHA);
    expect(o.branch).toBe(BRANCH);
    if (o.msg === 'branch-head compare failed: exhausted') {
      expect(o.attempts).toBe(3);
    } else {
      expect(typeof o.attempt).toBe('number');
    }
  }
}

/** Keep every retry attempt but run its backoff timer at once. */
function skipRetryDelay(): void {
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    schedule(callback, delay === 250 ? 0 : delay, ...args),
  );
}

describe('getBranchHeadComparisonStatus structured logging', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  // Unique installation id per test — getInstallationToken caches the
  // installation-wide token per id for the isolate, so a shared id would let a
  // minted token from one test satisfy the mint in another (skewing case 1).
  let installId = 0;
  function nextInstallId(): string {
    installId += 1;
    return `inst-${installId}`;
  }

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    skipRetryDelay();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Case 1: access-token POST -> 401 (token mint fails). Mint fails on every
  // attempt, so no compare GET is ever issued; returns null.
  it('logs token-mint-failed when the access-token POST returns 401 (no compare GET)', async () => {
    const installationId = nextInstallId();
    let compareCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return new Response('bad creds', { status: 401 });
        }
        if (isCompare(url)) {
          compareCalls += 1;
          return accessTokenOk();
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await getBranchHeadComparisonStatus(
      makeEnv(),
      installationId,
      REPO,
      BASE_SHA,
      BRANCH,
    );

    expect(result).toBeNull();
    expect(compareCalls).toBe(0);
    const reasons = reasonsOf(warnSpy);
    expect(reasons).toContain('token-mint-failed');
    // Mint fails on all 3 attempts, then exhausted.
    expect(reasons.filter((r) => r === 'token-mint-failed')).toHaveLength(3);
    expect(reasons).toContain('exhausted');
    assertSchema(warnSpy, installationId);
  });

  // Case 2: compare GET -> 404 + body. Definitive 4xx -> immediate null, exactly
  // one compare GET (no retries).
  it('logs http-4xx with status 404 and body, returns null with no retries', async () => {
    const installationId = nextInstallId();
    let compareCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCompare(url)) {
          compareCalls += 1;
          return new Response('Not Found', { status: 404, statusText: 'Not Found' });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await getBranchHeadComparisonStatus(
      makeEnv(),
      installationId,
      REPO,
      BASE_SHA,
      BRANCH,
    );

    expect(result).toBeNull();
    expect(compareCalls).toBe(1);
    const fourxx = warnObjects(warnSpy).find(
      (o) => o.msg === 'branch-head compare failed: http-4xx',
    );
    expect(fourxx).toBeDefined();
    expect(fourxx!.status).toBe(404);
    expect(fourxx!.body).toBe('Not Found');
    expect(reasonsOf(warnSpy)).not.toContain('exhausted');
    assertSchema(warnSpy, installationId);
  });

  // Case 3: compare GET -> 403 + body. Another definitive 4xx.
  it('logs http-4xx with status 403', async () => {
    const installationId = nextInstallId();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCompare(url)) {
          return new Response('Forbidden', { status: 403, statusText: 'Forbidden' });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await getBranchHeadComparisonStatus(
      makeEnv(),
      installationId,
      REPO,
      BASE_SHA,
      BRANCH,
    );

    expect(result).toBeNull();
    const fourxx = warnObjects(warnSpy).find(
      (o) => o.msg === 'branch-head compare failed: http-4xx',
    );
    expect(fourxx).toBeDefined();
    expect(fourxx!.status).toBe(403);
    assertSchema(warnSpy, installationId);
  });

  // Case 4: compare GET -> 500 every time. 5xx is transient -> 3 compare GETs
  // (1 + 2 retries), one http-5xx per attempt, then one exhausted.
  it('logs http-5xx per attempt then exhausted on a persistent 500', async () => {
    const installationId = nextInstallId();
    let compareCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCompare(url)) {
          compareCalls += 1;
          return new Response('boom', { status: 500 });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await getBranchHeadComparisonStatus(
      makeEnv(),
      installationId,
      REPO,
      BASE_SHA,
      BRANCH,
    );

    expect(result).toBeNull();
    expect(compareCalls).toBe(3);
    const reasons = reasonsOf(warnSpy);
    expect(reasons.filter((r) => r === 'http-5xx')).toHaveLength(3);
    expect(reasons.filter((r) => r === 'exhausted')).toHaveLength(1);
    const fivexx = warnObjects(warnSpy).find(
      (o) => o.msg === 'branch-head compare failed: http-5xx',
    );
    expect(fivexx!.status).toBe(500);
    assertSchema(warnSpy, installationId);
  });

  // Case 5: compare GET throws (network) every time. Transient -> 3 attempts,
  // one network-error per attempt, then exhausted.
  it('logs network-error per attempt then exhausted when the compare GET throws', async () => {
    const installationId = nextInstallId();
    let compareCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCompare(url)) {
          compareCalls += 1;
          throw new Error('ECONNRESET');
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await getBranchHeadComparisonStatus(
      makeEnv(),
      installationId,
      REPO,
      BASE_SHA,
      BRANCH,
    );

    expect(result).toBeNull();
    expect(compareCalls).toBe(3);
    const reasons = reasonsOf(warnSpy);
    expect(reasons.filter((r) => r === 'network-error')).toHaveLength(3);
    expect(reasons.filter((r) => r === 'exhausted')).toHaveLength(1);
    const net = warnObjects(warnSpy).find(
      (o) => o.msg === 'branch-head compare failed: network-error',
    );
    expect((net!.err as { message?: string }).message).toMatch(/ECONNRESET/);
    assertSchema(warnSpy, installationId);
  });

  // Case 6: compare GET -> 200 {status:'identical'}. Success path: returns the
  // status, emits ZERO warn lines.
  it('returns the status with no warn lines on a 200 success', async () => {
    const installationId = nextInstallId();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCompare(url)) {
          return Response.json({ status: 'identical' });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await getBranchHeadComparisonStatus(
      makeEnv(),
      installationId,
      REPO,
      BASE_SHA,
      BRANCH,
    );

    expect(result).toBe('identical');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // Case 7: compare GET -> 500 then 200 {status:'ahead'}. One http-5xx, then the
  // retry succeeds: returns 'ahead', NO exhausted.
  it('logs one http-5xx then returns the status when the retry succeeds', async () => {
    const installationId = nextInstallId();
    let compareCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (isTokenMint(url)) {
          return accessTokenOk();
        }
        if (isCompare(url)) {
          compareCalls += 1;
          if (compareCalls === 1) {
            return new Response('boom', { status: 500 });
          }
          return Response.json({ status: 'ahead' });
        }
        throw new Error(`Unmocked fetch: ${url}`);
      }),
    );

    const result = await getBranchHeadComparisonStatus(
      makeEnv(),
      installationId,
      REPO,
      BASE_SHA,
      BRANCH,
    );

    expect(result).toBe('ahead');
    expect(compareCalls).toBe(2);
    const reasons = reasonsOf(warnSpy);
    expect(reasons.filter((r) => r === 'http-5xx')).toHaveLength(1);
    expect(reasons).not.toContain('exhausted');
    assertSchema(warnSpy, installationId);
  });
});
