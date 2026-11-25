import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { compileWorkerEntry } from '../../src/router/compile.ts';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const runtimePath = join(root, 'packages/void/src/runtime/workflows/index.ts');
const durablePath = join(root, 'packages/void/src/runtime/durable/index.ts');
const temporary = mkdtempSync(join(tmpdir(), 'void-workflow-runtime-'));
type Runtime = { dispatchFetch(url: string): Promise<Response>; dispose(): Promise<void> };
let runtime: Runtime;

const ROUTE_STUBS = `
export const scheduled = async () => {};
export const __voidCollectPrerenderPaths = async () => [];
export const __voidRenderStaticNotFound = async () => new Response(null, { status: 204 });
export const __voidHandleInternalRoute = async () => null;
export const __withRawEnv = (_env, fn) => fn();
`;

/** Build a generated Worker entry for `entryOptions` into `name/worker.mjs`. */
async function buildWorker(
  name: string,
  routes: string,
  entryOptions: Parameters<typeof compileWorkerEntry>[0],
): Promise<string> {
  const directory = join(temporary, name);
  const routesPath = join(temporary, `${name}-routes.ts`);
  const entryPath = join(temporary, `${name}-entry.ts`);
  writeFileSync(routesPath, ROUTE_STUBS + routes);
  writeFileSync(
    entryPath,
    compileWorkerEntry({
      runtimeEnvPath: join(root, 'packages/void/src/runtime/env/runtime.ts'),
      ...entryOptions,
    }),
  );
  await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'workflow-runtime-fixture',
        resolveId: (id) => (id === 'virtual:void-routes' ? routesPath : null),
      },
    ],
    ssr: { noExternal: true },
    build: {
      outDir: directory,
      emptyOutDir: true,
      ssr: entryPath,
      target: 'esnext',
      rollupOptions: {
        external: [/^cloudflare:/, /^node:/],
        output: { entryFileNames: 'worker.mjs', codeSplitting: false },
      },
    },
  });
  return directory;
}

function file(name: string, source: string): string {
  const path = join(temporary, name);
  writeFileSync(path, source);
  return path;
}

describe('Workflows through the generated Worker and a real Workflows engine', () => {
  beforeAll(async () => {
    const definition = file(
      'welcome.ts',
      `
import { defineWorkflow } from ${JSON.stringify(runtimePath)};
const params = { '~standard': { version: 1, vendor: 'test', validate(value) {
  return typeof value?.name === 'string' ? { value } : { issues: [{ message: 'name is required', path: ['name'] }] };
} } };
export const Welcome = defineWorkflow({
  params,
  async run(event, step, { env }) {
    const greeting = await step.do('greet', async () => env.GREETING + ', ' + event.payload.name);
    return { greeting };
  },
});
export default Welcome;
`,
    );
    const output = await buildWorker(
      'valid',
      `
import { Welcome } from ${JSON.stringify(definition)};
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/start') {
    try {
      const instance = await Welcome.create({ id: url.searchParams.get('id'), params: { name: url.searchParams.get('name') ?? undefined } });
      return Response.json({ id: instance.id });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  }
  const instance = await Welcome.get(url.searchParams.get('id'));
  return Response.json(await instance.status());
}};
`,
      {
        workflows: [
          {
            bindingName: 'WORKFLOW_WELCOME',
            className: 'WelcomeWorkflow',
            filePath: definition,
          },
        ],
      },
    );
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat'],
        modules: true,
        modulesRoot: output,
        scriptPath: join(output, 'worker.mjs'),
        bindings: { GREETING: 'Hello' },
        workflows: { WORKFLOW_WELCOME: { name: 'welcome', className: 'WelcomeWorkflow' } },
      }),
    ) as unknown as Runtime;
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    rmSync(temporary, { recursive: true, force: true });
  });

  it('starts an instance from a route and runs its steps with the Worker env', async () => {
    const started = await runtime.dispatchFetch('http://localhost/start?id=first&name=Ada');
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ id: 'first' });

    let status: { status: string; output?: unknown } = { status: 'queued' };
    for (let attempt = 0; attempt < 100 && status.status !== 'complete'; attempt++) {
      const response = await runtime.dispatchFetch('http://localhost/status?id=first');
      status = await response.json<typeof status>();
      if (status.status === 'errored') {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
    expect(status).toMatchObject({ status: 'complete', output: { greeting: 'Hello, Ada' } });
  });

  it('rejects invalid params before starting an instance', async () => {
    const response = await runtime.dispatchFetch('http://localhost/start?id=invalid');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'workflows: invalid params: name: name is required',
    });
  });
});

describe('convention modules without a definition default export', () => {
  it.each([
    {
      kind: 'workflows',
      source: 'export const Welcome = 1;',
      message:
        'workflows: workflows/missing.ts must default-export defineWorkflow() or defineWorkflowEntrypoint().',
    },
    {
      kind: 'workflows',
      source: 'export default class Welcome {}',
      message:
        'workflows: workflows/missing.ts must default-export defineWorkflow() or defineWorkflowEntrypoint().',
    },
    {
      kind: 'durable-objects',
      source: 'export const Counter = 1;',
      message:
        'durable: durable-objects/missing.ts must default-export defineDurableState() or defineDurableObject().',
    },
    {
      kind: 'durable-objects',
      source: `import { defineDurableState } from ${JSON.stringify(durablePath)};
export const Counter = defineDurableState({ initialState: 0, methods: {} });`,
      message:
        'durable: durable-objects/missing.ts must default-export defineDurableState() or defineDurableObject().',
    },
  ])(
    'fails Worker startup with a clear error for $kind: $source',
    async ({ kind, source, message }) => {
      const name = `${kind}-${Math.random().toString(36).slice(2)}`;
      const definition = join(temporary, name, kind);
      mkdirSync(definition, { recursive: true });
      const filePath = join(definition, 'missing.ts');
      writeFileSync(filePath, source);
      const entry = { bindingName: 'MISSING', className: 'Missing', filePath };
      const output = await buildWorker(
        name,
        'export default { fetch: () => new Response("ok") };',
        kind === 'workflows' ? { workflows: [entry] } : { durableObjects: [entry] },
      );
      const worker = new Miniflare(
        convertV4MiniflareOptions({
          compatibilityDate: '2026-07-01',
          compatibilityFlags: ['nodejs_compat'],
          modules: true,
          modulesRoot: output,
          scriptPath: join(output, 'worker.mjs'),
        }),
      ) as unknown as Runtime;
      try {
        await expect(worker.dispatchFetch('http://localhost/')).rejects.toThrow(message);
      } finally {
        await worker.dispose().catch(() => {});
      }
    },
    30_000,
  );
});
