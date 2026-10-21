import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { compileRouteTable, compileWorkerEntry } from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const temporary = mkdtempSync(join(tmpdir(), 'void-websocket-middleware-'));
const output = join(temporary, 'dist');
const routeTablePath = join(temporary, 'virtual-void-routes.ts');
const workerPath = join(temporary, 'worker.ts');

type MiniflareInstance = {
  ready: Promise<URL>;
  dispatchFetch(input: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
  getBindings<T extends Record<string, unknown>>(): Promise<T>;
};

let miniflare: MiniflareInstance;

async function rejectedUpgrade(url: URL): Promise<{ status: number | undefined; body: string }> {
  const upgrade = request(url, {
    agent: false,
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  });
  const socket = once(upgrade, 'socket').then(async ([socket]) => {
    await once(socket, 'close');
  });
  const response = new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    upgrade.once('error', reject);
    upgrade.once('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('Unauthorized request unexpectedly upgraded to a WebSocket.'));
    });
    upgrade.once('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body }));
    });
  });
  // Miniflare's dispatchFetch rejection path does not own/close its WebSocket
  // ClientRequest. Own this real upgrade request and wait for its TCP teardown.
  const completed = Promise.all([response, socket]);
  upgrade.end();
  try {
    return (await completed)[0];
  } finally {
    upgrade.destroy();
  }
}

describe('generated worker WebSocket middleware', () => {
  beforeAll(async () => {
    const routesDir = join(temporary, 'routes');
    const middlewareDir = join(temporary, 'middleware');
    const websocketPath = join(routesDir, 'chat.ws.ts');
    const httpRoutePath = join(routesDir, 'chat.ts');
    const middlewarePath = join(middlewareDir, '01.auth.ts');
    const runtimeEnvPath = join(temporary, 'runtime-env.ts');
    mkdirSync(routesDir, { recursive: true });
    mkdirSync(middlewareDir, { recursive: true });

    writeFileSync(
      websocketPath,
      `const schema = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
export default {
  __kind: "socket",
  messages: { client: schema, server: schema },
  async onConnect({ storage }) {
    await storage.put("dispatches", ((await storage.get("dispatches")) ?? 0) + 1);
  },
  async onRequest({ storage }) {
    return Response.json({ dispatches: (await storage.get("dispatches")) ?? 0 });
  },
};\n`,
    );
    writeFileSync(
      httpRoutePath,
      'export function GET(c) { c.header("x-http-handler", "GET"); return c.text("HTTP route"); }\n',
    );
    for (const mode of ['socket', 'room'] as const) {
      writeFileSync(
        join(routesDir, `${mode}.ws.ts`),
        `const schema = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
export default {
  __kind: ${JSON.stringify(mode)},
  messages: { client: schema, server: schema },
  async onRequest(ctx) {
    const requests = ((await ctx.storage.get("requests")) ?? 0) + 1;
    await ctx.storage.put("requests", requests);
    return Response.json({ kind: ${JSON.stringify(mode)}, id: ctx.id, params: ctx.params, method: ctx.request.method, requests${mode === 'room' ? ', active: Array.from(ctx.room.getConnections()).length' : ''} }, { headers: { "x-ws-on-request": ${JSON.stringify(mode)} } });
  },
};\n`,
      );
    }
    writeFileSync(
      join(routesDir, 'upgrade-only.ws.ts'),
      `const schema = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
export default { __kind: "socket", messages: { client: schema, server: schema } };\n`,
    );
    writeFileSync(
      middlewarePath,
      `export default async function auth(c, next) {
  if (c.req.raw.headers.get("authorization") !== "Bearer allowed") {
    return c.text("Unauthorized", 401);
  }
  return next();
}\n`,
    );
    writeFileSync(runtimeEnvPath, 'export function withRuntimeEnv(_env, fn) { return fn(); }\n');

    const scan: ScanResult = {
      routes: [
        {
          pattern: '/chat',
          methods: ['GET'],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'chat.ts',
        },
      ],
      websockets: [
        {
          pattern: '/chat',
          methods: [],
          params: [],
          catchAll: false,
          env: null,
          filePath: 'chat.ws.ts',
          className: 'ChatWs',
          bindingName: 'CHAT_WS',
          mode: 'socket',
          hasAuthGate: false,
        },
        ...(['socket', 'room', 'upgrade-only'] as const).map((mode) => ({
          pattern: `/${mode}/:id`,
          methods: [],
          params: ['id'],
          catchAll: false,
          env: null,
          filePath: `${mode}.ws.ts`,
          className: mode === 'room' ? 'RoomWs' : mode === 'socket' ? 'SocketWs' : 'UpgradeOnlyWs',
          bindingName:
            mode === 'room' ? 'ROOM_WS' : mode === 'socket' ? 'SOCKET_WS' : 'UPGRADE_ONLY_WS',
          mode: mode === 'room' ? ('room' as const) : ('socket' as const),
          hasAuthGate: false,
        })),
      ],
      middleware: [{ order: 1, filePath: '01.auth.ts' }],
      jobs: [],
      queues: [],
      pages: { pages: [], layouts: [], namedLayouts: [] },
    };

    writeFileSync(
      routeTablePath,
      compileRouteTable(scan, routesDir, middlewareDir, temporary, temporary, null, {
        honoPath: import.meta.resolve('hono'),
        honoRoutePath: import.meta.resolve('hono/route'),
        runtimeEnvPath,
        webSocketRuntimePath: join(root, 'packages/void/src/runtime/ws-server.ts'),
        projectRoot: temporary,
        homeDir: temporary,
        reactRefresh: false,
        auth: null,
      }),
    );
    writeFileSync(
      workerPath,
      compileWorkerEntry({
        webSocketClasses: ['ChatWs', 'SocketWs', 'RoomWs', 'UpgradeOnlyWs'],
        runtimeEnvPath,
      }),
    );

    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'void-websocket-middleware-test',
          resolveId(id) {
            return id === 'virtual:void-routes' ? routeTablePath : null;
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
          external: [/^cloudflare:/],
          output: { entryFileNames: 'worker.mjs', codeSplitting: false },
        },
      },
    });

    miniflare = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat', 'web_socket_manual_reply_to_close'],
        durableObjects: {
          CHAT_WS: 'ChatWs',
          SOCKET_WS: 'SocketWs',
          ROOM_WS: 'RoomWs',
          UPGRADE_ONLY_WS: 'UpgradeOnlyWs',
        },
        modules: true,
        modulesRoot: output,
        scriptPath: join(output, 'worker.mjs'),
      }),
    ) as unknown as MiniflareInstance;
  }, 30_000);

  afterAll(async () => {
    await miniflare?.dispose();
    rmSync(temporary, { force: true, recursive: true });
  });

  it('authorizes upgrades before Durable Object dispatch and preserves the WebSocket response', async () => {
    const unauthorized = await rejectedUpgrade(new URL('/chat', await miniflare.ready));

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toBe('Unauthorized');

    const { CHAT_WS } = await miniflare.getBindings<{
      CHAT_WS: DurableObjectNamespace;
    }>();
    const stub = CHAT_WS.get(CHAT_WS.idFromName('default'));
    const beforeAuthorized = await stub.fetch('http://localhost/chat');
    expect(await beforeAuthorized.json()).toEqual({ dispatches: 0 });

    const authorized = await miniflare.dispatchFetch('http://localhost/chat', {
      headers: { Authorization: 'Bearer allowed', Upgrade: 'websocket' },
    });

    expect(authorized.status).toBe(101);
    expect(authorized.webSocket).not.toBeNull();
    const afterAuthorized = await stub.fetch('http://localhost/chat');
    expect(await afterAuthorized.json()).toEqual({ dispatches: 1 });
    const socket = authorized.webSocket!;
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.addEventListener('close', (event) => resolve(event), { once: true });
    });
    socket.accept();
    socket.close(1000, 'test complete');
    // Finish the close handshake before disposing workerd. Killing it while
    // the upgrade transport is open can emit an unhandled Windows ECONNRESET.
    const closeEvent = await closed;
    expect(closeEvent.code).toBe(1000);
    expect(closeEvent.reason).toBe('test complete');
  });

  it('continues non-upgrade requests to an HTTP route at the same path', async () => {
    const response = await miniflare.dispatchFetch('http://localhost/chat', {
      headers: { Authorization: 'Bearer allowed' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-http-handler')).toBe('GET');
    expect(await response.text()).toBe('HTTP route');
  });

  it.each(['socket', 'room'] as const)(
    'forwards ordinary HTTP to the %s onRequest hook',
    async (mode) => {
      const response = await miniflare.dispatchFetch(`http://localhost/${mode}/ordinary`, {
        headers: { Authorization: 'Bearer allowed' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-ws-on-request')).toBe(mode);
      expect(await response.json()).toEqual({
        kind: mode,
        id: 'id=ordinary',
        params: { id: 'ordinary' },
        method: 'GET',
        requests: 1,
        ...(mode === 'room' ? { active: 0 } : {}),
      });
    },
  );

  it('returns 426 for a WebSocket route without an ordinary HTTP hook', async () => {
    const response = await miniflare.dispatchFetch('http://localhost/upgrade-only/ordinary', {
      headers: { Authorization: 'Bearer allowed' },
    });
    expect(response.status).toBe(426);
    expect(await response.text()).toBe('Upgrade Required');
  });

  it.each(['socket', 'room', 'upgrade-only'] as const)(
    'authorizes ordinary %s requests before DO dispatch',
    async (mode) => {
      const response = await miniflare.dispatchFetch(`http://localhost/${mode}/restricted`);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('Unauthorized');
      const allowed = await miniflare.dispatchFetch(`http://localhost/${mode}/restricted`, {
        headers: { Authorization: 'Bearer allowed' },
      });
      expect(allowed.status).toBe(mode === 'upgrade-only' ? 426 : 200);
      if (mode !== 'upgrade-only') {
        expect(((await allowed.json()) as { requests: number }).requests).toBe(1);
      }
    },
  );

  it('keeps GET and HEAD HTTP precedence while other methods use onRequest', async () => {
    const head = await miniflare.dispatchFetch('http://localhost/chat', {
      method: 'HEAD',
      headers: { Authorization: 'Bearer allowed' },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('x-http-handler')).toBe('GET');
    expect(await head.text()).toBe('');
    const post = await miniflare.dispatchFetch('http://localhost/chat', {
      method: 'POST',
      headers: { Authorization: 'Bearer allowed' },
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ dispatches: 1 });
    const wsHead = await miniflare.dispatchFetch('http://localhost/socket/head', {
      method: 'HEAD',
      headers: { Authorization: 'Bearer allowed' },
    });
    expect(wsHead.status).toBe(200);
    expect(wsHead.headers.get('x-ws-on-request')).toBe('socket');
    expect(await wsHead.text()).toBe('');
  });
});
