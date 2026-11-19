import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { analyzeApplication } from '../../src/application-routing.ts';
import { readConfig } from '../../src/config.ts';
import { drizzlePlugin } from '../../src/plugin-drizzle.ts';
import {
  compileRouteTable,
  compileWorkerClient,
  compileWorkerEntry,
} from '../../src/router/compile.ts';

const source = (file: string) =>
  fileURLToPath(new URL(`../../src/runtime/${file}`, import.meta.url));
let directory: string;
let runtime: Miniflare | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('D1 bookmarks in generated Workers', () => {
  // Local D1 has no replica lag. The unit reproduction controls lag; this verifies
  // real D1 bookmarks, middleware, redirects, bundling and request scope in workerd.
  it.each(
    [
      { module: 'runtime', bindingName: 'DB' },
      { module: 'generated', bindingName: 'DB' },
      { module: 'generated', bindingName: 'APP_DB' },
    ].flatMap((client) =>
      ['header', 'cookie'].flatMap((transport) =>
        ['direct', 'server-fetch', 'before-use', 'nested-write', 'concurrent'].map((dispatch) => ({
          ...client,
          transport,
          dispatch,
        })),
      ),
    ),
  )(
    '$module / $bindingName carries a bookmark through $transport middleware ($dispatch)',
    async ({ module, bindingName, transport, dispatch }) => {
      directory = mkdtempSync(join(tmpdir(), 'void-db-bookmark-worker-'));
      const routes = join(directory, 'routes');
      const middleware = join(directory, 'middleware');
      const output = join(directory, 'output');
      mkdirSync(routes);
      mkdirSync(middleware);
      writeFileSync(
        join(middleware, '01.database.ts'),
        `
import { db, setSession, getBookmark } from 'void/db';
import { getCookie, setCookie } from 'hono/cookie';
export default async (c, next) => {
  // Incidental probes must not open the session before middleware configures it.
  await Promise.resolve(db);
  JSON.stringify(db);
  Object.prototype.toString.call(db);
  Reflect.get(db, Symbol.for('nodejs.util.inspect.custom'));
  const incoming = ${transport === 'cookie' ? "getCookie(c, 'db-bookmark')" : "c.req.header('X-DB-Bookmark')"};
  setSession(incoming === undefined ? 'first-unconstrained' : { bookmark: incoming });
  await next();
  const bookmark = getBookmark();
  if (bookmark) {
    c.header('X-DB-Bookmark', bookmark);
    ${transport === 'cookie' ? "setCookie(c, 'db-bookmark', bookmark, { httpOnly: true, sameSite: 'Lax', path: '/' });" : ''}
  }
};
`,
      );
      writeFileSync(
        join(routes, 'profile.ts'),
        `
import { db, createDb, getBookmark, sql } from 'void/db';
export async function POST(c) {
  await db.run(sql\`UPDATE profile SET name = 'Alice' WHERE id = 1\`);
  return c.redirect('/profile', 303);
}
export async function GET(c) {
  const name = await db.get(sql\`SELECT name FROM profile WHERE id = 1\`);
  const bookmark = getBookmark();
  const client = createDb(c.env[${JSON.stringify(bindingName)}], {
    session: bookmark === null ? 'first-unconstrained' : { bookmark },
  });
  const explicit = await client.get(sql\`SELECT name FROM profile WHERE id = 1\`);
  return c.json({ name, explicit, bookmark: getBookmark(client) });
}
export async function PATCH(c) {
  await db.run(sql\`UPDATE profile SET name = 'Nested name' WHERE id = 1\`);
  return c.json({ bookmark: getBookmark() });
}
`,
      );
      writeFileSync(join(routes, 'unused.ts'), 'export function GET() { return "unused"; }');
      if (dispatch !== 'direct') {
        writeFileSync(
          join(routes, 'nested.ts'),
          `
import { fetch } from 'void/client';
import { db, sql } from 'void/db';
export async function GET(c) {
  ${dispatch === 'before-use' ? '' : 'await db.get(sql`SELECT name FROM profile WHERE id = 1`);'}
  ${
    dispatch === 'nested-write'
      ? `await fetch('/profile', { method: 'PATCH', retry: 0 });
  const outerName = await db.get(sql\`SELECT name FROM profile WHERE id = 1\`);
  return c.json({ ...await fetch('/profile', { retry: 0 }), outerName });`
      : dispatch === 'concurrent'
        ? `const results = await Promise.all([
    fetch('/profile', { retry: 0 }),
    fetch('/profile', { retry: 0 }),
  ]);
  return c.json({ ...results[0], concurrent: results });`
        : "return c.json(await fetch('/profile', { retry: 0 }));"
  }
}
`,
        );
      }
      const { scan } = await analyzeApplication(directory, { config: readConfig(directory) });
      const routeTable = join(directory, 'generated-routes.ts');
      const entry = join(directory, 'generated-worker.ts');
      writeFileSync(
        routeTable,
        compileRouteTable(
          scan,
          routes,
          middleware,
          join(directory, 'crons'),
          join(directory, 'queues'),
          null,
          {
            honoPath: fileURLToPath(import.meta.resolve('hono')),
            honoRoutePath: fileURLToPath(import.meta.resolve('hono/route')),
            runtimeEnvPath: source('env/runtime.ts'),
            projectRoot: directory,
            homeDir: tmpdir(),
            auth: null,
            dev: false,
            reactRefresh: false,
          },
        ),
      );
      writeFileSync(entry, compileWorkerEntry({ runtimeEnvPath: source('env/runtime.ts') }));
      const instrumentedEntry = join(directory, 'instrumented-worker.ts');
      writeFileSync(
        instrumentedEntry,
        `
import worker from './generated-worker.ts';
export default {
  async fetch(request, env, ctx) {
    const starts = [];
    const bindingName = ${JSON.stringify(bindingName)};
    const binding = env[bindingName];
    const tracked = new Proxy(binding, {
      get(target, prop) {
        if (prop === 'withSession') return (start) => {
          starts.push(start);
          return target.withSession(start);
        };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await new worker(ctx, { ...env, [bindingName]: tracked }).fetch(request);
    const result = new Response(response.body, response);
    result.headers.set('X-Test-Session-Starts', JSON.stringify(starts));
    return result;
  },
};
`,
      );
      await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [
          {
            name: 'bookmark-worker-fixture',
            enforce: 'pre',
            resolveId(id) {
              if (id === 'virtual:void-routes') {
                return routeTable;
              }
              if (id === 'hono/cookie') {
                return fileURLToPath(import.meta.resolve('hono/cookie'));
              }
              if (id.endsWith('/dist/runtime/db/session.mjs')) {
                return source('db/session.ts');
              }
              if (id.endsWith('/dist/runtime/routing/index.mjs')) {
                return source('routing/index.ts');
              }
              if (id === 'void/db' && module === 'runtime') {
                return source('db/index.ts');
              }
              if (id === 'void/client') {
                return '\0bookmark-worker-client';
              }
              if (id.endsWith('/dist/runtime/client/fetch-server.mjs')) {
                return source('client/fetch-server.ts');
              }
            },
            load(id) {
              if (id === '\0bookmark-worker-client') {
                return compileWorkerClient(source('auth/client.ts'));
              }
            },
          },
          ...(module === 'generated'
            ? [
                drizzlePlugin(directory, false, 'sqlite', {
                  d1BindingName: bindingName,
                  forceVirtualDb: true,
                }),
              ]
            : []),
        ],
        ssr: { noExternal: true },
        build: {
          outDir: output,
          ssr: instrumentedEntry,
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
          compatibilityFlags: ['nodejs_compat'],
          modules: true,
          modulesRoot: output,
          scriptPath: join(output, 'worker.mjs'),
          d1Databases: [bindingName],
        }),
      );
      const binding = await runtime.getD1Database(bindingName);
      await binding.prepare('CREATE TABLE profile (id INTEGER PRIMARY KEY, name TEXT)').run();
      await binding.prepare("INSERT INTO profile VALUES (1, 'Old name')").run();
      const saved = await runtime.dispatchFetch('https://app.test/profile', {
        method: 'POST',
        redirect: 'manual',
      });
      expect(saved.status, await saved.clone().text()).toBe(303);
      expect(saved.headers.get('Location')).toBe('/profile');
      const bookmark = saved.headers.get('X-DB-Bookmark');
      expect(bookmark).toBeTruthy();
      const loaded = await runtime.dispatchFetch(
        `https://app.test/${dispatch === 'direct' ? 'profile' : 'nested'}`,
        {
          headers:
            transport === 'cookie'
              ? { Cookie: `db-bookmark=${encodeURIComponent(bookmark!)}` }
              : { 'X-DB-Bookmark': bookmark! },
        },
      );
      expect(loaded.status, await loaded.clone().text()).toBe(200);
      // Local D1 has no replica lag, so explicitly assert that middleware
      // preserved the outer bookmark even when nested dispatch happens first.
      const starts = JSON.parse(loaded.headers.get('X-Test-Session-Starts')!) as Array<string>;
      expect(starts[0]).toBe(bookmark);
      // Direct GET also creates an explicit client from its wrapped env.
      // Local fetch receives cloudflare:workers env for explicit clients,
      // while its default db still shares the outer runtime session.
      expect(starts).toHaveLength(dispatch === 'direct' ? 2 : 1);
      const name = dispatch === 'nested-write' ? 'Nested name' : 'Alice';
      const profile = {
        name: { name },
        explicit: { name },
        bookmark: expect.any(String),
      };
      expect(await loaded.json()).toEqual({
        ...profile,
        ...(dispatch === 'nested-write' ? { outerName: { name } } : {}),
        ...(dispatch === 'concurrent' ? { concurrent: [profile, profile] } : {}),
      });
      expect(loaded.headers.get('X-DB-Bookmark')).toBeTruthy();
      if (transport === 'cookie') {
        expect(loaded.headers.get('Set-Cookie')).toContain('db-bookmark=');
      }
      const unused = await runtime.dispatchFetch('https://app.test/unused', {
        headers:
          transport === 'cookie'
            ? { Cookie: `db-bookmark=${encodeURIComponent(bookmark!)}` }
            : { 'X-DB-Bookmark': bookmark! },
      });
      expect(await unused.text()).toBe('unused');
      expect(unused.headers.has('X-DB-Bookmark')).toBe(false);
    },
    30_000,
  );
});
