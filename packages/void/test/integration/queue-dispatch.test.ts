import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { compileRouteTable, compileWorkerEntry } from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';

const temporary = mkdtempSync(join(tmpdir(), 'void-queue-dispatch-'));
const output = join(temporary, 'dist');

type QueueResult = {
  ok: boolean;
  error?: string;
  decisions?: Record<string, { action: 'ack' | 'retry'; delaySeconds?: number }>;
};

type GeneratedWorker = {
  default: {
    fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response>;
    queue(batch: MessageBatch, env: Record<string, unknown>, ctx: ExecutionContext): Promise<void>;
  };
  __processQueue(
    payload: Record<string, unknown>,
    env: Record<string, unknown>,
  ): Promise<QueueResult>;
};

let generated: GeneratedWorker;

function queueHandlerSource(handler: string): string {
  return `export default async function handler(batch, env) {
  env.calls.push({
    handler: ${JSON.stringify(handler)},
    queue: batch.queue,
    attempts: batch.messages.map(message => message.attempts),
    dates: batch.messages.every(message => message.timestamp instanceof Date),
  });
  if (env.fail === ${JSON.stringify(handler)}) throw new Error("handler failed");
  batch.messages[0]?.ack();
  batch.messages[1]?.retry({ delaySeconds: 9 });
}\n`;
}

function payload(queue: string): Record<string, unknown> {
  return {
    queue,
    messages: [
      { id: 'one', timestamp: '2026-09-15T00:00:00.000Z', body: { n: 1 }, attempts: 2 },
      { id: 'two', timestamp: '2026-09-15T00:00:01.000Z', body: { n: 2 }, attempts: 3 },
    ],
  };
}

describe('generated queue dispatch', () => {
  beforeAll(async () => {
    const queuesDir = join(temporary, 'queues');
    const routeTablePath = join(temporary, 'virtual-void-routes.ts');
    const workerPath = join(temporary, 'worker.ts');
    const runtimeEnvPath = join(temporary, 'runtime-env.ts');
    mkdirSync(join(queuesDir, 'nested'), { recursive: true });

    writeFileSync(join(queuesDir, 'emails.ts'), queueHandlerSource('emails'));
    writeFileSync(join(queuesDir, 'order-emails.ts'), queueHandlerSource('order-emails'));
    writeFileSync(join(queuesDir, 'nested/daily.ts'), queueHandlerSource('nested/daily'));
    writeFileSync(runtimeEnvPath, 'export function withRuntimeEnv(_env, fn) { return fn(); }\n');

    const scan: ScanResult = {
      routes: [],
      middleware: [],
      jobs: [],
      queues: [
        {
          filePath: 'order-emails.ts',
          name: 'order-emails',
          bindingName: 'QUEUE_ORDER_EMAILS',
        },
        { filePath: 'emails.ts', name: 'emails', bindingName: 'QUEUE_EMAILS' },
        {
          filePath: 'nested/daily.ts',
          name: 'nested/daily',
          bindingName: 'CUSTOM_NESTED_QUEUE',
        },
      ],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    writeFileSync(
      routeTablePath,
      compileRouteTable(scan, temporary, temporary, temporary, queuesDir, null, {
        honoPath: import.meta.resolve('hono'),
        honoRoutePath: import.meta.resolve('hono/route'),
        runtimeEnvPath,
        projectRoot: temporary,
        homeDir: temporary,
        reactRefresh: false,
        auth: null,
      }),
    );
    writeFileSync(
      workerPath,
      `${compileWorkerEntry({ hasQueues: true, runtimeEnvPath })}
export { __processQueue } from "virtual:void-routes";\n`,
    );

    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'void-queue-dispatch-test',
          resolveId(id) {
            if (id === 'cloudflare:workers') {
              return '\0test-workers-entrypoint';
            }
            return id === 'virtual:void-routes' ? routeTablePath : null;
          },
          load(id) {
            if (id === '\0test-workers-entrypoint') {
              return 'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
            }
          },
        },
      ],
      ssr: { noExternal: true },
      build: {
        emptyOutDir: true,
        outDir: output,
        ssr: workerPath,
        target: 'esnext',
        rollupOptions: {
          external: (id) => id.startsWith('cloudflare:') && id !== 'cloudflare:workers',
          output: { entryFileNames: 'worker.mjs', codeSplitting: false },
        },
      },
    });

    const module = (await import(pathToFileURL(join(output, 'worker.mjs')).href)) as {
      default: new (
        ctx: ExecutionContext,
        env: Record<string, unknown>,
      ) => {
        fetch(request: Request): Promise<Response>;
        queue(batch: MessageBatch): Promise<void>;
      };
      __processQueue: GeneratedWorker['__processQueue'];
    };
    generated = {
      __processQueue: module.__processQueue,
      default: {
        fetch: (request, env, ctx) => new module.default(ctx, env).fetch(request),
        queue: (batch, env, ctx) => new module.default(ctx, env).queue(batch),
      },
    };
  }, 30_000);

  afterAll(() => {
    rmSync(temporary, { force: true, recursive: true });
  });

  it.each([
    ['emails', 'emails'],
    ['order-emails', 'order-emails'],
    ['project-emails', 'emails'],
    ['project-order-emails', 'order-emails'],
    ['project-nested/daily', 'nested/daily'],
  ])('dispatches queue %s only to %s', async (queue, expectedHandler) => {
    const env = { calls: [] as Array<Record<string, unknown>> };
    const result = await generated.__processQueue(payload(queue), env);

    expect(result).toEqual({
      ok: true,
      decisions: {
        one: { action: 'ack' },
        two: { action: 'retry', delaySeconds: 9 },
      },
    });
    expect(env.calls).toEqual([{ handler: expectedHandler, queue, attempts: [2, 3], dates: true }]);
  });

  it('returns failure without dispatching an unknown logical or physical queue', async () => {
    for (const queue of ['unknown', 'project-unknown']) {
      const env = { calls: [] as Array<Record<string, unknown>> };
      const result = await generated.__processQueue(payload(queue), env);

      expect(result).toEqual({
        ok: false,
        error: `No unambiguous queue handler matches "${queue}"`,
      });
      expect(env.calls).toEqual([]);
    }
  });

  it.each(['emails', 'order-emails'])(
    'dispatches the hosted relay schema by exact logical name for %s',
    async (queue) => {
      const env = { __VOID_PROXY_TOKEN: 'secret', calls: [] as Array<Record<string, unknown>> };
      const response = await generated.default.fetch(
        new Request('https://internal/__void/queue', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-void-internal': 'secret' },
          body: JSON.stringify(payload(queue)),
        }),
        env,
        {} as ExecutionContext,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        decisions: {
          one: { action: 'ack' },
          two: { action: 'retry', delaySeconds: 9 },
        },
      });
      expect(env.calls).toEqual([{ handler: queue, queue, attempts: [2, 3], dates: true }]);
    },
  );

  it('makes native unknown queues and handler failures retry by rejecting the event', async () => {
    const makeNativeBatch = (queue: string) => {
      const firstAck = vi.fn();
      const firstRetry = vi.fn();
      const secondAck = vi.fn();
      const secondRetry = vi.fn();
      return {
        batch: {
          queue,
          messages: [
            {
              id: 'one',
              timestamp: new Date('2026-09-15T00:00:00.000Z'),
              body: {},
              attempts: 2,
              ack: firstAck,
              retry: firstRetry,
            },
            {
              id: 'two',
              timestamp: new Date('2026-09-15T00:00:01.000Z'),
              body: {},
              attempts: 3,
              ack: secondAck,
              retry: secondRetry,
            },
          ],
          ackAll: vi.fn(),
          retryAll: vi.fn(),
        } as unknown as MessageBatch,
        firstAck,
        firstRetry,
        secondAck,
        secondRetry,
      };
    };

    const nativeSuccess = makeNativeBatch('project-order-emails');
    const successEnv = { calls: [] as Array<Record<string, unknown>> };
    await generated.default.queue(nativeSuccess.batch, successEnv, {} as ExecutionContext);
    expect(successEnv.calls).toEqual([
      {
        handler: 'order-emails',
        queue: 'project-order-emails',
        attempts: [2, 3],
        dates: true,
      },
    ]);
    expect(nativeSuccess.firstAck).toHaveBeenCalledOnce();
    expect(nativeSuccess.firstRetry).not.toHaveBeenCalled();
    expect(nativeSuccess.secondAck).not.toHaveBeenCalled();
    expect(nativeSuccess.secondRetry).toHaveBeenCalledWith({ delaySeconds: 9 });

    const nativeUnknown = makeNativeBatch('project-unknown');

    await expect(
      generated.default.queue(nativeUnknown.batch, { calls: [] }, {} as ExecutionContext),
    ).rejects.toThrow('queue: Handler failed');
    expect(nativeUnknown.firstAck).not.toHaveBeenCalled();
    expect(nativeUnknown.firstRetry).not.toHaveBeenCalled();
    expect(nativeUnknown.secondAck).not.toHaveBeenCalled();
    expect(nativeUnknown.secondRetry).not.toHaveBeenCalled();

    const nativeFailure = makeNativeBatch('project-order-emails');
    await expect(
      generated.default.queue(
        nativeFailure.batch,
        { calls: [], fail: 'order-emails' },
        {} as ExecutionContext,
      ),
    ).rejects.toThrow('queue: Handler failed');
  });
});
