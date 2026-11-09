import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { compileWorkerEntry } from '../../src/router/compile.ts';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const temporary = mkdtempSync(join(tmpdir(), 'void-durable-rpc-'));
const output = join(temporary, 'dist');
type Runtime = { dispatchFetch(url: string): Promise<Response>; dispose(): Promise<void> };
let runtime: Runtime;
let createRuntime: () => Runtime;

describe('Durable State through the generated Worker and actual RPC', () => {
  beforeAll(async () => {
    const definition = join(temporary, 'counter.ts');
    const routes = join(temporary, 'routes.ts');
    const entry = join(temporary, 'entry.ts');
    writeFileSync(
      definition,
      `
import { defineDurableState } from ${JSON.stringify(join(root, 'packages/void/src/runtime/durable.ts'))};
export default defineDurableState({
  initialState: { count: 0 },
  fetch(context) { context.state.count += 10; return Response.json(context.state.count); },
  methods: {
    async increment(context, amount) { await Promise.resolve(); context.state.count += amount; return context.state.count; },
    read(context) { return context.state.count; },
    fail(context) { context.state.count++; throw new Error('deliberate failure'); },
    run(context) { return context.state.count; },
  },
});
`,
    );
    writeFileSync(
      routes,
      `
import Counter from ${JSON.stringify(definition)};
export const scheduled = async () => {};
export const __voidCollectPrerenderPaths = async () => [];
export const __voidRenderStaticNotFound = async () => new Response(null, { status: 204 });
export const __voidHandleInternalRoute = async () => null;
export const __withRawEnv = (_env, fn) => fn();
export default { async fetch(request) {
  const url = new URL(request.url);
  const stub = Counter.get(url.searchParams.get('name') || 'default');
  if (url.pathname === '/fetch') return stub.fetch(request);
  if (url.pathname === '/increment') return Response.json(await stub.increment(Number(url.searchParams.get('amount') || 1)));
  if (url.pathname === '/parallel') return Response.json(await Promise.all([stub.increment(1), stub.increment(2)]));
  if (url.pathname === '/fail') { try { await stub.fail(); } catch {} }
  if (url.pathname === '/helpers') {
    const accessible = {};
    for (const name of ['load', 'persist', 'context']) {
      try { await stub[name](); accessible[name] = true; } catch { accessible[name] = false; }
    }
    return Response.json({ accessible, declaredRun: await stub.run() });
  }
  return Response.json(await stub.read());
}};
`,
    );
    writeFileSync(
      entry,
      compileWorkerEntry({
        runtimeEnvPath: join(root, 'packages/void/src/runtime/env.ts'),
        durableObjects: [
          { bindingName: 'COUNTERS', className: 'CounterState', filePath: definition },
        ],
      }),
    );
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'durable-rpc-fixture',
          resolveId: (id) => (id === 'virtual:void-routes' ? routes : null),
        },
      ],
      ssr: { noExternal: true },
      build: {
        outDir: output,
        emptyOutDir: true,
        ssr: entry,
        target: 'esnext',
        rollupOptions: {
          external: [/^cloudflare:/, /^node:/],
          output: { entryFileNames: 'worker.mjs', codeSplitting: false },
        },
      },
    });
    createRuntime = () =>
      new Miniflare(
        convertV4MiniflareOptions({
          compatibilityDate: '2026-07-01',
          compatibilityFlags: ['nodejs_compat'],
          modules: true,
          modulesRoot: output,
          scriptPath: join(output, 'worker.mjs'),
          durableObjects: { COUNTERS: { className: 'CounterState', useSQLite: true } },
          resourcePersistencePath: join(temporary, 'state'),
        }),
      ) as unknown as Runtime;
    runtime = createRuntime();
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    rmSync(temporary, { recursive: true, force: true });
  });

  it('invokes declared methods through real stubs, persists and isolates instances', async () => {
    const response = await runtime.dispatchFetch('http://localhost/parallel?name=first');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([1, 3]);
    expect(await (await runtime.dispatchFetch('http://localhost/read?name=first')).json()).toBe(3);
    expect(await (await runtime.dispatchFetch('http://localhost/read?name=second')).json()).toBe(0);
    expect(await (await runtime.dispatchFetch('http://localhost/fail?name=first')).json()).toBe(3);
  });

  it('persists both RPC and fetch updates across a real runtime restart', async () => {
    expect(
      await (
        await runtime.dispatchFetch('http://localhost/increment?name=persisted&amount=4')
      ).json(),
    ).toBe(4);
    expect(
      await (await runtime.dispatchFetch('http://localhost/fetch?name=persisted')).json(),
    ).toBe(14);
    await runtime.dispose();
    runtime = createRuntime();
    expect(await (await runtime.dispatchFetch('http://localhost/read?name=persisted')).json()).toBe(
      14,
    );
  });

  it('keeps implementation helpers private while allowing explicitly declared names', async () => {
    const response = await runtime.dispatchFetch('http://localhost/helpers');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accessible: { load: false, persist: false, context: false },
      declaredRun: 0,
    });
  });
});
