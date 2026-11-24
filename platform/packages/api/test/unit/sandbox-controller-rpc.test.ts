import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
// Reuse the core SDK's declared Miniflare test dependency.
const require = createRequire(join(root, 'packages/void/package.json'));
const { Miniflare, convertV4MiniflareOptions } = await import(require.resolve('miniflare'));
const temporary = mkdtempSync(join(tmpdir(), 'void-controller-rpc-'));
let runtime: { dispatchFetch(url: string): Promise<Response>; dispose(): Promise<void> };

describe('managed Sandbox idle expiry through actual Workers RPC', () => {
  beforeAll(async () => {
    writeFileSync(
      join(temporary, 'controller.ts'),
      `
import SandboxService, { SandboxController } from ${JSON.stringify(join(root, 'platform/packages/api/src/sandbox-controller-runtime.ts'))};
export class Native extends SandboxController {
  #finish;
  #native = {
    running: false, images: { default: 'custom' },
    start: () => { this.#native.running = true; },
    destroy: async () => { this.#native.running = false; this.#finish?.(137); },
    setInactivityTimeout: async () => {},
    exec: async argv => {
      if (argv[0] !== 'sleep') return {
        pid: 1, stdin: null, stdout: null, stderr: null, exitCode: Promise.resolve(0),
        output: async () => ({ exitCode: 0, stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0) }),
        kill() {}, resize() {},
      };
      let controller;
      const stdout = new ReadableStream({ start(value) { controller = value; } });
      const exitCode = new Promise(resolve => {
        this.#finish = code => { try { controller.close(); } catch {} resolve(code); };
      });
      return { pid: 42, stdin: null, stdout, stderr: null, exitCode, kill() {}, resize() {} };
    },
  };
  constructor(ctx, env) {
    super(ctx, { ...env, __VOID_SANDBOX_CONTROL: {
      reserve: async () => ({ ok: true }), started: async () => ({ ok: true }),
      heartbeat: async () => ({ ok: true }), stopped: async () => {},
    } });
  }
  get container() { return this.#native; }
  async check() { await this.alarm(); return this.invoke('running', []); }
  complete() { this.#finish?.(0); }
}
export default class extends SandboxService {
  async check(id) { return this.env.SANDBOX.getByName(id).check(); }
  async complete(id) { await this.env.SANDBOX.getByName(id).complete(); }
}
`,
    );
    writeFileSync(
      join(temporary, 'application.ts'),
      `
import { getSandbox } from ${JSON.stringify(join(root, 'packages/void/src/runtime/sandbox/index.ts'))};
export default { async fetch(request, env) {
  const id = new URL(request.url).pathname.slice(1);
  const sandbox = await getSandbox(id, { inactivityTimeoutMs: 50 });
  const process = await sandbox.exec(['sleep', '100']);
  const waiting = id === 'waiting' ? process.exitCode : undefined;
  // Keep the same RPC session and its unconsumed stdout capability open.
  await new Promise(resolve => setTimeout(resolve, 150));
  const running = await env.__VOID_SANDBOX.check(id);
  if (waiting) { await env.__VOID_SANDBOX.complete(id); await waiting; }
  return Response.json({ running, pid: process.pid });
} };
`,
    );
    for (const name of ['controller', 'application']) {
      await build({
        configFile: false,
        logLevel: 'silent',
        resolve: {
          alias: {
            'void/_sandbox-container': join(root, 'packages/void/src/runtime/sandbox/container.ts'),
          },
        },
        ssr: { noExternal: true },
        build: {
          ssr: join(temporary, `${name}.ts`),
          outDir: temporary,
          emptyOutDir: false,
          target: 'esnext',
          rollupOptions: {
            external: [/^cloudflare:/, /^node:/],
            output: { entryFileNames: `${name}.mjs`, codeSplitting: false },
          },
        },
      });
    }
    // oxlint-disable-next-line typescript/no-unsafe-call -- The Worker test environment resolves the SDK fixture dependency dynamically.
    runtime = new Miniflare(
      // oxlint-disable-next-line typescript/no-unsafe-call -- The Worker test environment resolves the SDK fixture dependency dynamically.
      convertV4MiniflareOptions({
        workers: [
          {
            name: 'controller',
            modules: true,
            compatibilityDate: '2026-09-30',
            compatibilityFlags: ['nodejs_compat'],
            modulesRoot: temporary,
            scriptPath: join(temporary, 'controller.mjs'),
            durableObjects: { SANDBOX: { className: 'Native', useSQLite: true } },
          },
          {
            name: 'application',
            modules: true,
            compatibilityDate: '2026-09-30',
            compatibilityFlags: ['nodejs_compat'],
            modulesRoot: temporary,
            scriptPath: join(temporary, 'application.mjs'),
            routes: ['*/*'],
            serviceBindings: { __VOID_SANDBOX: 'controller' },
          },
        ],
      }),
    );
  });
  afterAll(async () => {
    await runtime?.dispose();
    rmSync(temporary, { recursive: true, force: true });
  });
  it('expires silent background processes whose transferred stdout is never read', async () => {
    expect(await (await runtime.dispatchFetch('http://localhost/background')).json()).toEqual({
      running: false,
      pid: 42,
    });
  });
  it('keeps an explicit exit-code waiter active beyond the idle deadline', async () => {
    expect(await (await runtime.dispatchFetch('http://localhost/waiting')).json()).toEqual({
      running: true,
      pid: 42,
    });
  });
});
