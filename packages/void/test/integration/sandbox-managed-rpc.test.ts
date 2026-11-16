import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const temporary = mkdtempSync(join(tmpdir(), 'void-sandbox-rpc-'));
const output = join(temporary, 'dist');
type Runtime = { dispatchFetch(url: string): Promise<Response>; dispose(): Promise<void> };
let runtime: Runtime;

describe('Sandbox 1.0 through actual Workers RPC', () => {
  beforeAll(async () => {
    const controller = join(temporary, 'controller.ts');
    const application = join(temporary, 'application.ts');
    writeFileSync(
      controller,
      `
import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
const bytes = value => new Blob([value]).stream();
let file = '';
class Process extends RpcTarget {
  #exit; #resolve;
  constructor(background, limited) { super(); this.limited = limited; this.#exit = background ? new Promise(resolve => {this.#resolve = resolve;}) : Promise.resolve(0); }
  async invoke(operation, args) {
    if (operation === 'exitCode') { if (this.limited) throw new Error('VOID_SANDBOX_runtime_budget'); return this.#exit; }
    if (operation === 'kill') { this.#resolve?.(137); return; }
    if (operation === 'resize') return;
    throw new TypeError('process operation denied');
  }
}
class Capability extends RpcTarget {
  async invoke(operation, args) {
    if (operation === 'files' && args[0] === 'writeFile') { file = await new Response(args[2]).text(); return; }
    if (operation === 'files' && args[0] === 'readFile') return new Response(bytes(file));
    if (operation === 'exec') {
      if (args[0][0] === 'denied') throw new Error('admission failed');
      if (args[0][0] === 'limited') throw new Error('VOID_SANDBOX_concurrency');
      const background = args[0][0] === 'sleep';
      const process = new Process(background, args[0][0] === 'budget');
      if (args[1]?.abort) {
        const reader = args[1].abort.getReader();
        reader.read().then(() => process.invoke('kill', []));
      }
      let buffer = '';
      const stdin = new WritableStream({write(chunk) { buffer += new TextDecoder().decode(chunk); }, close() { file = buffer; }});
      return { pid: 42, isPty: false, stdin, stdout: bytes('root stream'), stderr: bytes(''), capability: process };
    }
    throw new TypeError('operation denied');
  }
}
export default class extends WorkerEntrypoint {
  async getSandbox() { return new Capability(); }
  fetch() { return new Response('Not found', { status: 404 }); }
}
`,
    );
    writeFileSync(
      application,
      `
import { getSandbox } from ${JSON.stringify(join(root, 'packages/void/src/runtime/sandbox/index.ts'))};
import { UsageLimit } from ${JSON.stringify(join(root, 'packages/void/src/runtime/limits/index.ts'))};
export default { async fetch(request) {
  const sandbox = await getSandbox('default');
  const path = new URL(request.url).pathname;
  if (path === '/limited' || path === '/budget') {
    try { await sandbox.run([path === '/limited' ? 'limited' : 'budget']); }
    catch (error) { if (error instanceof UsageLimit) return error.response(); throw error; }
  }
  if (path === '/files') {
    await sandbox.files.writeFile('/file', new Blob(['input stream']).stream());
    return await sandbox.files.readFile('/file');
  }
  if (path === '/blob') {
    await sandbox.files.writeFile('/file', new Blob(['blob content']));
    return await sandbox.files.readFile('/file');
  }
  if (path === '/process') {
    const process = await sandbox.exec(['sleep', '10']);
    await process.kill(9);
    return Response.json({pid: process.pid, exitCode: await process.exitCode});
  }
  if (path === '/abort') {
    const abort = new AbortController();
    const process = await sandbox.exec(['sleep', '10'], {signal: abort.signal});
    abort.abort();
    return Response.json({exitCode: await process.exitCode});
  }
  if (path === '/rejected') {
    const abort = new AbortController();
    const signal = abort.signal;
    const listeners = new Set();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, listener, options) => { if (type === 'abort') listeners.add(listener); return add(type, listener, options); };
    signal.removeEventListener = (type, listener, options) => { if (type === 'abort') listeners.delete(listener); return remove(type, listener, options); };
    try { await sandbox.exec(['denied'], {signal}); } catch {}
    return Response.json({listeners: listeners.size});
  }
  if (path === '/stdin') {
    const process = await sandbox.exec(['cat'], {stdin: 'pipe'});
    const writer = process.stdin.getWriter();
    await writer.write(new TextEncoder().encode('stdin stream')); await writer.close();
    return await sandbox.files.readFile('/file');
  }
  const process = await sandbox.exec(['echo', 'ok']);
  const result = await process.output();
  return Response.json({output: new TextDecoder().decode(result.stdout), exitCode: result.exitCode});
} };
`,
    );
    for (const [name, entry] of [
      ['application', application],
      ['controller', controller],
    ] as const) {
      await build({
        configFile: false,
        logLevel: 'silent',
        ssr: { noExternal: true },
        build: {
          outDir: output,
          emptyOutDir: name === 'application',
          ssr: entry,
          target: 'esnext',
          rollupOptions: {
            external: [/^cloudflare:/, /^node:/],
            output: { entryFileNames: `${name}.mjs`, codeSplitting: false },
          },
        },
      });
    }
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-09-30',
        compatibilityFlags: ['nodejs_compat'],
        workers: [
          {
            name: 'application',
            compatibilityDate: '2026-09-30',
            compatibilityFlags: ['nodejs_compat'],
            modules: true,
            modulesRoot: output,
            scriptPath: join(output, 'application.mjs'),
            routes: ['*/*'],
            serviceBindings: { __VOID_SANDBOX: 'controller' },
          },
          {
            name: 'controller',
            compatibilityDate: '2026-09-30',
            compatibilityFlags: ['nodejs_compat'],
            modules: true,
            modulesRoot: output,
            scriptPath: join(output, 'controller.mjs'),
          },
        ],
      }),
    ) as unknown as Runtime;
  }, 30_000);
  afterAll(async () => {
    await runtime?.dispose();
    rmSync(temporary, { recursive: true, force: true });
  });
  it('returns native byte output and exit codes', async () => {
    expect(await (await runtime.dispatchFetch('http://localhost/output')).json()).toEqual({
      output: 'root stream',
      exitCode: 0,
    });
  });
  it.each([
    ['limited', 'concurrency'],
    ['budget', 'runtime_budget'],
  ])('restores typed %s limits across Workers RPC', async (path, reason) => {
    const response = await runtime.dispatchFetch(`http://localhost/${path}`);
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      code: 'usage_limit',
      resource: 'sandbox',
      reason,
    });
  });
  it('transfers streaming file inputs and Response bodies', async () => {
    expect(await (await runtime.dispatchFetch('http://localhost/files')).text()).toBe(
      'input stream',
    );
  });
  it('transfers Blob file contents', async () => {
    expect(await (await runtime.dispatchFetch('http://localhost/blob')).text()).toBe(
      'blob content',
    );
  });
  it('returns a background process before exit and restricts its controls', async () => {
    expect(await (await runtime.dispatchFetch('http://localhost/process')).json()).toEqual({
      pid: 42,
      exitCode: 137,
    });
  });
  it('propagates cancellation after the process capability returns', async () => {
    expect(await (await runtime.dispatchFetch('http://localhost/abort')).json()).toEqual({
      exitCode: 137,
    });
  });
  it('releases cancellation after a real RPC invocation fails before admission', async () => {
    expect(await (await runtime.dispatchFetch('http://localhost/rejected')).json()).toEqual({
      listeners: 0,
    });
  });
  it('transfers writable process stdin', async () => {
    expect(await (await runtime.dispatchFetch('http://localhost/stdin')).text()).toBe(
      'stdin stream',
    );
  });
});
