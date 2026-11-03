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
const adapterSource = (path: string) => JSON.stringify(join(packageRoot, '..', path));
const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// Checked against a fixture generated with routing.typedRoutes on.
const typedCheck = `import { routeUrl, type Href, type RouteUrl } from 'void/routes';
import { defineConfig } from 'void/config';
import type { VoidRouter } from 'void/pages-client';
import { defineMiddleware, type CloudContext } from 'void/handler';
declare const id: number;
declare const dynamic: string;
const user: RouteUrl = routeUrl('/users/:id', { params: { id } });
const plain: string = user;
const hrefs: Array<Href> = [
  '/',
  '/about',
  '/about?tab=activity',
  '/about#team',
  '/?tab=activity',
  '/users/42',
  \`/users/\${id}\`,
  '/files/docs/start',
  '/wild',
  '/wild/a/b',
  '/api/legacy',
  '/café menu',
  '/caf%C3%A9%20menu',
  '/caf%C3%A9%20menu?q=caf%C3%A9+menu',
  '/café/42',
  '/caf%C3%A9/42',
  '/api/users/42',
  '?page=2',
  '#details',
  'https://vite.dev/guide',
  'http://localhost:5173',
  'mailto:team@example.com',
  'tel:+15550100',
  user,
  dynamic as RouteUrl,
  ('https://' + dynamic) as Href,
];
// @ts-expect-error unknown routes are rejected
const unknown: Href = '/unknown';
// @ts-expect-error unchecked strings are rejected
const unchecked: Href = dynamic;
// @ts-expect-error relative paths are rejected
const relative: Href = '../about';
// @ts-expect-error protocol-relative URLs are rejected when no root dynamic route matches them
const protocolRelative: Href = '//example.com/about';
// @ts-expect-error empty strings are rejected
const empty: Href = '';
// @ts-expect-error route URLs exclude external links
const external: RouteUrl = 'https://vite.dev';
void [plain, hrefs, unknown, unchecked, relative, protocolRelative, empty, external];
declare const router: VoidRouter;
void router.visit('/users/42');
void router.visit(routeUrl('/about'));
void router.visit({ pathname: '/users/:id', params: { id } });
void router.prefetch(new URL('https://example.com'));
router.flush('#details');
// @ts-expect-error router navigation is checked
void router.visit('/unknown');
// @ts-expect-error router prefetches are checked
void router.prefetch('../relative');
declare const honoContext: Parameters<ReturnType<typeof defineMiddleware>>[0];
const context: CloudContext = honoContext;
void context.rewrite('/users/42');
void context.rewrite(user);
void context.rewrite('/api/legacy');
// @ts-expect-error rewrites only reach the app's routes
void context.rewrite('https://example.com');
// @ts-expect-error rewrites do not take same-page hashes
void context.rewrite('#details');
context.redirect('https://example.com/elsewhere');
// Config rewrites keep placeholders and static files.
defineConfig({
  routing: {
    typedRoutes: true,
    rewrites: { '/old/*': '/new/:splat', '/app/*': '/index.html' },
    fallbacks: { '/legacy/:id': '/legacy-proxy/:id' },
  },
});
`;

const linkHrefCheck = `import type { Href } from 'void/routes';
import type { LinkProps as ReactLinkProps } from ${adapterSource('react/src/runtime/link.tsx')};
import type { Link as VueLink } from ${adapterSource('vue/src/runtime/link.ts')};
import type { LinkProps as SvelteLinkProps } from ${adapterSource('svelte/src/runtime/link-props.ts')};
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type VueLinkProps = InstanceType<typeof VueLink>['$props'];
const same: [
  Same<ReactLinkProps['href'], Href>,
  Same<VueLinkProps['href'], Href>,
  Same<SvelteLinkProps['href'], Href>,
] = [true, true, true];
const known: [ReactLinkProps['href'], VueLinkProps['href'], SvelteLinkProps['href']] = [
  '/users/42',
  '/users/42',
  '/users/42',
];
// @ts-expect-error React Link rejects unknown routes
const react: ReactLinkProps['href'] = '/unknown';
// @ts-expect-error Vue Link rejects unknown routes
const vue: VueLinkProps['href'] = '/unknown';
// @ts-expect-error Svelte Link rejects unknown routes
const svelte: SvelteLinkProps['href'] = '/unknown';
void [same, known, react, vue, svelte];
`;

const solidLinkHrefCheck = `import type { Href } from 'void/routes';
import type { LinkProps } from ${adapterSource('solid/src/runtime/link.tsx')};
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Same<LinkProps['href'], Href> = true;
const known: LinkProps['href'] = '/users/42';
// @ts-expect-error Solid Link rejects unknown routes
const unknown: LinkProps['href'] = '/unknown';
void [same, known, unknown];
`;

async function createFixture({
  typedRoutes = false,
  extraFiles = {},
}: { typedRoutes?: boolean; extraFiles?: Record<string, string> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'void-route-util-'));
  roots.push(root);
  const files: Record<string, string> = {
    'check-typed.ts': typedCheck,
    'check-links.ts': linkHrefCheck,
    'check-solid-link.ts': solidLinkHrefCheck,
    'package.json': '{"type":"module"}',
    'routes/api/users/[id].ts':
      "import { defineHandler } from 'void/handler'; export const GET = defineHandler(() => ({ ok: true }));",
    'routes/api/legacy.ts':
      "import { defineHandler } from 'void/handler'; export default defineHandler(() => ({ ok: true }));",
    'pages/index.tsx': 'export default function Page() { return null; }',
    'pages/about.tsx': 'export default function Page() { return null; }',
    'pages/café menu.tsx': 'export default function Page() { return null; }',
    'pages/café/[id].tsx': 'export default function Page() { return null; }',
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
    ...extraFiles,
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
    { typedRoutes },
  );
  mkdirSync(join(root, '.void'));
  writeFileSync(join(root, '.void/routes.d.ts'), dts);
  writeFileSync(
    join(root, '.void/tsconfig.json'),
    JSON.stringify(createProjectTsconfig(root, true)),
  );
  return root;
}

function typecheck(
  root: string,
  declarations: 'generated' | 'package',
  include: Array<string>,
  compilerOptions: Record<string, unknown> = {},
) {
  const config = `tsconfig.${include.join('-')}.json`;
  writeFileSync(
    join(root, config),
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
        ...compilerOptions,
      },
      include,
    }),
  );
  const tsc = join(
    dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
    'bin/tsc',
  );
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, config)], {
    encoding: 'utf8',
  });
  return { output: result.stdout + result.stderr, status: result.status };
}

describe('standalone routeUrl utility', () => {
  it.each(['generated', 'package'] as const)(
    'typechecks through the %s declarations',
    async (declarations) => {
      const root = await createFixture();
      expect(typecheck(root, declarations, ['check.ts'])).toEqual({ output: '', status: 0 });
    },
  );

  it.each(['generated', 'package'] as const)(
    'checks URL strings against routes through the %s declarations with routing.typedRoutes',
    async (declarations) => {
      const root = await createFixture({ typedRoutes: true });
      expect(typecheck(root, declarations, ['check-typed.ts'])).toEqual({ output: '', status: 0 });
    },
  );

  it('lets a root dynamic page match any single-segment URL with routing.typedRoutes', async () => {
    const root = await createFixture({
      typedRoutes: true,
      extraFiles: {
        'pages/[slug].tsx': 'export default function Page() { return null; }',
        // Template literal types cannot exclude empty or slash-leading segments.
        'check-root-dynamic.ts': `import type { RouteUrl } from 'void/routes';
const loose: Array<RouteUrl> = ['/anything', '/users/', '//example.com'];
void loose;
`,
      },
    });
    expect(typecheck(root, 'generated', ['check-root-dynamic.ts'])).toEqual({
      output: '',
      status: 0,
    });
  });

  it('checks Link href in every adapter with routing.typedRoutes', async () => {
    const root = await createFixture({ typedRoutes: true });
    const tsSources = { allowImportingTsExtensions: true };
    expect(
      typecheck(root, 'generated', ['check-links.ts'], { ...tsSources, jsx: 'react-jsx' }),
    ).toEqual({ output: '', status: 0 });
    expect(
      typecheck(root, 'generated', ['check-solid-link.ts'], {
        ...tsSources,
        jsx: 'preserve',
        jsxImportSource: 'solid-js',
      }),
    ).toEqual({ output: '', status: 0 });
  });

  it('checks URL strings through the package types alone with routing.typedRoutes', () => {
    // The generated declarations repeat the route URL types, so check the
    // package's own copy without a generated .void/routes.d.ts.
    const root = mkdtempSync(join(tmpdir(), 'void-route-stub-'));
    roots.push(root);
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(packageRoot, join(root, 'node_modules/void'), 'junction');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(root, 'routes.d.ts'),
      `export {};
declare module 'void/routes' {
  interface RoutePathMap { '/': never; '/docs/*': '*'; '/users/:id': 'id'; '/café menu': never }
  interface EncodedRoutePathMap { '/café menu': '/caf%C3%A9%20menu' }
  interface RouteTypesConfig { typedRoutes: true }
}
`,
    );
    writeFileSync(
      join(root, 'check.ts'),
      `import type { Href, RouteUrl } from 'void/routes';
const hrefs: Array<Href> = ['/', '/docs', '/docs/a/b', '/users/42', '/café menu', '/caf%C3%A9%20menu?q=1', '#top', 'https://vite.dev'];
const route: RouteUrl = '/caf%C3%A9%20menu';
// @ts-expect-error unknown routes are rejected
const unknown: Href = '/unknown';
// @ts-expect-error route URLs exclude external links
const external: RouteUrl = 'https://vite.dev';
void [hrefs, route, unknown, external];
`,
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'DOM'],
          types: [],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['routes.d.ts', 'check.ts'],
      }),
    );
    const tsc = join(
      dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
      'bin/tsc',
    );
    const result = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
      encoding: 'utf8',
    });
    expect({ output: result.stdout + result.stderr, status: result.status }).toEqual({
      output: '',
      status: 0,
    });
  });

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
