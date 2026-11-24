import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vite-plus/test';
import { buildMime, normalizeEmail } from '../../../../../packages/void/src/runtime/email/mime.ts';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(
      public from: string,
      public to: string,
      public raw: unknown,
    ) {}
  },
}));
const { email } = await import('../../src/email.ts');

function fixture() {
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
  const apiFetch = vi.fn(async (request: Request | string, init?: RequestInit) => {
    const path = new URL(typeof request === 'string' ? request : request.url).pathname;
    const body = (
      typeof request === 'string' ? JSON.parse(String(init?.body)) : await request.json()
    ) as Record<string, unknown>;
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
        });
      }
      const entry = {
        operationId: `act_${key}`,
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
      });
    }
    const operationId = path.split('/').at(-2)!;
    const entry = [...actions.values()].find((a) => a.operationId === operationId)!;
    if (path.endsWith('/start')) {
      for (const recipient of body.recipients as Array<string>) {
        const row = entry.recipients.find((r) => r.recipient === recipient)!;
        if (row.state !== 'reserved') {
          return Response.json({ code: 'INVALID_STATE' }, { status: 409 });
        }
        row.state = 'attempt_started';
      }
    } else if (path.endsWith('/finish')) {
      for (const recipient of body.recipients as Array<string>) {
        const row = entry.recipients.find((r) => r.recipient === recipient)!;
        const expected = body.state === 'cancelled' ? 'reserved' : 'attempt_started';
        if (row.state !== expected) {
          return Response.json({ code: 'INVALID_STATE' }, { status: 409 });
        }
        row.state = body.state as string;
        row.providerReference = (body.providerReference as string) ?? null;
        row.errorCode = (body.errorCode as string) ?? null;
      }
    }
    return Response.json({ recipients: entry.recipients });
  });
  const sender = vi.fn(async () => ({ messageId: 'provider-1' }));
  const env = {
    API: { fetch: apiFetch },
    EMAIL_SIGNING_SECRET: 'test-secret',
    SEND_EMAIL: { send: sender },
    EMAIL_SENDER_DOMAIN: 'mail.example.com',
    ROUTING: { get: vi.fn() },
  };
  const app = new Hono<{ Variables: { projectId: string; body: unknown } }>();
  app.use('*', async (context, next) => {
    context.set('projectId', 'proj_000000000001');
    context.set('body', await context.req.json());
    await next();
  });
  app.route('/email', email);
  const send = async (key: string, recipients = ['one@example.com'], raw?: Uint8Array) =>
    app.request(
      '/email/send',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          from: 'acme+news@mail.example.com',
          recipients,
          mimeBase64: btoa(
            raw
              ? Array.from(raw, (byte) => String.fromCharCode(byte)).join('')
              : 'From: acme+news@mail.example.com\r\nSubject: hello\r\n\r\nbody',
          ),
          idempotencyKey: key,
        }),
      },
      env,
    );
  return { send, sender, apiFetch, actions };
}

describe('proxy email admission delivery', () => {
  it('replays rebuilt SDK multipart MIME without another provider submission', async () => {
    const test = fixture();
    const options = {
      from: 'acme+news@mail.example.com',
      to: 'one@example.com',
      subject: 'multipart retry',
      text: 'Plain text',
      html: '<p>HTML</p>',
      attachments: [{ filename: 'note.txt', content: 'Attachment', contentType: 'text/plain' }],
    };
    const normalized = await normalizeEmail(options);
    const firstMime = buildMime(normalized).raw;
    const retryMime = buildMime(normalized).raw;
    const first = await test.send('multipart', undefined, firstMime);
    const retry = await test.send('multipart', undefined, retryMime);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(test.sender).toHaveBeenCalledTimes(1);

    const changed = buildMime(await normalizeEmail({ ...options, text: 'Changed text' })).raw;
    expect((await test.send('multipart', undefined, changed)).status).toBe(409);
    expect(test.sender).toHaveBeenCalledTimes(1);
  });

  it('replays a caller key without another provider submission', async () => {
    const test = fixture();
    expect((await test.send('one')).status).toBe(200);
    expect((await test.send('one')).status).toBe(200);
    expect(test.sender).toHaveBeenCalledTimes(1);
    expect(test.actions.get('one')?.recipients[0]?.state).toBe('provider_accepted');
  });

  it('persists uncertainty for one recipient while continuing a partial fanout', async () => {
    const test = fixture();
    test.sender.mockImplementationOnce(async () => {
      throw new Error('timeout');
    });
    const result = await test.send('partial', ['one@example.com', 'two@example.com']);
    const body = await result.json<{
      deliveries: Array<{ recipient: string; state: string }>;
    }>();
    expect(body.deliveries).toEqual(
      expect.arrayContaining([
        {
          recipient: 'one@example.com',
          state: 'outcome_unknown',
          ok: false,
          error: expect.any(Object),
        },
        {
          recipient: 'two@example.com',
          state: 'provider_accepted',
          ok: true,
          messageId: 'provider-1',
        },
      ]),
    );
    expect(test.actions.get('partial')?.recipients.map((r) => r.state)).toEqual([
      'outcome_unknown',
      'provider_accepted',
    ]);
  });

  it('cancels and durably replays a reservation when start fails before committing', async () => {
    const test = fixture();
    const normalFetch = test.apiFetch.getMockImplementation()!;
    test.apiFetch.mockImplementation(async (request, init) => {
      const path = new URL(typeof request === 'string' ? request : request.url).pathname;
      return path.endsWith('/start')
        ? new Response(null, { status: 503 })
        : normalFetch(request, init);
    });

    const first = await (
      await test.send('unstarted')
    ).json<{
      deliveries: Array<{ state: string; error: { code: string } }>;
    }>();
    expect(first.deliveries[0]).toMatchObject({
      state: 'cancelled',
      error: { code: 'UPSTREAM_ERROR' },
    });
    expect(test.actions.get('unstarted')?.recipients[0]?.state).toBe('cancelled');
    expect(test.sender).not.toHaveBeenCalled();

    const replay = await (
      await test.send('unstarted')
    ).json<{
      deliveries: Array<{ state: string; error: { code: string } }>;
    }>();
    expect(replay.deliveries[0]).toMatchObject({
      state: 'cancelled',
      error: { code: 'UPSTREAM_ERROR' },
    });
    expect(test.sender).not.toHaveBeenCalled();
  });

  it('keeps the outcome unknown when start committed but its response was lost', async () => {
    const test = fixture();
    const normalFetch = test.apiFetch.getMockImplementation()!;
    test.apiFetch.mockImplementation(async (request, init) => {
      const path = new URL(typeof request === 'string' ? request : request.url).pathname;
      if (path.endsWith('/start')) {
        await normalFetch(request, init);
        return new Response(null, { status: 503 });
      }
      return normalFetch(request, init);
    });

    const body = await (
      await test.send('ambiguous-start')
    ).json<{
      deliveries: Array<{ state: string; error: { code: string } }>;
    }>();
    expect(body.deliveries[0]).toMatchObject({
      state: 'outcome_unknown',
      error: { code: 'OUTCOME_UNKNOWN' },
    });
    expect(test.actions.get('ambiguous-start')?.recipients[0]?.state).toBe('attempt_started');
    expect(test.sender).not.toHaveBeenCalled();
  });
});
