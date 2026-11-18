/** Custom-domain sends use SQL admission and a customer-account send_raw credential. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// `cloudflare:email` is a workerd built-in with no npm shim — same mock as
// email.test.ts, hoisted above the worker import.
vi.mock('cloudflare:email', () => ({
  EmailMessage: class MockEmailMessage {
    constructor(
      public readonly from: string,
      public readonly to: string,
      public readonly raw: unknown,
    ) {}
  },
}));

const worker = (await import('../../src/index.ts')).default;
const { requestSendRaw } = await import('../../src/email.ts');
const { clearProxyTokenStateCache } = await import('../../src/proxy-token.ts');

const JWT_SECRET = 'test-secret-key';
const EMAIL_SIGNING_SECRET = 'test-email-signing-key-independent';
const PROD_DOMAIN = 'mail.void.cloud';
const CUSTOM_DOMAIN = 'acme.com';
const CUSTOM_FROM = `support@${CUSTOM_DOMAIN}`;
/** Dummy fixture value for the leased credential — not a real token. */
const LEASED = 'leased-credential-fixture-value';

// --- HMAC helper (mirrors the worker's project token signing) ---

function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signHmac(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64urlEncode(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data))),
  );
}

// --- Mocks ---

function createMockEnv() {
  const actions = new Map<
    string,
    {
      operationId: string;
      digest: string;
      recipients: Array<{
        recipient: string;
        state: string;
        errorCode: string | null;
        providerReference: string | null;
      }>;
    }
  >();
  const apiFetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/domain-credential')) {
      return Response.json({ kind: 'api_token', token: LEASED, accountId: 'acct_customer' });
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (path.endsWith('/admit')) {
      const key = body.key as string;
      const previous = actions.get(key);
      if (previous && previous.digest !== body.digest) {
        return Response.json({ code: 'CONFLICT' }, { status: 409 });
      }
      if (previous) {
        return Response.json({
          operationId: previous.operationId,
          replay: true,
          recipients: previous.recipients,
          accountId: 'acct_customer',
        });
      }
      const entry = {
        operationId: `act_${actions.size + 1}`,
        digest: body.digest as string,
        recipients: (body.recipients as Array<string>).map((recipient) => ({
          recipient,
          state: 'reserved',
          errorCode: null,
          providerReference: null,
        })),
      };
      actions.set(key, entry);
      return Response.json({
        operationId: entry.operationId,
        replay: false,
        recipients: entry.recipients,
        accountId: 'acct_customer',
      });
    }
    const operationId = path.split('/').at(-2)!;
    const entry = [...actions.values()].find((action) => action.operationId === operationId)!;
    if (path.endsWith('/start')) {
      for (const recipient of body.recipients as Array<string>) {
        entry.recipients.find((row) => row.recipient === recipient)!.state = 'attempt_started';
      }
    }
    if (path.endsWith('/finish')) {
      for (const recipient of body.recipients as Array<string>) {
        const row = entry.recipients.find((item) => item.recipient === recipient)!;
        row.state = body.state as string;
        row.errorCode = (body.errorCode as string) ?? null;
        row.providerReference = (body.providerReference as string) ?? null;
      }
    }
    return Response.json({ recipients: entry.recipients });
  });
  const sendEmail = vi.fn(async () => ({ messageId: 'msg_platform' }));
  const env = {
    AI: {},
    JWT_SECRET,
    EMAIL_SIGNING_SECRET,
    ROUTING: { get: vi.fn(async () => null) },
    CF_ACCOUNT_ID: 'acct',
    CF_API_TOKEN: 'cf-token',
    API: { fetch: apiFetch },
    DISPATCH: { get: vi.fn(() => ({ email: vi.fn(async () => []) })) },
    SEND_EMAIL: { send: sendEmail },
    EMAIL_SENDER_DOMAIN: PROD_DOMAIN,
  };
  return { env, apiFetch, sendEmail, actions };
}

function base64Of(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function mimeBase64(body = `From: ${CUSTOM_FROM}\r\nSubject: hi\r\n\r\nhello\r\n`): string {
  return base64Of(new TextEncoder().encode(body));
}

async function postSend(
  env: Record<string, unknown>,
  body: Record<string, unknown>,
): Promise<Response> {
  return (worker.fetch as (req: Request, env: unknown) => Promise<Response>)(
    new Request('https://email-proxy/email/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function sendBody(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'proj_000000000001',
    aiToken: await signHmac('proj_000000000001', JWT_SECRET),
    from: CUSTOM_FROM,
    recipients: ['dev@example.com'],
    mimeBase64: mimeBase64(),
    requestId: 'req_1',
    ...overrides,
  };
}

/** A stubbed `api.cloudflare.com` that records calls; 200 success by default. */
function stubCloudflare(handler?: (call: { url: string; init: RequestInit }) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (handler) {
        return handler({ url, init });
      }
      // The real send_raw result: snake_case `message_id`, and per-recipient
      // lists (`delivered` echoes the accepted recipients here).
      const recipients =
        (JSON.parse(init.body as string) as { recipients?: Array<string> }).recipients ?? [];
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            message_id: 'cf_msg_1',
            delivered: recipients,
            permanent_bounces: [],
            queued: [],
            suppressed_recipients: [],
          },
        }),
        { status: 200 },
      );
    }),
  );
  return calls;
}

beforeEach(() => {
  clearProxyTokenStateCache();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('POST /email/send — custom sender domain', () => {
  it('does not call send_raw when serialization exhausts the request deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);
    const stringify = JSON.stringify;
    const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      if (typeof value === 'object' && value !== null && 'mime_message' in value) {
        vi.setSystemTime(5_001);
      }
      return stringify(value);
    });

    await expect(
      requestSendRaw(
        {
          accountId: 'acct_customer',
          bearer: LEASED,
          from: CUSTOM_FROM,
          recipients: ['dev@example.com'],
          mimeMessage: 'mime',
        },
        5_000,
      ),
    ).rejects.toThrow('email sending request timed out');
    stringifySpy.mockRestore();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('leases a credential and delivers through the customer account via send_raw', async () => {
    const { env, apiFetch, sendEmail } = createMockEnv();
    const calls = stubCloudflare();
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      ids: [{ recipient: 'dev@example.com', messageId: 'cf_msg_1', state: 'provider_accepted' }],
      operationId: 'act_1',
    });

    // The lease: one POST to the api's internal endpoint, HMAC-authed.
    expect(
      apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/domain-credential')),
    ).toHaveLength(1);
    const [leaseUrl, leaseInit] = apiFetch.mock.calls.find(([url]) =>
      String(url).endsWith('/domain-credential'),
    )! as [string, RequestInit];
    expect(leaseUrl).toBe('https://api/internal/email/domain-credential');
    expect(leaseInit.method).toBe('POST');
    expect(JSON.parse(leaseInit.body as string)).toEqual({
      domain: CUSTOM_DOMAIN,
      projectId: 'proj_000000000001',
    });
    const leaseHeaders = new Headers(leaseInit.headers);
    expect(leaseHeaders.get('x-void-internal')).toBe(
      await signHmac(`email-lease-v1\nproj_000000000001\n${CUSTOM_DOMAIN}`, EMAIL_SIGNING_SECRET),
    );

    // The delivery: one POST to the CUSTOMER account's send_raw, leased
    // credential as Bearer, envelope + MIME in the JSON body.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct_customer/email/sending/send_raw',
    );
    const sendHeaders = new Headers(calls[0]?.init.headers);
    expect(sendHeaders.get('authorization')).toBe(`Bearer ${LEASED}`);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      from: CUSTOM_FROM,
      recipients: ['dev@example.com'],
      mime_message: `From: ${CUSTOM_FROM}\r\nSubject: hi\r\n\r\nhello\r\n`,
    });

    // The platform binding is never touched on this path.
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('cancels the whole unstarted batch when the start checkpoint fails', async () => {
    const { env, apiFetch, actions } = createMockEnv();
    const normalFetch = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url, init) =>
      String(url).endsWith('/start') ? new Response(null, { status: 503 }) : normalFetch(url, init),
    );
    const providerCalls = stubCloudflare();

    const response = await postSend(
      env,
      await sendBody({ recipients: ['one@example.com', 'two@example.com'] }),
    );
    const body = (await response.json()) as {
      deliveries: Array<{ state: string; error: { code: string } }>;
    };
    expect(body.deliveries).toHaveLength(2);
    expect(body.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'cancelled',
          error: expect.objectContaining({ code: 'UPSTREAM_ERROR' }),
        }),
        expect.objectContaining({
          state: 'cancelled',
          error: expect.objectContaining({ code: 'UPSTREAM_ERROR' }),
        }),
      ]),
    );
    expect([...actions.values()][0]?.recipients.map((row) => row.state)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    expect(providerCalls).toEqual([]);
  });

  it.each(['fetch', 'body'] as const)(
    'times out a stalled credential lease %s and cancels before provider submission',
    async (stall) => {
      vi.useFakeTimers();
      const { env, apiFetch, actions } = createMockEnv();
      const normalFetch = apiFetch.getMockImplementation()!;
      let markLeaseStarted!: () => void;
      const leaseStarted = new Promise<void>((resolve) => {
        markLeaseStarted = resolve;
      });
      apiFetch.mockImplementation(async (url, init) => {
        if (!String(url).endsWith('/domain-credential')) {
          return normalFetch(url, init);
        }
        markLeaseStarted();
        if (stall === 'fetch') {
          return new Promise<Response>(() => {});
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    kind: 'api_token',
                    token: LEASED,
                    accountId: 'acct_customer',
                  }),
                ),
              );
            },
          }),
        );
      });
      const providerCalls = stubCloudflare();

      const pending = postSend(env, await sendBody());
      await leaseStarted;
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      const response = await pending;

      expect(response.status).toBe(502);
      expect([...actions.values()][0]?.recipients[0]?.state).toBe('cancelled');
      const finish = apiFetch.mock.calls.find(([url]) => String(url).endsWith('/finish'));
      expect(finish).toBeDefined();
      expect(JSON.parse(String((finish![1] as RequestInit).body))).toMatchObject({
        state: 'cancelled',
      });
      expect(providerCalls).toEqual([]);
    },
  );

  it('rejects an oversized credential lease body before provider submission', async () => {
    const { env, apiFetch, actions } = createMockEnv();
    const normalFetch = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url, init) =>
      String(url).endsWith('/domain-credential')
        ? Response.json({
            kind: 'api_token',
            token: 'x'.repeat(5 * 1024),
            accountId: 'acct_customer',
          })
        : normalFetch(url, init),
    );
    const providerCalls = stubCloudflare();

    expect((await postSend(env, await sendBody())).status).toBe(502);
    expect([...actions.values()][0]?.recipients[0]?.state).toBe('cancelled');
    expect(providerCalls).toEqual([]);
  });

  it('does not require the platform send binding for a custom-domain send', async () => {
    const { env } = createMockEnv();
    delete (env as { SEND_EMAIL?: unknown }).SEND_EMAIL;
    stubCloudflare();
    const response = await postSend(env, await sendBody());
    expect(await response.json()).toMatchObject({
      ok: true,
      ids: [{ recipient: 'dev@example.com', messageId: 'cf_msg_1', state: 'provider_accepted' }],
    });
  });

  it.each([
    { response: new Response(null, { status: 500 }), state: 'outcome_unknown' },
    { response: new Response('{', { status: 200 }), state: 'outcome_unknown' },
    { response: Response.json({ success: true, result: {} }), state: 'outcome_unknown' },
    { response: Response.json({ success: false }), state: 'failed' },
  ])(
    'records a send_raw response as $state when provider submission may be ambiguous',
    async ({ response, state }) => {
      const { env, apiFetch } = createMockEnv();
      const calls = stubCloudflare(() => response);
      const result = await postSend(env, await sendBody());
      const body = await result.json();
      expect(body).toMatchObject({
        ok: false,
        operationId: 'act_1',
        deliveries: [{ recipient: 'dev@example.com', ok: false, state }],
      });
      expect(calls).toHaveLength(1);
      const finishCall = apiFetch.mock.calls.find(([url]) => String(url).endsWith('/finish'))!;
      expect(JSON.parse(String(finishCall[1].body)).state).toBe(state);
    },
  );

  it.each([
    {
      name: 'omitted',
      result: {
        message_id: 'cf_msg_missing',
        delivered: [],
        permanent_bounces: [],
        queued: [],
        suppressed_recipients: [],
      },
    },
    {
      name: 'overlapping',
      result: {
        message_id: 'cf_msg_overlap',
        delivered: ['dev@example.com'],
        permanent_bounces: ['dev@example.com'],
        queued: [],
        suppressed_recipients: [],
      },
    },
  ])('keeps a recipient with an $name provider classification unresolved', async ({ result }) => {
    const { env, apiFetch } = createMockEnv();
    stubCloudflare(() => Response.json({ success: true, result }));
    const response = await postSend(env, await sendBody());
    expect(await response.json()).toMatchObject({
      ok: false,
      operationId: 'act_1',
      deliveries: [
        {
          recipient: 'dev@example.com',
          ok: false,
          state: 'outcome_unknown',
          error: { code: 'OUTCOME_UNKNOWN' },
        },
      ],
    });
    const finishCall = apiFetch.mock.calls.find(([url]) => String(url).endsWith('/finish'))!;
    expect(JSON.parse(String(finishCall[1].body))).toMatchObject({
      recipients: ['dev@example.com'],
      state: 'outcome_unknown',
    });
  });

  it('accepts a recipient explicitly classified as queued', async () => {
    const { env } = createMockEnv();
    stubCloudflare(() =>
      Response.json({
        success: true,
        result: {
          message_id: 'cf_msg_q',
          delivered: [],
          permanent_bounces: [],
          queued: ['dev@example.com'],
          suppressed_recipients: [],
        },
      }),
    );
    expect(await (await postSend(env, await sendBody())).json()).toEqual({
      ok: true,
      ids: [{ recipient: 'dev@example.com', messageId: 'cf_msg_q', state: 'provider_accepted' }],
      operationId: 'act_1',
    });
  });

  it('re-leases the domain for each send', async () => {
    const { env, apiFetch } = createMockEnv();
    stubCloudflare();
    await postSend(env, await sendBody());
    await postSend(env, await sendBody({ requestId: 'req_2' }));
    expect(
      apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/domain-credential')),
    ).toHaveLength(2);
  });

  it('replays a completed operation without consulting a later revoked credential', async () => {
    const { env, apiFetch } = createMockEnv();
    const calls = stubCloudflare();
    const body = await sendBody({ idempotencyKey: 'same-operation' });
    expect(await (await postSend(env, body)).json()).toHaveProperty('ok', true);
    const leaseCalls = apiFetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/domain-credential'),
    ).length;
    const replay = await postSend(env, body);
    expect(await replay.json()).toHaveProperty('ok', true);
    expect(calls).toHaveLength(1);
    expect(
      apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/domain-credential')),
    ).toHaveLength(leaseCalls);
  });

  it('re-leases after a definitive 401 from send_raw', async () => {
    const { env, apiFetch } = createMockEnv();
    let sendCount = 0;
    stubCloudflare(() => {
      sendCount += 1;
      if (sendCount === 1) {
        return new Response('nope', { status: 401 });
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            message_id: 'cf_msg_2',
            delivered: ['dev@example.com'],
            permanent_bounces: [],
            queued: [],
            suppressed_recipients: [],
          },
        }),
        {
          status: 200,
        },
      );
    });
    const first = await postSend(env, await sendBody());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: false,
      operationId: 'act_1',
      deliveries: [
        {
          recipient: 'dev@example.com',
          ok: false,
          state: 'failed',
          error: { code: 'UPSTREAM_ERROR', message: 'email sending API returned 401' },
        },
      ],
    });
    // A distinct request leases again and can succeed after the refusal.
    const second = await postSend(env, await sendBody({ requestId: 'req_2' }));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ok: true,
      ids: [{ recipient: 'dev@example.com', messageId: 'cf_msg_2', state: 'provider_accepted' }],
      operationId: 'act_2',
    });
    expect(
      apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/domain-credential')),
    ).toHaveLength(2);
  });

  it('maps a 429 from send_raw to QUOTA_EXCEEDED', async () => {
    const { env } = createMockEnv();
    stubCloudflare(() => new Response('slow down', { status: 429 }));
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('ok', false);
    expect(body).toHaveProperty('deliveries.0.error.code', 'QUOTA_EXCEEDED');
  });

  it('marks a network failure on send_raw as an unknown outcome', async () => {
    const { env } = createMockEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hangup');
      }),
    );
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('ok', false);
    expect(body).toHaveProperty('deliveries.0.error', {
      code: 'OUTCOME_UNKNOWN',
      message: 'provider outcome unknown; inspect email logs before retrying',
    });
  });

  it.each(['fetch', 'body'] as const)(
    'shares the request deadline with a send_raw %s and records an unknown outcome',
    async (stall) => {
      vi.useFakeTimers();
      const { env, apiFetch } = createMockEnv();
      const normalFetch = apiFetch.getMockImplementation()!;
      let markAdmissionStarted!: () => void;
      const admissionStarted = new Promise<void>((resolve) => {
        markAdmissionStarted = resolve;
      });
      let markStartStarted!: () => void;
      const startStarted = new Promise<void>((resolve) => {
        markStartStarted = resolve;
      });
      apiFetch.mockImplementation(async (url, init) => {
        if (String(url).endsWith('/admit')) {
          markAdmissionStarted();
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        } else if (String(url).endsWith('/start')) {
          markStartStarted();
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        }
        return normalFetch(url, init);
      });
      let markProviderStarted!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        markProviderStarted = resolve;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          markProviderStarted();
          if (stall === 'fetch') {
            return new Promise<Response>(() => {});
          }
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"success":true,"result":'));
                },
              }),
            ),
          );
        }),
      );

      const pending = postSend(env, await sendBody());
      await admissionStarted;
      await vi.advanceTimersByTimeAsync(10_000);
      await startStarted;
      await vi.advanceTimersByTimeAsync(10_000);
      await providerStarted;
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(25_001);
      const body = await (await pending).json();

      expect(body).toMatchObject({
        ok: false,
        deliveries: [{ state: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' } }],
      });
      const finishCall = apiFetch.mock.calls.find(([url]) => String(url).endsWith('/finish'))!;
      expect(JSON.parse(String(finishCall[1].body)).state).toBe('outcome_unknown');
    },
  );

  it('bounds an oversized send_raw response and records an unknown outcome', async () => {
    const { env, apiFetch } = createMockEnv();
    const cancel = vi.fn();
    stubCloudflare(
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              cancel,
              pull() {
                throw new Error('oversized body must not be read');
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { 'content-length': String(64 * 1024 + 1) } },
        ),
    );

    const body = await (await postSend(env, await sendBody())).json();
    expect(body).toMatchObject({
      ok: false,
      deliveries: [{ state: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' } }],
    });
    expect(
      JSON.parse(
        String(apiFetch.mock.calls.find(([url]) => String(url).endsWith('/finish'))?.[1].body),
      ).state,
    ).toBe('outcome_unknown');
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('answers 502 when the lease fails, without burning quota or calling send_raw', async () => {
    const { env, apiFetch } = createMockEnv();
    const normalFetch = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (url, init) =>
      String(url).endsWith('/domain-credential')
        ? new Response('denied', { status: 403 })
        : normalFetch(url, init),
    );
    const cfFetch = vi.fn();
    vi.stubGlobal('fetch', cfFetch);
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(502);
    expect(await res.json()).toHaveProperty('error', {
      code: 'UPSTREAM_ERROR',
      message: 'could not lease the domain credential',
    });
    expect(cfFetch).not.toHaveBeenCalled();
  });

  it('pins the MIME From to the envelope sender on the custom domain too', async () => {
    const { env, apiFetch } = createMockEnv();
    const cfFetch = vi.fn();
    vi.stubGlobal('fetch', cfFetch);
    const res = await postSend(
      env,
      await sendBody({ mimeBase64: mimeBase64(`From: other@${CUSTOM_DOMAIN}\r\n\r\nx\r\n`) }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty('error.code', 'INVALID_FROM');
    expect(body).toHaveProperty(
      'error.message',
      expect.stringContaining('mime From must be the envelope sender'),
    );
    expect(apiFetch).not.toHaveBeenCalled();
    expect(cfFetch).not.toHaveBeenCalled();
  });

  it('refuses MIME that is not valid UTF-8 before leasing or burning quota', async () => {
    const { env, apiFetch } = createMockEnv();
    const cfFetch = vi.fn();
    vi.stubGlobal('fetch', cfFetch);
    const prefix = new TextEncoder().encode(`From: ${CUSTOM_FROM}\r\n\r\n`);
    const bytes = new Uint8Array(prefix.length + 2);
    bytes.set(prefix);
    bytes.set([0xff, 0xfe], prefix.length);
    const res = await postSend(env, await sendBody({ mimeBase64: base64Of(bytes) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error', {
      code: 'MIME_ERROR',
      message: 'mime must be valid UTF-8',
    });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(cfFetch).not.toHaveBeenCalled();
  });

  it('reports a permanently bounced recipient as failed, not sent', async () => {
    const { env } = createMockEnv();
    stubCloudflare(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              message_id: 'cf_msg_b',
              delivered: [],
              permanent_bounces: ['dev@example.com'],
              queued: [],
              suppressed_recipients: [],
            },
          }),
          { status: 200 },
        ),
    );
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      operationId: 'act_1',
      deliveries: [
        {
          recipient: 'dev@example.com',
          ok: false,
          state: 'failed',
          error: {
            code: 'UNVERIFIED_DESTINATION',
            message: "recipient 'dev@example.com' permanently bounced",
          },
        },
      ],
    });
  });

  it('reports a suppressed recipient as failed, not sent', async () => {
    const { env } = createMockEnv();
    stubCloudflare(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              message_id: 'cf_msg_s',
              delivered: [],
              permanent_bounces: [],
              queued: [],
              suppressed_recipients: ['dev@example.com'],
            },
          }),
          { status: 200 },
        ),
    );
    const res = await postSend(env, await sendBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      operationId: 'act_1',
      deliveries: [
        {
          recipient: 'dev@example.com',
          ok: false,
          state: 'failed',
          error: {
            code: 'UNVERIFIED_DESTINATION',
            message: "recipient 'dev@example.com' is on the suppression list",
          },
        },
      ],
    });
  });

  it('splits a mixed batch: delivered recipients keep the id, bounced ones fail', async () => {
    const { env } = createMockEnv();
    stubCloudflare(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              message_id: 'cf_msg_m',
              delivered: ['dev@example.com'],
              permanent_bounces: ['gone@example.com'],
              queued: [],
              suppressed_recipients: [],
            },
          }),
          { status: 200 },
        ),
    );
    const res = await postSend(
      env,
      await sendBody({ recipients: ['dev@example.com', 'gone@example.com'] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      operationId: 'act_1',
      deliveries: [
        {
          recipient: 'dev@example.com',
          ok: true,
          state: 'provider_accepted',
          messageId: 'cf_msg_m',
        },
        {
          recipient: 'gone@example.com',
          ok: false,
          state: 'failed',
          error: {
            code: 'UNVERIFIED_DESTINATION',
            message: "recipient 'gone@example.com' permanently bounced",
          },
        },
      ],
    });
  });
});
