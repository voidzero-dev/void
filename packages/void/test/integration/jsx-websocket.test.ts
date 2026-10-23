import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { analyzeApplication } from '../../src/application-routing.ts';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';
import { readConfig } from '../../src/config.ts';
import { compileRouteTable, compileWorkerEntry } from '../../src/router/compile.ts';

const repository = join(import.meta.dirname, '../../../..');
const variants = ['tsx', 'jsx'].flatMap((ext) =>
  (['room', 'socket'] as const).map((mode) => ({ ext, mode })),
);

describe.each(
  ['react', 'hono/jsx'].flatMap((jsxImportSource) =>
    (['dev', 'prod'] as const).map((environment) => ({ jsxImportSource, environment })),
  ),
)('JSX WebSockets with $jsxImportSource in $environment', ({ jsxImportSource, environment }) => {
  let playground: IsolatedPlayground;
  let miniflare: Miniflare;
  let types: string;
  let modules: Array<string>;

  beforeAll(async () => {
    playground = createIsolatedPlayground(repository, 'playground/websockets');
    const root = playground.root;
    for (const directory of ['routes', 'pages', 'middleware']) {
      rmSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, 'void.config.ts'), 'export default {};');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource } }),
    );
    for (const { ext, mode } of variants) {
      mkdirSync(join(root, 'routes', ext), { recursive: true });
      for (const env of ['dev', 'prod']) {
        const helper = mode === 'room' ? 'defineRoom' : 'defineWebSocket';
        const send = mode === 'room' ? 'ctx.room.broadcast' : 'ctx.socket.send';
        writeFileSync(
          join(root, 'routes', ext, `${mode}.${env}.ws.${ext}`),
          `import * as v from 'valibot';
import { ${helper} } from 'void/ws';
${jsxImportSource === 'react' ? "import { renderToStaticMarkup } from 'react-dom/server.edge';" : ''}
function ChatMessage({ text }) { return <p data-environment="${env}">{text}</p>; }
export default ${helper}({
  messages: {
    client: v.object({ text: v.string() }),
    server: v.object({ html: v.string() }),
  },
  async onMessage(ctx, event) {
    const element = <ChatMessage text={event.text} />;
    await ${send}({ html: ${jsxImportSource === 'react' ? 'renderToStaticMarkup(element)' : 'element.toString()'} });
  },
});`,
        );
      }
    }
    const { scan } = await analyzeApplication(root, { config: readConfig(root), environment });
    types = generateRouteTypes(scan, join(root, 'routes'), join(root, '.void')).dts;
    const routeTable = join(root, 'generated-routes.ts');
    const worker = join(root, 'generated-worker.ts');
    const runtimeEnvPath = join(repository, 'packages/void/src/runtime/env.ts');
    writeFileSync(
      routeTable,
      compileRouteTable(
        scan,
        join(root, 'routes'),
        join(root, 'middleware'),
        join(root, 'crons'),
        join(root, 'queues'),
        null,
        {
          honoPath: import.meta.resolve('hono'),
          honoRoutePath: import.meta.resolve('hono/route'),
          runtimeEnvPath,
          webSocketRuntimePath: join(repository, 'packages/void/src/runtime/ws-server.ts'),
          projectRoot: root,
          homeDir: root,
          reactRefresh: false,
          auth: null,
          dev: environment === 'dev',
        },
      ),
    );
    writeFileSync(
      worker,
      compileWorkerEntry({
        runtimeEnvPath,
        webSocketClasses: scan.websockets!.map((route) => route.className),
        dev: environment === 'dev',
      }),
    );
    const output = join(root, 'dist');
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      oxc: { jsx: { runtime: 'automatic', importSource: jsxImportSource } },
      plugins: [
        {
          name: 'jsx-websocket-test',
          resolveId(id) {
            return id === 'virtual:void-routes' ? routeTable : null;
          },
          generateBundle() {
            modules = [...this.getModuleIds()];
          },
        },
      ],
      ssr: { noExternal: true },
      build: {
        outDir: output,
        ssr: worker,
        target: 'esnext',
        rollupOptions: {
          external: [/^cloudflare:/],
          output: { entryFileNames: 'worker.mjs', codeSplitting: false },
        },
      },
    });
    miniflare = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat', 'web_socket_manual_reply_to_close'],
        durableObjects: Object.fromEntries(
          scan.websockets!.map((route) => [route.bindingName, route.className]),
        ),
        modules: true,
        modulesRoot: output,
        scriptPath: join(output, 'worker.mjs'),
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await miniflare?.dispose();
    playground?.cleanup();
  });

  it.each(variants)('sends JSX-rendered HTML from .$ext $mode handlers', async ({ ext, mode }) => {
    const response = await miniflare.dispatchFetch(`http://localhost/${ext}/${mode}`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    expect(socket).not.toBeNull();
    socket.accept();
    try {
      const received = new Promise<string>((resolve, reject) => {
        socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      socket.send(JSON.stringify({ text: 'Hello <JSX>' }));
      expect(JSON.parse(await received)).toEqual({
        html: `<p data-environment="${environment}">Hello &lt;JSX&gt;</p>`,
      });
    } finally {
      const closed = new Promise<void>((resolve) => {
        socket.addEventListener('close', () => resolve(), { once: true });
      });
      socket.close(1000, 'test complete');
      await closed;
    }
  });

  it('generates WebSocket types and bundles only the selected environment and JSX runtime', () => {
    const websocketTypes = types.split('  interface WebSocketRouteMap {')[1]!;
    const graph = modules.join('\n').replaceAll('\\', '/');
    const otherEnvironment = environment === 'dev' ? 'prod' : 'dev';
    for (const { ext, mode } of variants) {
      expect(websocketTypes).toContain(`"/${ext}/${mode}": {`);
      expect(websocketTypes).toContain(
        `typeof import("../routes/${ext}/${mode}.${environment}.ws.${ext}")`,
      );
      expect(types).not.toContain(`${mode}.${otherEnvironment}.ws.${ext}`);
      expect(graph).toContain(`/routes/${ext}/${mode}.${environment}.ws.${ext}`);
      expect(graph).not.toContain(`/routes/${ext}/${mode}.${otherEnvironment}.ws.${ext}`);
    }
    expect(graph).toMatch(
      jsxImportSource === 'react'
        ? /\/react\/jsx-(?:dev-)?runtime\.js/
        : /\/hono\/dist\/jsx\/jsx-(?:dev-)?runtime\.js/,
    );
  });
});
