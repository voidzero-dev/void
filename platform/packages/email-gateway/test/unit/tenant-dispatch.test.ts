import { describe, expect, it, vi } from 'vite-plus/test';
import { dispatchBoundedEmailToTenant } from '../../src/tenant-dispatch.ts';

describe('bounded tenant email dispatch', () => {
  it('times out a service binding fetch that ignores abort', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const stub = {
        fetch: vi.fn((_url: string, init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          markStarted();
          return new Promise<Response>(() => {});
        }),
      };
      const pending = dispatchBoundedEmailToTenant(
        stub,
        { EMAIL_SIGNING_SECRET: 'secret' },
        {
          projectId: 'project-1',
          deploymentId: 'deployment-1',
          receiptId: 'a'.repeat(64),
          envelope: {
            from: 'sender@example.com',
            to: 'support@example.com',
            headers: {},
            raw: new Uint8Array(),
            rawSize: 0,
          },
        },
      );
      const rejected = expect(pending).rejects.toThrow('email tenant request timeout');
      await started;
      await vi.advanceTimersByTimeAsync(20_001);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
