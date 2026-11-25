import { describe, expect, it, vi } from 'vite-plus/test';
import { processCronFiresBatch } from '../../src/cron-fires-queue.ts';
import type { CronFireMessage } from '../../src/cron-fires-queue.ts';
import type { ApiEnv } from '../../src/env.ts';

type QueueMessageStub = {
  body: CronFireMessage;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
};

function makeMessage(body: CronFireMessage): QueueMessageStub {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

function makeBatch(messages: Array<QueueMessageStub>) {
  return {
    queue: 'void-cron-fires',
    messages,
    retryAll: vi.fn(),
    ackAll: vi.fn(),
  } as unknown as MessageBatch<CronFireMessage>;
}

function makeEnv(fetchImpl: (req: Request) => Promise<Response>): ApiEnv['Bindings'] {
  return {
    DISPATCH: {
      get: vi.fn((_workerName: string) => ({ fetch: fetchImpl })),
    },
  } as unknown as ApiEnv['Bindings'];
}

describe('processCronFiresBatch', () => {
  it('acks message when user worker returns 2xx on /__void/scheduled', async () => {
    const seen: Array<Request> = [];
    const env = makeEnv(async (req) => {
      seen.push(req);
      return new Response('{"ok":true}', { status: 200 });
    });
    const msg = makeMessage({
      workerName: 'user-foo-dpl_a',
      cron: '* * * * *',
      scheduledTime: 1_700_000_000_000,
      proxyToken: 'tok',
    });

    await processCronFiresBatch(makeBatch([msg]), env);

    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname).toBe('/__void/scheduled');
    expect(seen[0].headers.get('x-void-internal')).toBe('tok');
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('falls back to legacy /__scheduled when /__void/scheduled returns 404', async () => {
    const seen: Array<Request> = [];
    let n = 0;
    const env = makeEnv(async (req) => {
      seen.push(req);
      n += 1;
      return n === 1
        ? new Response('not found', { status: 404 })
        : new Response('{"ok":true}', { status: 200 });
    });
    const msg = makeMessage({
      workerName: 'user-foo-dpl_a',
      cron: '* * * * *',
      scheduledTime: 1_700_000_000_000,
    });

    await processCronFiresBatch(makeBatch([msg]), env);

    expect(seen).toHaveLength(2);
    expect(new URL(seen[1].url).pathname).toBe('/__scheduled');
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('acks 401 with AUTH_DRIFT marker (and does not retry — same token would yield same failure)', async () => {
    // Auth drift between CronScheduler's stored proxyToken and the user
    // worker's baked __VOID_PROXY_TOKEN: retry sends the same token back
    // and gets the same 401, so retry can't help. Ack; the next deploy's
    // /sync resyncs the token. Log with a stable AUTH_DRIFT marker so ops
    // can alert on the (rare) case this happens in production.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetchSpy = vi.fn(async () => new Response('unauthorized', { status: 401 }));
      const env = makeEnv(fetchSpy);
      const msg = makeMessage({
        workerName: 'user-foo-dpl_a',
        cron: '* * * * *',
        scheduledTime: 1_700_000_000_000,
        proxyToken: 'stale-tok',
      });

      await processCronFiresBatch(makeBatch([msg]), env);

      expect(msg.ack).toHaveBeenCalledOnce();
      expect(msg.retry).not.toHaveBeenCalled();
      // Stable marker that ops alerts can grep on.
      const errArg = errSpy.mock.calls.find((args) =>
        typeof args[0] === 'string' ? args[0].includes('AUTH_DRIFT') : false,
      );
      expect(errArg).toBeDefined();
      expect(errArg![0]).toContain('user-foo-dpl_a');
      expect(errArg![0]).toContain('status=401');
    } finally {
      errSpy.mockRestore();
    }
  });

  it.each([401, 403])(
    'invokes the cron handler once when the worker rejects the token with %i',
    async (status) => {
      // The Worker's own middleware runs before the cron route checks the
      // token, so a rejected fire is never sent again with another token.
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const fetchSpy = vi.fn(async () => Response.json({ error: 'unauthorized' }, { status }));
        const msg = makeMessage({
          workerName: 'user-foo-dpl_a',
          cron: '* * * * *',
          scheduledTime: 1_700_000_000_000,
          proxyToken: 'tok',
        });

        await processCronFiresBatch(makeBatch([msg]), makeEnv(fetchSpy));

        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(msg.ack).toHaveBeenCalledOnce();
        expect(msg.retry).not.toHaveBeenCalled();
        const drift = errSpy.mock.calls.filter((args) =>
          typeof args[0] === 'string' ? args[0].includes('AUTH_DRIFT') : false,
        );
        expect(drift).toHaveLength(1);
      } finally {
        errSpy.mockRestore();
      }
    },
  );

  it('acks 5xx responses and does not retry the user worker', async () => {
    // A Response (any status) means the user worker received the request.
    // The user's handler ran or made a routing decision — the queue is not
    // responsible for retrying application-level failures, since doing so
    // duplicates side effects (emails, payments, DB writes) for non-idempotent
    // cron handlers that fail mid-execution.
    const fetchSpy = vi.fn(async () => new Response('boom', { status: 500 }));
    const env = makeEnv(fetchSpy);
    const msg = makeMessage({
      workerName: 'user-foo-dpl_a',
      cron: '*/5 * * * *',
      scheduledTime: 1_700_000_000_000,
      proxyToken: 'tok',
    });

    await processCronFiresBatch(makeBatch([msg]), env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('acks unknown dispatch errors (at-most-once for crons)', async () => {
    // A throw that isn't "Worker not found" can come from the dispatch layer
    // (transport failure) OR from inside the user worker after it partially
    // executed (CPU limit, OOM, top-level uncaught). We can't distinguish
    // these from the error message alone, so we ack to preserve at-most-once
    // for cron handlers — retrying a partially-executed handler would
    // duplicate side effects. This deliberately restores the prior
    // at-most-once contract; we accept transient delivery-failure data loss
    // to prevent duplicate executions.
    const fetchSpy = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const env = makeEnv(fetchSpy);
    const msg = makeMessage({
      workerName: 'user-foo-dpl_a',
      cron: '* * * * *',
      scheduledTime: 1_700_000_000_000,
      proxyToken: 'tok',
    });

    await processCronFiresBatch(makeBatch([msg]), env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('drops (acks) the message when the worker is gone', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('Worker not found');
    });
    const env = makeEnv(fetchSpy);
    const msg = makeMessage({
      workerName: 'user-deleted-dpl_x',
      cron: '* * * * *',
      scheduledTime: 1_700_000_000_000,
    });

    await processCronFiresBatch(makeBatch([msg]), env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('processes multiple messages independently', async () => {
    const fetchSpy = vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      if (req.headers.get('x-void-internal') === 'fail') {
        return new Response('fail', { status: 500 });
      }
      return new Response('{"ok":true}', { status: 200, headers: { 'x-path': url.pathname } });
    });
    const env = makeEnv(fetchSpy);

    const ok = makeMessage({
      workerName: 'user-a',
      cron: '* * * * *',
      scheduledTime: 1,
      proxyToken: 'ok',
    });
    const bad = makeMessage({
      workerName: 'user-b',
      cron: '* * * * *',
      scheduledTime: 1,
      proxyToken: 'fail',
    });

    await processCronFiresBatch(makeBatch([ok, bad]), env);

    // Both received a Response from the user worker (one 200, one 500). The
    // queue acks both — application failure is not the queue's problem.
    expect(ok.ack).toHaveBeenCalledOnce();
    expect(ok.retry).not.toHaveBeenCalled();
    expect(bad.ack).toHaveBeenCalledOnce();
    expect(bad.retry).not.toHaveBeenCalled();
  });
});
