import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ApiEnv } from '../../src/env.ts';
import { GITHUB_API_VERSION } from '../../src/github/installation-token.ts';
import {
  listFailedWebhookDeliveries,
  redeliverWebhookDelivery,
} from '../../src/github/webhook-deliveries.ts';

// Real RS256 PKCS#8 key so the REAL createAppJwt -> importPKCS8/sign path runs.
let PRIVATE_KEY_PEM: string;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  PRIVATE_KEY_PEM = await exportPKCS8(pair.privateKey);
});

function makeEnv(overrides?: Partial<ApiEnv['Bindings']>): ApiEnv['Bindings'] {
  return {
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
    ...overrides,
  } as unknown as ApiEnv['Bindings'];
}

function urlOf(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  if (input instanceof Request) {
    return input.method;
  }
  return (init?.method ?? 'GET').toUpperCase();
}

function headersOf(input: string | URL | Request, init?: RequestInit): Headers {
  if (input instanceof Request) {
    return input.headers;
  }
  return new Headers(init?.headers as HeadersInit | undefined);
}

// A GitHub delivery-log item (only the fields we map).
function deliveryItem(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 100,
    guid: 'guid-100',
    event: 'push',
    status: 'Invalid HTTP Response: 502',
    status_code: 502,
    delivered_at: '2026-07-01T00:00:00Z',
    redelivery: false,
    ...overrides,
  };
}

function pageResponse(items: Array<Record<string, unknown>>, nextUrl?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (nextUrl) {
    headers.Link = `<${nextUrl}>; rel="next"`;
  }
  return new Response(JSON.stringify(items), { status: 200, headers });
}

/** Keep every retry attempt but run its backoff timer at once. */
function skipRetryDelay(): void {
  const schedule = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    schedule(callback, delay === 250 ? 0 : delay, ...args),
  );
}

describe('listFailedWebhookDeliveries', () => {
  beforeEach(() => {
    skipRetryDelay();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requests status=failure with the app-JWT header block and maps items', async () => {
    const calls: Array<{ url: string; auth: string | null; apiVersion: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = headersOf(input, init);
        calls.push({
          url: urlOf(input),
          auth: headers.get('authorization'),
          apiVersion: headers.get('x-github-api-version'),
        });
        return pageResponse([
          deliveryItem({ id: 111, guid: 'g1', event: 'push', status_code: 502 }),
        ]);
      }),
    );

    const result = await listFailedWebhookDeliveries(makeEnv());

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/app/hook/deliveries');
    expect(calls[0].url).toContain('status=failure');
    expect(calls[0].url).toContain('per_page=100');
    expect(calls[0].auth).toMatch(/^Bearer .+/);
    expect(calls[0].apiVersion).toBe(GITHUB_API_VERSION);

    expect(result).toEqual([
      {
        id: '111',
        guid: 'g1',
        event: 'push',
        statusCode: 502,
        deliveredAt: '2026-07-01T00:00:00Z',
      },
    ]);
  });

  it('follows the Link rel="next" cursor across 2 pages then stops', async () => {
    const requestedUrls: Array<string> = [];
    const nextUrl =
      'https://api.github.com/app/hook/deliveries?per_page=100&status=failure&cursor=PAGE2';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        requestedUrls.push(url);
        if (!url.includes('cursor=')) {
          // Page 1 -> hands back a rel="next" cursor url.
          return pageResponse([deliveryItem({ id: 1, guid: 'g1' })], nextUrl);
        }
        // Page 2 -> no Link header, iteration stops.
        return pageResponse([deliveryItem({ id: 2, guid: 'g2' })]);
      }),
    );

    const result = await listFailedWebhookDeliveries(makeEnv());

    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[1]).toBe(nextUrl);
    expect(result.map((d) => d.id)).toEqual(['1', '2']);
    expect(result.map((d) => d.guid)).toEqual(['g1', 'g2']);
  });

  it('stops at maxPages even when every page advertises a rel="next"', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        return pageResponse(
          [deliveryItem({ id: n, guid: `g${n}` })],
          `https://api.github.com/app/hook/deliveries?per_page=100&status=failure&cursor=P${n}`,
        );
      }),
    );

    const result = await listFailedWebhookDeliveries(makeEnv(), { maxPages: 2 });

    expect(n).toBe(2);
    expect(result).toHaveLength(2);
  });

  it('on a 4xx warns and returns what was collected so far', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nextUrl =
      'https://api.github.com/app/hook/deliveries?per_page=100&status=failure&cursor=PAGE2';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = urlOf(input);
        if (!url.includes('cursor=')) {
          return pageResponse([deliveryItem({ id: 1, guid: 'g1' })], nextUrl);
        }
        return new Response('Not Found', { status: 404, statusText: 'Not Found' });
      }),
    );

    const result = await listFailedWebhookDeliveries(makeEnv());

    expect(result.map((d) => d.id)).toEqual(['1']);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('retries a 5xx page then succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n === 1) {
          return new Response('boom', { status: 500 });
        }
        return pageResponse([deliveryItem({ id: 7, guid: 'g7', event: 'push', status_code: 502 })]);
      }),
    );

    const result = await listFailedWebhookDeliveries(makeEnv());

    expect(n).toBe(2);
    expect(result).toEqual([
      {
        id: '7',
        guid: 'g7',
        event: 'push',
        statusCode: 502,
        deliveredAt: '2026-07-01T00:00:00Z',
      },
    ]);
  });

  it('requests the maximum page size of failed deliveries', async () => {
    let seenUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        seenUrl = urlOf(input);
        return pageResponse([deliveryItem({ id: 1, guid: 'g1' })]);
      }),
    );

    await listFailedWebhookDeliveries(makeEnv());

    expect(seenUrl).toContain('per_page=100');
    expect(seenUrl).toContain('status=failure');
  });

  it('returns [] and makes no fetch when App secrets are absent', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const noId = await listFailedWebhookDeliveries(makeEnv({ GITHUB_APP_ID: undefined }));
    const noKey = await listFailedWebhookDeliveries(makeEnv({ GITHUB_APP_PRIVATE_KEY: undefined }));

    expect(noId).toEqual([]);
    expect(noKey).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Secrets PRESENT but the key is malformed: createAppJwt -> importPKCS8 throws.
  // Presence != validity — the never-throws contract must still hold.
  it('returns [] (never throws) when the app-JWT mint fails on a bad private key', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await listFailedWebhookDeliveries(
      makeEnv({ GITHUB_APP_PRIVATE_KEY: 'not-a-real-pem' }),
    );

    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('redeliverWebhookDelivery', () => {
  beforeEach(() => {
    skipRetryDelay();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('POSTs /app/hook/deliveries/<id>/attempts with the app-JWT block and returns true on 202', async () => {
    let seenUrl = '';
    let seenMethod = '';
    let seenAuth: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        seenUrl = urlOf(input);
        seenMethod = methodOf(input, init);
        seenAuth = headersOf(input, init).get('authorization');
        return new Response(null, { status: 202 });
      }),
    );

    const ok = await redeliverWebhookDelivery(makeEnv(), '98765');

    expect(ok).toBe(true);
    expect(seenMethod).toBe('POST');
    expect(seenUrl).toBe('https://api.github.com/app/hook/deliveries/98765/attempts');
    expect(seenAuth).toMatch(/^Bearer .+/);
  });

  it('returns false on a definitive 4xx (404 / 422)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const status of [404, 422]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('nope', { status })),
      );
      const ok = await redeliverWebhookDelivery(makeEnv(), '1');
      expect(ok).toBe(false);
    }
  });

  it('retries a 5xx then succeeds on the following 202', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n === 1) {
          return new Response('boom', { status: 500 });
        }
        return new Response(null, { status: 202 });
      }),
    );

    const ok = await redeliverWebhookDelivery(makeEnv(), '55');

    expect(ok).toBe(true);
    expect(n).toBe(2);
  });

  it('returns false and makes no fetch when App secrets are absent', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const noId = await redeliverWebhookDelivery(makeEnv({ GITHUB_APP_ID: undefined }), '1');
    const noKey = await redeliverWebhookDelivery(
      makeEnv({ GITHUB_APP_PRIVATE_KEY: undefined }),
      '1',
    );

    expect(noId).toBe(false);
    expect(noKey).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Secrets PRESENT but the key is malformed: createAppJwt -> importPKCS8 throws.
  // Presence != validity — the never-throws contract must still hold.
  it('returns false (never throws) when the app-JWT mint fails on a bad private key', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const ok = await redeliverWebhookDelivery(
      makeEnv({ GITHUB_APP_PRIVATE_KEY: 'not-a-real-pem' }),
      '98765',
    );

    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });
});
