import { describe, expect, it, vi } from 'vite-plus/test';
import { hmacSignState } from '../../src/auth/hmac.ts';
import emailActions from '../../src/routes/internal-email-actions.ts';

describe('internal email action request bounds', () => {
  it('authenticates actions with the email key and rejects the login key', async () => {
    const bindings = { JWT_SECRET: 'login-key', EMAIL_SIGNING_SECRET: 'email-key' };
    const raw = '{}';
    const call = async (signingKey: string, emailKey = bindings.EMAIL_SIGNING_SECRET) =>
      emailActions.request(
        '/admit',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-void-internal': await hmacSignState(raw, signingKey),
          },
          body: raw,
        },
        { ...bindings, EMAIL_SIGNING_SECRET: emailKey },
      );
    expect((await call(bindings.EMAIL_SIGNING_SECRET)).status).toBe(400);
    expect((await call(bindings.JWT_SECRET)).status).toBe(403);
    expect((await call(bindings.JWT_SECRET, '')).status).toBe(403);
  });

  it('times out a stalled body without awaiting its cancellation', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel,
      });
      const request = new Request('https://api/internal/email/actions/admit', {
        method: 'POST',
        headers: { 'x-void-internal': 'present' },
        body,
        duplex: 'half',
      } as RequestInit);
      const result = emailActions.request(request);
      await vi.advanceTimersByTimeAsync(5001);
      const response = await result;
      expect(response.status).toBe(408);
      expect(await response.json()).toEqual({ error: 'action request timed out' });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
