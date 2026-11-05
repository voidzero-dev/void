import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { sendEmail } from '../../src/runtime/email.ts';
import {
  clearDevBuffer,
  DEV_INBOX_ENV_VAR,
  listDevMessages,
} from '../../src/runtime/email/dev-inbox.ts';
import { createEmailTestHarness } from '../../src/runtime/email/testing.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';

afterEach(() => {
  clearDevBuffer();
});

// Stand-in for workerd's `EmailMessage`, so the own-account `SEND_EMAIL`
// transport can run in the plain-node runner and its result be compared
// with a captured one.
const fake = vi.hoisted(() => {
  class FakeEmailMessage {
    constructor(
      readonly from: string,
      readonly to: string,
      readonly raw: ReadableStream<Uint8Array> | string,
    ) {}
  }
  return { FakeEmailMessage };
});

vi.mock('cloudflare:email', () => ({ EmailMessage: fake.FakeEmailMessage }));

/**
 * Build a fake `__VOID_PROXY` service binding that responds to
 * `/email/send` with a canned response. Captures every request body for
 * assertion.
 */
function fakeProxy(handler: (body: unknown) => { status: number; body: unknown }): {
  proxy: { fetch(req: Request | string, init?: RequestInit): Promise<Response> };
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  return {
    calls,
    proxy: {
      async fetch(req, init) {
        const url = typeof req === 'string' ? req : req.url;
        const bodyText =
          typeof init?.body === 'string'
            ? init.body
            : init?.body instanceof ArrayBuffer
              ? new TextDecoder().decode(init.body)
              : '';
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          /* ignore */
        }
        calls.push({ url, body: parsed });
        const result = handler(parsed);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
}

const PROXY_ENV_KEYS = {
  __VOID_PROXY_TOKEN: 'tok',
  __PROJECT_ID: 'p_test',
};

/** Sends through `__VOID_PROXY` when no harness sink is active. */
function send(
  proxy: ReturnType<typeof fakeProxy>['proxy'],
  to: string | Array<string> = 'b@y.dev',
  extra: Partial<Parameters<typeof sendEmail>[0]> = {},
): ReturnType<typeof sendEmail> {
  return withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
    sendEmail({ from: 'a@x.dev', to, subject: 's', text: 't', ...extra }),
  );
}

describe('sendEmail (test harness)', () => {
  it('captures sends and returns ok with a dev id', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: 'Acme <hello@acme.dev>',
        to: 'user@example.com',
        subject: 'Welcome',
        text: 'Hi there',
        html: '<p>Hi there</p>',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.ids).toHaveLength(1);
        expect(result.ids[0].recipient).toBe('user@example.com');
        expect(result.ids[0].messageId).toMatch(/^dev_/);
      }
      expect(harness.messages).toHaveLength(1);
      const m = harness.messages[0];
      expect(m.subject).toBe('Welcome');
      expect(m.from.email).toBe('hello@acme.dev');
      expect(m.to[0].email).toBe('user@example.com');
      expect(m.text).toBe('Hi there');
      expect(m.html).toBe('<p>Hi there</p>');
    } finally {
      harness.dispose();
    }
  });

  it('threads a later reply with the threading option', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: 'support@acme.dev',
        to: 'user@example.com',
        subject: 'Re: Help',
        text: 'Fixed.',
        threading: { inReplyTo: '<question@example.com>' },
      });
      expect(result.ok).toBe(true);
      const raw = new TextDecoder().decode(harness.messages[0].raw);
      expect(raw).toContain('\r\nIn-Reply-To: <question@example.com>\r\n');
      expect(raw).toContain('\r\nReferences: <question@example.com>\r\n');
    } finally {
      harness.dispose();
    }
  });

  it('does not populate the dev buffer when only the harness sink is active', async () => {
    const harness = createEmailTestHarness();
    try {
      await sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 'harness-only',
        text: 'hi',
      });
      expect(listDevMessages().some((m) => m.subject === 'harness-only')).toBe(false);
      expect(harness.messages.some((m) => m.subject === 'harness-only')).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  // `ids` reports what production sends (one lowercased entry per unique
  // address); the captured message keeps the fields as given.
  it('reports one id per unique address, the way the production transports do', async () => {
    const opts = {
      from: 'a@x.dev',
      to: ['A@x.dev'],
      cc: ['a@x.dev'],
      bcc: ['Bob <B@x.dev>', 'b@x.dev'],
      subject: 's',
      text: 't',
    };
    const harness = createEmailTestHarness();
    let captured: Awaited<ReturnType<typeof sendEmail>>;
    try {
      captured = await sendEmail(opts);
      expect(harness.messages).toHaveLength(1);
      const m = harness.messages[0];
      expect(m.to).toEqual([{ email: 'A@x.dev' }]);
      expect(m.cc).toEqual([{ email: 'a@x.dev' }]);
      expect(m.bcc).toEqual([{ email: 'B@x.dev', name: 'Bob' }, { email: 'b@x.dev' }]);
    } finally {
      harness.dispose();
    }
    expect(captured.ok).toBe(true);
    if (!captured.ok) {
      return;
    }
    expect(captured.ids).toEqual([
      { recipient: 'a@x.dev', messageId: captured.ids[0].messageId },
      { recipient: 'b@x.dev', messageId: captured.ids[0].messageId },
    ]);
    expect(captured.ids[0].messageId).toMatch(/^dev_/);

    // The same call through the own-account binding: the recipients the
    // capture reported are exactly the envelopes production sends.
    const sent: Array<string> = [];
    const binding = {
      async send(msg: unknown) {
        const m = msg as InstanceType<typeof fake.FakeEmailMessage>;
        sent.push(m.to);
        return { messageId: `cf-${m.to}` };
      },
    };
    const deployed = await withRuntimeEnv({ SEND_EMAIL: binding }, () => sendEmail(opts));
    expect(deployed.ok).toBe(true);
    if (deployed.ok) {
      expect(deployed.ids.map((d) => d.recipient)).toEqual(captured.ids.map((d) => d.recipient));
      expect(sent).toEqual(captured.ids.map((d) => d.recipient));
    }
  });

  it('bounds native binding submissions and preserves later provider references', async () => {
    vi.useFakeTimers();
    try {
      const send = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({ messageId: 'cf-second' });
      const pending = withRuntimeEnv({ SEND_EMAIL: { send } }, () =>
        sendEmail({
          from: 'a@x.dev',
          to: ['first@y.dev', 'second@y.dev'],
          subject: 'deadline',
          text: 'body',
        }),
      );

      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;

      expect(result).toMatchObject({
        ok: false,
        deliveries: [
          {
            recipient: 'first@y.dev',
            state: 'outcome_unknown',
            error: { code: 'OUTCOME_UNKNOWN' },
          },
          { recipient: 'second@y.dev', ok: true, messageId: 'cf-second' },
        ],
      });
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a native binding batch at 60 seconds without submitting the remainder', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(() => new Promise(() => {}));
      const pending = withRuntimeEnv({ SEND_EMAIL: { send } }, () =>
        sendEmail({
          from: 'a@x.dev',
          to: ['first@y.dev', 'second@y.dev', 'third@y.dev'],
          subject: 'batch deadline',
          text: 'body',
        }),
      );

      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      expect(send).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        ok: false,
        deliveries: [
          { state: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' } },
          { state: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' } },
          { state: 'cancelled', error: { code: 'UPSTREAM_ERROR' } },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear() empties the harness without disposing the sink', async () => {
    const harness = createEmailTestHarness();
    try {
      await sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's1', text: 't' });
      harness.clear();
      expect(harness.messages).toHaveLength(0);
      await sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's2', text: 't' });
      expect(harness.messages).toHaveLength(1);
      expect(harness.messages[0].subject).toBe('s2');
    } finally {
      harness.dispose();
    }
  });
});

describe('sendEmail (error mapping)', () => {
  it('returns INVALID_FROM for malformed sender', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: 'not-an-email',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      });
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
    } finally {
      harness.dispose();
    }
  });

  it('returns MIME_ERROR for threading that is not a string', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        threading: { inReplyTo: 5 },
      } as unknown as Parameters<typeof sendEmail>[0]);
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('MIME_ERROR');
      }
      expect(harness.messages).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it('returns MIME_ERROR when neither text nor html is set', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
      } as Parameters<typeof sendEmail>[0]);
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('MIME_ERROR');
      }
    } finally {
      harness.dispose();
    }
  });

  it('returns INVALID_TO for an oversize recipient list before any transport is tried', async () => {
    // Pre-flight: a top-level `error` from the harness, as from a deployed worker.
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: 'a@x.dev',
        to: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`),
        subject: 's',
        text: 't',
      });
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_TO');
        expect(result.error.message).toMatch(/too many recipients \(max 50, got 51\)/);
      }
      expect(harness.messages).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });
});

describe('sendEmail (from defaulting)', () => {
  // The platform mail domain is injected per environment (`mail.void.cloud`
  // in production, its own zone in staging), so these tests deliberately use
  // a non-production value: a passing assertion then proves the address was
  // built from the binding rather than from a baked-in constant.
  const MAIL_DOMAIN = 'mail.staging.void.cloud';

  it('defaults from to <slug>+noreply@<__VOID_EMAIL_DOMAIN> when omitted and both bindings are injected', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv(
        { __VOID_PROJECT_SLUG: 'acme', __VOID_EMAIL_DOMAIN: MAIL_DOMAIN },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(true);
      expect(harness.messages).toHaveLength(1);
      expect(harness.messages[0].from.email).toBe(`acme+noreply@${MAIL_DOMAIN}`);
    } finally {
      harness.dispose();
    }
  });

  it('defaults from to __VOID_EMAIL_FROM when omitted (own-account deploys)', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv(
        { __VOID_EMAIL_FROM: 'Acme <noreply@mail.acme.com>' },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(true);
      expect(harness.messages[0].from).toEqual({ email: 'noreply@mail.acme.com', name: 'Acme' });
    } finally {
      harness.dispose();
    }
  });

  it('prefers __VOID_EMAIL_FROM over the platform slug default', async () => {
    const harness = createEmailTestHarness();
    try {
      await withRuntimeEnv(
        {
          __VOID_EMAIL_FROM: 'noreply@mail.acme.com',
          __VOID_PROJECT_SLUG: 'acme',
          __VOID_EMAIL_DOMAIN: MAIL_DOMAIN,
        },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(harness.messages[0].from.email).toBe('noreply@mail.acme.com');
    } finally {
      harness.dispose();
    }
  });

  it('returns INVALID_FROM for a malformed __VOID_EMAIL_FROM instead of guessing', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({ __VOID_EMAIL_FROM: 'not-an-address' }, () =>
        sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
      expect(harness.messages).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it('respects explicit from even when both bindings are set', async () => {
    const harness = createEmailTestHarness();
    try {
      await withRuntimeEnv({ __VOID_PROJECT_SLUG: 'acme', __VOID_EMAIL_DOMAIN: MAIL_DOMAIN }, () =>
        sendEmail({
          from: 'override@example.com',
          to: 'b@y.dev',
          subject: 's',
          text: 't',
        }),
      );
      expect(harness.messages[0].from.email).toBe('override@example.com');
    } finally {
      harness.dispose();
    }
  });

  it('respects explicit from when neither binding is present', async () => {
    // The bindings only feed the default. A caller who supplies `from`
    // must keep working outside a deployed worker.
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({}, () =>
        sendEmail({ from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(true);
      expect(harness.messages[0].from.email).toBe('a@x.dev');
    } finally {
      harness.dispose();
    }
  });

  it('returns INVALID_FROM when from is omitted and neither binding is available', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({}, () =>
        sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
    } finally {
      harness.dispose();
    }
  });

  it('returns INVALID_FROM (never a baked-in domain) when __VOID_EMAIL_DOMAIN is missing', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({ __VOID_PROJECT_SLUG: 'acme' }, () =>
        sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
        expect(result.error.message).not.toContain('mail.void.cloud');
      }
      expect(harness.messages).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it('returns INVALID_FROM when __VOID_PROJECT_SLUG is missing but the domain is set', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({ __VOID_EMAIL_DOMAIN: MAIL_DOMAIN }, () =>
        sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
      expect(harness.messages).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it('refuses to substitute a malformed __VOID_PROJECT_SLUG', async () => {
    const harness = createEmailTestHarness();
    try {
      // Slug containing `@` would corrupt the resulting envelope address.
      const result = await withRuntimeEnv(
        { __VOID_PROJECT_SLUG: 'evil@x.com', __VOID_EMAIL_DOMAIN: MAIL_DOMAIN },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
    } finally {
      harness.dispose();
    }
  });

  it('returns INVALID_FROM (not MIME_ERROR) when from is explicitly null', async () => {
    const harness = createEmailTestHarness();
    try {
      const result = await sendEmail({
        from: null as unknown as string,
        to: 'b@y.dev',
        subject: 's',
        text: 't',
      });
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
    } finally {
      harness.dispose();
    }
  });

  it('accepts a 56-char slug (RFC 5321 64-octet local-part limit minus +noreply)', async () => {
    const harness = createEmailTestHarness();
    try {
      const slug = 'a'.repeat(56);
      const result = await withRuntimeEnv(
        { __VOID_PROJECT_SLUG: slug, __VOID_EMAIL_DOMAIN: MAIL_DOMAIN },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(true);
      expect(harness.messages[0].from.email).toBe(`${slug}+noreply@${MAIL_DOMAIN}`);
    } finally {
      harness.dispose();
    }
  });

  it('rejects a 57-char slug (would build a 65-octet local-part)', async () => {
    const harness = createEmailTestHarness();
    try {
      const slug = 'a'.repeat(57);
      const result = await withRuntimeEnv(
        { __VOID_PROJECT_SLUG: slug, __VOID_EMAIL_DOMAIN: MAIL_DOMAIN },
        () => sendEmail({ to: 'b@y.dev', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && 'error' in result) {
        expect(result.error.code).toBe('INVALID_FROM');
      }
    } finally {
      harness.dispose();
    }
  });
});

describe('sendEmail (proxy round trip)', () => {
  it('returns ok and surfaces messageIds from the proxy', async () => {
    const { proxy, calls } = fakeProxy(() => ({
      status: 200,
      body: { ok: true, ids: [{ recipient: 'b@y.dev', messageId: 'cf-1' }] },
    }));
    const result = await send(proxy);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://email-proxy/email/send');
    const body = calls[0].body as Record<string, unknown>;
    expect(body.projectId).toBe('p_test');
    expect(body.aiToken).toBe('tok');
    expect(body.from).toBe('a@x.dev');
    expect(Array.isArray(body.recipients)).toBe(true);
    expect(body.recipients as Array<string>).toEqual(['b@y.dev']);
    expect(typeof body.mimeBase64).toBe('string');
    expect((body.mimeBase64 as string).length).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids).toEqual([{ recipient: 'b@y.dev', messageId: 'cf-1' }]);
    }
  });

  it('surfaces QUOTA_EXCEEDED when the proxy denies the send', async () => {
    const { proxy } = fakeProxy(() => ({
      status: 429,
      body: { ok: false, error: { code: 'QUOTA_EXCEEDED', message: 'monthly cap reached' } },
    }));
    const result = await send(proxy);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('QUOTA_EXCEEDED');
      expect(result.error.message).toContain('monthly cap reached');
    }
  });

  it('returns OUTCOME_UNKNOWN on proxy fetch failure', async () => {
    const proxy = {
      async fetch() {
        throw new Error('network unreachable');
      },
    };
    const result = await send(proxy);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('OUTCOME_UNKNOWN');
    }
  });

  it.each(['fetch', 'body'] as const)(
    'returns OUTCOME_UNKNOWN when the platform proxy %s never settles',
    async (stall) => {
      vi.useFakeTimers();
      try {
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const proxy = {
          fetch() {
            markStarted();
            if (stall === 'fetch') {
              return new Promise<Response>(() => {});
            }
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"ok":true,"ids":['));
                  },
                }),
              ),
            );
          },
        };
        const pending = send(proxy);

        await started;
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(60_000);
        const result = await pending;
        expect(result).toMatchObject({ ok: false, error: { code: 'OUTCOME_UNKNOWN' } });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('returns OUTCOME_UNKNOWN without reading an oversized proxy response', async () => {
    const cancel = vi.fn();
    const proxy = {
      async fetch() {
        return new Response(
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
        );
      },
    };
    const result = await send(proxy);
    expect(result).toMatchObject({ ok: false, error: { code: 'OUTCOME_UNKNOWN' } });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('coerces unknown error codes to UPSTREAM_ERROR', async () => {
    const { proxy } = fakeProxy(() => ({
      status: 500,
      body: { ok: false, error: { code: 'WEIRD_NEW_CODE', message: 'something broke' } },
    }));
    const result = await send(proxy);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
      expect(result.error.message).toContain('something broke');
    }
  });

  it.each([{}, { code: 123, message: false }])(
    'keeps the upstream fallback for incomplete error fields: %j',
    async (error) => {
      const { proxy } = fakeProxy(() => ({ status: 500, body: { ok: false, error } }));
      const result = await send(proxy);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'UPSTREAM_ERROR', message: 'email: upstream send failed' },
      });
    },
  );

  it('preserves recipient outcomes when a failure also includes a top-level error', async () => {
    const { proxy } = fakeProxy(() => ({
      status: 500,
      body: {
        ok: false,
        error: { code: 'UPSTREAM_ERROR', message: 'partial send' },
        deliveries: [{ recipient: 'b@y.dev', ok: true, messageId: 'cf-b' }],
      },
    }));
    const result = await send(proxy);
    expect(result).toEqual({
      ok: false,
      deliveries: [{ recipient: 'b@y.dev', ok: true, messageId: 'cf-b' }],
    });
  });

  it.each([
    ['null body', null],
    ['empty object', {}],
    ['ok:true with no ids', { ok: true }],
    ['ok:true with non-array ids', { ok: true, ids: 'string' }],
    ['ok:false with neither error nor deliveries', { ok: false }],
    ['primitive number body', 42],
    ['primitive array body', []],
  ])('returns OUTCOME_UNKNOWN (no throw) for malformed proxy response: %s', async (_, payload) => {
    const { proxy } = fakeProxy(() => ({ status: 200, body: payload }));
    const result = await send(proxy);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('OUTCOME_UNKNOWN');
    }
  });

  // The proxy's middleware (capability gate, auth, platform lifecycle)
  // refuses ahead of the email handler with a flat `{ error, message? }`
  // and a non-2xx status — a well-formed refusal whose text must reach the
  // caller, not a "malformed response".
  it.each([
    [
      'a 501 from the platform capability gate',
      501,
      {
        error: 'platform capability unavailable',
        capability: 'email',
        message: 'This Void platform does not enable email.',
      },
      'This Void platform does not enable email.',
    ],
    [
      'a 403 from the auth middleware (no message, falls back to error)',
      403,
      { error: 'invalid project token' },
      'invalid project token',
    ],
  ])('surfaces the proxy refusal text for %s', async (_, status, payload, expected) => {
    const { proxy } = fakeProxy(() => ({ status, body: payload }));
    const result = await send(proxy);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('UPSTREAM_ERROR');
      expect(result.error.message).toBe(`email: proxy returned ${status}: ${expected}`);
      expect(result.error.cause).toEqual(payload);
    }
  });

  it('still reports a flat error body on a 2xx as malformed', async () => {
    const { proxy } = fakeProxy(() => ({ status: 200, body: { error: 'nope' } }));
    const result = await send(proxy);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('OUTCOME_UNKNOWN');
      expect(result.error.message).toBe('email: proxy returned malformed response (status 200)');
    }
  });

  it('returns OUTCOME_UNKNOWN when proxy responds with non-JSON', async () => {
    const proxy = {
      async fetch() {
        return new Response('not json', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        });
      },
    };
    const result = await send(proxy);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('OUTCOME_UNKNOWN');
    }
  });

  it('dedupes recipients across to/cc/bcc and sends one envelope per unique address', async () => {
    const { calls, proxy } = fakeProxy((body) => {
      const recipients = (body as { recipients: Array<string> }).recipients;
      return {
        status: 200,
        body: {
          ok: true,
          ids: recipients.map((r) => ({ recipient: r, messageId: `cf-${r}` })),
        },
      };
    });
    const result = await send(proxy, 'b@y.dev', { cc: 'B@Y.DEV', bcc: ['b@y.dev', 'c@y.dev'] });
    const recipients = (calls[0].body as { recipients: Array<string> }).recipients;
    expect(recipients).toEqual(['b@y.dev', 'c@y.dev']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids).toHaveLength(2);
    }
  });
});

// ok:true must account for every requested recipient.
describe('sendEmail (proxy delivery list)', () => {
  it.each([
    [
      'a null entry',
      'b@y.dev',
      { ok: true, ids: [null] },
      'entry 0 is not { recipient: string, messageId: string }',
    ],
    [
      'a missing messageId',
      'b@y.dev',
      { ok: true, ids: [{ recipient: 'b@y.dev' }] },
      'entry 0 is not { recipient: string, messageId: string }',
    ],
    [
      'a non-string recipient',
      'b@y.dev',
      { ok: true, ids: [{ recipient: 42, messageId: 'cf-1' }] },
      'entry 0 is not { recipient: string, messageId: string }',
    ],
    [
      'an empty list for a two-recipient send',
      ['b@y.dev', 'c@y.dev'],
      { ok: true, ids: [] },
      'expected 2 deliveries, got 0',
    ],
    [
      'one entry short of the request',
      ['b@y.dev', 'c@y.dev'],
      { ok: true, ids: [{ recipient: 'b@y.dev', messageId: 'cf-1' }] },
      'expected 2 deliveries, got 1',
    ],
    [
      'a duplicated recipient',
      ['b@y.dev', 'c@y.dev'],
      {
        ok: true,
        ids: [
          { recipient: 'b@y.dev', messageId: 'cf-1' },
          { recipient: 'b@y.dev', messageId: 'cf-2' },
        ],
      },
      'entry 1 repeats a recipient',
    ],
    [
      'a recipient that was not requested',
      'b@y.dev',
      { ok: true, ids: [{ recipient: 'z@y.dev', messageId: 'cf-1' }] },
      'entry 0 names a recipient that was not requested',
    ],
    [
      'a recipient in the wrong case',
      'b@y.dev',
      { ok: true, ids: [{ recipient: 'B@y.dev', messageId: 'cf-1' }] },
      'entry 0 names a recipient that was not requested',
    ],
  ])(
    'returns OUTCOME_UNKNOWN for an ok:true response carrying %s',
    async (_, to, payload, reason) => {
      const { proxy } = fakeProxy(() => ({ status: 200, body: payload }));
      const result = await send(proxy, to);
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'OUTCOME_UNKNOWN',
          message: `email: proxy returned a malformed delivery list (${reason}); do not retry with a new idempotency key`,
          cause: payload,
        },
      });
    },
  );

  it('passes a complete list through verbatim, in the order the proxy sent it', async () => {
    const { calls, proxy } = fakeProxy(() => ({
      status: 200,
      body: {
        ok: true,
        ids: [
          { recipient: 'c@y.dev', messageId: 'cf-c' },
          { recipient: 'b@y.dev', messageId: '' },
        ],
      },
    }));
    const result = await send(proxy, ['b@y.dev', 'c@y.dev']);
    expect((calls[0].body as { recipients: Array<string> }).recipients).toEqual([
      'b@y.dev',
      'c@y.dev',
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Order-insensitive: the proxy's order is kept, not re-sorted. The
      // empty messageId is the proxy's "CF returned none" convention and
      // still falls back to the locally generated Message-ID.
      expect(result.ids.map((d) => d.recipient)).toEqual(['c@y.dev', 'b@y.dev']);
      expect(result.ids[0].messageId).toBe('cf-c');
      expect(result.ids[1].messageId).toMatch(/^<.+@x\.dev>$/);
    }
  });
});

// A mid-batch list must state one outcome per requested recipient, or it is refused whole.
describe('sendEmail (proxy mid-batch delivery list)', () => {
  const failed = (recipient: string) => ({
    recipient,
    ok: false,
    error: { code: 'UNVERIFIED_DESTINATION', message: `${recipient} not verified` },
  });
  const SHAPE =
    '{ recipient: string, ok: true, messageId: string } | { recipient: string, ok: false, error: { message: string } }';

  it.each([
    [
      'a null entry standing in for one recipient',
      ['a@y.dev', 'b@y.dev'],
      { ok: false, deliveries: [null, failed('b@y.dev')] },
      `entry 0 is not ${SHAPE}`,
    ],
    [
      'a string entry',
      ['a@y.dev', 'b@y.dev'],
      { ok: false, deliveries: [failed('a@y.dev'), 'string-not-object'] },
      `entry 1 is not ${SHAPE}`,
    ],
    [
      'an empty list for a two-recipient send',
      ['a@y.dev', 'b@y.dev'],
      { ok: false, deliveries: [] },
      'expected 2 deliveries, got 0',
    ],
    [
      'one entry short of the request',
      ['a@y.dev', 'b@y.dev'],
      { ok: false, deliveries: [failed('b@y.dev')] },
      'expected 2 deliveries, got 1',
    ],
    [
      'more entries than the request',
      ['a@y.dev', 'b@y.dev'],
      {
        ok: false,
        deliveries: [
          { recipient: 'a@y.dev', ok: true, messageId: 'cf-a' },
          null,
          { recipient: 'b@y.dev', ok: false, error: null },
          'string-not-object',
          { ok: true, messageId: 'cf-x' },
        ],
      },
      'expected 2 deliveries, got 5',
    ],
    [
      'a duplicated recipient',
      ['a@y.dev', 'b@y.dev'],
      {
        ok: false,
        deliveries: [failed('b@y.dev'), { recipient: 'b@y.dev', ok: true, messageId: 'cf-b' }],
      },
      'entry 1 repeats a recipient',
    ],
    [
      'a recipient that was not requested',
      ['a@y.dev', 'b@y.dev'],
      {
        ok: false,
        deliveries: [failed('z@y.dev'), { recipient: 'b@y.dev', ok: true, messageId: 'cf-b' }],
      },
      'entry 0 names a recipient that was not requested',
    ],
    [
      'a recipient in the wrong case',
      ['a@y.dev', 'b@y.dev'],
      {
        ok: false,
        deliveries: [failed('A@y.dev'), { recipient: 'b@y.dev', ok: true, messageId: 'cf-b' }],
      },
      'entry 0 names a recipient that was not requested',
    ],
    [
      'an entry with no recipient',
      ['a@y.dev', 'b@y.dev'],
      { ok: false, deliveries: [{ ok: true, messageId: 'cf-a' }, failed('b@y.dev')] },
      `entry 0 is not ${SHAPE}`,
    ],
    [
      'an entry with no ok',
      ['a@y.dev', 'b@y.dev'],
      { ok: false, deliveries: [{ recipient: 'a@y.dev', messageId: 'cf-a' }, failed('b@y.dev')] },
      `entry 0 is not ${SHAPE}`,
    ],
    [
      'an entry whose ok is the string "true"',
      ['a@y.dev', 'b@y.dev'],
      {
        ok: false,
        deliveries: [{ recipient: 'a@y.dev', ok: 'true', messageId: 'cf-a' }, failed('b@y.dev')],
      },
      `entry 0 is not ${SHAPE}`,
    ],
    [
      'an ok:true entry with no messageId',
      ['a@y.dev', 'b@y.dev'],
      { ok: false, deliveries: [{ recipient: 'a@y.dev', ok: true }, failed('b@y.dev')] },
      `entry 0 is not ${SHAPE}`,
    ],
    [
      'an ok:true entry with a non-string messageId',
      ['a@y.dev', 'b@y.dev'],
      {
        ok: false,
        deliveries: [{ recipient: 'a@y.dev', ok: true, messageId: 42 }, failed('b@y.dev')],
      },
      `entry 0 is not ${SHAPE}`,
    ],
    [
      'an ok:false entry with no error',
      ['a@y.dev', 'b@y.dev'],
      {
        ok: false,
        deliveries: [
          { recipient: 'a@y.dev', ok: true, messageId: 'cf-a' },
          { recipient: 'b@y.dev', ok: false },
        ],
      },
      `entry 1 is not ${SHAPE}`,
    ],
    [
      'an ok:false entry with a null error',
      ['a@y.dev', 'b@y.dev'],
      {
        ok: false,
        deliveries: [
          { recipient: 'a@y.dev', ok: true, messageId: 'cf-a' },
          { recipient: 'b@y.dev', ok: false, error: null },
        ],
      },
      `entry 1 is not ${SHAPE}`,
    ],
    [
      'an ok:false entry whose error has no string message',
      ['a@y.dev', 'b@y.dev'],
      {
        ok: false,
        deliveries: [
          { recipient: 'a@y.dev', ok: true, messageId: 'cf-a' },
          { recipient: 'b@y.dev', ok: false, error: { code: 'UPSTREAM_ERROR', message: 7 } },
        ],
      },
      `entry 1 is not ${SHAPE}`,
    ],
  ])(
    'returns a top-level OUTCOME_UNKNOWN for a mid-batch response carrying %s',
    async (_, to, payload, reason) => {
      const { proxy } = fakeProxy(() => ({ status: 200, body: payload }));
      const result = await send(proxy, to);
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'OUTCOME_UNKNOWN',
          message: `email: proxy returned a malformed delivery list (${reason}); do not retry with a new idempotency key`,
          cause: payload,
        },
      });
    },
  );

  it('passes a complete list through in the order the proxy sent it', async () => {
    // The proxy lists allowlist rejections before the sends it attempted,
    // so the order differs from the request's; it is kept, not re-sorted.
    // An unknown error code is coerced; the empty messageId is the proxy's
    // "CF returned none" convention and falls back to the locally generated
    // Message-ID, as on the success path.
    const { calls, proxy } = fakeProxy(() => ({
      status: 200,
      body: {
        ok: false,
        deliveries: [
          { recipient: 'c@y.dev', ok: false, error: { code: 'WEIRD_NEW_CODE', message: 'nope' } },
          failed('b@y.dev'),
          { recipient: 'a@y.dev', ok: true, messageId: '' },
        ],
      },
    }));
    const result = await send(proxy, ['a@y.dev', 'b@y.dev', 'c@y.dev']);
    expect((calls[0].body as { recipients: Array<string> }).recipients).toEqual([
      'a@y.dev',
      'b@y.dev',
      'c@y.dev',
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok && 'deliveries' in result) {
      expect(result.deliveries.map((d) => d.recipient)).toEqual(['c@y.dev', 'b@y.dev', 'a@y.dev']);
      expect(result.deliveries[0]).toEqual({
        recipient: 'c@y.dev',
        ok: false,
        error: { code: 'UPSTREAM_ERROR', message: 'nope' },
      });
      expect(result.deliveries[1]).toEqual({
        recipient: 'b@y.dev',
        ok: false,
        error: { code: 'UNVERIFIED_DESTINATION', message: 'b@y.dev not verified' },
      });
      const a = result.deliveries[2];
      expect(a.ok).toBe(true);
      if (a.ok) {
        expect(a.messageId).toMatch(/^<.+@x\.dev>$/);
      }
    } else {
      throw new Error('expected a mid-batch result');
    }
  });

  it('does not refuse a mid-batch list in which every entry succeeded', async () => {
    // Contradicts `anyFailed`, but every recipient has a trustworthy
    // accepted outcome. Refusing it would make the caller treat the whole
    // call as unknown despite the complete provider evidence.
    const { proxy } = fakeProxy(() => ({
      status: 200,
      body: {
        ok: false,
        deliveries: [
          { recipient: 'a@y.dev', ok: true, messageId: 'cf-a' },
          { recipient: 'b@y.dev', ok: true, messageId: 'cf-b' },
        ],
      },
    }));
    const result = await send(proxy, ['a@y.dev', 'b@y.dev']);
    expect(result).toEqual({
      ok: false,
      deliveries: [
        { recipient: 'a@y.dev', ok: true, messageId: 'cf-a' },
        { recipient: 'b@y.dev', ok: true, messageId: 'cf-b' },
      ],
    });
  });
});

describe('sendEmail (deprecated sendInDev)', () => {
  it('bypasses the harness and calls the proxy', async () => {
    const harness = createEmailTestHarness();
    try {
      const { proxy, calls } = fakeProxy(() => ({
        status: 200,
        body: { ok: true, ids: [{ recipient: 'b@y.dev', messageId: 'cf-id-123' }] },
      }));
      const result = await send(proxy, 'b@y.dev', { sendInDev: true });
      expect(harness.messages).toHaveLength(0);
      expect(calls).toHaveLength(1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.ids[0].messageId).toBe('cf-id-123');
      }
    } finally {
      harness.dispose();
    }
  });

  // `void dev` binds neither `__VOID_PROXY` nor `SEND_EMAIL`, so there
  // `sendInDev: true` reaches no transport.
  it('returns BINDING_MISSING under a real `void dev` env (no transport to fall through to)', async () => {
    const assets = {
      calls: 0,
      async fetch() {
        this.calls += 1;
        return new Response('unreachable', { status: 500 });
      },
    };
    const result = await withRuntimeEnv({ [DEV_INBOX_ENV_VAR]: 'ASSETS', ASSETS: assets }, () =>
      sendEmail({
        from: 'a@x.dev',
        to: 'b@y.dev',
        subject: 's',
        text: 't',
        sendInDev: true,
      }),
    );
    // The inbox was bypassed: nothing was posted to the dev server, and
    // nothing was buffered.
    expect(assets.calls).toBe(0);
    expect(listDevMessages()).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok && 'error' in result) {
      expect(result.error.code).toBe('BINDING_MISSING');
      expect(result.error.message).toContain(
        'bypassed by the deprecated `sendInDev: true` (it never delivers)',
      );
    }
  });
});

describe('sendEmail platform idempotency', () => {
  const options = { from: 'a@x.dev', to: 'b@y.dev', subject: 's', text: 't' };
  it('carries the key and preserves the operation and provider acceptance state', async () => {
    const { proxy, calls } = fakeProxy(() => ({
      status: 200,
      body: {
        ok: true,
        operationId: 'emailact_1',
        ids: [{ recipient: 'b@y.dev', messageId: 'cf-1', state: 'provider_accepted' }],
      },
    }));
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail({ ...options, idempotencyKey: 'invoice:42' }),
    );
    expect(calls[0]?.body).toMatchObject({ idempotencyKey: 'invoice:42' });
    expect(result).toMatchObject({
      ok: true,
      operationId: 'emailact_1',
      ids: [{ state: 'provider_accepted' }],
    });
  });
  it('keeps partial outcomes when the response also carries an overall error', async () => {
    const { proxy } = fakeProxy(() => ({
      status: 200,
      body: {
        ok: false,
        operationId: 'emailact_2',
        error: { code: 'OUTCOME_UNKNOWN', message: 'unknown' },
        deliveries: [
          {
            recipient: 'b@y.dev',
            ok: false,
            state: 'outcome_unknown',
            error: { code: 'OUTCOME_UNKNOWN', message: 'unknown' },
          },
        ],
      },
    }));
    const result = await withRuntimeEnv({ __VOID_PROXY: proxy, ...PROXY_ENV_KEYS }, () =>
      sendEmail(options),
    );
    expect(result).toMatchObject({
      ok: false,
      operationId: 'emailact_2',
      deliveries: [{ state: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' } }],
    });
  });
  it('refuses an invalid key before transport and rejects unsupported native deduplication', async () => {
    const send = vi.fn();
    for (const idempotencyKey of ['', 'a b', 'x'.repeat(129)]) {
      const result = await withRuntimeEnv({ SEND_EMAIL: { send } }, () =>
        sendEmail({ ...options, idempotencyKey }),
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'MIME_ERROR' } });
    }
    const result = await withRuntimeEnv({ SEND_EMAIL: { send } }, () =>
      sendEmail({ ...options, idempotencyKey: 'invoice:42' }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'MIME_ERROR', message: expect.stringContaining('native Cloudflare') },
    });
    expect(send).not.toHaveBeenCalled();
  });
});
