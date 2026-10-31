import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium } from 'playwright';
import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { analyzeApplication } from '../../src/application-routing.ts';
import { createProjectTsconfig } from '../../src/codegen/project-tsconfig.ts';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';
import { readConfig } from '../../src/config.ts';

const packageRoot = join(import.meta.dirname, '../..');
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'void-route-util-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': '{"type":"module"}',
    'routes/api/users/[id].ts':
      "import { defineHandler } from 'void/handler'; export const GET = defineHandler(() => ({ ok: true }));",
    'pages/index.tsx': 'export default function Page() { return null; }',
    'pages/about.tsx': 'export default function Page() { return null; }',
    'pages/café menu.tsx': 'export default function Page() { return null; }',
    'pages/users/[id].tsx': 'export default function Page() { return null; }',
    'pages/files/[...path].tsx': 'export default function Page() { return null; }',
    'pages/wild/[...].tsx': 'export default function Page() { return null; }',
    'check.ts': `import {
  routeUrl,
  type RouteDestination,
  type RouteOptions,
  type RoutePath,
} from 'void/routes';
import type { VoidRouter } from 'void/pages-client';
import { defineHandler, defineMiddleware, type CloudContext } from 'void/handler';
const path: RoutePath = '/users/:id';
const options: RouteOptions<typeof path> = { params: { id: 123 }, query: { tab: 'activity' }, hash: 'details' };
const url: string = routeUrl(path, options);
routeUrl('/');
routeUrl('/about');
routeUrl('/café menu');
routeUrl('/api/users/:id', { params: { id: '123' } });
routeUrl('/files/:path{.+}', { params: { path: 'docs/start' } });
routeUrl('/wild/*', { params: { '*': 'a/b' } });
// @ts-expect-error a known route's params are required
routeUrl('/users/:id');
// @ts-expect-error params cannot be omitted while providing other options
routeUrl('/users/:id', { query: { tab: 'activity' } });
// @ts-expect-error unknown routes are rejected
routeUrl('/unknown');
// @ts-expect-error extra params are rejected
routeUrl('/users/:id', { params: { id: '123', wrong: 'x' } });
// @ts-expect-error static routes do not accept params
routeUrl('/about', { params: {} });
// @ts-expect-error catch-all routes require params too
routeUrl('/files/:path{.+}');
// @ts-expect-error anonymous catch-all routes require a wildcard param
routeUrl('/wild/*');
void url;
const destination: RouteDestination = { pathname: '/users/:id', params: { id: 123 }, query: { tab: 'activity' } };
declare const router: VoidRouter;
void router.visit(destination);
void router.prefetch(destination);
router.flush(destination);
// @ts-expect-error destinations require path params
void router.visit({ pathname: '/users/:id' });
declare const honoContext: Parameters<ReturnType<typeof defineMiddleware>>[0];
const context: CloudContext = honoContext;
const response: Response & { _status: 307 } = context.redirect(url, 307);
void response;
void context.rewrite(destination);
// @ts-expect-error Hono redirects require a string or URL
context.redirect(destination);
// @ts-expect-error typed server rewrites reject unknown patterns
void context.rewrite({ pathname: '/unknown' });
defineHandler(c => c.redirect(url));
defineMiddleware(async c => c.redirect(url));
`,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(packageRoot, join(root, 'node_modules/void'), 'junction');
  const { scan } = await analyzeApplication(root, {
    config: readConfig(root),
  });
  const { dts } = generateRouteTypes(
    scan,
    join(root, 'routes'),
    join(root, '.void'),
    join(root, 'pages'),
  );
  mkdirSync(join(root, '.void'));
  writeFileSync(join(root, '.void/routes.d.ts'), dts);
  writeFileSync(
    join(root, '.void/tsconfig.json'),
    JSON.stringify(createProjectTsconfig(root, true)),
  );
  return root;
}

describe('standalone routeUrl utility', () => {
  it.each(['generated', 'package'] as const)(
    'typechecks through the %s declarations',
    async (declarations) => {
      const root = await createFixture();
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          extends: './.void/tsconfig.json',
          compilerOptions: {
            target: 'ES2022',
            module: declarations === 'generated' ? 'ESNext' : 'NodeNext',
            moduleResolution: declarations === 'generated' ? 'Bundler' : 'NodeNext',
            lib: ['ES2022', 'DOM'],
            types: [],
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            ...(declarations === 'package' ? { paths: {} } : {}),
          },
          include: ['check.ts'],
        }),
      );
      const tsc = join(
        dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
        'bin/tsc',
      );
      const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
        encoding: 'utf8',
      });
      expect(result.stdout + result.stderr).toBe('');
      expect(result.status).toBe(0);
    },
  );

  it('preserves URLs created in another realm', async () => {
    const root = await createFixture();
    writeFileSync(join(root, 'entry.ts'), "export { toUrlString } from 'void/pages-client';\n");
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      build: {
        minify: false,
        lib: { entry: join(root, 'entry.ts'), formats: ['es'], fileName: () => 'route.mjs' },
      },
    });
    const code = readFileSync(join(root, 'dist/route.mjs'), 'utf8');
    const original = 'https://other.example/users?tab=activity#details';
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<iframe></iframe>');
      const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
      // Keep the import in browser code so Vitest does not rewrite it for SSR.
      expect(
        await page.evaluate(`import(${JSON.stringify(dataUrl)}).then(({ toUrlString }) => {
          const iframe = document.querySelector('iframe');
          const value = new iframe.contentWindow.URL(${JSON.stringify(original)});
          return { isLocalURL: value instanceof URL, serialized: toUrlString(value) };
        })`),
      ).toEqual({ isLocalURL: false, serialized: original });
    } finally {
      await browser.close();
    }
  });

  it('bundles the public export for browsers and runs on Workers without Node compatibility', async () => {
    const root = await createFixture();
    writeFileSync(
      join(root, 'entry.ts'),
      `import { routeUrl } from 'void/routes';
export function buildUrls() {
  return [
    routeUrl('/users/:id', { params: { id: 'a/b' }, query: { page: 2, tag: ['one', 'two'] }, hash: '/settings?tab=1&next=%2Fhome' }),
    routeUrl('/café menu', { query: { q: 'café menu' }, hash: 'café menu' }),
  ];
}
`,
    );
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      build: {
        minify: false,
        lib: { entry: join(root, 'entry.ts'), formats: ['es'], fileName: () => 'route.mjs' },
      },
    });
    const expected = [
      '/users/a%2Fb?page=2&tag=one&tag=two#/settings?tab=1&next=%2Fhome',
      '/caf%C3%A9%20menu?q=caf%C3%A9+menu#caf%C3%A9%20menu',
    ];
    const scriptPath = join(root, 'dist/route.mjs');
    const code = readFileSync(scriptPath, 'utf8');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
      // Keep the dynamic import in browser code so Vitest does not rewrite it for SSR.
      expect(
        await page.evaluate(
          `import(${JSON.stringify(dataUrl)}).then((module) => module.buildUrls())`,
        ),
      ).toEqual(expected);
    } finally {
      await browser.close();
    }
    const workerPath = join(root, 'dist/worker.mjs');
    writeFileSync(
      workerPath,
      "import { buildUrls } from './route.mjs'; export default { fetch() { return Response.json(buildUrls()); } };\n",
    );
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: '2026-10-01',
        modules: [
          { type: 'ESModule', path: workerPath },
          { type: 'ESModule', path: scriptPath },
        ],
        modulesRoot: join(root, 'dist'),
      }),
    );
    try {
      const response = await runtime.dispatchFetch('https://app.test/');
      expect(await response.json()).toEqual(expected);
    } finally {
      await runtime.dispose();
    }
  });
});
