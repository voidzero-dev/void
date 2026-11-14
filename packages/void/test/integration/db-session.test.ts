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
import { compileRouteTable, compileWorkerEntry } from '../../src/router/compile.ts';

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
  it.each([
    { module: 'runtime', bindingName: 'DB' },
    { module: 'generated', bindingName: 'DB' },
    { module: 'generated', bindingName: 'APP_DB' },
  ])(
    '$module / $bindingName carries a bookmark through middleware',
    async ({ module, bindingName }) => {
      directory = mkdtempSync(join(tmpdir(), 'void-db-bookmark-worker-'));
      const routes = join(directory, 'routes');
      const middleware = join(directory, 'middleware');
      const output = join(directory, 'output');
      mkdirSync(routes);
      mkdirSync(middleware);
      writeFileSync(
        join(middleware, '01.database.ts'),
        `
import { setSession, getBookmark } from 'void/db';
export default async (c, next) => {
  setSession(c.req.header('X-DB-Bookmark') ?? 'first-unconstrained');
  await next();
  const bookmark = getBookmark();
  if (bookmark) c.header('X-DB-Bookmark', bookmark);
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
  const client = createDb(c.env[${JSON.stringify(bindingName)}], { session: getBookmark() ?? 'first-unconstrained' });
  const explicit = await client.get(sql\`SELECT name FROM profile WHERE id = 1\`);
  return c.json({ name, explicit, bookmark: getBookmark(client) });
}
`,
      );
      writeFileSync(join(routes, 'unused.ts'), 'export function GET() { return "unused"; }');
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
            runtimeEnvPath: source('env.ts'),
            projectRoot: directory,
            homeDir: tmpdir(),
            auth: null,
            dev: false,
            reactRefresh: false,
          },
        ),
      );
      writeFileSync(entry, compileWorkerEntry({ runtimeEnvPath: source('env.ts') }));
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
              if (id.endsWith('/dist/runtime/routing.mjs')) {
                return source('routing.ts');
              }
              if (id === 'void/db' && module === 'runtime') {
                return source('db.ts');
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
      expect(saved.status).toBe(303);
      expect(saved.headers.get('Location')).toBe('/profile');
      const bookmark = saved.headers.get('X-DB-Bookmark');
      expect(bookmark).toBeTruthy();
      const loaded = await runtime.dispatchFetch('https://app.test/profile', {
        headers: { 'X-DB-Bookmark': bookmark! },
      });
      expect(loaded.status).toBe(200);
      expect(await loaded.json()).toEqual({
        name: { name: 'Alice' },
        explicit: { name: 'Alice' },
        bookmark: expect.any(String),
      });
      expect(loaded.headers.get('X-DB-Bookmark')).toBeTruthy();
      const unused = await runtime.dispatchFetch('https://app.test/unused', {
        headers: { 'X-DB-Bookmark': bookmark! },
      });
      expect(await unused.text()).toBe('unused');
      expect(unused.headers.has('X-DB-Bookmark')).toBe(false);
    },
    30_000,
  );
});
