/**
 * Email on the developer's OWN Cloudflare account (`void deploy --platform
 * cloudflare`).
 *
 * Two things differ from the managed platform and both are exercised here
 * with `cloudflare:email` faked, since the real module exists only in workerd:
 *
 *   outbound  sendEmail() -> env.SEND_EMAIL.send(new EmailMessage(...)),
 *             one envelope per recipient, no proxy hop
 *   inbound   Cloudflare calls the worker's `email()` with a REAL
 *             `ForwardableEmailMessage` and ignores the return value, so the
 *             generated entry must ENACT the recorded actions on it
 */
import { describe, expect, it, vi } from 'vite-plus/test';
import { compileWorkerEntry } from '../../src/router/compile.ts';
import { sendEmail } from '../../src/runtime/email.ts';
import {
  createMessageProxy,
  enactEmailActions,
  isForwardableEmailMessage,
  parseEmail,
  replyEmail,
} from '../../src/runtime/email/inbound.ts';
import { MimeError } from '../../src/runtime/email/mime.ts';
import { createEmailTestHarness } from '../../src/runtime/email/testing.ts';
import { envContext } from '../../src/runtime/env-raw.ts';
import { withRuntimeEnv } from '../../src/runtime/env.ts';

// Stand-in for workerd's `EmailMessage`. It only needs to be a recognisable
// class that keeps its constructor arguments, so a test can assert which
// envelope reached the binding and that a genuine instance (not a duck-typed
// object) was handed to `reply()`.
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

async function readAll(raw: ReadableStream<Uint8Array> | string): Promise<string> {
  if (typeof raw === 'string') {
    return raw;
  }
  const reader = raw.getReader();
  let out = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** An error shaped the way Email Service throws them: `Error` + `code`. */
function bindingError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function fakeSendBinding(
  respond: (msg: InstanceType<typeof fake.FakeEmailMessage>) => { messageId?: string } | undefined,
): {
  binding: { send(msg: unknown): Promise<{ messageId?: string } | undefined> };
  sent: Array<InstanceType<typeof fake.FakeEmailMessage>>;
} {
  const sent: Array<InstanceType<typeof fake.FakeEmailMessage>> = [];
  return {
    sent,
    binding: {
      async send(msg: unknown) {
        expect(msg).toBeInstanceOf(fake.FakeEmailMessage);
        const m = msg as InstanceType<typeof fake.FakeEmailMessage>;
        sent.push(m);
        return respond(m);
      },
    },
  };
}

describe('sendEmail (SEND_EMAIL binding)', () => {
  it('sends one EmailMessage per unique recipient and surfaces the binding messageIds', async () => {
    const { binding, sent } = fakeSendBinding((m) => ({ messageId: `cf-${m.to}` }));
    const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
      sendEmail({
        from: 'Acme <support@mail.acme.com>',
        to: ['alice@example.com', 'Bob <bob@example.com>'],
        cc: 'ALICE@example.com',
        subject: 'Welcome',
        text: 'Hi there',
      }),
    );

    expect(result).toEqual({
      ok: true,
      ids: [
        { recipient: 'alice@example.com', messageId: 'cf-alice@example.com' },
        { recipient: 'bob@example.com', messageId: 'cf-bob@example.com' },
      ],
    });
    expect(sent.map((m) => [m.from, m.to])).toEqual([
      ['support@mail.acme.com', 'alice@example.com'],
      ['support@mail.acme.com', 'bob@example.com'],
    ]);
    // Each envelope carries the shared MIME, on a fresh stream.
    const bodies = await Promise.all(sent.map((m) => readAll(m.raw)));
    for (const body of bodies) {
      expect(body).toContain('Subject: Welcome');
      expect(body).toContain('Hi there');
    }
  });

  it('falls back to the locally generated messageId when the binding returns none', async () => {
    const { binding } = fakeSendBinding(() => undefined);
    const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
      sendEmail({ from: 'a@mail.acme.com', to: 'b@example.com', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids[0].messageId).toMatch(/@/);
    }
  });

  it('is tried before __VOID_PROXY', async () => {
    const { binding, sent } = fakeSendBinding(() => ({ messageId: 'cf-1' }));
    const proxyCalls: Array<string> = [];
    const proxy = {
      async fetch(req: Request | string) {
        proxyCalls.push(typeof req === 'string' ? req : req.url);
        return new Response('{"ok":true,"ids":[]}');
      },
    };
    const result = await withRuntimeEnv(
      { SEND_EMAIL: binding, __VOID_PROXY: proxy, __VOID_PROXY_TOKEN: 't', __PROJECT_ID: 'p' },
      () => sendEmail({ from: 'a@mail.acme.com', to: 'b@example.com', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(proxyCalls).toEqual([]);
  });

  it('yields to the dev inbox / test harness sink', async () => {
    const { binding, sent } = fakeSendBinding(() => ({ messageId: 'cf-1' }));
    const harness = createEmailTestHarness();
    try {
      const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
        sendEmail({ from: 'a@mail.acme.com', to: 'b@example.com', subject: 's', text: 't' }),
      );
      expect(result.ok).toBe(true);
      expect(harness.messages).toHaveLength(1);
      expect(sent).toHaveLength(0);
    } finally {
      harness.dispose();
    }
  });

  it('defaults from to __VOID_EMAIL_FROM', async () => {
    const { binding, sent } = fakeSendBinding(() => ({ messageId: 'cf-1' }));
    const result = await withRuntimeEnv(
      { SEND_EMAIL: binding, __VOID_EMAIL_FROM: 'noreply@mail.acme.com' },
      () => sendEmail({ to: 'b@example.com', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(true);
    expect(sent[0].from).toBe('noreply@mail.acme.com');
    expect(await readAll(sent[0].raw)).toContain('From: noreply@mail.acme.com');
  });

  it.each([
    ['E_RECIPIENT_NOT_ALLOWED', 'UNVERIFIED_DESTINATION'],
    ['E_SENDER_NOT_VERIFIED', 'INVALID_FROM'],
    ['E_SENDER_DOMAIN_NOT_AVAILABLE', 'INVALID_FROM'],
    ['E_RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED'],
    ['E_DAILY_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED'],
    ['E_DELIVERY_FAILED', 'OUTCOME_UNKNOWN'],
    ['E_INTERNAL_SERVER_ERROR', 'OUTCOME_UNKNOWN'],
  ])(
    'maps a thrown %s to %s per recipient, keeping the Cloudflare message',
    async (cfCode, code) => {
      const thrown = bindingError(cfCode, `cloudflare says: ${cfCode}`);
      const { binding } = fakeSendBinding(() => {
        throw thrown;
      });
      const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
        sendEmail({ from: 'a@mail.acme.com', to: 'b@example.com', subject: 's', text: 't' }),
      );
      expect(result).toEqual({
        ok: false,
        deliveries: [
          {
            recipient: 'b@example.com',
            ok: false,
            ...(code === 'OUTCOME_UNKNOWN' ? { state: 'outcome_unknown' } : {}),
            error: { code, message: `cloudflare says: ${cfCode}`, cause: thrown },
          },
        ],
      });
    },
  );

  it('recognises the older message-only "destination address not verified" error', async () => {
    const { binding } = fakeSendBinding(() => {
      throw new Error('destination address b@example.com not verified');
    });
    const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
      sendEmail({ from: 'a@mail.acme.com', to: 'b@example.com', subject: 's', text: 't' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && 'deliveries' in result) {
      expect(result.deliveries[0]).toMatchObject({
        ok: false,
        error: { code: 'UNVERIFIED_DESTINATION' },
      });
    } else {
      throw new Error('expected a per-recipient failure');
    }
  });

  it('attempts every recipient and reports a mid-batch failure in the proxy shape', async () => {
    const { binding, sent } = fakeSendBinding((m) => {
      if (m.to === 'blocked@example.com') {
        throw bindingError('E_RECIPIENT_NOT_ALLOWED', 'not allowed');
      }
      return { messageId: `cf-${m.to}` };
    });
    const result = await withRuntimeEnv({ SEND_EMAIL: binding }, () =>
      sendEmail({
        from: 'a@mail.acme.com',
        to: ['blocked@example.com', 'ok@example.com'],
        subject: 's',
        text: 't',
      }),
    );
    expect(sent.map((m) => m.to)).toEqual(['blocked@example.com', 'ok@example.com']);
    expect(result).toMatchObject({
      ok: false,
      deliveries: [
        {
          recipient: 'blocked@example.com',
          ok: false,
          error: { code: 'UNVERIFIED_DESTINATION', message: 'not allowed' },
        },
        { recipient: 'ok@example.com', ok: true, messageId: 'cf-ok@example.com' },
      ],
    });
  });
});

/**
 * A `ForwardableEmailMessage` as workerd hands it to `email()`: a one-shot
 * raw stream, a `Headers` instance, and the three native methods, each
 * recording its call.
 */
function nativeMessage(opts: { from: string; to: string; mime: string }): {
  message: ForwardableEmailMessage;
  calls: {
    rejects: Array<string>;
    forwards: Array<{ to: string; headers: Headers | undefined }>;
    replies: Array<unknown>;
  };
} {
  const bytes = new TextEncoder().encode(opts.mime);
  const headers = new Headers();
  for (const line of opts.mime.split('\r\n\r\n')[0].split('\r\n')) {
    const idx = line.indexOf(':');
    headers.set(line.slice(0, idx), line.slice(idx + 1).trim());
  }
  const calls = {
    rejects: [] as Array<string>,
    forwards: [] as Array<{ to: string; headers: Headers | undefined }>,
    replies: [] as Array<unknown>,
  };
  const message = {
    from: opts.from,
    to: opts.to,
    headers,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: bytes.byteLength,
    setReject(reason: string) {
      calls.rejects.push(reason);
    },
    async forward(to: string, fwdHeaders?: Headers) {
      calls.forwards.push({ to, headers: fwdHeaders });
      return { messageId: 'fwd' };
    },
    async reply(reply: unknown) {
      calls.replies.push(reply);
      return { messageId: 'rep' };
    },
  } as unknown as ForwardableEmailMessage;
  return { message, calls };
}

const INBOUND_MIME =
  'From: sender@example.com\r\n' +
  'To: support@mail.acme.com\r\n' +
  'Subject: Help\r\n' +
  'Message-ID: <orig-1@example.com>\r\n' +
  '\r\n' +
  'my order is missing\r\n';

/**
 * Runs the GENERATED `handleEmail` from `compileWorkerEntry` with the real
 * runtime wired in and the user handler injected — the seam between "record
 * the actions" and "enact them on the native message" is what is under test.
 */
function buildHandleEmail(
  userHandler: (
    message: ForwardableEmailMessage,
    env: unknown,
    ctx: unknown,
    opts?: { slug?: string },
  ) => Promise<void>,
): (envelope: unknown, env: unknown, ctx: unknown) => Promise<unknown> {
  const code = compileWorkerEntry({ hasEmail: true });
  const start = code.indexOf('async function handleEmail');
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf('\n}\n', start);
  const body = code.slice(start, end + 3);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(
    '__filterInternalBindings',
    '__createMessageProxy',
    '__enactEmailActions',
    '__isForwardableEmailMessage',
    '__withRawEnv',
    'withRuntimeEnv',
    '__emailHandler',
    `${body}\nreturn handleEmail;`,
  )(
    (env: unknown) => env,
    createMessageProxy,
    enactEmailActions,
    isForwardableEmailMessage,
    (env: unknown, fn: () => unknown) => envContext.run(env as never, fn),
    withRuntimeEnv,
    userHandler,
  ) as never;
}

describe('generated handleEmail on a native ForwardableEmailMessage', () => {
  it('enacts setReject on the real message', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      message.setReject('no thanks');
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      mime: INBOUND_MIME,
    });

    const actions = await handleEmail(message, {}, {});

    expect(calls.rejects).toEqual(['no thanks']);
    expect(actions).toEqual([{ type: 'reject', reason: 'no thanks' }]);
  });

  it('enacts forward with its headers as a Headers instance', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      await message.forward('ops@acme.com', new Headers({ 'X-Void-Trace': 'abc' }));
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      mime: INBOUND_MIME,
    });

    await handleEmail(message, {}, {});

    expect(calls.forwards).toHaveLength(1);
    expect(calls.forwards[0].to).toBe('ops@acme.com');
    expect(calls.forwards[0].headers).toBeInstanceOf(Headers);
    expect(calls.forwards[0].headers?.get('X-Void-Trace')).toBe('abc');
  });

  it('enacts a forward recorded after parseEmail drained the native raw stream', async () => {
    // Native forwarding must still work after parsing consumes the raw stream.
    const handleEmail = buildHandleEmail(async (message) => {
      const parsed = await parseEmail(message);
      await message.forward('ops@acme.com', new Headers({ 'X-Subject': parsed.subject ?? '' }));
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      mime: INBOUND_MIME,
    });
    const actions = await handleEmail(message, {}, {});

    expect(await readAll(message.raw)).toBe('');
    expect(calls.forwards).toHaveLength(1);
    expect(calls.forwards[0].to).toBe('ops@acme.com');
    expect(calls.forwards[0].headers?.get('X-Subject')).toBe('Help');
    expect(actions).toEqual([
      { type: 'forward', to: 'ops@acme.com', headers: { 'x-subject': 'Help' } },
    ]);
  });

  it('fires nothing on the native message when a later forward carries an invalid header record', async () => {
    // The plain-record form is stored verbatim, so a bad header must fail in
    // the handler's own call, before the first forward is enacted.
    const handleEmail = buildHandleEmail(async (message) => {
      await message.forward('ops@acme.com');
      // The record form is a runtime affordance (JS handlers, or a cast):
      // `ForwardableEmailMessage.forward` is typed against `Headers`.
      const record = { 'X-Void-Trace': 'abc\r\nBcc: leak@evil.test' } as unknown as Headers;
      await message.forward('archive@acme.com', record);
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      mime: INBOUND_MIME,
    });

    const outcome = await handleEmail(message, {}, {}).then(
      () => 'resolved',
      (e: unknown) => e,
    );

    expect(calls.forwards).toEqual([]);
    expect(calls.replies).toEqual([]);
    expect(calls.rejects).toEqual([]);
    expect(outcome).toBeInstanceOf(MimeError);
    expect((outcome as MimeError).message).toMatch(/^forward: invalid header/);
  });

  it('enacts replyEmail as a real EmailMessage sent from the delivered address', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      // Both reads of the one-shot native stream must work: the proxy
      // buffers it so a parse followed by a reply is the ordinary case.
      const parsed = await parseEmail(message);
      await replyEmail(message, { text: `re: ${parsed.text?.trim()}` });
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      mime: INBOUND_MIME,
    });

    // No __VOID_PROJECT_SLUG: the reply sender is message.to itself.
    const actions = await handleEmail(message, {}, {});

    expect(calls.replies).toHaveLength(1);
    const reply = calls.replies[0] as InstanceType<typeof fake.FakeEmailMessage>;
    expect(reply).toBeInstanceOf(fake.FakeEmailMessage);
    expect(reply.from).toBe('support@mail.acme.com');
    expect(reply.to).toBe('sender@example.com');
    const raw = await readAll(reply.raw);
    expect(raw).toContain('Subject: Re: Help');
    expect(raw).toContain('In-Reply-To: <orig-1@example.com>');
    expect(raw).toContain('re: my order is missing');
    expect(actions).toMatchObject([
      { type: 'reply', from: 'support@mail.acme.com', to: 'sender@example.com' },
    ]);
  });

  it('keeps the platform reply sender when a slug is injected', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      await replyEmail(message, { text: 'ack' });
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'acme+support@mail.void.cloud',
      mime: INBOUND_MIME,
    });

    await handleEmail(
      message,
      { __VOID_PROJECT_SLUG: 'acme', __VOID_EMAIL_DOMAIN: 'mail.void.cloud' },
      {},
    );

    const reply = calls.replies[0] as InstanceType<typeof fake.FakeEmailMessage>;
    expect(reply.from).toBe('acme+noreply@mail.void.cloud');
  });

  it('hands the native setReject() the reason the platform router would send', async () => {
    // The parser unfolds the encoded CRLF, but the decoded subject still
    // contains a NUL. The proxy must bound and normalize the reason before
    // replaying it through native setReject(), matching the platform router.
    const handleEmail = buildHandleEmail(async (message) => {
      const parsed = await parseEmail(message);
      message.setReject(`unwanted: ${parsed.subject}${'!'.repeat(2000)}`);
    });
    const { message, calls } = nativeMessage({
      from: 'sender@example.com',
      to: 'support@mail.acme.com',
      mime:
        'From: sender@example.com\r\n' +
        'To: support@mail.acme.com\r\n' +
        'Subject: =?UTF-8?Q?spam=0D=0ABcc:_x=00?=\r\n' +
        '\r\n' +
        'body\r\n',
    });

    const actions = await handleEmail(message, {}, {});

    // The parsed prefix is 22 characters, leaving room for 978 "!".
    // Replacing the remaining NUL with a space preserves the window's length.
    const expected = `unwanted: spam Bcc: x ${'!'.repeat(978)}`;
    expect(calls.rejects).toEqual([expected]);
    expect(actions).toEqual([{ type: 'reject', reason: expected }]);
  });

  it('returns actions for an authenticated receipt envelope without native enaction', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      message.setReject('spam');
    });
    const envelope = {
      from: 'sender@example.com',
      to: 'acme+support@mail.void.cloud',
      headers: {},
      raw: new TextEncoder().encode(INBOUND_MIME),
      rawSize: INBOUND_MIME.length,
    };

    const actions = await handleEmail(envelope, { __VOID_PROJECT_SLUG: 'acme' }, {});

    expect(actions).toEqual([{ type: 'reject', reason: 'spam' }]);
    expect(isForwardableEmailMessage(envelope)).toBe(false);
  });
});

/**
 * A verified custom-domain receipt carries `viaDomain` and a recipient
 * without a `<slug>+` prefix, while
 * provisioning still injects `__VOID_PROJECT_SLUG` unconditionally. The
 * generated `handleEmail` must suppress the slug so the dispatcher runs in
 * no-prefix mode — left applied, the strip would take
 * everything up to the first `+` and `support+T-42@acme.com` would dispatch
 * as `T-42` to `_default` or a wrong `[user]` param.
 */
describe('generated handleEmail on a verified custom-domain receipt', () => {
  function relayEnvelope(to = 'support+T-42@acme.com') {
    return {
      from: 'sender@example.com',
      to,
      headers: {},
      raw: new TextEncoder().encode(INBOUND_MIME),
      rawSize: INBOUND_MIME.length,
      viaDomain: 'acme.com',
    };
  }

  it('suppresses the injected slug: the recipient reaches the handler unstripped', async () => {
    const seen: Array<{ to: string; slug: unknown; platformTo: unknown }> = [];
    const handleEmail = buildHandleEmail(async (message, _env, _ctx, opts) => {
      seen.push({
        to: message.to,
        slug: opts?.slug,
        platformTo: (message as { __voidPlatformTo?: unknown }).__voidPlatformTo,
      });
    });

    // The slug deliberately equals the local-part prefix: stripping keyed on
    // the slug alone would turn `support+T-42@` into `T-42@`.
    const actions = await handleEmail(relayEnvelope(), { __VOID_PROJECT_SLUG: 'support' }, {});

    expect(seen).toEqual([{ to: 'support+T-42@acme.com', slug: undefined, platformTo: undefined }]);
    expect(actions).toEqual([]);
  });

  it('still strips the slug for a platform-lane envelope (no viaDomain)', async () => {
    const seen: Array<{ to: string; slug: unknown }> = [];
    const handleEmail = buildHandleEmail(async (message, _env, _ctx, opts) => {
      seen.push({ to: message.to, slug: opts?.slug });
    });
    const envelope = {
      from: 'sender@example.com',
      to: 'acme+support@mail.void.cloud',
      headers: {},
      raw: new TextEncoder().encode(INBOUND_MIME),
      rawSize: INBOUND_MIME.length,
    };

    await handleEmail(envelope, { __VOID_PROJECT_SLUG: 'acme' }, {});

    expect(seen).toEqual([{ to: 'support@mail.void.cloud', slug: 'acme' }]);
  });

  it('defaults replyEmail from to the receiving address on the customer domain', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      await replyEmail(message, { text: 'ack' });
    });

    const actions = (await handleEmail(
      relayEnvelope(),
      { __VOID_PROJECT_SLUG: 'acme', __VOID_EMAIL_DOMAIN: 'mail.void.cloud' },
      {},
    )) as Array<{ type: string; from: string; to: string }>;

    // The spec's "Inbound identity": a reply to a relayed message leaves
    // from the address that received it, on the customer domain — the
    // platform's reply pin accepts exactly that shape for the receiving
    // project, and the shared-sender `<slug>+noreply@` default would fail it.
    expect(actions).toMatchObject([
      { type: 'reply', from: 'support+T-42@acme.com', to: 'sender@example.com' },
    ]);
  });

  it('keeps the shared-sender reply default on the platform lane', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      await replyEmail(message, { text: 'ack' });
    });
    const envelope = {
      from: 'sender@example.com',
      to: 'acme+support@mail.void.cloud',
      headers: {},
      raw: new TextEncoder().encode(INBOUND_MIME),
      rawSize: INBOUND_MIME.length,
    };

    const actions = (await handleEmail(
      envelope,
      { __VOID_PROJECT_SLUG: 'acme', __VOID_EMAIL_DOMAIN: 'mail.void.cloud' },
      {},
    )) as Array<{ type: string; from: string }>;

    expect(actions).toMatchObject([{ type: 'reply', from: 'acme+noreply@mail.void.cloud' }]);
  });
});

/**
 * A project with an email alias receives on `<alias>@<domain>` as well as
 * `<slug>@<domain>`. The platform router already matched the prefix to this
 * project, so the generated `handleEmail` strips the name the recipient used,
 * not the injected `__VOID_PROJECT_SLUG`.
 */
describe('generated handleEmail on a project email alias', () => {
  function sharedEnvelope(to: string) {
    return {
      from: 'sender@example.com',
      to,
      headers: {},
      raw: new TextEncoder().encode(INBOUND_MIME),
      rawSize: INBOUND_MIME.length,
    };
  }

  it('strips the alias prefix the same way it strips the slug prefix', async () => {
    const seen: Array<{ to: string; slug: unknown }> = [];
    const handleEmail = buildHandleEmail(async (message, _env, _ctx, opts) => {
      seen.push({ to: message.to, slug: opts?.slug });
    });
    const env = { __VOID_PROJECT_SLUG: 'proj' };

    await handleEmail(sharedEnvelope('alias+orders@mail.void.cloud'), env, {});
    await handleEmail(sharedEnvelope('proj+orders@mail.void.cloud'), env, {});

    expect(seen).toEqual([
      { to: 'orders@mail.void.cloud', slug: 'alias' },
      { to: 'orders@mail.void.cloud', slug: 'proj' },
    ]);
  });

  it('keys a bare alias address on the alias, so it reads as an empty tag', async () => {
    const seen: Array<{ to: string; slug: unknown }> = [];
    const handleEmail = buildHandleEmail(async (message, _env, _ctx, opts) => {
      seen.push({ to: message.to, slug: opts?.slug });
    });

    await handleEmail(sharedEnvelope('alias@mail.void.cloud'), { __VOID_PROJECT_SLUG: 'proj' }, {});

    // Keyed on `proj`, the dispatcher would read `alias` as an address.
    expect(seen).toEqual([{ to: 'alias@mail.void.cloud', slug: 'alias' }]);
  });

  it('still strips nothing when no slug is injected', async () => {
    const seen: Array<{ to: string; slug: unknown }> = [];
    const handleEmail = buildHandleEmail(async (message, _env, _ctx, opts) => {
      seen.push({ to: message.to, slug: opts?.slug });
    });

    await handleEmail(sharedEnvelope('alias+orders@mail.void.cloud'), {}, {});

    expect(seen).toEqual([{ to: 'alias+orders@mail.void.cloud', slug: undefined }]);
  });

  it('keeps the slug shared-sender reply default when the alias received the message', async () => {
    const handleEmail = buildHandleEmail(async (message) => {
      await replyEmail(message, { text: 'ack' });
    });

    const actions = (await handleEmail(
      sharedEnvelope('alias+orders@mail.void.cloud'),
      { __VOID_PROJECT_SLUG: 'proj', __VOID_EMAIL_DOMAIN: 'mail.void.cloud' },
      {},
    )) as Array<{ type: string; from: string }>;

    expect(actions).toMatchObject([{ type: 'reply', from: 'proj+noreply@mail.void.cloud' }]);
  });
});
