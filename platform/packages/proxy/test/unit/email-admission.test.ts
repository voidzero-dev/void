import { describe, expect, it, vi } from 'vite-plus/test';
import { admitEmail, emailPayloadDigest, finishEmailAttempt } from '../../src/email-admission.ts';

const encoder = new TextEncoder();
function message(date: string, id: string, boundary: string, body: string) {
  return encoder.encode(
    [
      `Date: ${date}`,
      'From: acme@mail.example.com',
      'To: recipient@example.com',
      'Subject: hello',
      `Message-ID: <${id}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      '',
      body,
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  );
}

function nestedMessage(generation: string, bodyLine: string) {
  const depth = 64;
  const boundaries = Array.from(
    { length: depth },
    (_, index) => `=_void_mixed_${generation}_${index}`,
  );
  const lines = [
    `Date: Fri, 18 Sep 2026 01:00:${generation.padStart(2, '0')} +0000`,
    'From: acme@mail.example.com',
    'To: recipient@example.com',
    `Message-ID: <${generation}@mail.example.com>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundaries[0]}"`,
    '',
  ];
  for (let index = 0; index < boundaries.length - 1; index++) {
    lines.push(
      `--${boundaries[index]}`,
      `Content-Type: multipart/mixed; boundary="${boundaries[index + 1]}"`,
      '',
    );
  }
  lines.push(
    `--${boundaries.at(-1)}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    ...Array.from({ length: 512 }, () => bodyLine),
  );
  for (let index = boundaries.length - 1; index >= 0; index--) {
    lines.push(`--${boundaries[index]}--`);
  }
  lines.push('');
  return encoder.encode(lines.join('\r\n'));
}

describe('email admission payload digest', () => {
  it('deduplicates retries when generated date, message ID and multipart boundary change', async () => {
    const a = message(
      'Fri, 18 Sep 2026 01:00:00 +0000',
      'one@mail.example.com',
      '=_void_mixed_AAAA',
      'hello',
    );
    const b = message(
      'Fri, 18 Sep 2026 01:01:00 +0000',
      'two@mail.example.com',
      '=_void_mixed_BBBB',
      'hello',
    );
    expect(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], a),
    ).toBe(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], b),
    );

    const boundaryEndingInDashesA = message(
      'Fri, 18 Sep 2026 01:00:00 +0000',
      'one@mail.example.com',
      '=_void_mixed_A--',
      'hello',
    );
    const boundaryEndingInDashesB = message(
      'Fri, 18 Sep 2026 01:01:00 +0000',
      'two@mail.example.com',
      '=_void_mixed_B--',
      'hello',
    );
    expect(
      await emailPayloadDigest(
        'direct',
        'acme@mail.example.com',
        ['recipient@example.com'],
        boundaryEndingInDashesA,
      ),
    ).toBe(
      await emailPayloadDigest(
        'direct',
        'acme@mail.example.com',
        ['recipient@example.com'],
        boundaryEndingInDashesB,
      ),
    );

    const dateOnlyA = encoder.encode('Date: first\r\nFrom: acme@mail.example.com\r\n\r\nhello');
    const dateOnlyB = encoder.encode('Date: second\r\nFrom: acme@mail.example.com\r\n\r\nhello');
    expect(
      await emailPayloadDigest(
        'direct',
        'acme@mail.example.com',
        ['recipient@example.com'],
        dateOnlyA,
      ),
    ).toBe(
      await emailPayloadDigest(
        'direct',
        'acme@mail.example.com',
        ['recipient@example.com'],
        dateOnlyB,
      ),
    );
  });

  it('conflicts on changed message content and preserves boundary-like body text', async () => {
    const a = message(
      'Fri, 18 Sep 2026 01:00:00 +0000',
      'one@mail.example.com',
      '=_void_mixed_AAAA',
      'hello =_void_mixed_AAAA',
    );
    const b = message(
      'Fri, 18 Sep 2026 01:01:00 +0000',
      'two@mail.example.com',
      '=_void_mixed_BBBB',
      'hello =_void_mixed_BBBB',
    );
    expect(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], a),
    ).not.toBe(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], b),
    );
    const c = message(
      'Fri, 18 Sep 2026 01:00:00 +0000',
      'one@mail.example.com',
      '=_void_mixed_AAAA',
      'changed',
    );
    expect(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], a),
    ).not.toBe(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], c),
    );
  });

  it('does not normalize a boundary declaration written as ordinary body text', async () => {
    const a = message(
      'Fri, 18 Sep 2026 01:00:00 +0000',
      'one@mail.example.com',
      '=_void_mixed_AAAA',
      'literal boundary="=_void_mixed_body_A"',
    );
    const b = message(
      'Fri, 18 Sep 2026 01:01:00 +0000',
      'two@mail.example.com',
      '=_void_mixed_BBBB',
      'literal boundary="=_void_mixed_body_B"',
    );
    expect(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], a),
    ).not.toBe(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], b),
    );
  });

  it('unfolds boundary headers on SP or HTAB only and keeps other leading whitespace', async () => {
    const folded = (fold: string, boundary: string) =>
      encoder.encode(
        [
          'From: acme@mail.example.com',
          'MIME-Version: 1.0',
          'Content-Type: multipart/alternative;',
          `${fold}boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          '',
          'hello',
          `--${boundary}--`,
          '',
        ].join('\r\n'),
      );
    const digest = (raw: Uint8Array) =>
      emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], raw);

    const ideographicSpace = String.fromCodePoint(0x30_00);

    const space = await digest(folded(' ', '=_void_alternative_AAAA'));
    expect(await digest(folded('\t', '=_void_alternative_BBBB'))).toBe(space);
    expect(await digest(folded('  \t ', '=_void_alternative_CCCC'))).toBe(space);
    expect(await digest(folded(` ${ideographicSpace}`, '=_void_alternative_DDDD'))).not.toBe(space);
  });

  it('normalizes deeply nested generated boundaries without normalizing dense body lines', async () => {
    const a = nestedMessage('1', 'same body');
    const b = nestedMessage('2', 'same body');
    const changed = nestedMessage('3', 'changed body');

    const first = await emailPayloadDigest(
      'direct',
      'acme@mail.example.com',
      ['recipient@example.com'],
      a,
    );
    expect(first).toBe(
      await emailPayloadDigest('direct', 'acme@mail.example.com', ['recipient@example.com'], b),
    );
    expect(first).not.toBe(
      await emailPayloadDigest(
        'direct',
        'acme@mail.example.com',
        ['recipient@example.com'],
        changed,
      ),
    );
  });
});

describe('email admission service deadline', () => {
  it('allows an admission response after five seconds within the control deadline', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetch = vi.fn((_input: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                Response.json({
                  operationId: 'emailact_1',
                  replay: false,
                  recipients: [
                    {
                      recipient: 'recipient@example.com',
                      state: 'reserved',
                      errorCode: null,
                      providerReference: null,
                    },
                  ],
                }),
              ),
            6000,
          );
        });
      });
      const pending = admitEmail(
        { API: { fetch } as never, EMAIL_SIGNING_SECRET: 'secret' },
        {
          projectId: 'project_1',
          kind: 'direct',
          key: 'request_1',
          digest: 'a'.repeat(64),
          from: 'sender@example.com',
          recipients: ['recipient@example.com'],
          transport: 'binding',
        },
      );

      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(6000);
      await expect(pending).resolves.toMatchObject({ operationId: 'emailact_1' });
      expect(signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a lifecycle checkpoint after five seconds within its control deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(
              () =>
                resolve(
                  Response.json({
                    recipients: [
                      {
                        recipient: 'recipient@example.com',
                        state: 'provider_accepted',
                        errorCode: null,
                        providerReference: 'message-1',
                      },
                    ],
                  }),
                ),
              6000,
            );
          }),
      );
      const pending = finishEmailAttempt(
        { API: { fetch } as never, EMAIL_SIGNING_SECRET: 'secret' },
        'emailact_1',
        ['recipient@example.com'],
        'provider_accepted',
        { providerReference: 'message-1' },
      );

      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(6000);
      await expect(pending).resolves.toMatchObject({
        recipients: [{ state: 'provider_accepted' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles when the service binding ignores its abort signal', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(() => new Promise<Response>(() => {}));
      const pending = admitEmail(
        { API: { fetch } as never, EMAIL_SIGNING_SECRET: 'secret' },
        {
          projectId: 'project_1',
          kind: 'direct',
          key: 'request_1',
          digest: 'a'.repeat(64),
          from: 'sender@example.com',
          recipients: ['recipient@example.com'],
          transport: 'binding',
        },
      );

      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      const rejection = expect(pending).rejects.toThrow('EMAIL_ADMISSION_TIMEOUT');
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
