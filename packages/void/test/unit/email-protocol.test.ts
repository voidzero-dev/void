import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { verifyEmailReceiptThroughProxy } from '../../src/runtime/email/protocol.ts';

const input = {
  receipt: 'receipt-token',
  projectId: 'project-1',
  deploymentId: 'deployment-1',
  recipient: 'support@example.com',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('email receipt proxy verification', () => {
  it('sends the project proof and accepts a bounded valid response', async () => {
    const fetch = vi.fn(async (_url: string | Request, _init?: RequestInit) =>
      Response.json({ valid: true, receiptId: 'receipt-1' }),
    );

    await expect(verifyEmailReceiptThroughProxy({ fetch }, 'project-token', input)).resolves.toBe(
      true,
    );
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://proxy/email/verify-receipt');
    expect(init?.headers).toMatchObject({ 'x-void-internal': 'project-token' });
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it('ends an uncooperative fetch at the absolute deadline and aborts its signal', async () => {
    vi.useFakeTimers();
    const captured: { signal: AbortSignal | null } = { signal: null };
    const verification = verifyEmailReceiptThroughProxy(
      {
        fetch(_input, init) {
          captured.signal = init?.signal ?? null;
          return new Promise<Response>(() => {});
        },
      },
      'project-token',
      input,
    );

    await vi.advanceTimersByTimeAsync(5000);

    await expect(verification).resolves.toBe(false);
    expect(captured.signal?.aborted).toBe(true);
  });

  it('strictly checks response bytes and declared length', async () => {
    const invalidUtf8 = await verifyEmailReceiptThroughProxy(
      {
        async fetch() {
          return new Response(new Uint8Array([0xff]), {
            headers: { 'content-length': '1' },
          });
        },
      },
      'project-token',
      input,
    );
    expect(invalidUtf8).toBe(false);

    const wrongLength = await verifyEmailReceiptThroughProxy(
      {
        async fetch() {
          return new Response('{}', { headers: { 'content-length': '3' } });
        },
      },
      'project-token',
      input,
    );
    expect(wrongLength).toBe(false);

    const oversized = await verifyEmailReceiptThroughProxy(
      {
        async fetch() {
          return new Response(new Uint8Array(2 * 1024 + 1));
        },
      },
      'project-token',
      input,
    );
    expect(oversized).toBe(false);
  });

  it('does not await cancellation of a stalled response stream', async () => {
    vi.useFakeTimers();
    let cancelled = 0;
    const verification = verifyEmailReceiptThroughProxy(
      {
        async fetch() {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled++;
                return new Promise<void>(() => {});
              },
            }),
          );
        },
      },
      'project-token',
      input,
    );

    await vi.advanceTimersByTimeAsync(5000);

    await expect(verification).resolves.toBe(false);
    expect(cancelled).toBe(1);
  });
});
