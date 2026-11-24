import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { expect, it } from 'vite-plus/test';

it('transfers native Sandbox WebSockets through DO fetch and strips the routing header', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'void-sandbox-websocket-'));
  const root = join(import.meta.dirname, '../..');
  const entry = join(directory, 'entry.ts');
  const sdk = join(directory, 'sdk.ts');
  let runtime: Miniflare | undefined;
  try {
    writeFileSync(sdk, 'export class Files {}');
    writeFileSync(
      entry,
      `
import { SandboxContainer } from ${JSON.stringify(join(root, 'src/runtime/sandbox/container.ts'))};
import { getSandbox } from ${JSON.stringify(join(root, 'src/runtime/sandbox/index.ts'))};
import { envContext } from ${JSON.stringify(join(root, 'src/runtime/env/raw.ts'))};
export class NativeBox extends SandboxContainer {
  get container() { return { running: false, getTcpPort(port) { return { fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener('message', event => server.send(JSON.stringify({data: event.data, port, routingHeader: request.headers.get('x-void-sandbox-port'), path: new URL(request.url).pathname})));
    return new Response(null, {status: 101, webSocket: client});
  } }; } }; }
  async ensureRunning() {}
}
export default { fetch(request, env) { return envContext.run(env, async () => {
  const box = await getSandbox();
  return box.fetch(5173, request);
}); } };
`,
    );
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'sandbox-files-fixture',
          enforce: 'pre',
          resolveId: (id) => (id === '@cloudflare/sandbox' ? sdk : null),
        },
      ],
      ssr: { noExternal: true },
      build: {
        outDir: join(directory, 'dist'),
        ssr: entry,
        target: 'esnext',
        rollupOptions: {
          external: [/^cloudflare:/, /^node:/],
          output: { entryFileNames: 'entry.mjs', codeSplitting: false },
        },
      },
    });
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat'],
        modules: true,
        modulesRoot: join(directory, 'dist'),
        scriptPath: join(directory, 'dist/entry.mjs'),
        durableObjects: { SANDBOX: { className: 'NativeBox', useSQLite: true } },
        resourcePersistencePath: join(directory, 'state'),
      }),
    );
    const response = await runtime.dispatchFetch('http://sandbox/socket', {
      headers: { Upgrade: 'websocket' },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const message = new Promise<string>((resolve) =>
      socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true }),
    );
    socket.send('hello');
    expect(JSON.parse(await message)).toEqual({
      data: 'hello',
      port: 5173,
      routingHeader: null,
      path: '/socket',
    });
    socket.close();
  } finally {
    await runtime?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
