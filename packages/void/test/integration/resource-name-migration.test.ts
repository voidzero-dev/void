import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import spawn from 'cross-spawn';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { analyzeApplication } from '../../src/application-routing.ts';
import { buildVoidManifest } from '../../src/cli/package.ts';
import { syncWranglerDurableObjects, syncWranglerWebSockets } from '../../src/cli/wrangler.ts';
import { readConfig } from '../../src/config.ts';
import { scanDurableObjectModules } from '../../src/durable/scan.ts';
import { collectPrerenderWorkerModules } from '../../src/prerender.ts';
import { compileRouteTable, compileWorkerEntry } from '../../src/router/compile.ts';

const repository = join(import.meta.dirname, '..', '..', '..', '..');
const runtimePath = (file: string) => join(repository, 'packages/void/src/runtime', file);
const noBindings = {
  needsD1: false,
  needsKV: false,
  needsR2: false,
  needsAuth: false,
  needsQueues: false,
  needsAI: false,
  needsSandbox: false,
  needsLive: false,
};

type Runtime = {
  dispatchFetch(input: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
};

let directory: string;
let runtime: Runtime | undefined;

async function connectRoom(active: Runtime, path: string): Promise<unknown> {
  const response = await active.dispatchFetch(`http://localhost${path}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const message = new Promise<MessageEvent>((resolve) =>
    socket.addEventListener('message', resolve, { once: true }),
  );
  socket.accept();
  const result = JSON.parse((await message).data);
  const closed = new Promise<CloseEvent>((resolve) =>
    socket.addEventListener('close', resolve, { once: true }),
  );
  socket.close(1000, 'fixture complete');
  expect((await closed).code).toBe(1000);
  return result;
}

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('persistent resource names through generated Workers', () => {
  it('preserves deployed namespaces, migration history and actual state when pinning and moving code', async () => {
    directory = mkdtempSync(join(tmpdir(), 'void-resource-name-'));
    const routesDirectory = join(directory, 'routes');
    const durableDirectory = join(directory, 'durable-objects');
    const output = join(directory, 'dist');
    const routeTable = join(directory, 'generated-routes.ts');
    const entry = join(directory, 'generated-worker.ts');
    mkdirSync(durableDirectory);
    mkdirSync(routesDirectory);
    writeFileSync(
      join(directory, 'void.config.ts'),
      'export default { cloudflare: { name: "resource-name-migration" } };\n',
    );

    function writeSources(
      durableFile: string,
      roomFile: string,
      pinned: boolean,
      preserveLegacyKey = false,
    ): void {
      const durablePath = join(durableDirectory, durableFile);
      const roomPath = join(routesDirectory, roomFile);
      mkdirSync(dirname(roomPath), { recursive: true });
      writeFileSync(
        durablePath,
        `import { defineDurableState } from ${JSON.stringify(runtimePath('durable.ts'))};
export default defineDurableState({
  ${pinned ? "name: 'counter'," : ''}
  initialState: { count: 0 },
  methods: {
    increment(context, amount) { context.state.count += amount; return context.state.count; },
    read(context) { return context.state.count; },
  },
});\n`,
      );
      writeFileSync(
        join(routesDirectory, 'counter.ts'),
        `import Counter from ${JSON.stringify(durablePath)};
export async function GET(c) {
  const counter = Counter.get(c.req.query('instance') || 'global');
  const amount = c.req.query('amount');
  return c.json(amount ? await counter.increment(Number(amount)) : await counter.read());
}\n`,
      );
      writeFileSync(
        roomPath,
        `import { defineRoom } from ${JSON.stringify(runtimePath('ws.ts'))};
const schema = { '~standard': { version: 1, vendor: 'fixture', validate: value => ({ value }) } };
export default defineRoom({
  ${pinned ? "name: 'chat-room'," : ''}
  ${preserveLegacyKey ? "key: ({ params }) => 'room=' + params.id," : ''}
  messages: { client: schema, server: schema },
  async onConnect({ id, storage, connection }) {
    const visits = ((await storage.get('visits')) ?? 0) + 1;
    await storage.put('visits', visits);
    await connection.send({ visits, id });
  },
  async onRequest({ storage }) {
    return Response.json({ visits: (await storage.get('visits')) ?? 0 });
  },
});\n`,
      );
    }

    async function buildAndStart() {
      await runtime?.dispose();
      runtime = undefined;
      const durableObjects = scanDurableObjectModules(directory);
      const { scan } = await analyzeApplication(directory, { config: readConfig(directory) });
      syncWranglerDurableObjects(directory, durableObjects);
      syncWranglerWebSockets(directory, scan.websockets ?? []);
      const cloudflare = JSON.parse(readFileSync(join(directory, '.void-wrangler.jsonc'), 'utf8'));
      const identity = {
        config: readFileSync(join(directory, '.void-wrangler.jsonc'), 'utf8'),
        lock: readFileSync(join(directory, 'void.lock.json'), 'utf8'),
        hostedClasses: buildVoidManifest({
          bindings: noBindings,
          webSockets: scan.websockets,
        }).websocket?.classes,
      };
      writeFileSync(
        routeTable,
        compileRouteTable(
          scan,
          routesDirectory,
          join(directory, 'middleware'),
          join(directory, 'crons'),
          join(directory, 'queues'),
          null,
          {
            honoPath: import.meta.resolve('hono'),
            honoRoutePath: import.meta.resolve('hono/route'),
            runtimeEnvPath: runtimePath('env.ts'),
            webSocketRuntimePath: runtimePath('ws-server.ts'),
            projectRoot: directory,
            homeDir: directory,
            reactRefresh: false,
            auth: null,
          },
        ),
      );
      writeFileSync(
        entry,
        compileWorkerEntry({
          runtimeEnvPath: runtimePath('env.ts'),
          durableObjects,
          webSocketClasses: scan.websockets?.map((route) => route.className),
        }),
      );
      await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [
          {
            name: 'resource-name-migration-fixture',
            resolveId: (id) => (id === 'virtual:void-routes' ? routeTable : null),
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
      runtime = new Miniflare(
        convertV4MiniflareOptions({
          compatibilityDate: '2026-07-01',
          compatibilityFlags: ['nodejs_compat', 'web_socket_manual_reply_to_close'],
          modules: true,
          modulesRoot: output,
          scriptPath: join(output, 'worker.mjs'),
          durableObjects: Object.fromEntries(
            cloudflare.durable_objects.bindings.map(
              (binding: { name: string; class_name: string }) => [
                binding.name,
                { className: binding.class_name, useSQLite: true },
              ],
            ),
          ),
          resourcePersistencePath: join(directory, 'state'),
        }),
      ) as unknown as Runtime;
      return { identity, room: scan.websockets![0], durable: durableObjects[0] };
    }

    async function counter(query = ''): Promise<number> {
      const response = await runtime!.dispatchFetch(`http://localhost/counter${query}`);
      expect(response.status).toBe(200);
      return response.json();
    }

    async function connect(path: string): Promise<unknown> {
      return connectRoom(runtime!, path);
    }

    writeSources('counter.ts', 'chat/[room].ws.ts', false);
    const original = await buildAndStart();
    expect(original.durable).toMatchObject({
      bindingName: 'COUNTER',
      className: 'CounterDurableObject',
      migrationTag: 'void-durable-counter-v1',
    });
    expect(original.room).toMatchObject({
      className: 'ChatRoomWs',
      bindingName: 'ChatRoomWs',
    });
    expect(JSON.parse(original.identity.config).migrations).toEqual([
      { tag: 'void-durable-counter-v1', new_sqlite_classes: ['CounterDurableObject'] },
      { tag: 'void-ws-v1', new_sqlite_classes: ['ChatRoomWs'] },
    ]);
    expect(original.identity.hostedClasses).toEqual(['ChatRoomWs']);
    expect(await counter('?amount=7')).toBe(7);
    expect(await counter('?instance=other&amount=2')).toBe(2);
    expect(await connect('/chat/general')).toEqual({ visits: 1, id: 'room=general' });
    expect(await connect('/chat/other')).toEqual({ visits: 1, id: 'room=other' });

    writeSources('counter.ts', 'chat/[room].ws.ts', true);
    const pinned = await buildAndStart();
    expect(pinned.identity).toEqual(original.identity);
    expect(await counter()).toBe(7);
    expect(await counter('?instance=other')).toBe(2);
    expect(await connect('/chat/general')).toEqual({ visits: 2, id: 'room=general' });

    rmSync(join(durableDirectory, 'counter.ts'));
    rmSync(join(routesDirectory, 'chat'), { recursive: true });
    writeSources('visits.ts', 'rooms/[room].ws.ts', true);
    const moved = await buildAndStart();
    expect(moved.identity).toEqual(original.identity);
    expect(moved.room.pattern).toBe('/rooms/:room');
    expect(await counter()).toBe(7);
    expect(await counter('?amount=3')).toBe(10);
    expect(await counter('?instance=other')).toBe(2);
    expect(await connect('/rooms/general')).toEqual({ visits: 3, id: 'room=general' });
    expect(await connect('/rooms/other')).toEqual({ visits: 2, id: 'room=other' });
    const removedRoute = await runtime!.dispatchFetch('http://localhost/chat/general');
    expect(removedRoute.status).toBe(404);
    // Drain the response before restarting workerd so disposal cannot wait on its open stream.
    await removedRoute.arrayBuffer();

    rmSync(join(routesDirectory, 'rooms', '[room].ws.ts'));
    writeSources('visits.ts', 'rooms/[id].ws.ts', true, true);
    const parameterRenamed = await buildAndStart();
    expect(parameterRenamed.identity).toEqual(original.identity);
    expect(parameterRenamed.room.pattern).toBe('/rooms/:id');
    expect(await counter()).toBe(10);
    expect(await connect('/rooms/general')).toEqual({ visits: 4, id: 'room=general' });
    expect(await connect('/rooms/other')).toEqual({ visits: 3, id: 'room=other' });
  }, 30_000);

  it(
    'carries explicit names through a public Void plugin build into the running Worker',
    async () => {
      directory = mkdtempSync(join(tmpdir(), 'void-named-resource-plugin-'));
      mkdirSync(join(directory, 'durable-objects'));
      mkdirSync(join(directory, 'routes', 'api'), { recursive: true });
      mkdirSync(join(directory, 'routes', 'rooms'), { recursive: true });
      const nodeModules = join(directory, 'node_modules');
      mkdirSync(nodeModules);
      // Link each package to its real directory so pnpm's relative workspace
      // links do not depend on the temporary app's ancestors on Windows.
      for (const [name, source] of [
        ['vite-plus', join(repository, 'node_modules/vite-plus')],
        ['void', join(repository, 'packages/void')],
      ]) {
        symlinkSync(
          realpathSync(source),
          join(nodeModules, name),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name: 'void-resource-name-fixture', private: true, type: 'module' }),
      );
      writeFileSync(
        join(directory, 'vite.config.ts'),
        `import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';
export default defineConfig({ plugins: [voidPlugin()] });\n`,
      );
      writeFileSync(
        join(directory, 'void.config.ts'),
        `export default { cloudflare: {
  name: 'named-resource-plugin',
  compatibility_date: '2026-07-01',
  compatibility_flags: ['nodejs_compat', 'web_socket_manual_reply_to_close'],
} };\n`,
      );
      writeFileSync(join(directory, 'index.html'), '<!doctype html><p>Named resource fixture</p>');
      writeFileSync(
        join(directory, 'durable-objects', 'visits.ts'),
        `import { defineDurableState } from 'void/durable';
export default defineDurableState({
  name: 'counter',
  initialState: { count: 41 },
  methods: { increment(context) { return ++context.state.count; } },
});\n`,
      );
      writeFileSync(
        join(directory, 'routes', 'api', 'counter.ts'),
        `import Counter from '../../durable-objects/visits';
export async function GET(c) { return c.json(await Counter.get('global').increment()); }\n`,
      );
      writeFileSync(
        join(directory, 'routes', 'rooms', '[id].ws.ts'),
        `import { defineRoom } from 'void/ws';
const schema = { '~standard': { version: 1, vendor: 'fixture', validate: value => ({ value }) } };
export default defineRoom({
  name: 'chat-room',
  key: ({ params }) => 'room=' + params.id,
  messages: { client: schema, server: schema },
  async onConnect({ id, storage, connection }) {
    const visits = ((await storage.get('visits')) ?? 0) + 1;
    await storage.put('visits', visits);
    await connection.send({ visits, id });
  },
});\n`,
      );
      const result = await new Promise<{ status: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn('vp', ['build'], {
            cwd: directory,
            env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: process.platform === 'win32' ? 40_000 : 20_000,
          });
          let output = '';
          child.stdout!.on('data', (chunk: Buffer) => (output += String(chunk)));
          child.stderr!.on('data', (chunk: Buffer) => (output += String(chunk)));
          child.on('error', reject);
          child.on('close', (status) => resolve({ status, output }));
        },
      );
      expect(result.status, result.output).toBe(0);

      const output = join(directory, 'dist', 'ssr');
      const config = JSON.parse(readFileSync(join(output, 'wrangler.json'), 'utf8'));
      expect(config.durable_objects.bindings).toEqual([
        { name: 'COUNTER', class_name: 'CounterDurableObject' },
        { name: 'ChatRoomWs', class_name: 'ChatRoomWs' },
      ]);
      expect(config.migrations).toEqual([
        { tag: 'void-durable-counter-v1', new_sqlite_classes: ['CounterDurableObject'] },
        { tag: 'void-ws-v1', new_sqlite_classes: ['ChatRoomWs'] },
      ]);
      // Source maps belong in uploads, but are not executable Worker modules.
      const modules = collectPrerenderWorkerModules(output, config.main);
      expect(modules.every((module) => module.type === 'ESModule')).toBe(true);
      runtime = new Miniflare(
        convertV4MiniflareOptions({
          compatibilityDate: config.compatibility_date,
          compatibilityFlags: config.compatibility_flags,
          modules,
          modulesRoot: output,
          durableObjects: {
            COUNTER: { className: 'CounterDurableObject', useSQLite: true },
            ChatRoomWs: { className: 'ChatRoomWs', useSQLite: true },
          },
        }),
      ) as unknown as Runtime;
      const counter = await runtime.dispatchFetch('http://localhost/api/counter');
      expect(counter.status).toBe(200);
      expect(await counter.json()).toBe(42);
      expect(await connectRoom(runtime, '/rooms/general')).toEqual({
        visits: 1,
        id: 'room=general',
      });
    },
    process.platform === 'win32' ? 45_000 : 30_000,
  );
});
