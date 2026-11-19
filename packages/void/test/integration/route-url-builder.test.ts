import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { chromium } from 'playwright';
import { build, transformWithOxc } from 'vite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { analyzeApplication } from '../../src/application-routing.ts';
import { createProjectTsconfig } from '../../src/codegen/project-tsconfig.ts';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';
import { readConfig } from '../../src/config.ts';

const packageRoot = join(import.meta.dirname, '../..');
const adapterSource = (path: string) => JSON.stringify(join(packageRoot, '..', path));
const roots: Array<string> = [];
const compilers = [
  createRequire(import.meta.url),
  createRequire(join(packageRoot, '../../playground/analog/package.json')),
].map((require) => ({
  version: require('typescript/package.json').version as string,
  tsc: join(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
}));
const declarationChecks = compilers.flatMap((compiler) =>
  (['generated', 'package'] as const).map((declarations) => ({ ...compiler, declarations })),
);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// Checked against a fixture generated with routing.typedRoutes on.
const typedCheck = `import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { etag } from 'hono/etag';
import { routeUrl, type Href, type RouteUrl } from 'void/routes';
import { defineConfig } from 'void/config';
import type { VoidRouter } from 'void/pages-client';
import { defineHandler, defineMiddleware, type CloudContext } from 'void/handler';
import { revalidate } from 'void/isr';
import { connectLiveStream } from 'void/live/client';
import { connectEventStream } from 'void/sse/client';
import type { IslandFormState } from 'void/pages-client';
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
// @ts-expect-error protocol-relative URLs are rejected
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
declare const context: CloudContext;
void context.rewrite('/users/42');
void context.rewrite(user);
void context.rewrite('/api/legacy');
// @ts-expect-error rewrites only reach the app's routes
void context.rewrite('https://example.com');
// @ts-expect-error rewrites do not take same-page hashes
void context.rewrite('#details');
context.redirect('/about');
context.redirect(user);
context.redirect(routeUrl('/users/:id', { params: { id } }));
context.redirect({ pathname: '/users/:id', params: { id } });
context.redirect('https://example.com/elsewhere');
context.redirect(new URL('https://example.com/login'));
context.redirect(dynamic as Href);
// @ts-expect-error unknown routes are rejected
context.redirect('/unknown');
// @ts-expect-error unchecked strings are rejected
context.redirect(dynamic);
defineHandler((c) => {
  c.redirect('/about');
  c.redirect({ pathname: '/users/:id', params: { id } });
  // @ts-expect-error unknown routes are rejected
  return c.redirect('/unknown');
});
defineMiddleware(async (c) => {
  c.redirect('https://example.com/login');
  // @ts-expect-error unknown routes are rejected
  return c.redirect('/unknown');
});
// Checked redirects keep the context usable with Hono helpers and middleware.
const honoContext: Context = context;
void [honoContext, getCookie(context, 'session')];
defineHandler(etag(), (c) => c.redirect('/about'));
defineMiddleware(async (c, next) => {
  if (!getCookie(c, 'session')) return c.redirect('/about');
  await next();
});
void revalidate({ paths: ['/', '/about', \`/users/\${id}\`, user] });
// @ts-expect-error revalidated paths are checked
void revalidate({ paths: ['/unknown'] });
declare const stored: string[];
// @ts-expect-error unchecked string arrays are rejected
void revalidate({ paths: stored });
void revalidate({ paths: stored as RouteUrl[] });
connectEventStream('/api/legacy');
connectEventStream(\`/api/users/\${id}\`);
connectEventStream(user);
connectEventStream('https://example.com/events');
connectEventStream(new URL('https://example.com/events'));
connectEventStream(dynamic as RouteUrl);
// @ts-expect-error event streams reject unknown routes
connectEventStream('/unknown');
// @ts-expect-error event streams do not take WebSocket URLs
connectEventStream('ws://example.com/events');
// @ts-expect-error event streams do not take same-page hashes
connectEventStream('#details');
// @ts-expect-error event streams reject unchecked strings
connectEventStream(dynamic);
connectLiveStream('/api/legacy');
connectLiveStream(\`/api/users/\${id}?room=1\`);
connectLiveStream('http://localhost:5173/live');
connectLiveStream(new URL('https://example.com/live'));
// @ts-expect-error live streams reject unknown routes
connectLiveStream('/unknown');
// @ts-expect-error live streams do not take WebSocket URLs
connectLiveStream('wss://example.com/live');
// @ts-expect-error live streams reject unchecked strings
connectLiveStream(dynamic);
declare const island: IslandFormState<{ title: string }, 'setters'>;
void island.post('/about');
void island.post('/users/42?update');
void island.delete(user);
// @ts-expect-error unknown routes are rejected
void island.post('/unknown');
// @ts-expect-error external URLs are rejected
void island.put('https://example.com');
// Config rewrites keep placeholders and static files.
defineConfig({
  routing: {
    typedRoutes: true,
    rewrites: { '/old/*': '/new/:splat', '/app/*': '/index.html' },
    fallbacks: { '/legacy/:id': '/legacy-proxy/:id' },
  },
});
`;

const linkHrefCheck = `import { routeUrl, type Href } from 'void/routes';
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
const built: [ReactLinkProps['href'], VueLinkProps['href'], SvelteLinkProps['href']] = [
  routeUrl('/users/[id]', { params: { id: 42 } }),
  routeUrl('/users/[id]', { params: { id: 42 } }),
  routeUrl('/users/[id]', { params: { id: 42 } }),
];
// @ts-expect-error React Link rejects unknown routes
const react: ReactLinkProps['href'] = '/unknown';
// @ts-expect-error Vue Link rejects unknown routes
const vue: VueLinkProps['href'] = '/unknown';
// @ts-expect-error Svelte Link rejects unknown routes
const svelte: SvelteLinkProps['href'] = '/unknown';
void [same, known, built, react, vue, svelte];
`;

// Svelte's implementation uses runes, so this tsc fixture covers the other adapters.
// Svelte's `submit` takes the same `RouteUrl`, and `post`/`put`/`patch`/`delete` come from IslandFormState.
const islandFormCheck = `import { useIslandForm as react } from ${adapterSource('react/src/runtime/use-island-form.ts')};
import { useIslandForm as vue } from ${adapterSource('vue/src/runtime/use-island-form.ts')};
import { useIslandForm as solid } from ${adapterSource('solid/src/runtime/use-island-form.ts')};
const reactForm = react({ title: '' });
const vueForm = vue({ title: '' });
const solidForm = solid({ title: '' });
void reactForm.post('/about');
void vueForm.put('/users/42?update');
void solidForm.delete('/api/legacy');
void vueForm.submit('/about', 'POST');
// @ts-expect-error unknown routes are rejected
void reactForm.post('/unknown');
// @ts-expect-error external URLs are rejected
void solidForm.put('https://example.com');
// @ts-expect-error Vue submit is a route URL
void vueForm.submit('/unknown', 'POST');
`;

const solidLinkHrefCheck = `import { routeUrl, type Href } from 'void/routes';
import type { LinkProps } from ${adapterSource('solid/src/runtime/link.tsx')};
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const same: Same<LinkProps['href'], Href> = true;
const known: LinkProps['href'] = '/users/42';
const built: LinkProps['href'] = routeUrl('/users/[id]', { params: { id: 42 } });
// @ts-expect-error Solid Link rejects unknown routes
const unknown: LinkProps['href'] = '/unknown';
void [same, known, built, unknown];
`;

// Page params typed through each adapter's useParams<Pattern>().
const useParamsCheck = `import type { PagePath } from 'void/routes';
import { useParams as react } from ${adapterSource('react/src/runtime/use-params.ts')};
import { useParams as vue } from ${adapterSource('vue/src/runtime/use-params.ts')};
import { useParams as svelte } from ${adapterSource('svelte/src/runtime/use-params.ts')};
import { useParams as solid } from ${adapterSource('solid/src/runtime/use-params.ts')};
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const pages: Array<PagePath> = ['/', '/about', '/users/[id]', '/files/[...path]', '/wild/[...]', '/users/:id', '/files/:path{.+}', '/wild/*'];
// @ts-expect-error HTTP routes are not pages
const api: PagePath = '/api/users/:id';
void [pages, api];
type Either = '/users/:id' | '/files/:path{.+}';
${['react', 'vue', 'svelte', 'solid']
  .map(
    (useParams) => `{
  const user = ${useParams}<'/users/:id'>();
  const bracketUser = ${useParams}<'/users/[id]'>();
  const bracketFiles = ${useParams}<'/files/[...path]'>();
  const bracketWild = ${useParams}<'/wild/[...]'>();
  const aliases: [
    Same<typeof bracketUser, typeof user>,
    Same<typeof bracketFiles, { path: string }>,
    Same<typeof bracketWild, {}>,
  ] = [true, true, true];
  void aliases;
  const files = ${useParams}<'/files/:path{.+}'>();
  const wild = ${useParams}<'/wild/*'>();
  const about = ${useParams}<'/about'>();
  const same: [
    Same<typeof user, { id: string }>,
    Same<typeof files, { path: string }>,
    Same<typeof wild, {}>,
    Same<typeof about, {}>,
  ] = [true, true, true, true];
  // @ts-expect-error misspelled params are rejected
  void user.idd;
  // @ts-expect-error static pages have no params
  void about.id;
  // @ts-expect-error unknown pages are rejected
  ${useParams}<'/unknown'>();
  // @ts-expect-error HTTP routes are not pages
  ${useParams}<'/api/users/:id'>();
  // A pattern union gives a union of params, not params from every pattern.
  const either = ${useParams}<Either>();
  const union: Same<typeof either, { id: string } | { path: string }> = true;
  // @ts-expect-error a param of one pattern is not guaranteed
  void either.id;
  void union;
  const untyped: Record<string, string> = ${useParams}();
  const annotated: string = ${useParams}<{ slug: string }>().slug;
  // Existing generic wrappers and ReturnType keep the record contract.
  function wrapper<T extends Record<string, string>>(): T {
    return ${useParams}<T>();
  }
  const derived: Same<ReturnType<typeof ${useParams}>, Record<string, string>> = true;
  void [same, untyped, annotated, wrapper, derived];
}
`,
  )
  .join('')}`;

async function createFixture({
  typedRoutes = false,
  includeHandlers = true,
  staticOnly = false,
  extraFiles = {},
}: {
  typedRoutes?: boolean;
  includeHandlers?: boolean;
  staticOnly?: boolean;
  extraFiles?: Record<string, string>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'void-route-util-'));
  roots.push(root);
  const files: Record<string, string> = {
    'check-typed.ts': typedCheck,
    'check-links.ts': linkHrefCheck,
    'check-solid-link.ts': solidLinkHrefCheck,
    'check-use-params.ts': useParamsCheck,
    'package.json': '{"type":"module"}',
    ...(includeHandlers && {
      'routes/api/legacy.ts':
        "import { defineHandler } from 'void/handler'; export default defineHandler(() => ({ ok: true }));",
      ...(!staticOnly && {
        'routes/api/users/[id].ts':
          "import { defineHandler } from 'void/handler'; export const GET = defineHandler(() => ({ ok: true }));",
      }),
    }),
    'pages/index.tsx': 'export default function Page() { return null; }',
    'pages/about.tsx': 'export default function Page() { return null; }',
    'pages/café menu.tsx': 'export default function Page() { return null; }',
    ...(!staticOnly && {
      'pages/café/[id].tsx': 'export default function Page() { return null; }',
      'pages/users/[id].tsx': 'export default function Page() { return null; }',
      'pages/blog/[category]/[slug].tsx': 'export default function Page() { return null; }',
      'pages/files/[...path].tsx': 'export default function Page() { return null; }',
      'pages/wild/[...].tsx': 'export default function Page() { return null; }',
    }),
    'check.ts': `import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  routeUrl,
  type RouteDestination,
  type RouteOptions,
  type RoutePath,
} from 'void/routes';
import type { VoidRouter } from 'void/pages-client';
import { defineHandler, defineMiddleware, type CloudContext, type CloudEnv } from 'void/handler';
const path: RoutePath = '/users/:id';
const options: RouteOptions<typeof path> = { params: { id: 123 }, query: { tab: 'activity' }, hash: 'details' };
const url: string = routeUrl(path, options);
routeUrl('/');
routeUrl('/about');
routeUrl('/café menu');
routeUrl('/api/users/:id', { params: { id: '123' } });
routeUrl('/files/:path{.+}', { params: { path: 'docs/start' } });
routeUrl('/wild/*', { params: { '*': 'a/b' } });
routeUrl('/users/[id]', { params: { id: 123 } });
routeUrl('/files/[...path]', { params: { path: 'docs/start' } });
routeUrl('/wild/[...]', { params: { '*': 'a/b' } });
routeUrl<'/users/[id]'>('/users/[id]', { params: { id: 123 } });
interface UserParams { id: number; }
const userParams: UserParams = { id: 123 };
routeUrl('/users/[id]', { params: userParams });
declare const either: '/about' | '/users/[id]';
routeUrl(either, { params: { id: 123 } });
// @ts-expect-error every possible route's params must be present
routeUrl(either);
declare const optional: [options?: RouteOptions<'/users/[id]'>];
// @ts-expect-error an optional tuple cannot guarantee required params
routeUrl('/users/[id]', ...optional);
// @ts-expect-error bracket patterns require params
routeUrl('/users/[id]');
// @ts-expect-error bracket catch-all patterns require params
routeUrl('/files/[...path]');
// @ts-expect-error bracket anonymous catch-alls require a wildcard param
routeUrl('/wild/[...]');
// @ts-expect-error bracket params are checked
routeUrl('/users/[id]', { params: { wrong: 123 } });
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
const bracketDestination: RouteDestination = { pathname: '/users/[id]', params: { id: 123 } };
void bracketDestination;
declare const router: VoidRouter;
void router.visit(destination);
void router.prefetch(destination);
router.flush(destination);
// @ts-expect-error destinations require path params
void router.visit({ pathname: '/users/:id' });
declare const honoContext: Context<CloudEnv>;
const context: CloudContext = honoContext;
const nativeContext: Context<CloudEnv> = context;
const readUser = (c: CloudContext) => c.get('user');
const middleware: MiddlewareHandler<CloudEnv> = async (c, next) => {
  readUser(c);
  await next();
};
defineHandler(middleware, c => c.redirect('/unknown'));
context.set('user', null);
// @ts-expect-error compatibility overloads must not bypass context variable types
context.set('user', 'not a user');
void [nativeContext, getCookie(context, 'session')];
const response: Response & { _status: 307 } = context.redirect(url, 307);
void response;
void context.rewrite(destination);
context.redirect(destination);
context.redirect('/unknown');
context.redirect('https://example.com/elsewhere');
context.redirect(new URL('https://example.com/login'));
// @ts-expect-error typed server rewrites reject unknown patterns
void context.rewrite({ pathname: '/unknown' });
defineHandler(c => c.redirect(url));
defineHandler(c => c.redirect(destination));
defineHandler(c => c.redirect('/unknown'));
defineMiddleware(async c => c.redirect(url));
defineMiddleware(async c => c.redirect(destination));
`,
    ...extraFiles,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(packageRoot, join(root, 'node_modules/void'), 'junction');
  symlinkSync(join(packageRoot, 'node_modules/hono'), join(root, 'node_modules/hono'), 'junction');
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
  tsc = compilers[0].tsc,
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
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, config)], {
    encoding: 'utf8',
  });
  return { output: result.stdout + result.stderr, status: result.status };
}

describe('standalone routeUrl utility', () => {
  it.each(declarationChecks)(
    'preserves generic helpers and structural options through $declarations declarations with TS $version',
    async ({ declarations, tsc }) => {
      const root = await createFixture({
        extraFiles: {
          'check-compatibility.ts': `import { routeUrl, type RouteDestination, type RouteOptions, type RoutePath } from 'void/routes';
function userUrl<T extends string | number>(id: T) {
  return routeUrl('/users/[id]', { params: { id } });
}
function forwardOptions<T extends RouteOptions<'/users/[id]'>>(options: T) {
  return routeUrl('/users/[id]', options);
}
function forwardRouteOptions<P extends RoutePath>(path: P, options: RouteOptions<P>) {
  return routeUrl(path, options);
}
function forwardRouteOptionsSubtype<P extends RoutePath, O extends RouteOptions<P>>(path: P, options: O) {
  return routeUrl(path, options);
}
function forwardExplicitOptions<P extends RoutePath>(path: P, options: RouteOptions<P>) {
  return routeUrl<P>(path, options);
}
function forwardAnyOptions<P extends RoutePath>(path: P, options: any) {
  return routeUrl(path, options);
}
const buildRoute: <P extends RoutePath>(path: P, options: RouteOptions<P>) => string = routeUrl;
const buildRouteWithSubtype: <P extends RoutePath, O extends RouteOptions<P>>(path: P, options: O) => string = routeUrl;
function forwardStaticOptions<T extends RouteOptions<'/about'>>(options: T) {
  return routeUrl('/about', options);
}
function forwardDestination<T extends RouteDestination<'/users/[id]'>>(destination: T) {
  return routeUrl('/users/[id]', destination);
}
function forwardArgs(...args: Parameters<typeof routeUrl<'/users/[id]'>>) {
  return routeUrl(...args);
}
function forwardGenericArgs<P extends RoutePath>(...args: Parameters<typeof routeUrl<P>>) {
  return routeUrl(...args);
}
function forwardIntersectedPath<P extends string>(path: P & RoutePath, options: any) {
  return routeUrl(path, options);
}
function forwardUnconstrainedPath<P>(path: P & RoutePath, options: any) {
  return routeUrl(path, options);
}
function forwardStaticIntersection<P extends string>(path: P & ('/' | '/about')) {
  return routeUrl(path);
}
function forwardPathOrAbout<P extends RoutePath>(path: P | '/about', options: any) {
  return routeUrl(path, options);
}
forwardArgs('/users/[id]', { params: { id: 42 } });
const user = { id: 42, name: 'Alice' };
routeUrl('/users/[id]', { params: user });
const options = { params: user, trace: 'request' };
routeUrl('/users/[id]', options);
const destination: RouteDestination<'/users/[id]'> = {
  pathname: '/users/[id]', params: { id: 42 },
};
routeUrl('/users/[id]', destination);
const staticDestination: RouteDestination<'/about'> = { pathname: '/about' };
routeUrl('/about', staticDestination);
declare const indexedParams: Record<string, unknown> & { id: number };
routeUrl('/users/[id]', { params: indexedParams });
void [userUrl, forwardOptions, forwardRouteOptions, forwardRouteOptionsSubtype, forwardExplicitOptions, forwardAnyOptions, buildRoute, buildRouteWithSubtype, forwardStaticOptions, forwardDestination, forwardArgs, forwardGenericArgs, forwardIntersectedPath, forwardUnconstrainedPath, forwardStaticIntersection, forwardPathOrAbout];
`,
        },
      });
      expect(typecheck(root, declarations, ['check-compatibility.ts'], {}, tsc)).toEqual({
        output: '',
        status: 0,
      });
    },
  );

  it.each(declarationChecks)(
    'checks function helpers through $declarations declarations with TS $version',
    async ({ declarations, tsc }) => {
      const root = await createFixture({
        extraFiles: {
          'check-function-helpers.ts': `import { routeUrl, type RouteOptions, type RoutePath } from 'void/routes';
function forward(...args: Parameters<typeof routeUrl>) {
  return routeUrl(...args);
}
function wrap<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => fn(...args);
}
function curry<P, A extends unknown[], R>(fn: (path: P, ...args: A) => R) {
  return (path: P) => (...args: A): R => fn(path, ...args);
}
export const wrapped = wrap(routeUrl);
wrapped('/about');
wrapped('/users/[id]', { params: { id: 42 } });
wrapped('/blog/[category]/[slug]', { params: { category: 'typescript', slug: 'routes' } });
// @ts-expect-error wrapping retains required params
wrapped('/users/[id]');
// @ts-expect-error wrapping retains per-route param names
wrapped('/users/[id]', { params: { slug: 'routes' } });
// @ts-expect-error wrapping retains route checks
wrapped('/missing');
function forwardWrappedOptions<P extends RoutePath, O extends RouteOptions<P>>(path: P, options: O) {
  return wrapped(path, options);
}
forwardWrappedOptions('/users/[id]', { params: { id: 42 }, trace: 'request' });
// @ts-expect-error forwarding an options subtype still requires the route's params
forwardWrappedOptions('/users/[id]', { hash: 'team' });
export const curried = curry(routeUrl);
const buildAbout: (path: '/about') => string = routeUrl;
const buildAboutWithOptions: (path: '/about', options?: RouteOptions<'/about'>) => string = routeUrl;
// @ts-expect-error a builder specialized to a dynamic route requires options
const buildUser: (path: '/users/[id]') => string = routeUrl<'/users/[id]'>;
void [buildAbout, buildAboutWithOptions, buildUser];
declare const options: RouteOptions<RoutePath>;
const userUrl = routeUrl.bind(undefined, '/users/[id]');
userUrl(options);
routeUrl.call(undefined, '/users/[id]', options);
routeUrl.apply(undefined, ['/users/[id]', options]);
forward('/users/[id]', options);
const specificUserUrl = (routeUrl<'/users/[id]'>).bind(undefined, '/users/[id]');
specificUserUrl({ params: { id: 42 } });
// @ts-expect-error bound functions retain required params
userUrl();
// @ts-expect-error bound functions retain param value checks
userUrl({ params: { id: true } });
// @ts-expect-error bound functions retain query value checks
userUrl({ ...options, query: { nested: { id: 42 } } });
// @ts-expect-error call retains required params
routeUrl.call(undefined, '/users/[id]');
// @ts-expect-error call retains param value checks
routeUrl.call(undefined, '/users/[id]', { params: { id: true } });
// @ts-expect-error call retains route checks
routeUrl.call(undefined, '/missing', options);
// @ts-expect-error apply retains required params
routeUrl.apply(undefined, ['/users/[id]']);
// @ts-expect-error apply retains param value checks
routeUrl.apply(undefined, ['/users/[id]', { params: { id: true } }]);
// @ts-expect-error apply retains hash checks
routeUrl.apply(undefined, ['/users/[id]', { ...options, hash: 42 }]);
// @ts-expect-error extracted arguments retain required params
forward('/users/[id]');
// @ts-expect-error extracted arguments retain param value checks
forward('/users/[id]', { params: { id: true } });
// @ts-expect-error widening a route type cannot bypass static-route checks
routeUrl<string>('/about', options);
// @ts-expect-error widening a route type cannot bypass dynamic-route checks
routeUrl<string>('/users/[id]', options);
// @ts-expect-error an unknown candidate cannot make options optional for a dynamic route
routeUrl<RoutePath, '/missing'>('/users/[id]');
`,
          'check-inferred-exports.ts': `import { curried, wrapped } from './dist/check-function-helpers.js';
curried('/about')();
curried('/about')({ hash: 'team' });
curried('/users/[id]')({ params: { id: 42 } });
// @ts-expect-error currying retains required params
curried('/users/[id]')();
// @ts-expect-error currying retains per-route param names
curried('/users/[id]')({ params: { slug: 'routes' } });
// @ts-expect-error currying retains route checks
curried('/missing');
wrapped('/about');
wrapped('/users/[id]', { params: { id: 42 } });
// @ts-expect-error the emitted wrapper declaration retains required params
wrapped('/users/[id]');
`,
        },
      });
      expect(
        typecheck(
          root,
          declarations,
          ['check-function-helpers.ts'],
          { declaration: true, emitDeclarationOnly: true, noEmit: false, outDir: './dist' },
          tsc,
        ),
      ).toEqual({ output: '', status: 0 });
      expect(typecheck(root, declarations, ['check-inferred-exports.ts'], {}, tsc)).toEqual({
        output: '',
        status: 0,
      });
    },
  );

  it.each(declarationChecks)(
    'keeps options optional in static function helpers through $declarations declarations with TS $version',
    async ({ declarations, tsc }) => {
      const root = await createFixture({
        includeHandlers: false,
        staticOnly: true,
        extraFiles: {
          'check-static-binding.ts': `import { routeUrl } from 'void/routes';
const build = routeUrl.bind(undefined, '/about');
build();
build({ hash: 'team' });
const buildAbout = (routeUrl<'/about'>).bind(undefined, '/about');
buildAbout();
buildAbout({ hash: 'team' });
// @ts-expect-error static routes still reject params when bound
buildAbout({ params: { id: 42 } });
declare const unchecked: any;
routeUrl.call(undefined, unchecked);
routeUrl.call(undefined, unchecked, undefined);
`,
        },
      });
      for (const compilerOptions of [
        { exactOptionalPropertyTypes: true },
        { strictNullChecks: false },
      ]) {
        expect
          .soft(
            typecheck(root, declarations, ['check-static-binding.ts'], compilerOptions, tsc),
            JSON.stringify(compilerOptions),
          )
          .toEqual({ output: '', status: 0 });
      }
    },
  );

  it.each(compilers)(
    'checks generated routes in Node16 CommonJS with TS $version',
    async ({ tsc }) => {
      const root = await createFixture({
        typedRoutes: true,
        includeHandlers: false,
        extraFiles: {
          'package.json': '{"type":"commonjs"}',
          'check-commonjs.ts': `import { routeUrl, type Href } from 'void/routes';
const url: Href = routeUrl('/users/[id]', { params: { id: 42 } });
// @ts-expect-error known dynamic routes require params
routeUrl('/users/[id]');
// @ts-expect-error unknown route patterns remain checked
routeUrl('/missing');
// @ts-expect-error raw URLs remain checked
const missing: Href = '/missing';
void [url, missing];
`,
        },
      });
      expect(
        typecheck(
          root,
          'generated',
          ['check-commonjs.ts'],
          { module: 'Node16', moduleResolution: 'Node16', skipLibCheck: false },
          tsc,
        ),
      ).toEqual({ output: '', status: 0 });
    },
  );

  it.each([false, true])(
    'retains legacy Node URL checks with skipLibCheck=%s',
    async (skipLibCheck) => {
      const root = await createFixture({
        typedRoutes: true,
        extraFiles: {
          'check-legacy.ts': `import { routeUrl, type Href } from 'void/routes';
routeUrl('/about');
routeUrl('/users/[id]', { params: { id: 42 } });
// @ts-expect-error unknown route patterns remain checked
routeUrl('/missing');
// @ts-expect-error required params remain checked
routeUrl('/users/[id]');
// @ts-expect-error raw URLs retain their existing checks
const unknown: Href = '/missing';
void unknown;
`,
        },
      });
      const { scan } = await analyzeApplication(root, { config: readConfig(root) });
      // Legacy resolution can consume generated routes without resolving SDK runtime imports.
      scan.routes = scan.routes.map((route) => ({ ...route, methods: [] }));
      writeFileSync(
        join(root, '.void/routes.d.ts'),
        generateRouteTypes(scan, join(root, 'routes'), join(root, '.void'), undefined, {
          typedRoutes: true,
        }).dts,
      );
      expect(
        typecheck(
          root,
          'generated',
          ['check-legacy.ts'],
          { moduleResolution: 'node', ignoreDeprecations: '6.0', skipLibCheck },
          compilers[1].tsc,
        ),
      ).toEqual({ output: '', status: 0 });
    },
  );

  it.each(['generated', 'package'] as const)(
    'retains URL checks after an SDK upgrade without regenerating the %s declarations',
    async (declarations) => {
      const root = mkdtempSync(join(tmpdir(), 'void-route-upgrade-'));
      roots.push(root);
      const outDir = join(root, '.void');
      const packageLink = join(root, 'node_modules/void');
      mkdirSync(outDir, { recursive: true });
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      const generatorCode = (
        await transformWithOxc(
          readFileSync(join(packageRoot, 'src/codegen/route-types.ts'), 'utf8'),
          'route-types.ts',
        )
      ).code;
      function createSdkVersion(version: string, updateQueryTypes = false): string {
        const directory = join(root, 'node_modules/.pnpm', `void@${version}/node_modules/void`);
        mkdirSync(join(directory, 'src/codegen'), { recursive: true });
        const copied = new Set<string>();
        function copyDeclaration(path: string): void {
          if (copied.has(path)) {
            return;
          }
          copied.add(path);
          const content = readFileSync(join(packageRoot, path), 'utf8');
          mkdirSync(dirname(join(directory, path)), { recursive: true });
          writeFileSync(join(directory, path), content);
          for (const [, specifier] of content.matchAll(
            /(?:from\s*|import\()\s*["'](\.[^"']+)["']/g,
          )) {
            copyDeclaration(join(dirname(path), specifier.replace(/\.mjs$/, '.d.mts')));
          }
        }
        copyDeclaration(manifest.exports['./routes'].types);
        copyDeclaration(manifest.exports['./_route-url-types'].types);
        if (updateQueryTypes) {
          // Give the second SDK a different contract, not just a different location.
          const path = [...copied].find((path) =>
            readFileSync(join(directory, path), 'utf8').includes('type RouteQueryValue ='),
          );
          expect(path).toBeDefined();
          const file = join(directory, path!);
          const previous = readFileSync(file, 'utf8');
          const updated = previous.replace(
            'type RouteQueryValue = string | number | boolean | null | undefined;',
            'type RouteQueryValue = string | number | null | undefined;',
          );
          expect(updated).not.toBe(previous);
          writeFileSync(file, updated);
        }
        symlinkSync(join(packageRoot, 'node_modules'), join(directory, 'node_modules'), 'junction');
        writeFileSync(join(directory, 'src/codegen/route-types.mjs'), generatorCode);
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ ...manifest, version }));
        return directory;
      }
      const oldSdk = createSdkVersion('1.9.1');
      const newSdk = createSdkVersion('1.9.2', true);
      symlinkSync(oldSdk, packageLink, 'junction');
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      const generator = pathToFileURL(join(oldSdk, 'src/codegen/route-types.mjs')).href;
      const generation = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { generateRouteTypes } from ${JSON.stringify(generator)};
const scan = { routes: [
  { pattern: '/about', params: [], methods: [] },
  { pattern: '/users/:id', params: ['id'], methods: [] },
], pages: { pages: [] } };
process.stdout.write(generateRouteTypes(scan, ${JSON.stringify(join(root, 'routes'))}, ${JSON.stringify(outDir)}, undefined, { typedRoutes: true }).dts);`,
        ],
        { encoding: 'utf8' },
      );
      expect({ status: generation.status, errors: generation.stderr }).toEqual({
        status: 0,
        errors: '',
      });
      const routeTypesPath = join(outDir, 'routes.d.ts');
      writeFileSync(routeTypesPath, generation.stdout);
      writeFileSync(
        join(outDir, 'tsconfig.json'),
        JSON.stringify(createProjectTsconfig(root, true)),
      );
      const upgradeCheck = `import { routeUrl, type Href, type RouteQuery } from 'void/routes';
const href: Href = routeUrl('/users/[id]', { params: { id: 42 } });
routeUrl('/about');
const query: RouteQuery = { enabled: true };
routeUrl('/about', { query: { enabled: true } });
// @ts-expect-error unknown route patterns remain checked
routeUrl('/missing');
// @ts-expect-error required params remain checked
routeUrl('/users/[id]');
// @ts-expect-error param values remain checked
routeUrl('/users/[id]', { params: { id: true } });
// @ts-expect-error raw URLs retain their existing route checks
const unknown: Href = '/missing';
void [href, unknown, query];
`;
      writeFileSync(join(root, 'check-upgrade.ts'), upgradeCheck);
      expect(typecheck(root, declarations, ['check-upgrade.ts'])).toEqual({
        output: '',
        status: 0,
      });

      rmSync(packageLink, { force: true, recursive: true });
      symlinkSync(newSdk, packageLink, 'junction');
      rmSync(oldSdk, { force: true, recursive: true });

      expect(readFileSync(routeTypesPath, 'utf8')).toBe(generation.stdout);
      writeFileSync(
        join(root, 'check-upgrade.ts'),
        upgradeCheck
          .replace(
            'const query:',
            '// @ts-expect-error the new SDK query type is used\nconst query:',
          )
          .replace(
            "routeUrl('/about', { query:",
            "// @ts-expect-error the new SDK function signature is used\nrouteUrl('/about', { query:",
          ),
      );
      expect(typecheck(root, declarations, ['check-upgrade.ts'])).toEqual({
        output: '',
        status: 0,
      });
    },
  );

  it.each(declarationChecks)(
    'keeps invalid inputs rejected through $declarations declarations with TS $version',
    async ({ declarations, tsc }) => {
      const root = await createFixture({
        extraFiles: {
          'check-invalid-unions.ts': `import { routeUrl, type RoutePath } from 'void/routes';
declare const query: { q: string } | { filter: { id: number } };
// @ts-expect-error every query union member must contain supported values
routeUrl('/about', { query });
declare const optionalQuery: { q?: string } | { filter?: { id: number } };
// @ts-expect-error optional query keys cannot hide invalid union members
routeUrl('/about', { query: optionalQuery });
declare const overlappingQuery: { q: string } | { q: string; filter: { id: number } };
// @ts-expect-error a valid union member cannot hide invalid values on another member
routeUrl('/about', { query: overlappingQuery });
// @ts-expect-error numeric params do not supply the required id
routeUrl('/users/[id]', { params: { 0: 'missing-id' } });
// @ts-expect-error fresh numeric extra params are still rejected
routeUrl('/users/[id]', { params: { id: 42, 0: 'extra' } });
declare const params: { id: number } | { 0: string };
// @ts-expect-error every params union member must supply id
routeUrl('/users/[id]', { params });
declare const key: unique symbol;
// @ts-expect-error symbol keys cannot hide a missing id
routeUrl('/users/[id]', { params: { [key]: 42 } });
// @ts-expect-error numeric option keys do not belong to RouteOptions
routeUrl('/about', { 0: 'unknown-option' });
declare const options: { query: { q: string } } | { query: { filter: { id: number } } };
// @ts-expect-error every options union member must be valid
routeUrl('/about', options);
// @ts-expect-error explicit type arguments retain fresh-object excess checks
routeUrl<'/users/[id]'>('/users/[id]', { params: { id: 42, extra: 'x' } });
// @ts-expect-error widening the type argument cannot omit required params
routeUrl<string>('/users/[id]');
declare const uncheckedOptions: Record<string, any>;
// @ts-expect-error an index signature does not supply the required params
routeUrl('/users/[id]', uncheckedOptions);
const uncheckedPath = JSON.parse('"/users/[id]"');
routeUrl(uncheckedPath, { params: { id: 42 } });
// @ts-expect-error a path typed as any may require options
routeUrl(uncheckedPath);
// @ts-expect-error undefined cannot supply the options for a path typed as any
routeUrl(uncheckedPath, undefined);
// @ts-expect-error a broad candidate cannot make required options optional
routeUrl<RoutePath, string>(uncheckedPath);
const fakeUnknownPath = Object.assign('/missing' as const, {
  get 'Unknown route: /missing. Use a registered route pattern.'(): never { throw new Error(); },
});
// @ts-expect-error a boxed error message cannot make an unknown path valid
routeUrl<RoutePath, '/missing'>(fakeUnknownPath);
// @ts-expect-error an any-valued unknown option remains invalid
routeUrl('/about', { search: undefined as any });
// @ts-expect-error explicit diagnostic type arguments retain native params checking
routeUrl<RoutePath, '/users/[id]'>('/users/[id]', { params: { id: true } });
// @ts-expect-error an any candidate cannot bypass the route pattern check
routeUrl<'/about', any>('/missing', { params: {} });
// @ts-expect-error an any candidate cannot bypass per-route param checks
routeUrl<'/users/[id]', any>('/users/[id]', { params: {} });
`,
          'check-exact-optional.ts': `import { routeUrl, type RouteOptions } from 'void/routes';
routeUrl('/about');
routeUrl('/about', undefined);
routeUrl('/users/[id]', { params: { id: 42 } });
function forwardStaticOptions<O extends RouteOptions<'/about'>>(options?: O) {
  return routeUrl('/about', options);
}
void forwardStaticOptions;
declare const value: any;
// @ts-expect-error exact optional properties do not allow params on static routes
routeUrl('/about', { params: value });
// @ts-expect-error query cannot be explicitly undefined in exact mode
routeUrl('/about', { query: undefined });
// @ts-expect-error hash cannot be explicitly undefined in exact mode
routeUrl('/about', { hash: undefined });
// @ts-expect-error fresh extra params stay rejected when their value is any
routeUrl('/users/[id]', { params: { id: 42, extra: value } });
`,
        },
      });
      expect(typecheck(root, declarations, ['check-invalid-unions.ts'], {}, tsc)).toEqual({
        output: '',
        status: 0,
      });
      expect(
        typecheck(
          root,
          declarations,
          ['check-exact-optional.ts'],
          { exactOptionalPropertyTypes: true },
          tsc,
        ),
      ).toEqual({ output: '', status: 0 });
    },
  );

  it.each(declarationChecks)(
    'rejects unknown routes in bivariant parameter checks through $declarations declarations with TS $version',
    async ({ declarations, tsc }) => {
      const root = await createFixture({
        extraFiles: {
          'check-bivariant.ts': `import { routeUrl } from 'void/routes';
interface Builder { url(path: '/missing'): string }
// @ts-expect-error method signatures compare parameters bivariantly but still reject unknown routes
const builder: Builder = { url: routeUrl };
// @ts-expect-error a class property implementing a method signature still rejects unknown routes
class RouteBuilder implements Builder { url = routeUrl; }
// @ts-expect-error an unknown bracket route would throw for its missing param at runtime
const renamed: { url(path: '/users/[uid]'): string } = { url: routeUrl };
// @ts-expect-error a known route cannot hide an unknown one in the same union
const mixed: { url(path: '/about' | '/missing'): string } = { url: routeUrl };
// @ts-expect-error function types without strictFunctionTypes still reject unknown routes
const callback: (path: '/missing') => string = routeUrl;
const known: { url(path: '/about'): string } = { url: routeUrl };
void [builder, RouteBuilder, renamed, mixed, callback, known];
`,
        },
      });
      for (const compilerOptions of [{}, { strictFunctionTypes: false }]) {
        expect
          .soft(
            typecheck(root, declarations, ['check-bivariant.ts'], compilerOptions, tsc),
            JSON.stringify(compilerOptions),
          )
          .toEqual({ output: '', status: 0 });
      }
    },
  );

  it.each(declarationChecks)(
    'checks routeUrl in apps with hundreds of routes through $declarations declarations with TS $version',
    async ({ declarations, tsc }) => {
      // A non-primitive member in Candidate's constraint made `P & Candidate` a cross product
      // of the route union, which TypeScript rejects (TS2590) past ~316 route keys.
      const pages = Object.fromEntries(
        Array.from({ length: 150 }, (_, index) => [
          [`pages/large/s${index}.tsx`, 'export default function Page() { return null; }'],
          [`pages/large/d${index}/[id].tsx`, 'export default function Page() { return null; }'],
        ]).flat(),
      );
      const root = await createFixture({
        extraFiles: {
          ...pages,
          'check-large.ts': `import { routeUrl, type RouteOptions, type RoutePath } from 'void/routes';
routeUrl('/large/s0');
routeUrl('/large/d0/[id]', { params: { id: 1 } });
declare const path: RoutePath;
routeUrl(path, {} as any);
function forward<P extends RoutePath>(path: P, options: RouteOptions<P>) {
  return routeUrl(path, options);
}
function forwardIntersectedPath<P extends string>(path: P & RoutePath, options: any) {
  return routeUrl(path, options);
}
// @ts-expect-error unknown routes are still rejected
routeUrl('/large/missing');
// @ts-expect-error params are still required
routeUrl('/large/d0/[id]');
void [forward, forwardIntersectedPath];
`,
        },
      });
      expect(typecheck(root, declarations, ['check-large.ts'], {}, tsc)).toEqual({
        output: '',
        status: 0,
      });
    },
  );

  it.each(declarationChecks)(
    'uses native option errors and custom path errors through $declarations declarations with TS $version',
    async ({ declarations, tsc }) => {
      const cases: Array<[call: string, message: string | RegExp, kind: 'native' | 'custom']> = [
        ["routeUrl('/missing');", 'Unknown route: /missing.', 'custom'],
        ["routeUrl('/missing', {});", 'Unknown route: /missing.', 'custom'],
        ["routeUrl('/users/42');", 'Unknown route: /users/42.', 'custom'],
        ["routeUrl('/users/[id]');", 'Expected 2 arguments, but got 1.', 'native'],
        ["routeUrl('/users/[id]', {});", "Property 'params' is missing", 'native'],
        [
          "routeUrl('/users/[id]', { query: { page: 1 } });",
          "Property 'params' is missing",
          'native',
        ],
        ["routeUrl('/users/[id]', { params: {} });", "Property 'id' is missing", 'native'],
        [
          "routeUrl('/users/[id]', { params: { userId: 42 } });",
          "'userId' does not exist",
          'native',
        ],
        [
          "routeUrl('/users/[id]', { params: { id: 42, extra: 'x' } });",
          "'extra' does not exist",
          'native',
        ],
        [
          "routeUrl('/users/[id]', { params: { id: true } });",
          "Type 'boolean' is not assignable to type 'string | number'.",
          'native',
        ],
        [
          "routeUrl('/about', { params: {} });",
          "Type '{}' is not assignable to type 'undefined'.",
          'native',
        ],
        [
          "routeUrl('/about', { hash: 123 });",
          "Type 'number' is not assignable to type 'string'.",
          'native',
        ],
        [
          "routeUrl('/users/[id]', { params: {} as Record<string, string> });",
          "Property 'id' is missing",
          'native',
        ],
        [
          "routeUrl('/users/[id]', { params: {} as { id?: string } });",
          "Type 'undefined' is not assignable to type 'string | number'.",
          'native',
        ],
        [
          "routeUrl('/users/[id]', { params: {} as Record<string, unknown> & { id: boolean } });",
          "Type 'boolean' is not assignable to type 'string | number'.",
          'native',
        ],
        [
          "routeUrl('/users/[id]', { params: {} as Record<string, string> & { id: string }, query: { nested: {} } });",
          /Type '\{\}' is not assignable to type '.*RouteQueryValue/,
          'native',
        ],
        [
          "routeUrl('/about', { query: () => 'x' });",
          "Index signature for type 'string' is missing",
          'native',
        ],
        [
          "routeUrl('/about', { query: null });",
          "Type 'null' is not assignable to type 'RouteQuery | undefined'.",
          'native',
        ],
        ["routeUrl('/about', () => 'x');", 'has no properties in common', 'native'],
        [
          "routeUrl('/about', { query: { nested: { value: 'x' } } });",
          "'value' does not exist",
          'native',
        ],
        [
          "routeUrl('/about', { query: null as unknown as { q: string } | { filter: { id: number } } });",
          "Property 'filter' is incompatible with index signature.",
          'native',
        ],
        [
          "routeUrl('/users/[id]', { params: { 0: 'missing-id' } });",
          "'0' does not exist",
          'native',
        ],
        ["routeUrl('/about', { 0: 'unknown' });", "'0' does not exist", 'native'],
        ["routeUrl('/about', { search: 'x' });", "'search' does not exist", 'native'],
        [
          "routeUrl('/users/[id]', undefined);",
          "Argument of type 'undefined' is not assignable",
          'native',
        ],
        ["routeUrl('' as '/about' | '/users/[id]');", 'Expected 2 arguments, but got 1.', 'native'],
        ["routeUrl('' as string, {});", "Argument of type 'string' is not assignable", 'native'],
        ["routeUrl('' as '/about' | '/missing', {});", 'Unknown route: /missing.', 'custom'],
        ["routeUrl('/missing', undefined);", 'Unknown route: /missing.', 'custom'],
        ["routeUrl('/missing', {} as unknown);", 'Unknown route: /missing.', 'custom'],
        ["routeUrl('/missing', {} as any);", 'Unknown route: /missing.', 'custom'],
        [
          "routeUrl('/blog/[category]/[slug]', { params: { category: 'typescript' } });",
          "Property 'slug' is missing",
          'native',
        ],
      ];
      const root = await createFixture({
        extraFiles: {
          'check-diagnostics.ts': [
            "import { routeUrl } from 'void/routes';",
            ...cases.map(([call]) => call),
          ].join('\n'),
        },
      });
      const { output, status } = typecheck(root, declarations, ['check-diagnostics.ts'], {}, tsc);
      expect(status).not.toBe(0);
      const diagnostics = output
        .split(/.*check-diagnostics\.ts\(\d+,\d+\): error TS\d+: /)
        .slice(1);
      expect(diagnostics).toHaveLength(cases.length);
      cases.forEach(([, message, kind], index) => {
        expect(diagnostics[index]).toMatch(message);
        if (kind === 'native') {
          expect(diagnostics[index]).not.toContain('UrlTypeError');
          expect(diagnostics[index]).not.toContain('UrlErrorToken');
          expect(diagnostics[index]).not.toContain('Symbol.toPrimitive');
          expect(diagnostics[index]).not.toMatch(
            /not assignable to type '"(?:Missing|Unknown|Invalid|Param|Query|Hash|Options)/,
          );
        }
      });
      expect(output).not.toContain('No overload matches this call');
      expect(output).not.toContain('UrlTypeError<never>');
      expect(output).not.toContain('RouteUrlOptionsInput');
      expect(output).not.toContain('__voidUrlError');
      expect(output).not.toContain('Unknown route: /about.');
      const missingSlug = diagnostics.at(-1)!.trim();
      expect(missingSlug).toBe(
        "Property 'slug' is missing in type '{ category: string; }' but required in type '{ category: string | number; slug: string | number; }'.",
      );
    },
  );

  it.each(declarationChecks)(
    'requires options for generic paths through $declarations declarations with TS $version',
    async ({ declarations, tsc }) => {
      const root = await createFixture({
        extraFiles: {
          'check-generic-diagnostic.ts': `import { routeUrl, type RoutePath } from 'void/routes';
function bare<P extends RoutePath>(path: P) {
  return routeUrl(path);
}
void bare;
`,
        },
      });
      const { output, status } = typecheck(
        root,
        declarations,
        ['check-generic-diagnostic.ts'],
        {},
        tsc,
      );
      expect(status).not.toBe(0);
      expect(output).toContain("Argument of type '[]' is not assignable");
    },
  );

  it.each(['generated', 'package'] as const)(
    'keeps diagnostic details out of completions through the %s declarations',
    async (declarations) => {
      const root = await createFixture();
      const check = join(root, 'check-completions.ts');
      writeFileSync(
        check,
        `import { routeUrl } from 'void/routes';
routeUrl('/*route*/');
routeUrl('/users/[id]', { /*options*/ });
routeUrl('/users/[id]', { params: { /*params*/ } });
`,
      );
      const tsModule = createRequire(compilers[1].tsc).resolve('typescript');
      const options = {
        target: 'ES2022',
        module: declarations === 'generated' ? 'ESNext' : 'NodeNext',
        moduleResolution: declarations === 'generated' ? 'Bundler' : 'NodeNext',
        strict: true,
        skipLibCheck: true,
        types: [],
        paths:
          declarations === 'generated' ? { 'void/routes': [join(root, '.void/routes.d.ts')] } : {},
      };
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import ts from ${JSON.stringify(pathToFileURL(tsModule).href)};
const root = ${JSON.stringify(root)};
const file = ${JSON.stringify(check)};
const content = ts.sys.readFile(file);
const options = ts.convertCompilerOptionsFromJson(${JSON.stringify(options)}, root).options;
const service = ts.createLanguageService({
  getScriptFileNames: () => [file, ${JSON.stringify(join(root, '.void/routes.d.ts'))}],
  getScriptVersion: () => '0',
  getScriptSnapshot: (path) => ts.sys.fileExists(path) ? ts.ScriptSnapshot.fromString(ts.sys.readFile(path)) : undefined,
  getCurrentDirectory: () => root,
  getCompilationSettings: () => options,
  getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
});
const completions = Object.fromEntries(['route', 'options', 'params'].map((marker) => [
  marker,
  (service.getCompletionsAtPosition(file, content.indexOf('/*' + marker + '*/'), {})?.entries ?? []).map((entry) => entry.name).sort(),
]));
service.dispose();
process.stdout.write(JSON.stringify(completions));`,
        ],
        { encoding: 'utf8' },
      );
      expect({ status: result.status, errors: result.stderr }).toEqual({ status: 0, errors: '' });
      const completions = JSON.parse(result.stdout);
      expect(completions.route).toEqual(expect.arrayContaining(['/about', '/users/[id]']));
      expect(completions.route.every((name: string) => name.startsWith('/'))).toBe(true);
      expect(completions.options).toEqual(['hash', 'params', 'query']);
      expect(completions.params).toEqual(['id']);
    },
  );

  it.each(['generated', 'package'] as const)(
    'preserves HTTP, WebSocket and page action contracts for both syntaxes through %s declarations',
    async (declarations) => {
      const root = await createFixture({
        extraFiles: {
          'routes/chat/[room].ws.ts': `import { defineRoom } from 'void/ws';
type Schema<T> = { '~standard': { version: 1; vendor: string; validate: (value: unknown) => { value: T }; types?: { input: T; output: T } } };
declare const message: Schema<{ text: string }>;
export default defineRoom({ messages: { client: message, server: message } });
`,
          'pages/users/[id].server.ts': `import { defineHandler } from 'void/handler';
type Schema<T> = { '~standard': { version: 1; vendor: string; validate: (value: unknown) => { value: T }; types?: { input: T; output: T } } };
declare const body: Schema<{ name: string }>;
export const actions = { save: defineHandler.withValidator({ body })(() => ({ ok: true })) };
`,
          'check-aliases.ts': `import { fetch } from 'void/client';
import { connect } from 'void/ws';
import { createActionClient } from 'void/pages-client';
import type { RouteMap, RoutePathMap, PagePathMap, PageActionMap, WebSocketRouteMap } from 'void/routes';
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const aliases: [
  Same<RouteMap['/api/users/[id]'], RouteMap['/api/users/:id']>,
  Same<RoutePathMap['/files/[...path]'], RoutePathMap['/files/:path{.+}']>,
  Same<PagePathMap['/users/[id]'], PagePathMap['/users/:id']>,
  Same<PageActionMap['/users/[id]'], PageActionMap['/users/:id']>,
  Same<WebSocketRouteMap['/chat/[room]'], WebSocketRouteMap['/chat/:room']>,
] = [true, true, true, true, true];
void aliases;
const bracket = fetch('/api/users/[id]', { params: { id: '42' } });
const legacy = fetch('/api/users/:id', { params: { id: '42' } });
const responses: Same<typeof bracket, typeof legacy> = true;
void responses;
// @ts-expect-error methods stay constrained through bracket keys
fetch('/api/users/[id]', { method: 'POST' });
// @ts-expect-error legacy methods stay constrained
fetch('/api/users/:id', { method: 'POST' });
connect('/chat/[room]', { params: { room: 'lobby' } }).send({ text: 'hi' });
connect('/chat/:room', { params: { room: 'lobby' } }).send({ text: 'hi' });
// @ts-expect-error bracket WebSocket params are required
connect('/chat/[room]', {});
// @ts-expect-error legacy WebSocket params are required
connect('/chat/:room', {});
connect('/chat/[room]', { params: { room: 'lobby' } }).on('message', (message) => {
  const text: string = message.text;
  // @ts-expect-error server message types stay constrained
  void message.missing;
  void text;
});
const { action } = createActionClient();
action('/users/[id]?save', { params: { id: '42' }, data: { name: 'Alice' } });
action('/users/:id?save', { params: { id: '42' }, data: { name: 'Alice' } });
// @ts-expect-error bracket actions require params
action('/users/[id]?save');
// @ts-expect-error legacy actions require params
action('/users/:id?save');
// @ts-expect-error bracket action bodies stay constrained
action('/users/[id]?save', { params: { id: '42' }, data: { name: 42 } });
// @ts-expect-error legacy action bodies stay constrained
action('/users/:id?save', { params: { id: '42' }, data: { name: 42 } });
// @ts-expect-error bracket action names stay constrained
action('/users/[id]?missing', { params: { id: '42' } });
`,
        },
      });
      expect(typecheck(root, declarations, ['check-aliases.ts'])).toEqual({
        output: '',
        status: 0,
      });
    },
  );

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

  it.each(['generated', 'package'] as const)(
    'types useParams<Pattern>() in every adapter through the %s declarations',
    async (declarations) => {
      const root = await createFixture();
      expect(
        typecheck(root, declarations, ['check-use-params.ts'], {
          allowImportingTsExtensions: true,
        }),
      ).toEqual({ output: '', status: 0 });
    },
  );

  it.each([
    { file: '[slug]', pattern: '/[slug]', legacy: '/:slug', param: 'slug' },
    { file: '[...slug]', pattern: '/[...slug]', legacy: '/:slug{.+}', param: 'slug' },
    { file: '[...]', pattern: '/[...]', legacy: '/*', param: '*' },
  ])('keeps raw URL checks with a root $file page', async ({ file, pattern, legacy, param }) => {
    const root = await createFixture({
      typedRoutes: true,
      extraFiles: {
        [`pages/${file}.tsx`]: 'export default function Page() { return null; }',
        'pages/[locale]/localized.tsx': 'export default function Page() { return null; }',
        'check-root-dynamic.ts': `import { routeUrl, type Href, type RouteDestination, type RoutePath, type RouteUrl } from 'void/routes';
import type { VoidRouter } from 'void/pages-client';
import type { CloudContext } from 'void/handler';
import { revalidate } from 'void/isr';
import { connectEventStream } from 'void/sse/client';
import { connectLiveStream } from 'void/live/client';
const path: RoutePath = ${JSON.stringify(pattern)};
const destination: RouteDestination = { pathname: path, params: { ${JSON.stringify(param)}: 'dashboard' } };
const url: RouteUrl = routeUrl(path, { params: { ${JSON.stringify(param)}: 'dashboard' } });
const alias: Href = routeUrl(${JSON.stringify(legacy)}, { params: { ${JSON.stringify(param)}: 'dashboard' } });
const text: string = url;
const known: Href[] = ['/about', '/about?tab=activity', '/users/42', '/files/docs/start', '/wild/a/b', '/fr/localized', url, alias];
// @ts-expect-error root dynamic routes do not admit misspelled static URLs
const typo: Href = '/abuot';
// @ts-expect-error root dynamic routes require explicit URL construction
const dynamic: RouteUrl = '/dashboard';
// @ts-expect-error root dynamic routes do not admit arbitrary nested URLs
const nested: Href = '/dashboard/settings';
// @ts-expect-error root dynamic routes do not admit protocol-relative URLs
const external: Href = '//example.com';
// @ts-expect-error query strings do not bypass route checks
const query: RouteUrl = '/dashboard?tab=activity';
// @ts-expect-error hashes do not bypass route checks
const hash: RouteUrl = '/dashboard#details';
// @ts-expect-error params remain required for root dynamic routes
routeUrl(${JSON.stringify(pattern)});
// @ts-expect-error root dynamic parameter names remain checked
routeUrl(${JSON.stringify(pattern)}, { params: { wrong: 'dashboard' } });
// @ts-expect-error routeUrl still requires a registered pattern
routeUrl('/abuot');
declare const router: VoidRouter;
declare const context: CloudContext;
void router.visit(url);
void router.prefetch(destination);
context.redirect(url);
void context.rewrite(url);
void revalidate({ paths: [url] });
connectEventStream(url);
connectLiveStream(url);
void [known, text, typo, dynamic, nested, external, query, hash];
`,
      },
    });
    for (const declarations of ['generated', 'package'] as const) {
      expect(typecheck(root, declarations, ['check-typed.ts', 'check-root-dynamic.ts'])).toEqual({
        output: '',
        status: 0,
      });
    }
  });

  it.each(['[slug]', '[...slug]', '[...]'])(
    'keeps raw URL checks with a trailing-slash root %s page',
    async (file) => {
      const root = await createFixture({
        typedRoutes: true,
        extraFiles: {
          'void.json': JSON.stringify({ routing: { trailingSlash: true } }),
          [`pages/${file}.tsx`]: 'export default function Page() { return null; }',
          'check-root-trailing.ts': `import { routeUrl, type Href } from 'void/routes';
const url: Href = routeUrl('/${file}/', { params: { ${JSON.stringify(file === '[...]' ? '*' : 'slug')}: 'dashboard' } });
const known: Href = '/about/';
// @ts-expect-error root dynamic routes do not admit misspelled trailing-slash URLs
const typo: Href = '/abuot/';
// @ts-expect-error root dynamic routes do not admit nested trailing-slash URLs
const nested: Href = '/dashboard/settings/';
void [url, known, typo, nested];
`,
        },
      });
      for (const declarations of ['generated', 'package'] as const) {
        expect(typecheck(root, declarations, ['check-root-trailing.ts'])).toEqual({
          output: '',
          status: 0,
        });
      }
    },
  );

  it('checks useIslandForm URLs in every adapter with routing.typedRoutes', async () => {
    const root = await createFixture({
      typedRoutes: true,
      extraFiles: { 'check-island-form.ts': islandFormCheck },
    });
    expect(
      typecheck(root, 'generated', ['check-island-form.ts'], {
        allowImportingTsExtensions: true,
      }),
    ).toEqual({ output: '', status: 0 });
  });

  it('checks Link href in every adapter with routing.typedRoutes', async () => {
    const root = await createFixture({
      typedRoutes: true,
      extraFiles: { 'pages/[...slug].tsx': 'export default function Page() { return null; }' },
    });
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

  it('checks empty trailing-slash catch-alls through generated declarations', async () => {
    const root = await createFixture({
      typedRoutes: true,
      extraFiles: {
        'void.json': JSON.stringify({ routing: { trailingSlash: true } }),
        'check-trailing.ts': `import type { RouteUrl } from 'void/routes';
const paths: Array<RouteUrl> = ['/wild/', '/wild/a/b/'];
void paths;`,
      },
    });
    expect(typecheck(root, 'generated', ['check-trailing.ts'])).toEqual({ output: '', status: 0 });
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
  interface RoutePathMap { '/': never; '/docs/[...]': '*'; '/trailing/[...]/': '*'; '/users/[id]': 'id'; '/café menu': never }
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
const emptyCatchAll: RouteUrl = '/trailing/';
const nestedCatchAll: RouteUrl = '/trailing/a/b/';
// @ts-expect-error unknown routes are rejected
const unknown: Href = '/unknown';
// @ts-expect-error route URLs exclude external links
const external: RouteUrl = 'https://vite.dev';
void [hrefs, route, emptyCatchAll, nestedCatchAll, unknown, external];
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
    routeUrl('/users/[id]', { params: { id: 'a/b' }, query: { page: 2, tag: ['one', 'two'] }, hash: '/settings?tab=1&next=%2Fhome' }),
    routeUrl('/users/:id', { params: { id: 'a/b' }, query: { page: 2, tag: ['one', 'two'] }, hash: '/settings?tab=1&next=%2Fhome' }),
    routeUrl('/files/[...path]', { params: { path: 'docs/start here' } }),
    routeUrl('/files/:path{.+}', { params: { path: 'docs/start here' } }),
    routeUrl('/wild/[...]', { params: { '*': 'a/b' } }),
    routeUrl('/wild/*', { params: { '*': 'a/b' } }),
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
      '/users/a%2Fb?page=2&tag=one&tag=two#/settings?tab=1&next=%2Fhome',
      '/files/docs/start%20here',
      '/files/docs/start%20here',
      '/wild/a/b',
      '/wild/a/b',
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
