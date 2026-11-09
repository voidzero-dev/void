import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createServer as createPgServer } from 'pglite-server';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import voidNitroModule from '../../src/nitro.ts';
import { startFakeMySqlServer } from '../helpers/fake-mysql-server.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

// Half of the integration project's test timeout, which Windows triples. A step that stops
// making progress fails with its name before the case times out.
const STEP_TIMEOUT_MS = (process.platform === 'win32' ? 3 : 1) * 60_000;

/**
 * Run `step`, or fail with its `name` when it has not finished within STEP_TIMEOUT_MS. The error
 * ends with `report()`, which says what the step was doing.
 */
async function withinStepTimeout<T>(
  name: string,
  step: () => Promise<T>,
  report?: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      step(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const details = report ? `\n${report()}` : '';
          reject(new Error(`${name} did not finish in ${STEP_TIMEOUT_MS} ms.${details}`));
        }, STEP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type RollupHook = (this: unknown, ...args: Array<unknown>) => unknown;
type RollupPlugin = { name: string } & Record<string, unknown>;

const TRACED_HOOKS = ['resolveId', 'load', 'transform', 'renderChunk'] as const;
// A plugin call is recorded when it fails or takes at least this long.
const SLOW_HOOK_MS = 1000;
const TRACE_TAIL = 40;
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

/**
 * What a Nitro build is doing, for the error when it does not finish: the Rollup plugin calls
 * (resolveId, load, transform, renderChunk) still running, the build steps, the last parsed
 * modules with any plugin call that failed or was slow, the last results of void's plugins, and
 * void's driver build files. Kept in memory: a build that finishes prints none of it.
 */
function createBuildTrace(root: string) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const steps: Array<string> = [];
  const records: Array<string> = [];
  const voidResults: Array<string> = [];
  const running = new Set<{ start: number; describe: () => string }>();
  let driverDir: string | undefined;

  const show = (path: string) => {
    let text = path.replaceAll('\0', '\\0');
    for (const [prefix, name] of [
      [root, '<app>'],
      [REPO_ROOT, '<repo>'],
    ] as const) {
      text = text.replaceAll(prefix, name).replaceAll(prefix.replaceAll('\\', '/'), name);
    }
    text = text.replace(/\.pnpm([\\/])[^\\/]+[\\/]node_modules[\\/]/g, '.pnpm$1…$1');
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  };
  const record = (list: Array<string>, text: string) => {
    list.push(`[${elapsed()}ms] ${text}`);
    if (list.length > TRACE_TAIL * 4) {
      list.splice(0, list.length - TRACE_TAIL);
    }
  };
  /** Track a call while it runs. The returned function ends it and returns how long it took. */
  const begin = (describe: () => string) => {
    const call = { start: elapsed(), describe };
    running.add(call);
    return () => {
      running.delete(call);
      return elapsed() - call.start;
    };
  };
  const describeCall = (hook: string, args: Array<unknown>) => {
    if (hook === 'resolveId') {
      const importer = typeof args[1] === 'string' ? show(args[1]) : '(entry)';
      return `${show(String(args[0]))} <- ${importer}`;
    }
    if (hook === 'renderChunk') {
      return String((args[1] as { fileName?: string } | undefined)?.fileName);
    }
    // load(id) and transform(code, id)
    return show(String(hook === 'load' ? args[0] : args[1]));
  };
  const describeResult = (hook: string, value: unknown): string | undefined => {
    if (value === null || value === undefined) {
      return undefined;
    }
    if (hook === 'resolveId') {
      if (typeof value === 'object') {
        const { id, external } = value as { id: string; external?: unknown };
        return `${show(id)}${external ? ' (external)' : ''}`;
      }
      return value === false ? '(external)' : show(String(value));
    }
    const code = typeof value === 'object' ? (value as { code?: unknown }).code : value;
    return typeof code === 'string' ? `${code.length} chars` : 'a result';
  };

  const tracePlugin = (plugin: RollupPlugin): RollupPlugin => {
    const results = plugin.name.startsWith('void:') ? voidResults : undefined;
    // A copy: void/nitro's plugins are shared between builds.
    const traced: RollupPlugin = { ...plugin };
    for (const hook of TRACED_HOOKS) {
      const value = plugin[hook] as RollupHook | { handler: RollupHook } | undefined;
      const handler = typeof value === 'function' ? value : value?.handler;
      if (typeof handler !== 'function') {
        continue;
      }
      const wrapped: RollupHook = function (...args) {
        const describe = () => `${plugin.name} ${hook} ${describeCall(hook, args)}`;
        const end = begin(describe);
        // Recorded when it failed or was slow, and among void's results when it returned one.
        const settle = (outcome: string | undefined, failed = false) => {
          const took = end();
          const list =
            failed || took >= SLOW_HOOK_MS ? records : outcome === undefined ? undefined : results;
          if (list) {
            record(list, `${describe()} => ${outcome ?? 'null'} (took ${took}ms)`);
          }
        };
        let result: unknown;
        try {
          result = handler.apply(this, args);
        } catch (error) {
          settle(`threw ${String(error)}`, true);
          throw error;
        }
        if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
          Promise.resolve(result).then(
            (resolved) => settle(describeResult(hook, resolved)),
            (error) => settle(`rejected ${String(error)}`, true),
          );
        } else {
          settle(describeResult(hook, result));
        }
        return result;
      };
      traced[hook] = typeof value === 'function' ? wrapped : { ...value, handler: wrapped };
    }
    return traced;
  };
  const stepsPlugin: RollupPlugin = {
    name: 'nitro-worker-test:trace',
    buildStart: () => record(steps, 'rollup buildStart'),
    moduleParsed: ({ id }: { id: string }) => record(records, `parsed ${show(id)}`),
    buildEnd: (error?: Error) =>
      record(steps, `rollup buildEnd${error ? `: ${error.message}` : ''}`),
    renderStart: () => record(steps, 'rollup renderStart'),
    writeBundle: () => record(steps, 'rollup writeBundle'),
  };

  /** Each file of void's driver builds, with when it was last written. */
  const driverFiles = () => {
    if (driverDir === undefined) {
      return [];
    }
    const dir = driverDir;
    try {
      const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).map(
        (file) => `  [${Math.round(statSync(join(dir, file)).mtimeMs) - startedAt}ms] ${file}`,
      );
      return [`Files in ${show(dir)}, by last write:`, ...files];
    } catch {
      return [`No ${show(dir)} folder.`];
    }
  };
  const resources = () => {
    const counts = new Map<string, number>();
    for (const type of process.getActiveResourcesInfo()) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts].map(([type, count]) => `${type} x${count}`).join(', ');
  };

  return {
    /** Run one step of the build, and record when it ended and how long it took. */
    async step<T>(name: string, run: () => Promise<T>): Promise<T> {
      const end = begin(() => name);
      try {
        const result = await run();
        record(steps, `${name} done (took ${end()}ms)`);
        return result;
      } catch (error) {
        record(steps, `${name} failed (took ${end()}ms): ${String(error)}`);
        throw error;
      }
    },
    /** Trace the Rollup plugins that `nitro` builds with, and void's driver builds in it. */
    attach(nitro: NitroInstance) {
      driverDir = join(nitro.options.buildDir, 'void');
      nitro.hooks.hook('rollup:before', (_, config) => {
        const plugins = [config.plugins].flat(Infinity as 1) as Array<unknown>;
        config.plugins = [
          stepsPlugin,
          ...plugins.map((plugin) =>
            plugin && typeof plugin === 'object' && 'name' in plugin
              ? tracePlugin(plugin as RollupPlugin)
              : plugin,
          ),
        ];
      });
    },
    report: () => {
      const open = [...running].sort((a, b) => a.start - b.start);
      const more = open.length - TRACE_TAIL;
      const list = (title: string, lines: Array<string>) => [
        title,
        ...lines.slice(-TRACE_TAIL).map((line) => `  ${line}`),
      ];
      return [
        `Still running at ${elapsed()}ms (by start time):`,
        ...open.slice(0, TRACE_TAIL).map((call) => `  [${call.start}ms] ${call.describe()}`),
        ...(more > 0 ? [`  and ${more} more`] : []),
        ...list('Build steps:', steps),
        ...list('Last parsed modules, and plugin calls that failed or were slow:', records),
        ...list("Last results of void's plugins:", voidResults),
        ...driverFiles(),
        `Active resources: ${resources()}`,
      ].join('\n');
    },
  };
}

type NitroInstance = {
  options: { buildDir: string };
  hooks: {
    hook(name: 'rollup:before', run: (nitro: unknown, config: { plugins?: unknown }) => void): void;
  };
  close(): Promise<void>;
};

type NitroBuildApi = {
  createNitro(config: Record<string, unknown>): Promise<NitroInstance>;
  prepare(nitro: NitroInstance): Promise<void>;
  build(nitro: NitroInstance): Promise<void>;
  createDevServer(nitro: NitroInstance): {
    fetch(request: Request): Response | Promise<Response>;
    close(): Promise<void>;
  };
};

/** Nitro's build API, from the Nitro that the Nuxt playground's Nuxt installs. */
async function importNitro(version: 2 | 3 = 2): Promise<NitroBuildApi> {
  if (version === 3) {
    return import('nitro/builder') as unknown as Promise<NitroBuildApi>;
  }
  let require = createRequire(
    join(import.meta.dirname, '../../../../playground/nuxt/package.json'),
  );
  for (const name of ['nuxt', '@nuxt/nitro-server', 'nitropack']) {
    require = createRequire(require.resolve(`${name}/package.json`));
  }
  const { exports } = require('./package.json') as { exports: { '.': { import: string } } };
  return import(pathToFileURL(require.resolve(exports['.'].import)).href) as Promise<NitroBuildApi>;
}

/**
 * Build a Nitro Worker, as Nuxt and Analog do, whose `/users` route runs eight parallel void/db
 * queries and whose `/hash` route hashes with node:crypto. Returns its server output folder.
 */
async function buildNitroWorker(
  database: 'pg' | 'mysql',
  nitroConfig: Record<string, unknown> = {},
  version: 2 | 3 = 2,
  devRequests?: (fetch: (request: Request) => Response | Promise<Response>) => Promise<void>,
): Promise<string> {
  // Windows runners report a short-name temp path, which the bundler refuses to serve.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'void-nitro-worker-')));
  roots.push(root);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('void.json', JSON.stringify({ database }));
  const [table, id] = database === 'pg' ? ['pgTable', 'serial'] : ['mysqlTable', 'int'];
  write(
    'db/schema.ts',
    `import { ${table}, ${id}, text } from 'void/schema-${database}';
export const users = ${table}('users', { id: ${id}('id').primaryKey(), name: text('name').notNull() });
`,
  );
  write(
    'routes/users.ts',
    `${version === 3 ? 'import { defineHandler as defineEventHandler } from "nitro/h3";\n' : ''}import { users } from '@schema';
import { db } from 'void/db';

export default defineEventHandler(async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => db.select().from(users)));
  return results.map((rows) => rows.length);
});
`,
  );
  write(
    'routes/hash.ts',
    `${version === 3 ? 'import { defineHandler as defineEventHandler } from "nitro/h3";\n' : ''}import { createHash } from 'node:crypto';

export default defineEventHandler(() => ({ hash: createHash('sha256').update('void').digest('hex') }));
`,
  );
  // The schema imports Void's SQL helpers by package name, as an app does.
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(
    join(import.meta.dirname, '..', '..'),
    join(root, 'node_modules', 'void'),
    'junction',
  );
  if (version === 3) {
    symlinkSync(
      dirname(createRequire(import.meta.url).resolve('nitro/package.json')),
      join(root, 'node_modules/nitro'),
      'junction',
    );
    const require = createRequire(fileURLToPath(import.meta.resolve('@cloudflare/vite-plugin')));
    for (const dependency of ['miniflare', 'wrangler']) {
      symlinkSync(
        dirname(require.resolve(`${dependency}/package.json`)),
        join(root, 'node_modules', dependency),
        'junction',
      );
    }
  }

  const trace = createBuildTrace(root);
  await withinStepTimeout(
    'The Nitro build',
    async () => {
      const { createNitro, prepare, build, createDevServer } = await trace.step(
        'import Nitro',
        () => importNitro(version),
      );
      const nitro = await trace.step('createNitro', () =>
        createNitro({
          rootDir: root,
          dev: false,
          preset: 'cloudflare-module',
          compatibilityDate: '2026-02-24',
          modules: [voidNitroModule],
          logLevel: 0,
          minify: false,
          sourceMap: false,
          ...(version === 3 ? { serverDir: root } : {}),
          ...nitroConfig,
        }),
      );
      trace.attach(nitro);
      try {
        await trace.step('prepare', () => prepare(nitro));
        if (devRequests) {
          const server = createDevServer(nitro);
          try {
            await trace.step('build dev', () => build(nitro));
            await trace.step('dev requests', () => devRequests((request) => server.fetch(request)));
          } finally {
            await server.close();
          }
        } else {
          await trace.step('build', () => build(nitro));
        }
      } finally {
        await trace.step('close', () => nitro.close());
      }
    },
    trace.report,
  );
  return join(root, '.output', 'server');
}

/** Request `paths` at once from the Worker in workerd, with the flags a deploy gives it. */
async function fetchNitroWorker(
  serverDir: string,
  connectionString: string,
  paths: Array<string>,
): Promise<Array<{ status: number; body: unknown }>> {
  const modules = readdirSync(serverDir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.mjs'))
    .sort((a, b) => Number(b === 'index.mjs') - Number(a === 'index.mjs'))
    .map((file) => ({ type: 'ESModule' as const, path: join(serverDir, file) }));
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      modulesRoot: serverDir,
      modules,
      compatibilityDate: '2026-02-24',
      compatibilityFlags: ['nodejs_compat'],
      bindings: { HYPERDRIVE: { connectionString } },
    }),
  );
  try {
    await withinStepTimeout('workerd startup', () => miniflare.ready);
    return await Promise.all(
      paths.map((path) =>
        withinStepTimeout(`The Worker's response to ${path}`, async () => {
          const response = await miniflare.dispatchFetch(`http://localhost${path}`);
          return { status: response.status, body: await response.json() };
        }),
      ),
    );
  } finally {
    await miniflare.dispose();
  }
}

async function fetchNitroDevelopment(
  database: 'pg' | 'mysql',
  connectionString: string,
  paths: Array<string>,
  builder: 'rolldown' | false = 'rolldown',
): Promise<Array<{ status: number; body: unknown }>> {
  let responses: Array<{ status: number; body: unknown }> = [];
  await buildNitroWorker(
    database,
    {
      dev: true,
      builder,
      cloudflare: {
        wrangler: {
          compatibility_date: '2026-02-24',
          compatibility_flags: ['nodejs_compat'],
          vars: { DATABASE_URL: connectionString },
        },
      },
    },
    3,
    async (fetch) => {
      responses = await Promise.all(
        paths.map(async (path) => {
          const response = await fetch(new Request(`http://localhost${path}`));
          return { status: response.status, body: await response.json() };
        }),
      );
    },
  );
  return responses;
}

// Each case runs a Nitro build and starts workerd.
describe('a Nitro Worker with void/nitro', () => {
  const requests = ['/users', '/users', '/users', '/hash'];
  const hash = createHash('sha256').update('void').digest('hex');
  const expected = [
    ...Array.from({ length: 3 }, () => ({ status: 200, body: Array(8).fill(1) })),
    { status: 200, body: { hash } },
  ];

  it.each(['rolldown', false] as const)(
    'runs Nitro 3 development queries (builder: %s) on one connection per request',
    async (builder) => {
      const mysql = await startFakeMySqlServer([{ id: 1, name: 'alice' }]);
      try {
        const url = `mysql://void@127.0.0.1:${mysql.port}/app`;
        expect(await fetchNitroDevelopment('mysql', url, requests, builder)).toEqual(expected);
        expect(mysql.acceptedConnections()).toBe(3);
      } finally {
        await mysql.close();
      }
    },
  );

  it.each([
    [2, false],
    [3, false],
    [3, true],
  ] as const)(
    'runs PostgreSQL queries with Nitro %s (dev: %s) in workerd on one connection per request',
    async (version, dev) => {
      const serverDir = dev ? undefined : await buildNitroWorker('pg', {}, version);
      const pglite = new PGlite();
      await withinStepTimeout('PGlite startup', async () => {
        // pglite-server does not wait for PGlite: a query that arrives during startup spins
        // forever.
        await pglite.waitReady;
        await pglite.exec(
          "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL); INSERT INTO users (name) VALUES ('alice');",
        );
      });
      const server = createPgServer(pglite);
      let connections = 0;
      server.on('connection', () => connections++);
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const { port } = server.address() as AddressInfo;
        const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
        expect(
          await (dev
            ? fetchNitroDevelopment('pg', url, requests)
            : fetchNitroWorker(serverDir!, url, requests)),
        ).toEqual(expected);
        expect(connections).toBe(3);
      } finally {
        server.close();
        await pglite.close();
      }
    },
  );

  // Nitro's `commonJS.strictRequires` wraps every CommonJS module, mysql2 included.
  it.each([
    ['', {}, 2],
    [' when Nitro wraps every CommonJS module', { commonJS: { strictRequires: true } }, 2],
    [' with Nitro 3', {}, 3],
  ] as const)(
    'runs MySQL queries in workerd on one connection per request%s',
    async (_, nitroConfig, version) => {
      const serverDir = await buildNitroWorker('mysql', nitroConfig, version);
      const mysql = await startFakeMySqlServer([{ id: 1, name: 'alice' }]);
      try {
        const url = `mysql://void@127.0.0.1:${mysql.port}/app`;
        expect(await fetchNitroWorker(serverDir, url, requests)).toEqual(expected);
        expect(mysql.acceptedConnections()).toBe(3);
      } finally {
        await mysql.close();
      }
    },
  );
});
