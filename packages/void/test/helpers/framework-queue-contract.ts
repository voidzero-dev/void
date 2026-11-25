import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, vi } from 'vite-plus/test';
import { generateWrapper } from '../../src/cli/wrapper.ts';

export async function assertFrameworkQueueDelivery(dispatch: {
  queue(batch: never, env: never): Promise<void>;
}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'void-framework-queue-'));
  try {
    mkdirSync(join(root, 'queues'));
    writeFileSync(
      join(root, 'index.mjs'),
      'export default { fetch() { return new Response("framework fallback"); } };',
    );
    writeFileSync(
      join(root, 'queues/emails.ts'),
      `export default function(batch, env) {
      env.received.push(batch.messages.map(m => ({ id: m.id, year: m.timestamp.getUTCFullYear() })));
      batch.messages[0].ack();
      batch.messages[1].retry({ delaySeconds: 9 });
    }`,
    );
    await generateWrapper(root, 'index.mjs', root, {
      crons: [],
      queues: [{ name: 'emails', filePath: 'emails.ts', bindingName: 'QUEUE_EMAILS' }],
    });
    const { default: worker } = (await import(pathToFileURL(join(root, 'index.mjs')).href)) as {
      default: { fetch(request: Request, bindings: unknown, context: unknown): Promise<Response> };
    };
    const bindings = { __VOID_PROXY_TOKEN: 'token', received: [] as Array<unknown> };
    const forwarded: Array<Request> = [];
    const env = {
      ROUTING: {
        get: async () =>
          JSON.stringify({ workerName: 'app', queueName: 'emails', proxyToken: 'token' }),
      },
      DISPATCH: {
        get: () => ({
          fetch: (request: Request) => {
            forwarded.push(request);
            return worker.fetch(request, bindings, {});
          },
        }),
      },
    };
    const batch = {
      queue: 'project-emails',
      ackAll: vi.fn(),
      retryAll: vi.fn(),
      messages: ['one', 'two'].map((id) => ({
        id,
        body: {},
        timestamp: new Date('2026-01-01T00:00:00Z'),
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      })),
    };
    await dispatch.queue(batch as never, env as never);
    expect(forwarded).toHaveLength(1);
    expect(new URL(forwarded[0].url).pathname).toBe('/__void/queue');
    expect(bindings.received).toEqual([
      [
        { id: 'one', year: 2026 },
        { id: 'two', year: 2026 },
      ],
    ]);
    expect(batch.messages[0].ack).toHaveBeenCalledOnce();
    expect(batch.messages[1].retry).toHaveBeenCalledWith({ delaySeconds: 9 });
    expect(batch.retryAll).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
