import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { compileRouteTable, compileWorkerEntry } from '../../src/router/compile.ts';
import type { ScanResult } from '../../src/router/scan.ts';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const temporary = mkdtempSync(join(tmpdir(), 'void-room-actions-'));
const output = join(temporary, 'dist');
const routeTablePath = join(temporary, 'virtual-void-routes.ts');
const workerPath = join(temporary, 'worker.ts');
const runtimeEnvPath = join(root, 'packages/void/src/runtime/env.ts');
const roomRuntimePath = join(root, 'packages/void/src/runtime/ws-room.ts');

type MiniflareInstance = {
  ready: Promise<URL>;
  dispatchFetch(input: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
};

let miniflare: MiniflareInstance;

async function connect(url: URL, accountId: string, session: string) {
  const response = await miniflare.dispatchFetch(
    new URL(`/relay/${accountId}?session=${session}`, url).toString(),
    { headers: { Upgrade: 'websocket' } },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener('close', (event) => resolve(event), { once: true });
  });
  return { socket, closed };
}

async function call(url: URL, path: string, params: Record<string, string>) {
  const target = new URL(path, url);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, value);
  }
  return miniflare.dispatchFetch(target.toString());
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      return false;
    }
    await sleep(10);
  }
  return true;
}

describe('server-side room actions through the generated Worker', () => {
  beforeAll(async () => {
    const routesDir = join(temporary, 'routes');
    const middlewareDir = join(temporary, 'middleware');
    mkdirSync(routesDir, { recursive: true });
    mkdirSync(middlewareDir, { recursive: true });

    writeFileSync(
      join(routesDir, 'relay.ws.ts'),
      `const schema = { "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) } };
export default {
  __kind: "room",
  messages: { client: schema, server: schema },
  onConnect(ctx) {
    ctx.connection.setState({ sessionId: new URL(ctx.request.url).searchParams.get("session") });
  },
  async onMessage(ctx) {
    const seen = ((await ctx.storage.get("messages")) ?? 0) + 1;
    await ctx.storage.put("messages", seen);
  },
  actions: {
    async revokeSession(ctx, sessionId, code) {
      let closed = 0;
      for (const connection of ctx.room.getConnections()) {
        if (connection.state?.sessionId === sessionId) {
          connection.close(code, "session revoked");
          closed += 1;
        }
      }
      const calls = ((await ctx.storage.get("revocations")) ?? 0) + 1;
      await ctx.storage.put("revocations", calls);
      return { closed, calls, id: ctx.id, params: ctx.params };
    },
    async broadcast(ctx, text) {
      await ctx.room.broadcast({ type: "relay.message", text });
      return { sent: true };
    },
    async stats(ctx) {
      return {
        messages: (await ctx.storage.get("messages")) ?? 0,
        hasBinding: typeof ctx.env.RELAY_WS === "object",
      };
    },
  },
};
`,
    );

    const handler = (body: string) =>
      `import { getRoom } from ${JSON.stringify(roomRuntimePath)};
export async function GET(c) {
  const url = new URL(c.req.url);
  const accountId = url.searchParams.get("accountId");
  try {
    const room = getRoom("/relay/:accountId", { params: { accountId } });
    return Response.json(await room.actions.${body});
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
`;
    writeFileSync(
      join(routesDir, 'revoke.ts'),
      handler(
        'revokeSession(url.searchParams.get("session"), Number(url.searchParams.get("code") ?? 4001))',
      ),
    );
    writeFileSync(
      join(routesDir, 'broadcast.ts'),
      handler('broadcast(url.searchParams.get("text"))'),
    );
    writeFileSync(join(routesDir, 'stats.ts'), handler('stats()'));
    writeFileSync(join(routesDir, 'unknown.ts'), handler('missingAction()'));

    const routeFile = (pattern: string, filePath: string) => ({
      pattern,
      methods: ['GET'],
      params: [],
      catchAll: false,
      env: null,
      filePath,
    });
    const scan: ScanResult = {
      routes: [
        routeFile('/revoke', 'revoke.ts'),
        routeFile('/broadcast', 'broadcast.ts'),
        routeFile('/stats', 'stats.ts'),
        routeFile('/unknown', 'unknown.ts'),
      ],
      websockets: [
        {
          pattern: '/relay/:accountId',
          methods: [],
          params: ['accountId'],
          catchAll: false,
          env: null,
          filePath: 'relay.ws.ts',
          className: 'RelayWs',
          bindingName: 'RELAY_WS',
          mode: 'room',
          hasAuthGate: false,
        },
      ],
      middleware: [],
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
      compileWorkerEntry({ webSocketClasses: ['RelayWs'], runtimeEnvPath }),
    );

    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'void-room-actions-test',
          resolveId: (id) => (id === 'virtual:void-routes' ? routeTablePath : null),
        },
      ],
      ssr: { noExternal: true },
      build: {
        emptyOutDir: true,
        outDir: output,
        ssr: workerPath,
        target: 'esnext',
        rollupOptions: {
          external: [/^cloudflare:/, /^node:/],
          output: { entryFileNames: 'worker.mjs', codeSplitting: false },
        },
      },
    });

    miniflare = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat'],
        modules: true,
        modulesRoot: output,
        scriptPath: join(output, 'worker.mjs'),
        durableObjects: { RELAY_WS: { className: 'RelayWs', useSQLite: true } },
      }),
    ) as unknown as MiniflareInstance;
  }, 30_000);

  afterAll(async () => {
    await miniflare?.dispose();
    rmSync(temporary, { recursive: true, force: true });
  });

  it('reports the same instance id and params a connected client sees', async () => {
    const url = await miniflare.ready;
    const first = await call(url, '/stats', { accountId: 'acct_1' });
    expect(first.status).toBe(200);

    const other = await call(url, '/broadcast', { accountId: 'acct_2', text: 'nobody' });
    expect(await other.json()).toEqual({ sent: true });

    const response = await call(url, '/revoke', { accountId: 'acct_1', session: 'missing' });
    expect(await response.json()).toEqual({
      closed: 0,
      calls: 1,
      id: 'accountId=acct_1',
      params: { accountId: 'acct_1' },
    });
  });

  it('closes only the matching connections and keeps room storage', async () => {
    const url = await miniflare.ready;
    const target = await connect(url, 'acct_1', 'session_1');
    const bystander = await connect(url, 'acct_1', 'session_2');
    const elsewhere = await connect(url, 'acct_3', 'session_1');

    const response = await call(url, '/revoke', {
      accountId: 'acct_1',
      session: 'session_1',
      code: '4001',
    });
    expect(await response.json()).toMatchObject({ closed: 1, calls: 2 });

    const closeEvent = await target.closed;
    expect(closeEvent.code).toBe(4001);
    expect(closeEvent.reason).toBe('session revoked');
    expect((await Promise.race([bystander.closed, sleep(50).then(() => 'open')])) as unknown).toBe(
      'open',
    );
    expect((await Promise.race([elsewhere.closed, sleep(10).then(() => 'open')])) as unknown).toBe(
      'open',
    );

    const again = await call(url, '/revoke', { accountId: 'acct_1', session: 'session_1' });
    expect(await again.json()).toMatchObject({ closed: 0, calls: 3 });

    bystander.socket.close(1000, 'done');
    elsewhere.socket.close(1000, 'done');
    await Promise.all([bystander.closed, elsewhere.closed]);
  });

  it('broadcasts from an action to the addressed room only', async () => {
    const url = await miniflare.ready;
    const first = await connect(url, 'acct_4', 'session_1');
    const second = await connect(url, 'acct_4', 'session_2');
    const other = await connect(url, 'acct_5', 'session_1');

    const messages: Array<string> = [];
    first.socket.addEventListener('message', (event) => messages.push(String(event.data)));
    second.socket.addEventListener('message', (event) => messages.push(String(event.data)));
    other.socket.addEventListener('message', (event) => messages.push(String(event.data)));

    const response = await call(url, '/broadcast', { accountId: 'acct_4', text: 'hello' });
    expect(await response.json()).toEqual({ sent: true });

    expect(await waitFor(() => messages.length === 2)).toBe(true);
    expect(messages).toEqual([
      JSON.stringify({ type: 'relay.message', text: 'hello' }),
      JSON.stringify({ type: 'relay.message', text: 'hello' }),
    ]);

    first.socket.close(1000, 'done');
    second.socket.close(1000, 'done');
    other.socket.close(1000, 'done');
    await Promise.all([first.closed, second.closed, other.closed]);
  });

  it('reports unknown actions without running anything', async () => {
    const url = await miniflare.ready;
    const response = await call(url, '/unknown', { accountId: 'acct_6' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'ws: Unknown room action "missingAction".' });
  });

  it('cannot be reached from client messages or ordinary HTTP', async () => {
    const url = await miniflare.ready;
    const target = await connect(url, 'acct_7', 'session_1');

    target.socket.send(
      JSON.stringify({ name: 'revokeSession', args: ['session_1', 4001], id: 'accountId=acct_7' }),
    );
    expect((await Promise.race([target.closed, sleep(100).then(() => 'open')])) as unknown).toBe(
      'open',
    );
    const stats = await call(url, '/stats', { accountId: 'acct_7' });
    expect(await stats.json()).toEqual({ messages: 1, hasBinding: true });

    const http = await miniflare.dispatchFetch(new URL('/relay/acct_7', url).toString(), {
      method: 'POST',
      headers: { 'x-void-room-action': 'revokeSession' },
      body: JSON.stringify({ sessionId: 'session_1' }),
    });
    expect(http.status).toBe(426);

    target.socket.close(1000, 'done');
    await target.closed;
  });
});
