import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const router = vi.hoisted(() => ({ routeInbound: vi.fn(), routeRelayed: vi.fn() }));
vi.mock('../../../proxy/src/email-router.ts', () => ({
  ...router,
  MAX_INBOUND_BYTES: 10 * 1024 * 1024,
  MAX_INBOUND_HEADERS: 1024,
}));

import { hmacVerifyState } from '../../../api/src/auth/hmac.ts';
import gateway from '../../src/index.ts';

const identityHeaders = {
  authorization: 'Bearer relay-secret',
  'x-void-email-account': 'account-1',
  'x-void-email-zone': 'zone-1',
  'x-void-email-ingress': 'gateway-1',
  'x-void-email-request-id': '12345678-1234-4234-8234-123456789abc',
  'x-void-email-from': 'sender@example.net',
  'x-void-email-to': 'support@example.com',
};
const route = {
  routeId: 'route-1',
  routeGeneration: 1,
  connectionId: 'connection-1',
  projectId: 'project-1',
  slug: 'support',
  deploymentId: 'deployment-1',
  workerName: 'worker-1',
  addressing: 'custom',
  domain: 'example.com',
};
const context = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const env = (
  apiFetch: (...args: Array<unknown>) => Promise<Response>,
  dispatchGet: (...args: Array<unknown>) => Fetcher = () => ({ fetch: vi.fn() }) as never,
) =>
  ({
    EMAIL_SIGNING_SECRET: 'platform-secret',
    API: { fetch: apiFetch },
    EMAIL_SHARED_ACCOUNT_ID: 'account-1',
    EMAIL_SHARED_ZONE_ID: 'zone-1',
    EMAIL_SHARED_INGRESS_NAME: 'gateway-1',
    DISPATCH: { get: dispatchGet },
  }) as never;

function uncooperativeStream(chunk: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      return new Promise<void>(() => {});
    },
  });
}

async function settlesSoon<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('operation did not settle after stream cancellation')),
        250,
      );
    }),
  ]);
}

function request(body: BodyInit, headers: Record<string, string> = {}) {
  return new Request('https://gateway.example/email/ingress', {
    method: 'POST',
    body,
    headers: {
      ...identityHeaders,
      'content-length': String(body instanceof Uint8Array ? body.byteLength : 0),
      ...headers,
    },
    ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
  } as RequestInit);
}

beforeEach(() => {
  router.routeInbound.mockReset();
  router.routeRelayed.mockReset();
  router.routeRelayed.mockResolvedValue({ reject: false });
});

describe('dedicated email gateway', () => {
  it('reports its deployment identity and protocol for installation health checks', async () => {
    const response = await gateway.fetch(
      new Request('https://gateway.example/health'),
      { PLATFORM_INSTALLATION_ID: 'installation', PLATFORM_VERSION: '1.2.3' } as never,
      context,
    );
    expect(await response.json()).toEqual({
      ok: true,
      installationId: 'installation',
      platformVersion: '1.2.3',
      emailProtocolVersion: 1,
    });
  });

  it('relays the public confirmation route through the fixed API service path only', async () => {
    const apiFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe('https://api/email/destinations/confirm?token=payload.signature');
      const forwarded = new Request(String(input), init);
      expect(forwarded.method).toBe('GET');
      expect([...forwarded.headers]).toEqual([]);
      return new Response('<!doctype html><p>Confirmed</p>', {
        headers: {
          'content-type': 'text/html; charset=UTF-8',
          'set-cookie': 'must-not-leave-the-api=1',
        },
      });
    });
    const response = await gateway.fetch(
      new Request('https://gateway.example/email/destinations/confirm?token=payload.signature', {
        headers: {
          authorization: 'Bearer untrusted-client-value',
          cookie: 'untrusted=1',
          'cf-access-jwt-assertion': 'untrusted-client-value',
        },
      }),
      env(apiFetch),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Confirmed');
    expect(response.headers.get('content-type')).toBe('text/html; charset=UTF-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  // Opening the link shows a Confirm button; consent is the button's POST.
  it('relays the Confirm button POST with the token and no request body', async () => {
    const apiFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe('https://api/email/destinations/confirm?token=payload.signature');
      expect(init?.body).toBeUndefined();
      const forwarded = new Request(String(input), init);
      expect(forwarded.method).toBe('POST');
      expect([...forwarded.headers]).toEqual([]);
      return new Response('<!doctype html><p>Confirmed</p>', {
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      });
    });
    const response = await gateway.fetch(
      new Request('https://gateway.example/email/destinations/confirm?token=payload.signature', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'untrusted=1',
        },
        body: 'token=other.signature',
      }),
      env(apiFetch),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Confirmed');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(apiFetch).toHaveBeenCalledTimes(1);

    const put = await gateway.fetch(
      new Request('https://gateway.example/email/destinations/confirm?token=payload.signature', {
        method: 'PUT',
      }),
      env(apiFetch),
      context,
    );
    expect(put.status).toBe(404);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', ''],
    ['wrong key', '?other=payload.signature'],
    ['extra key', '?token=payload.signature&next=https://attacker.example'],
    ['repeated token', '?token=one.signature&token=two.signature'],
    ['malformed token', '?token=not-a-signed-token'],
    ['oversized token', `?token=${'a'.repeat(4097)}.signature`],
  ])('rejects a %s confirmation query', async (_label, query) => {
    const apiFetch = vi.fn();
    const response = await gateway.fetch(
      new Request(`https://gateway.example/email/destinations/confirm${query}`),
      env(apiFetch),
      context,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each(['staging', 'sandbox-drain'])('gates confirmation traffic while %s', async (state) => {
    const apiFetch = vi.fn();
    const response = await gateway.fetch(
      new Request('https://gateway.example/email/destinations/confirm?token=payload.signature'),
      { ...env(apiFetch), PLATFORM_TRAFFIC_STATE: state } as never,
      context,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('preserves the API capability response for an installation without email', async () => {
    const response = await gateway.fetch(
      new Request('https://gateway.example/email/destinations/confirm?token=payload.signature'),
      env(async () =>
        Response.json(
          { error: 'platform capability unavailable', capability: 'email' },
          { status: 501 },
        ),
      ),
      context,
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ capability: 'email' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('bounds the confirmation service request and response', async () => {
    const oversized = await gateway.fetch(
      new Request('https://gateway.example/email/destinations/confirm?token=payload.signature'),
      env(
        async () =>
          new Response('oversized', { headers: { 'content-length': String(32 * 1024 + 1) } }),
      ),
      context,
    );
    expect(oversized.status).toBe(503);

    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const pending = gateway.fetch(
        new Request('https://gateway.example/email/destinations/confirm?token=payload.signature'),
        env((_input, init) => {
          signal = (init as RequestInit | undefined)?.signal ?? undefined;
          markStarted();
          return new Promise<Response>(() => {});
        }),
        context,
      );
      await started;
      await vi.advanceTimersByTimeAsync(5_001);
      const timedOut = await pending;
      expect(timedOut.status).toBe(503);
      expect(timedOut.headers.get('cache-control')).toBe('no-store');
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a service response that arrives after the confirmation timeout', async () => {
    vi.useFakeTimers();
    try {
      let resolveApi!: (response: Response) => void;
      let signal: AbortSignal | undefined;
      const pending = gateway.fetch(
        new Request('https://gateway.example/email/destinations/confirm?token=payload.signature'),
        env((_input, init) => {
          signal = (init as RequestInit | undefined)?.signal ?? undefined;
          return new Promise<Response>((resolve) => {
            resolveApi = resolve;
          });
        }),
        context,
      );
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await pending).status).toBe(503);
      expect(signal?.aborted).toBe(true);

      let cancelled = false;
      resolveApi(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('late'));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  function receiptApi() {
    const receipts = new Map<string, { digest: string; reject?: boolean }>();
    return vi.fn(async (url: unknown, init?: unknown) => {
      if (String(url).endsWith('/resolve-ingress')) {
        return Response.json(route);
      }
      const request = new Request(String(url), init as RequestInit);
      const raw = await request.text();
      expect(
        await hmacVerifyState(raw, request.headers.get('x-void-internal') ?? '', 'platform-secret'),
      ).toBe(true);
      const input = JSON.parse(raw);
      const existing = receipts.get(input.receiptId);
      if (String(url).endsWith('/receipts/claim')) {
        expect(input.route).toEqual({
          routeId: route.routeId,
          routeGeneration: route.routeGeneration,
          connectionId: route.connectionId,
          addressing: route.addressing,
          domain: route.domain,
          projectSlug: route.slug,
        });
        if (!existing) {
          receipts.set(input.receiptId, { digest: input.payloadDigest });
          return Response.json({ state: 'claimed' });
        }
        if (existing.digest !== input.payloadDigest) {
          return Response.json({ error: 'content conflict' }, { status: 409 });
        }
        return Response.json(
          existing.reject === undefined
            ? { state: 'in_progress' }
            : { state: 'completed', reject: existing.reject },
        );
      }
      expect(String(url)).toContain('/receipts/complete');
      existing!.reject = input.reject;
      return Response.json({ ok: true });
    });
  }

  it('deduplicates completed HTTP attempts and binds the invocation to sender, recipient and MIME', async () => {
    const environment = env(receiptApi());
    const raw = new TextEncoder().encode('From: sender@example.net\r\n\r\nbody');
    const first = await gateway.fetch(request(raw), environment, context);
    expect(first.status).toBe(204);
    expect(first.headers.get('x-void-email-receipt')).toMatch(/^[a-f0-9]{64}$/);
    expect((await gateway.fetch(request(raw), environment, context)).status).toBe(204);
    for (const headers of [
      { 'x-void-email-from': 'other@example.net' },
      { 'x-void-email-to': 'other@example.com' },
    ]) {
      expect((await gateway.fetch(request(raw, headers), environment, context)).status).toBe(409);
    }
    expect(
      (
        await gateway.fetch(
          request(new TextEncoder().encode('From: sender@example.net\r\n\r\nchanged')),
          environment,
          context,
        )
      ).status,
    ).toBe(409);
    expect(router.routeRelayed).toHaveBeenCalledTimes(1);
  });

  it('does not rerun an in-progress invocation on a concurrent duplicate', async () => {
    const environment = env(receiptApi());
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    router.routeRelayed.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { reject: false };
    });
    const raw = new TextEncoder().encode('From: sender@example.net\r\n\r\nbody');
    const first = gateway.fetch(request(raw), environment, context);
    await entered;
    expect((await gateway.fetch(request(raw), environment, context)).status).toBe(503);
    finish();
    expect((await first).status).toBe(204);
    expect(router.routeRelayed).toHaveBeenCalledTimes(1);
  });

  it('can retry the same request ID after tenant stub resolution fails before claiming', async () => {
    const apiFetch = receiptApi();
    const resolvedStub = { fetch: vi.fn() };
    const dispatchGet = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('dispatch unavailable');
      })
      .mockReturnValue(resolvedStub);
    const environment = env(apiFetch, dispatchGet);
    const raw = new TextEncoder().encode('From: sender@example.net\r\n\r\nbody');

    expect((await gateway.fetch(request(raw), environment, context)).status).toBe(503);
    expect((await gateway.fetch(request(raw), environment, context)).status).toBe(204);

    expect(router.routeRelayed).toHaveBeenCalledTimes(1);
    expect(router.routeRelayed.mock.calls[0]?.[2]).toMatchObject({ stub: resolvedStub });
    expect(
      apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/receipts/claim')),
    ).toHaveLength(1);
  });

  it('preserves transient routing failures for both HTTP and native ingress', async () => {
    const environment = env(async () => new Response(null, { status: 503 }));
    expect((await gateway.fetch(request(new Uint8Array()), environment, context)).status).toBe(503);
    const message = {
      from: 'sender@example.net',
      to: 'support@example.com',
      setReject: vi.fn(),
    } as unknown as ForwardableEmailMessage;
    await expect(gateway.email(message, environment, context)).rejects.toThrow(
      'temporarily unavailable',
    );
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it.each(['staging', 'sandbox-drain'])(
    'does not dispatch native email during %s',
    async (state) => {
      const apiFetch = vi.fn();
      const environment = {
        ...env(apiFetch),
        PLATFORM_TRAFFIC_STATE: state,
      } as never;
      const message = {
        from: 'sender@example.net',
        to: 'support@example.com',
        setReject: vi.fn(),
      } as unknown as ForwardableEmailMessage;

      await expect(gateway.email(message, environment, context)).rejects.toThrow(
        'temporarily unavailable',
      );
      expect(message.setReject).not.toHaveBeenCalled();
      expect(apiFetch).not.toHaveBeenCalled();
      expect(router.routeInbound).not.toHaveBeenCalled();
    },
  );

  it.each([
    () => new Response(null),
    () => new Response('{'),
    () => Response.json({ projectId: 'project-1' }),
    () => new Response('x'.repeat(4097)),
    () => new Response('{}', { headers: { 'content-length': '4097' } }),
  ])(
    'does not turn a malformed authority response into a permanent rejection',
    async (response) => {
      const environment = env(async () => response());
      expect((await gateway.fetch(request(new Uint8Array()), environment, context)).status).toBe(
        503,
      );
      const message = {
        from: 'sender@example.net',
        to: 'support@example.com',
        setReject: vi.fn(),
      } as unknown as ForwardableEmailMessage;
      await expect(gateway.email(message, environment, context)).rejects.toThrow(
        'temporarily unavailable',
      );
      expect(message.setReject).not.toHaveBeenCalled();
      expect(router.routeInbound).not.toHaveBeenCalled();
      expect(router.routeRelayed).not.toHaveBeenCalled();
    },
  );

  it('does not await cancellation of an oversized authority response', async () => {
    const environment = env(async () => new Response(uncooperativeStream(new Uint8Array(4097))));
    const response = await settlesSoon(
      gateway.fetch(request(new Uint8Array()), environment, context),
    );
    expect(response.status).toBe(503);
  });

  it('bounds an authority fetch that ignores abort by the same response deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = gateway.fetch(
        request(new Uint8Array()),
        env(() => new Promise<Response>(() => {})),
        context,
      );
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await pending).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it('authenticates ingress before consuming MIME bytes', async () => {
    const pulled = vi.fn(() => {
      throw new Error('body must stay unread');
    });
    const body = new ReadableStream<Uint8Array>({ pull: pulled }, { highWaterMark: 0 });
    const response = await gateway.fetch(
      request(body, { 'content-length': '5' }),
      env(async () => new Response(null, { status: 403 })),
      context,
    );
    expect(response.status).toBe(403);
    expect(pulled).not.toHaveBeenCalled();
  });

  it('rejects oversize MIME before route resolution or body reading', async () => {
    const apiFetch = vi.fn();
    const response = await gateway.fetch(
      request(new Uint8Array(), { 'content-length': String(10 * 1024 * 1024 + 1) }),
      env(apiFetch),
      context,
    );
    expect(response.status).toBe(413);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('does not await cancellation after streamed MIME exceeds its declared length', async () => {
    const body = uncooperativeStream(new Uint8Array(2));
    const response = await settlesSoon(
      gateway.fetch(
        request(body, { 'content-length': '1' }),
        env(async () => Response.json(route)),
        context,
      ),
    );
    expect(response.status).toBe(502);
  });

  it('requires complete ingress identity', async () => {
    const apiFetch = vi.fn();
    const response = await gateway.fetch(
      request(new Uint8Array(), { 'x-void-email-zone': '' }),
      env(apiFetch),
      context,
    );
    expect(response.status).toBe(400);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('counts repeated physical MIME headers before routing to a tenant', async () => {
    const apiFetch = vi.fn(async () => Response.json(route));
    const raw = new TextEncoder().encode(`${'X-A: value\r\n'.repeat(1025)}\r\nbody`);
    const response = await gateway.fetch(request(raw), env(apiFetch), context);
    expect(response.status).toBe(413);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(router.routeRelayed).not.toHaveBeenCalled();
  });

  it('permanently refuses malformed MIME headers before claiming or routing', async () => {
    const apiFetch = vi.fn(async () => Response.json(route));
    const raw = new TextEncoder().encode('not-a-header\r\n\r\nbody');
    const response = await gateway.fetch(request(raw), env(apiFetch), context);

    expect(response.status).toBe(400);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(router.routeRelayed).not.toHaveBeenCalled();
  });

  it('limits concurrent deliveries per isolate', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const environment = env(async () => pending);
    const first = gateway.fetch(request(new Uint8Array()), environment, context);
    const second = gateway.fetch(request(new Uint8Array()), environment, context);
    const third = await gateway.fetch(request(new Uint8Array()), environment, context);
    expect(third.status).toBe(503);
    finish(new Response(null, { status: 403 }));
    expect((await first).status).toBe(403);
    expect((await second).status).toBe(403);
  });

  it('passes an authenticated custom domain on the platform zone to the native email router', async () => {
    const rejects: Array<string> = [];
    const message = {
      from: 'sender@example.net',
      to: 'support@example.com',
      setReject: (reason: string) => rejects.push(reason),
    } as ForwardableEmailMessage;
    await gateway.email(
      message,
      env(async (url, init) => {
        expect(url).toBe('https://api/internal/email/resolve-ingress');
        const request = new Request(String(url), init as RequestInit);
        const identity = (await request.json()) as Record<string, unknown>;
        expect(identity).toMatchObject({
          accountId: 'account-1',
          zoneId: 'zone-1',
          ingressName: 'gateway-1',
          native: true,
        });
        expect(
          await hmacVerifyState(
            'email-ingress-v1\naccount-1\nzone-1\ngateway-1\nsupport@example.com',
            request.headers.get('x-void-internal') ?? '',
            'platform-secret',
          ),
        ).toBe(true);
        return Response.json(route);
      }),
      context,
    );
    expect(rejects).toEqual([]);
    expect(router.routeInbound).toHaveBeenCalledWith(message, expect.anything(), context, route);
  });

  it('passes a shared route reached through the project email alias to the native router', async () => {
    const aliasRoute = {
      ...route,
      slug: 'proj',
      mailbox: 'alias',
      alias: 'alias',
      addressing: 'shared',
      domain: 'mail.example.com',
    };
    const message = {
      from: 'sender@example.net',
      to: 'alias+orders@mail.example.com',
      setReject: vi.fn(),
    } as unknown as ForwardableEmailMessage;
    await gateway.email(
      message,
      env(async () => Response.json(aliasRoute)),
      context,
    );
    expect(message.setReject).not.toHaveBeenCalled();
    expect(router.routeInbound).toHaveBeenCalledWith(
      message,
      expect.anything(),
      context,
      aliasRoute,
    );
  });

  it.each([
    ['mailbox', 42],
    ['mailbox', null],
    ['mailbox', { name: 'alias' }],
    ['alias', 42],
    ['alias', null],
  ])(
    'treats a route with a non-string %s (%j) as a malformed authority response',
    async (field, value) => {
      const environment = env(async () =>
        Response.json({ ...route, addressing: 'shared', [field]: value }),
      );
      expect((await gateway.fetch(request(new Uint8Array()), environment, context)).status).toBe(
        503,
      );
      const message = {
        from: 'sender@example.net',
        to: 'support@example.com',
        setReject: vi.fn(),
      } as unknown as ForwardableEmailMessage;
      await expect(gateway.email(message, environment, context)).rejects.toThrow(
        'temporarily unavailable',
      );
      expect(message.setReject).not.toHaveBeenCalled();
      expect(router.routeInbound).not.toHaveBeenCalled();
      expect(router.routeRelayed).not.toHaveBeenCalled();
    },
  );

  it('probes exact staged ingress identity through the authoritative API', async () => {
    const body = JSON.stringify({
      accountId: 'account-1',
      zoneId: 'zone-1',
      ingressName: 'gateway-1',
    });
    const probe = new Request('https://gateway.example/email/probe', {
      method: 'POST',
      body,
      headers: { authorization: 'Bearer staged-secret', 'content-type': 'application/json' },
    });
    const response = await gateway.fetch(
      probe,
      env(async (url, init) => {
        expect(url).toBe('https://api/internal/email/probe-ingress');
        const request = new Request(String(url), init as RequestInit);
        expect(
          await hmacVerifyState(
            'email-probe-v1\naccount-1\nzone-1\ngateway-1',
            request.headers.get('x-void-internal') ?? '',
            'platform-secret',
          ),
        ).toBe(true);
        expect(await request.json()).toEqual({
          accountId: 'account-1',
          zoneId: 'zone-1',
          ingressName: 'gateway-1',
          secret: 'staged-secret',
        });
        return new Response(null, { status: 204 });
      }),
      context,
    );
    expect(response.status).toBe(204);
  });

  it('bounds a probe API call that ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const body = JSON.stringify({
        accountId: 'account-1',
        zoneId: 'zone-1',
        ingressName: 'gateway-1',
      });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const response = gateway.fetch(
        new Request('https://gateway.example/email/probe', {
          method: 'POST',
          body,
          headers: { authorization: 'Bearer staged-secret' },
        }),
        env(() => {
          markStarted();
          return new Promise<Response>(() => {});
        }),
        context,
      );
      await started;
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await response).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not await cancellation of an oversized probe body', async () => {
    const probe = new Request('https://gateway.example/email/probe', {
      method: 'POST',
      body: uncooperativeStream(new Uint8Array(1025)),
      headers: { authorization: 'Bearer staged-secret' },
      duplex: 'half',
    } as RequestInit);
    const response = await settlesSoon(gateway.fetch(probe, env(vi.fn()), context));
    expect(response.status).toBe(400);
  });
});
