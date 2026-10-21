import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { compileRouteTable, compileWorkerEntry } from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';

/**
 * Manual trigger auth for `/__void/scheduled` and `/__void/queue` is fixed
 * when the route table is compiled. Both bundles below are built with
 * NODE_ENV=development, so `import.meta.env.DEV` is true in each: only the
 * compile-time `dev` flag may pick the rule.
 */

const temporary = mkdtempSync(join(tmpdir(), 'void-trigger-auth-'));
const DEV_TOKEN = 'dev-trigger-token';
const PROXY_TOKEN = 'proxy-token';

type Worker = {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  buildKey: string;
  viteDev: boolean;
};

async function buildWorker(name: string, dev: boolean): Promise<Worker> {
  const dir = join(temporary, name);
  const cronsDir = join(dir, 'crons');
  const queuesDir = join(dir, 'queues');
  mkdirSync(cronsDir, { recursive: true });
  mkdirSync(queuesDir, { recursive: true });
  writeFileSync(join(cronsDir, 'sync.ts'), 'export default async () => {};\n');
  writeFileSync(join(queuesDir, 'emails.ts'), 'export default async () => {};\n');
  const runtimeEnvPath = join(dir, 'runtime-env.ts');
  writeFileSync(runtimeEnvPath, 'export function withRuntimeEnv(_env, fn) { return fn(); }\n');
  const routeTablePath = join(dir, 'virtual-void-routes.ts');
  const workerPath = join(dir, 'worker.ts');

  const scan: ScanResult = {
    routes: [],
    middleware: [],
    jobs: [{ filePath: 'sync.ts', name: 'sync', crons: ['0 * * * *'] }],
    queues: [{ filePath: 'emails.ts', name: 'emails', bindingName: 'QUEUE_EMAILS' }],
    pages: { pages: [], layouts: [], namedLayouts: [] },
  };
  writeFileSync(
    routeTablePath,
    compileRouteTable(scan, dir, dir, cronsDir, queuesDir, null, {
      honoPath: import.meta.resolve('hono'),
      honoRoutePath: import.meta.resolve('hono/route'),
      runtimeEnvPath,
      projectRoot: dir,
      homeDir: dir,
      reactRefresh: false,
      auth: null,
      dev,
      devTriggerToken: DEV_TOKEN,
    }),
  );
  writeFileSync(
    workerPath,
    `${compileWorkerEntry({ hasQueues: true, runtimeEnvPath })}
export { __VOID_BUILD_KEY } from "virtual:void-routes";
export const __viteDev = import.meta.env.DEV;\n`,
  );

  const output = join(dir, 'dist');
  await build({
    configFile: false,
    logLevel: 'silent',
    mode: 'development',
    plugins: [
      {
        name: 'void-trigger-auth-test',
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
    ) => { fetch(request: Request): Promise<Response> };
    __VOID_BUILD_KEY: string;
    __viteDev: boolean;
  };
  return {
    fetch: (request, env) => new module.default({} as ExecutionContext, env).fetch(request),
    buildKey: module.__VOID_BUILD_KEY,
    viteDev: module.__viteDev,
  };
}

function trigger(kind: 'scheduled' | 'queue', headers: Record<string, string>): Request {
  return new Request(`https://internal/__void/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(
      kind === 'scheduled'
        ? { cron: '0 * * * *', scheduledTime: 0 }
        : { queue: 'emails', messages: [] },
    ),
  });
}

let prod: Worker;
let dev: Worker;

describe('generated trigger auth', () => {
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'development');
    try {
      prod = await buildWorker('prod', false);
      dev = await buildWorker('dev', true);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  afterAll(() => {
    rmSync(temporary, { force: true, recursive: true });
  });

  it('builds both bundles with import.meta.env.DEV set', () => {
    expect(prod.viteDev).toBe(true);
    expect(dev.viteDev).toBe(true);
  });

  it.each(['scheduled', 'queue'] as const)(
    'keeps the build rule for %s in a dev=false compile with DEV=true',
    async (kind) => {
      const withToken = { __VOID_PROXY_TOKEN: PROXY_TOKEN };
      expect(
        (await prod.fetch(trigger(kind, { 'x-void-internal': PROXY_TOKEN }), withToken)).status,
      ).toBe(200);
      expect(
        (await prod.fetch(trigger(kind, { 'x-void-dev-trigger': DEV_TOKEN }), withToken)).status,
      ).toBe(401);
      expect(
        (await prod.fetch(trigger(kind, { 'x-void-internal': prod.buildKey }), withToken)).status,
      ).toBe(401);

      expect(
        (await prod.fetch(trigger(kind, { 'x-void-internal': prod.buildKey }), {})).status,
      ).toBe(200);
      expect(
        (await prod.fetch(trigger(kind, { 'x-void-dev-trigger': DEV_TOKEN }), {})).status,
      ).toBe(401);
    },
  );

  it.each(['scheduled', 'queue'] as const)(
    'accepts only the dev trigger header for %s in a dev=true compile',
    async (kind) => {
      const withToken = { __VOID_PROXY_TOKEN: PROXY_TOKEN };
      expect(
        (await dev.fetch(trigger(kind, { 'x-void-dev-trigger': DEV_TOKEN }), withToken)).status,
      ).toBe(200);
      expect(
        (await dev.fetch(trigger(kind, { 'x-void-internal': PROXY_TOKEN }), withToken)).status,
      ).toBe(401);
      expect((await dev.fetch(trigger(kind, { 'x-void-dev-trigger': DEV_TOKEN }), {})).status).toBe(
        200,
      );
      expect((await dev.fetch(trigger(kind, { 'x-void-internal': dev.buildKey }), {})).status).toBe(
        401,
      );
      expect((await dev.fetch(trigger(kind, { 'x-void-dev-trigger': 'wrong' }), {})).status).toBe(
        401,
      );
    },
  );
});
