import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  RELAY_COMPATIBILITY_DATE,
  RELAY_GATEWAY_ORIGIN_BINDING,
  RELAY_ACCOUNT_BINDING,
  RELAY_ZONE_BINDING,
  RELAY_INGRESS_BINDING,
  RELAY_SECRET_BINDING,
  RELAY_SOURCE,
  RELAY_VERSION,
} from '../../src/email/relay-worker.ts';

// Dummy stand-ins — never real secret material.
const RELAY_SECRET = 'relay-secret-dummy';
const MIME_BODY = 'MIME-DUMMY-BODY';

// Node lacks the Workers-only FixedLengthStream global the relay source
// pipes through — mirror workerd's semantics (same shape as the
// integration harness's polyfill) so the evaluated source runs as-is.
if ((globalThis as { FixedLengthStream?: unknown }).FixedLengthStream === undefined) {
  class NodeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
    constructor(expectedLength: number) {
      let written = 0;
      super({
        transform(chunk, controller) {
          written += chunk.byteLength;
          if (written > expectedLength) {
            controller.error(new TypeError('FixedLengthStream: length exceeded'));
            return;
          }
          controller.enqueue(chunk);
        },
        flush(controller) {
          if (written !== expectedLength) {
            controller.error(new TypeError('FixedLengthStream: length mismatch'));
          }
        },
      });
    }
  }
  (globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = NodeFixedLengthStream;
}

type RelayEnv = Record<string, string>;
type RelayMessage = {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
  setReject: (reason: string) => void;
};

/**
 * Evaluate the embedded module-syntax source as-is and return its default
 * export, so the wire test exercises the exact code the api deploys.
 */
function loadRelayWorker(): {
  fetch: (request: Request, env: RelayEnv) => Promise<Response>;
  email: (
    message: RelayMessage,
    env: RelayEnv,
    ctx: { waitUntil: (p: Promise<unknown>) => void },
  ) => Promise<void>;
} {
  const factory = new Function(RELAY_SOURCE.replace('export default', 'return')) as () => {
    fetch: (request: Request, env: RelayEnv) => Promise<Response>;
    email: (
      message: RelayMessage,
      env: RelayEnv,
      ctx: { waitUntil: (p: Promise<unknown>) => void },
    ) => Promise<void>;
  };
  return factory();
}

function relayContext() {
  const env: RelayEnv = {
    [RELAY_SECRET_BINDING]: RELAY_SECRET,
    [RELAY_GATEWAY_ORIGIN_BINDING]: 'https://gateway.example.test',
    [RELAY_ACCOUNT_BINDING]: 'acct_1',
    [RELAY_ZONE_BINDING]: 'zone_1',
    [RELAY_INGRESS_BINDING]: 'void-zone-ingress',
  };
  const rawBytes = new TextEncoder().encode(MIME_BODY);
  const message: RelayMessage = {
    from: 'sender@example.org',
    to: 'support@acme.com',
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(rawBytes);
        controller.close();
      },
    }),
    rawSize: rawBytes.byteLength,
    setReject: vi.fn(),
  };
  const ctx = { waitUntil: vi.fn() };
  return { env, message, ctx };
}

describe('RELAY_SOURCE', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ships an integer RELAY_VERSION and a module-syntax default export', () => {
    expect(Number.isInteger(RELAY_VERSION)).toBe(true);
    expect(RELAY_SOURCE).toContain('export default');
    expect(RELAY_SOURCE).toContain('async email(message, env, ctx)');
    // No parsing, no buffering, no third-party imports.
    expect(RELAY_SOURCE).not.toMatch(/^\s*import\s/m);
  });

  it('reads exactly the binding names the uploader declares', () => {
    for (const binding of [
      RELAY_SECRET_BINDING,
      RELAY_GATEWAY_ORIGIN_BINDING,
      RELAY_ACCOUNT_BINDING,
      RELAY_ZONE_BINDING,
      RELAY_INGRESS_BINDING,
    ]) {
      expect(RELAY_SOURCE).toContain(`env.${binding}`);
    }
    expect(RELAY_COMPATIBILITY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('POSTs the raw MIME to the gateway through a FixedLengthStream with the zone identity', async () => {
    let uploaded = new Uint8Array();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      uploaded = new Uint8Array(await new Response(init.body).arrayBuffer());
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { env, message, ctx } = relayContext();

    await loadRelayWorker().email(message, env, ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example.test/email/ingress');
    expect(init.method).toBe('POST');
    // No hand-set Content-Length: the runtime ignores one on a stream body
    // and derives it from the FixedLengthStream instead — a plain stream
    // would go out chunked, and the proxy refuses a length-less body.
    expect(init.headers).toEqual({
      Authorization: `Bearer ${RELAY_SECRET}`,
      'X-Void-Email-Account': 'acct_1',
      'X-Void-Email-Zone': 'zone_1',
      'X-Void-Email-Ingress': 'void-zone-ingress',
      'X-Void-Email-Request-Id': expect.stringMatching(/^[a-f0-9-]{36}$/),
      'X-Void-Email-From': 'sender@example.org',
      'X-Void-Email-To': 'support@acme.com',
    });
    // Streamed straight through — no base64, no JSON envelope. The body is
    // the fixed-length transform's readable side, not the raw stream, and
    // draining it yields exactly rawSize bytes of the raw MIME.
    expect(RELAY_SOURCE).toContain('FixedLengthStream');
    const body = init.body as ReadableStream<Uint8Array>;
    expect(body).toBeInstanceOf(ReadableStream);
    expect(body).not.toBe(message.raw);
    expect(uploaded.byteLength).toBe(message.rawSize);
    expect(new TextDecoder().decode(uploaded)).toBe(MIME_BODY);
    expect(init.signal?.aborted).toBe(true);
    // The pump and the POST both ride waitUntil.
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('forwards another domain on the same zone for exact gateway resolution', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { env, message, ctx } = relayContext();
    message.to = 'user@other-acme.com';

    await loadRelayWorker().email(message, env, ctx);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      'X-Void-Email-To': 'user@other-acme.com',
    });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
  });

  it('forwards the SMTP envelope recipient without changing its case', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { env, message, ctx } = relayContext();
    message.to = 'Support@ACME.COM';

    await loadRelayWorker().email(message, env, ctx);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects with a short generic reason on a permanent refusal', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('nope', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const { env, message, ctx } = relayContext();

    await loadRelayWorker().email(message, env, ctx);

    expect(message.setReject).toHaveBeenCalledOnce();
    const reason = (message.setReject as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(typeof reason).toBe('string');
    expect(reason.length).toBeLessThanOrEqual(64);
    // The bounce goes back to the original sender — no internals leak.
    expect(reason).not.toContain(RELAY_SECRET);
    expect(reason).not.toContain('gateway.example.test');
    expect(reason).not.toContain('502');
  });

  it('throws temporary gateway failures without permanently rejecting the message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })));
    const { env, message, ctx } = relayContext();
    await expect(loadRelayWorker().email(message, env, ctx)).rejects.toThrow(
      'temporarily unavailable',
    );
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('aborts both a stalled gateway fetch and MIME pipe at the 60-second deadline', async () => {
    vi.useFakeTimers();
    try {
      const requestSignals: Array<AbortSignal> = [];
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        requestSignals.push(init.signal as AbortSignal);
        return new Promise<Response>(() => {});
      });
      vi.stubGlobal('fetch', fetchMock);
      const { env, message, ctx } = relayContext();
      const cancel = vi.fn();
      message.rawSize = 1;
      message.raw = new ReadableStream<Uint8Array>({ cancel });

      const pending = loadRelayWorker().email(message, env, ctx);
      const outcome = expect(pending).rejects.toThrow('temporarily unavailable');
      await vi.advanceTimersByTimeAsync(60_000);
      await outcome;

      expect(requestSignals[0]?.aborted).toBe(true);
      await Promise.all(ctx.waitUntil.mock.calls.map(([promise]) => promise as Promise<unknown>));
      expect(cancel).toHaveBeenCalledOnce();
      expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
      expect(message.setReject).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('proves the deployed secret with a challenge bound to the zone and generation', async () => {
    const { env } = relayContext();
    const challenge = 'a'.repeat(64);
    const response = await loadRelayWorker().fetch(
      new Request('https://worker.example/__void/email/probe', {
        method: 'POST',
        headers: { 'X-Void-Probe-Challenge': challenge, 'X-Void-Probe-Generation': '7' },
      }),
      env,
    );
    expect(response.status).toBe(200);
    const proof = await response.json<{
      accountId: string;
      zoneId: string;
      ingressName: string;
      generation: number;
      challenge: string;
      proof: string;
    }>();
    expect(proof).toMatchObject({
      accountId: 'acct_1',
      zoneId: 'zone_1',
      ingressName: 'void-zone-ingress',
      generation: 7,
      challenge,
    });
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(RELAY_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const payload = [
      'email-relay-proof-v1',
      'acct_1',
      'zone_1',
      'void-zone-ingress',
      '7',
      challenge,
    ].join('\n');
    const expected = Array.from(
      new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    expect(proof.proof).toBe(expected);
    expect(
      (
        await loadRelayWorker().fetch(
          new Request('https://worker.example/__void/email/probe', { method: 'POST' }),
          env,
        )
      ).status,
    ).toBe(400);
  });
});
