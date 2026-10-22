import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vite-plus/test';
import { generateRouteTypes } from '../../src/codegen/route-types.ts';
import { resolveLayoutIds } from '../../src/pages/layout-resolution.ts';
import {
  scanPages,
  resolveLayoutChain,
  resolveNamedLayout,
  resolveEffectiveLayoutChain,
  MAX_REVALIDATE,
} from '../../src/pages/scan.ts';

const TMP = join(import.meta.dirname, '__tmp_pages_scan__');

function writeFile(relativePath: string, content: string): void {
  const full = join(TMP, 'pages', relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('scanPages', () => {
  it('reads quoted server export names and ignores renamed local handlers', async () => {
    writeFile('[slug].vue', '<template><div>Post</div></template>');
    writeFile(
      '[slug].server.ts',
      `
      const loader = () => ({}), mutate = () => ({}), paths = () => [];
      export { loader as "helper", mutate as "action", paths as "getPrerenderPaths" };
      export { type loader as "loader" };
    `,
    );
    const page = (await scanPages(TMP, { output: 'static' })).pages[0];
    expect(page.methods).toEqual(['action']);
    expect(page.hasGetPrerenderPaths).toBe(true);
    expect(page.shouldPrerender).toBe(true);
  });

  it.each([
    ['export const { loader, action, actions } = handlers;', ['loader', 'action', 'actions']],
    [
      'export const { get: loader, action: helper, nested: [actions] } = handlers;',
      ['loader', 'actions'],
    ],
    ['export const [loader = fallback, , ...actions] = handlers;', ['loader', 'actions']],
    ['export const { [action]: helper, other = loader } = handlers;', []],
    ['const { loader, action } = handlers; export const helper = loader;', []],
  ])('detects exported page bindings in %s', async (source, methods) => {
    writeFile('index.vue', '<template><div>Home</div></template>');
    writeFile('index.server.ts', source as string);
    expect((await scanPages(TMP)).pages[0].methods).toEqual(methods);
  });

  it('prerenders a static dynamic page with a destructured path provider', async () => {
    writeFile('[slug].vue', '<template><div>Post</div></template>');
    writeFile('[slug].server.ts', 'export const { getPrerenderPaths } = handlers;');
    const page = (await scanPages(TMP, { output: 'static' })).pages[0];
    expect(page.hasGetPrerenderPaths).toBe(true);
    expect(page.shouldPrerender).toBe(true);
  });

  it('does not automatically prerender an island with a destructured loader', async () => {
    writeFile('index.island.tsx', 'export default () => null;');
    writeFile('index.server.ts', 'export const { loader } = handlers;');
    expect((await scanPages(TMP)).pages[0].shouldPrerender).toBe(false);
  });

  beforeEach(() => {
    mkdirSync(join(TMP, 'pages'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('returns empty result when no pages/ directory exists', async () => {
    rmSync(join(TMP, 'pages'), { recursive: true, force: true });
    const result = await scanPages(TMP);
    expect(result).toEqual({ pages: [], layouts: [], namedLayouts: [] });
  });

  it('scans .vue files and produces correct patterns', async () => {
    writeFile('index.vue', '<template><div>Home</div></template>');
    writeFile('about.vue', '<template><div>About</div></template>');
    writeFile('users/index.vue', '<template><div>Users</div></template>');
    writeFile('users/[id].vue', '<template><div>User</div></template>');

    const result = await scanPages(TMP);

    expect(result.pages).toHaveLength(4);

    const home = result.pages.find((p) => p.componentId === 'index');
    expect(home).toBeDefined();
    expect(home!.pattern).toBe('/');

    const about = result.pages.find((p) => p.componentId === 'about');
    expect(about).toBeDefined();
    expect(about!.pattern).toBe('/about');

    const users = result.pages.find((p) => p.componentId === 'users');
    expect(users).toBeDefined();
    expect(users!.pattern).toBe('/users');

    const userId = result.pages.find((p) => p.componentId === 'users/[id]');
    expect(userId).toBeDefined();
    expect(userId!.pattern).toBe('/users/:id');
    expect(userId!.params).toEqual(['id']);
  });

  it('detects companion .server.ts files and extracts methods', async () => {
    writeFile('users/index.vue', '<template><div>Users</div></template>');
    writeFile(
      'users/index.server.ts',
      'export const loader = () => [];\nexport const action = () => ({});',
    );

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'users');
    expect(page).toBeDefined();
    expect(page!.serverPath).toBe('users/index.server.ts');
    expect(page!.methods).toEqual(['loader', 'action']);
  });

  it('detects actions (plural) export from .server.ts', async () => {
    writeFile('settings.vue', '<template><div>Settings</div></template>');
    writeFile(
      'settings.server.ts',
      'export const actions = {\n  updateName: async () => ({}),\n  updateEmail: async () => ({}),\n};',
    );

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'settings');
    expect(page).toBeDefined();
    expect(page!.serverPath).toBe('settings.server.ts');
    expect(page!.methods).toEqual(['actions']);
  });

  it('detects both loader and actions exports from .server.ts', async () => {
    writeFile('profile.vue', '<template><div>Profile</div></template>');
    writeFile(
      'profile.server.ts',
      'export const loader = () => ({});\nexport const actions = {\n  update: async () => ({}),\n};',
    );

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'profile');
    expect(page).toBeDefined();
    expect(page!.methods).toEqual(['loader', 'actions']);
  });

  it('ignores commented and stringified action exports', async () => {
    writeFile('settings.vue', '<template><div>Settings</div></template>');
    writeFile(
      'settings.server.ts',
      `export const action = () => ({});
// export const actions = {};
/* export async function loader() {} */
const example = 'export const actions = {}';`,
    );

    const result = await scanPages(TMP);
    expect(result.pages[0]?.methods).toEqual(['action']);
    expect(() =>
      generateRouteTypes(
        { routes: [], middleware: [], jobs: [], queues: [], pages: result },
        join(TMP, 'routes'),
        join(TMP, '.void'),
        join(TMP, 'pages'),
      ),
    ).not.toThrow();
  });

  it('ignores commented and stringified page server metadata', async () => {
    writeFile('comments/[slug].vue', '<template><div>Comment</div></template>');
    writeFile(
      'comments/[slug].server.ts',
      `export const action = () => ({});
const example = 'export const prerender = true; export const ssr = false;';
// export const revalidate = 60;
/* export const prerender = true;
   export const ssr = false;
   export function getPrerenderPaths() {} */`,
    );

    const result = await scanPages(TMP, { output: 'static' });
    const page = result.pages[0];
    expect(page.methods).toEqual(['action']);
    expect(page.revalidate).toBeUndefined();
    expect(page.prerender).toBeUndefined();
    expect(page.ssr).toBeUndefined();
    expect(page.hasGetPrerenderPaths).toBeUndefined();
    expect(page.shouldPrerender).toBe(false);
  });

  it('reads page settings through TypeScript expression wrappers', async () => {
    writeFile('typed.vue', '<template><div>Typed</div></template>');
    writeFile(
      'typed.server.ts',
      `export const revalidate = (60 as number)!;
export const prerender = false satisfies boolean;
export const ssr = true as const;`,
    );

    const page = (await scanPages(TMP)).pages[0];
    expect(page.revalidate).toBe(60);
    expect(page.prerenderMode).toBe('disabled');
    expect(page.ssrMode).toBe('server');
  });

  it('does not treat a computed revalidate expression as its leading literal', async () => {
    writeFile('computed.vue', '<template><div>Computed</div></template>');
    writeFile('computed.server.ts', 'export const revalidate = 60 + 1;');

    expect((await scanPages(TMP)).pages[0].revalidate).toBeUndefined();
  });

  it('keeps detecting page methods declared with let or var', async () => {
    writeFile('methods.vue', '<template><div>Methods</div></template>');
    writeFile('methods.server.ts', 'export let loader = () => []; export var action = () => ({});');

    expect((await scanPages(TMP)).pages[0].methods).toEqual(['loader', 'action']);
  });

  it('detects page methods from named value re-exports without counting type exports', async () => {
    writeFile('settings.vue', '<template><div>Settings</div></template>');
    writeFile(
      'settings.server.ts',
      `const handler = () => ({});
type actions = {};
export { handler as action, type actions };`,
    );

    const result = await scanPages(TMP);
    expect(result.pages[0]?.methods).toEqual(['action']);
  });

  it('identifies layout.vue files separately', async () => {
    writeFile('layout.vue', '<template><slot /></template>');
    writeFile('users/layout.vue', '<template><slot /></template>');
    writeFile('index.vue', '<template><div>Home</div></template>');

    const result = await scanPages(TMP);
    expect(result.layouts).toHaveLength(2);

    const root = result.layouts.find((l) => l.directory === '');
    expect(root).toBeDefined();
    expect(root!.filePath).toBe('layout.vue');

    const users = result.layouts.find((l) => l.directory === 'users');
    expect(users).toBeDefined();
    expect(users!.filePath).toBe('users/layout.vue');

    // Layouts should not appear as pages
    expect(result.pages.every((p) => !p.componentPath.includes('layout'))).toBe(true);
  });

  it('skips _-prefixed files but allows _layouts/', async () => {
    writeFile('index.vue', '<template><div>Home</div></template>');
    writeFile('_components/shared.vue', '<template><div>Shared</div></template>');
    writeFile('_hidden.vue', '<template><div>Hidden</div></template>');
    writeFile('_layouts/home.vue', '<template><slot /></template>');

    const result = await scanPages(TMP);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].componentId).toBe('index');
    expect(result.namedLayouts).toHaveLength(1);
    expect(result.namedLayouts[0].name).toBe('home');
  });

  it('sorts static before dynamic, catch-all last', async () => {
    writeFile('about.vue', '<template><div /></template>');
    writeFile('[...slug].vue', '<template><div /></template>');
    writeFile('[id].vue', '<template><div /></template>');
    writeFile('index.vue', '<template><div /></template>');

    const result = await scanPages(TMP);
    const patterns = result.pages.map((p) => p.pattern);
    // Static routes first (/about, /), then dynamic (/:id), then catch-all
    expect(patterns.indexOf('/about')).toBeLessThan(patterns.indexOf('/:id'));
    expect(patterns.indexOf('/:id')).toBeLessThan(patterns.indexOf('/:slug{.+}'));
  });

  it('handles .tsx components', async () => {
    writeFile('dashboard.tsx', 'export default function Dashboard() { return <div />; }');
    const result = await scanPages(TMP);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].componentId).toBe('dashboard');
    expect(result.pages[0].pattern).toBe('/dashboard');
  });

  it('extracts revalidate from .server.ts', async () => {
    writeFile('products/index.vue', '<template><div>Products</div></template>');
    writeFile(
      'products/index.server.ts',
      'export const revalidate = 120;\nexport const loader = () => [];',
    );

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'products');
    expect(page).toBeDefined();
    expect(page!.revalidate).toBe(120);
  });

  it('extracts revalidate zero from .server.ts', async () => {
    writeFile('private.vue', '<template><div>Private</div></template>');
    writeFile('private.server.ts', 'export const revalidate = 0;\nexport const loader = () => [];');

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'private');
    expect(page).toBeDefined();
    expect(page!.revalidate).toBe(0);
  });

  it('returns undefined revalidate when not exported', async () => {
    writeFile('about.vue', '<template><div>About</div></template>');
    writeFile('about.server.ts', 'export const loader = () => [];');

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'about');
    expect(page).toBeDefined();
    expect(page!.revalidate).toBeUndefined();
  });

  it('detects ssr = false from .server.ts and resolves client render mode', async () => {
    writeFile('analytics.vue', '<template><div>Analytics</div></template>');
    writeFile('analytics.server.ts', 'export const ssr = false;\nexport const loader = () => [];');

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'analytics');
    expect(page).toBeDefined();
    expect(page!.ssr).toBe(false);
    expect(page!.ssrMode).toBe('client');
    expect(page!.renderMode).toBe('client');
  });

  it('detects ssr = true from .server.ts and resolves server render mode', async () => {
    writeFile('analytics.vue', '<template><div>Analytics</div></template>');
    writeFile('analytics.server.ts', 'export const ssr = true;\nexport const loader = () => [];');

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'analytics');
    expect(page).toBeDefined();
    expect(page!.ssr).toBe(true);
    expect(page!.ssrMode).toBe('server');
    expect(page!.renderMode).toBe('server');
  });

  it('throws when ssr = false is used on an island page', async () => {
    writeFile('analytics.island.vue', '<template><div>Analytics</div></template>');
    writeFile('analytics.server.ts', 'export const ssr = false;');

    await expect(scanPages(TMP)).rejects.toThrow(
      "pages: ssr = false is not valid for island page 'analytics.island.vue'.",
    );
  });

  it('detects getPrerenderPaths from .server.ts', async () => {
    writeFile('blog/[slug].vue', '<template><div>Blog</div></template>');
    writeFile(
      'blog/[slug].server.ts',
      "export const prerender = true;\nexport async function getPrerenderPaths() { return [{ slug: 'hello' }]; }\nexport const loader = () => [];",
    );

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'blog/[slug]');
    expect(page).toBeDefined();
    expect(page!.prerender).toBe(true);
    expect(page!.prerenderMode).toBe('force');
    expect(page!.shouldPrerender).toBe(true);
    expect(page!.hasGetPrerenderPaths).toBe(true);
  });

  it('scans .island.tsx files with island flag', async () => {
    writeFile('index.island.tsx', 'export default function Home() { return <div />; }');
    const result = await scanPages(TMP);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].island).toBe(true);
    expect(result.pages[0].componentId).toBe('index');
    expect(result.pages[0].pattern).toBe('/');
  });

  it('scans .island.vue files with island flag', async () => {
    writeFile('pricing.island.vue', '<template><div>Pricing</div></template>');
    const result = await scanPages(TMP);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].island).toBe(true);
    expect(result.pages[0].componentId).toBe('pricing');
    expect(result.pages[0].pattern).toBe('/pricing');
  });

  it('detects layout.island.tsx as island layout', async () => {
    writeFile(
      'blog/layout.island.tsx',
      'export default function Layout({ children }) { return <div>{children}</div>; }',
    );
    writeFile('blog/index.island.tsx', 'export default function Blog() { return <div />; }');
    const result = await scanPages(TMP);
    expect(result.layouts).toHaveLength(1);
    expect(result.layouts[0].island).toBe(true);
    expect(result.layouts[0].directory).toBe('blog');
  });

  it('finds companion .server.ts for island pages', async () => {
    writeFile('index.island.tsx', 'export default function Home() { return <div />; }');
    writeFile('index.server.ts', 'export const loader = () => ({});');
    const result = await scanPages(TMP);
    expect(result.pages[0].island).toBe(true);
    expect(result.pages[0].serverPath).toBe('index.server.ts');
  });

  it('throws when regular page is under island layout', async () => {
    writeFile(
      'blog/layout.island.tsx',
      'export default function L({ children }) { return children; }',
    );
    writeFile('blog/post.tsx', 'export default function Post() { return <div />; }');

    await expect(scanPages(TMP)).rejects.toThrow('Regular page');
  });

  it('throws when regular index page is under island layout', async () => {
    writeFile(
      'blog/layout.island.tsx',
      'export default function L({ children }) { return children; }',
    );
    writeFile('blog/index.tsx', 'export default function Blog() { return <div />; }');

    await expect(scanPages(TMP)).rejects.toThrow('Regular page');
  });

  it('non-island pages have island as undefined', async () => {
    writeFile('dashboard.tsx', 'export default function Dashboard() { return <div />; }');
    const result = await scanPages(TMP);
    expect(result.pages[0].island).toBeUndefined();
  });

  it('returns undefined prerender when not exported', async () => {
    writeFile('about.vue', '<template><div>About</div></template>');
    writeFile('about.server.ts', 'export const loader = () => [];');

    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'about');
    expect(page).toBeDefined();
    expect(page!.prerender).toBeUndefined();
    expect(page!.prerenderMode).toBe('auto');
    expect(page!.shouldPrerender).toBe(false);
    expect(page!.hasGetPrerenderPaths).toBeUndefined();
  });

  it('auto-prerenders static island page with no loader, no params', async () => {
    writeFile('pricing.island.vue', '<template><div>Pricing</div></template>');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'pricing');
    expect(page!.prerender).toBeUndefined();
    expect(page!.prerenderMode).toBe('auto');
    expect(page!.shouldPrerender).toBe(true);
    expect(page!.revalidate).toBe(MAX_REVALIDATE);
  });

  it('auto-prerenders island page even with island imports', async () => {
    writeFile(
      'pricing.island.vue',
      `<script setup>\nimport Counter from "./Counter.vue" with { island: "load" };\n</script>\n<template><Counter /></template>`,
    );
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'pricing');
    expect(page!.prerender).toBeUndefined();
    expect(page!.shouldPrerender).toBe(true);
    expect(page!.revalidate).toBe(MAX_REVALIDATE);
  });

  it('does not auto-prerender island page with loader', async () => {
    writeFile('products.island.vue', '<template><div>Products</div></template>');
    writeFile('products.server.ts', 'export const loader = () => [];');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'products');
    expect(page!.prerender).toBeUndefined();
    expect(page!.shouldPrerender).toBe(false);
  });

  it('does not auto-prerender dynamic island page', async () => {
    writeFile('blog/[slug].island.vue', '<template><div>Post</div></template>');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'blog/[slug]');
    expect(page!.prerender).toBeUndefined();
    expect(page!.shouldPrerender).toBe(false);
  });

  it('auto-sets max revalidate for explicit prerender on any page', async () => {
    writeFile('about.vue', '<template><div>About</div></template>');
    writeFile('about.server.ts', 'export const prerender = true;');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'about');
    expect(page!.prerender).toBe(true);
    expect(page!.prerenderMode).toBe('force');
    expect(page!.shouldPrerender).toBe(true);
    expect(page!.revalidate).toBe(MAX_REVALIDATE);
  });

  it('preserves explicit revalidate when prerender is true', async () => {
    writeFile('about.vue', '<template><div>About</div></template>');
    writeFile('about.server.ts', 'export const prerender = true;\nexport const revalidate = 3600;');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'about');
    expect(page!.prerender).toBe(true);
    expect(page!.shouldPrerender).toBe(true);
    expect(page!.revalidate).toBe(3600);
  });

  it('detects render config exports without semicolons', async () => {
    writeFile('about.vue', '<template><div>About</div></template>');
    writeFile(
      'about.server.ts',
      'export const ssr = false\nexport const prerender = true\nexport const revalidate = 120',
    );
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'about');
    expect(page!.ssr).toBe(false);
    expect(page!.prerender).toBe(true);
    expect(page!.renderMode).toBe('client');
    expect(page!.prerenderMode).toBe('force');
    expect(page!.shouldPrerender).toBe(true);
    expect(page!.revalidate).toBe(120);
  });

  it('preserves explicit prerender = false as disabled prerender mode', async () => {
    writeFile('pricing.island.vue', '<template><div>Pricing</div></template>');
    writeFile('pricing.server.ts', 'export const prerender = false;');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'pricing');
    expect(page!.prerender).toBe(false);
    expect(page!.prerenderMode).toBe('disabled');
    expect(page!.shouldPrerender).toBe(false);
    expect(page!.revalidate).toBeUndefined();
  });

  it('scans .md files as island pages', async () => {
    writeFile('docs/getting-started.md', '# Getting Started\n\nHello world.');
    const result = await scanPages(TMP);
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0];
    expect(page.island).toBe(true);
    expect(page.componentId).toBe('docs/getting-started');
    expect(page.pattern).toBe('/docs/getting-started');
    expect(page.componentPath).toBe('docs/getting-started.md');
  });

  it('auto-prerenders static .md page (no loader, no params)', async () => {
    writeFile('docs/guide.md', '# Guide');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'docs/guide');
    expect(page!.prerender).toBeUndefined();
    expect(page!.shouldPrerender).toBe(true);
    expect(page!.revalidate).toBe(MAX_REVALIDATE);
  });

  it('does not auto-prerender dynamic .md page', async () => {
    writeFile('blog/[slug].md', '# Post');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'blog/[slug]');
    expect(page!.island).toBe(true);
    expect(page!.prerender).toBeUndefined();
    expect(page!.shouldPrerender).toBe(false);
  });

  it('picks up companion .server.ts for .md page', async () => {
    writeFile('docs/guide.md', '# Guide');
    writeFile('docs/guide.server.ts', 'export const loader = () => ({});');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'docs/guide');
    expect(page!.serverPath).toBe('docs/guide.server.ts');
    expect(page!.methods).toEqual(['loader']);
    // Has loader → no auto-prerender
    expect(page!.prerender).toBeUndefined();
    expect(page!.shouldPrerender).toBe(false);
  });

  it('scans .md index file correctly', async () => {
    writeFile('docs/index.md', '# Docs Home');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'docs');
    expect(page).toBeDefined();
    expect(page!.pattern).toBe('/docs');
    expect(page!.island).toBe(true);
  });

  it('extracts title and description from .md frontmatter', async () => {
    writeFile('post.md', '---\ntitle: Hello\ndescription: "A post"\n---\n# Hello');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'post');
    expect(page!.metadata).toEqual({ title: 'Hello', description: 'A post' });
  });

  it('extracts .md frontmatter that follows a leading <script> block', async () => {
    writeFile(
      'post.md',
      '<script>\ndocument.title = "x"\n</script>\n\n---\n\ntitle: Hello\ndescription: A post\n\n---\n\n# Hello',
    );
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'post');
    expect(page!.metadata).toEqual({ title: 'Hello', description: 'A post' });
  });

  it('ignores a --- block that is not at the start of the .md body', async () => {
    writeFile('post.md', '# Hello\n\n---\ntitle: Not frontmatter\n---\n');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'post');
    expect(page!.metadata).toBeUndefined();
  });

  it('auto-prerenders island page but preserves user revalidate from server file', async () => {
    writeFile('pricing.island.vue', '<template><div>Pricing</div></template>');
    writeFile('pricing.server.ts', 'export const revalidate = 60;');
    const result = await scanPages(TMP);
    const page = result.pages.find((p) => p.componentId === 'pricing');
    expect(page!.prerender).toBeUndefined();
    expect(page!.shouldPrerender).toBe(true);
    expect(page!.revalidate).toBe(60);
  });

  describe('named layouts', () => {
    it('scans root _layouts/ directory', async () => {
      writeFile('_layouts/home.vue', '<template><slot /></template>');
      writeFile('_layouts/post.vue', '<template><slot /></template>');
      writeFile(
        'index.vue',
        '<script>export const layout = "home";</script>\n<template><div /></template>',
      );
      const result = await scanPages(TMP);
      expect(result.namedLayouts).toHaveLength(2);
      expect(result.namedLayouts.map((nl) => nl.name).sort()).toEqual(['home', 'post']);
      expect(result.namedLayouts[0].directory).toBe('');
    });

    it('scans nested _layouts/ directories', async () => {
      writeFile('guide/_layouts/api.vue', '<template><slot /></template>');
      writeFile(
        'guide/intro.vue',
        '<script>export const layout = "api";</script>\n<template><div /></template>',
      );
      const result = await scanPages(TMP);
      expect(result.namedLayouts).toHaveLength(1);
      expect(result.namedLayouts[0].name).toBe('api');
      expect(result.namedLayouts[0].directory).toBe('guide');
    });

    it('resolves nested named layouts for directory index pages', async () => {
      writeFile('guide/_layouts/api.vue', '<template><slot /></template>');
      writeFile(
        'guide/index.vue',
        '<script>export const layout = "api";</script>\n<template><div /></template>',
      );
      const result = await scanPages(TMP);
      const page = result.pages.find((p) => p.componentId === 'guide');
      expect(page).toBeDefined();
      expect(resolveLayoutIds(page!, result.layouts, result.namedLayouts)).toEqual([
        'guide/_layouts/api',
      ]);
    });

    it('detects island named layouts', async () => {
      writeFile('_layouts/post.island.vue', '<template><slot /></template>');
      writeFile(
        'index.island.vue',
        '<script>export const layout = "post";</script>\n<template><div /></template>',
      );
      const result = await scanPages(TMP);
      expect(result.namedLayouts).toHaveLength(1);
      expect(result.namedLayouts[0].island).toBe(true);
    });

    it('extracts layout from Vue SFC export const', async () => {
      writeFile('_layouts/home.vue', '<template><slot /></template>');
      writeFile(
        'index.vue',
        '<script>export const layout = "home";</script>\n<template><div /></template>',
      );
      const result = await scanPages(TMP);
      const page = result.pages.find((p) => p.componentId === 'index');
      expect(page!.layout).toBe('home');
    });

    it('extracts layout = false from Vue SFC', async () => {
      writeFile('layout.vue', '<template><slot /></template>');
      writeFile(
        'index.vue',
        '<script>export const layout = false;</script>\n<template><div /></template>',
      );
      const result = await scanPages(TMP);
      const page = result.pages.find((p) => p.componentId === 'index');
      expect(page!.layout).toBe(false);
    });

    it('ignores layout exports in Vue comments and template text', async () => {
      writeFile('_layouts/home.vue', '<template><slot /></template>');
      writeFile(
        'index.vue',
        `<script>
// export const layout = "home";
const example = 'export const layout = "home"';
</script>
<template><div>export const layout = "home"</div></template>`,
      );
      const result = await scanPages(TMP);
      expect(result.pages.find((p) => p.componentId === 'index')?.layout).toBeUndefined();
    });

    it('reads a Svelte script layout export with TypeScript syntax', async () => {
      writeFile('_layouts/home.svelte', '<slot />');
      writeFile(
        'index.svelte',
        '<script lang="ts">export const layout = "home" as const;</script><div />',
      );
      const result = await scanPages(TMP);
      expect(result.pages.find((p) => p.componentId === 'index')?.layout).toBe('home');
    });

    it('extracts exclusive layout from Vue SFC', async () => {
      writeFile('_layouts/home.vue', '<template><slot /></template>');
      writeFile(
        'index.vue',
        '<script>export const layout = "!home";</script>\n<template><div /></template>',
      );
      const result = await scanPages(TMP);
      const page = result.pages.find((p) => p.componentId === 'index');
      expect(page!.layout).toBe('!home');
    });

    it('extracts layout from TSX export', async () => {
      writeFile('_layouts/dash.vue', '<template><slot /></template>');
      writeFile(
        'admin.tsx',
        'export const layout = "dash";\nexport default function Admin() { return <div />; }',
      );
      const result = await scanPages(TMP);
      const page = result.pages.find((p) => p.componentId === 'admin');
      expect(page!.layout).toBe('dash');
    });

    it('extracts layout from markdown frontmatter', async () => {
      writeFile('_layouts/post.vue', '<template><slot /></template>');
      writeFile('blog/hello.md', '---\nlayout: post\n---\n# Hello');
      const result = await scanPages(TMP);
      const page = result.pages.find((p) => p.componentId === 'blog/hello');
      expect(page!.layout).toBe('post');
    });

    it('extracts layout: false from markdown frontmatter', async () => {
      writeFile('layout.vue', '<template><slot /></template>');
      writeFile('bare.md', '---\nlayout: false\n---\n# Bare');
      const result = await scanPages(TMP);
      const page = result.pages.find((p) => p.componentId === 'bare');
      expect(page!.layout).toBe(false);
    });

    it('extracts layout from markdown frontmatter after a leading <script> block', async () => {
      writeFile('_layouts/post.vue', '<template><slot /></template>');
      writeFile(
        'blog/hello.md',
        '<script>\nconsole.log(1)\n</script>\n---\nlayout: post\n---\n# Hello',
      );
      const result = await scanPages(TMP);
      const page = result.pages.find((p) => p.componentId === 'blog/hello');
      expect(page!.layout).toBe('post');
    });

    it('throws when named layout reference is not found', async () => {
      writeFile(
        'index.vue',
        '<script>export const layout = "missing";</script>\n<template><div /></template>',
      );
      await expect(scanPages(TMP)).rejects.toThrow('_layouts/missing.vue');
    });

    it.each(['./Shell.vue', '!./Shell.vue', '/layouts/shell'])(
      'warns and uses the default layouts when a page sets layout path %s',
      async (value) => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          writeFile('layout.vue', '<template><slot /></template>');
          writeFile(
            'index.vue',
            `<script>export const layout = "${value}";</script>\n<template><div /></template>`,
          );
          const result = await scanPages(TMP);
          const page = result.pages.find((p) => p.componentId === 'index')!;
          expect(
            resolveEffectiveLayoutChain(page, result.layouts, result.namedLayouts).map(
              (layout) => layout.filePath,
            ),
          ).toEqual(['layout.vue']);
          expect(log).toHaveBeenCalledOnce();
          expect(log.mock.calls[0][0]).toContain(
            `pages: Page 'index.vue' specifies layout '${value}'. Layout paths are not supported, so the default layouts are used.`,
          );
        } finally {
          log.mockRestore();
        }
      },
    );

    it('warns when markdown frontmatter sets a layout path', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        writeFile('post.md', '---\nlayout: ./x\n---\n# Hi');
        await scanPages(TMP);
        await scanPages(TMP);
        expect(log).toHaveBeenCalledOnce();
        expect(log.mock.calls[0][0]).toContain(
          "pages: Page 'post.md' specifies layout './x'. Layout paths are not supported",
        );
      } finally {
        log.mockRestore();
      }
    });
  });

  describe('route clashes', () => {
    it('throws once, listing every route that more than one page file resolves to', async () => {
      writeFile('about.tsx', 'export default () => null;');
      writeFile('about/index.tsx', 'export default () => null;');
      writeFile('(a)/team.tsx', 'export default () => null;');
      writeFile('(b)/team.tsx', 'export default () => null;');
      writeFile('docs/x.tsx', 'export default () => null;');
      writeFile('docs/x.vue', '<template><div /></template>');
      writeFile('docs/y.tsx', 'export default () => null;');
      writeFile('docs/y.island.tsx', 'export default () => null;');

      await expect(scanPages(TMP)).rejects.toThrow(
        [
          'pages: Multiple page files resolve to the same route:',
          '  "/about": "about.tsx", "about/index.tsx"',
          '  "/docs/x": "docs/x.tsx", "docs/x.vue"',
          '  "/docs/y": "docs/y.island.tsx", "docs/y.tsx"',
          '  "/team": "(a)/team.tsx", "(b)/team.tsx"',
          'Keep one page file per route and rename or remove the others.',
        ].join('\n'),
      );
    });

    it('throws when two page files on different routes get the same page id', async () => {
      writeFile('index.tsx', 'export default () => null;');
      writeFile('index/index.tsx', 'export default () => null;');

      await expect(scanPages(TMP)).rejects.toThrow(
        [
          'pages: Multiple page files resolve to the same page id:',
          '  "index": "index.tsx", "index/index.tsx"',
          'Rename or remove one of them.',
        ].join('\n'),
      );
    });

    it('warns once about a dynamic page another page with the same shape hides', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        writeFile('shadow/[id].tsx', 'export default () => null;');
        writeFile('shadow/[slug].tsx', 'export default () => null;');
        const { pages } = await scanPages(TMP);
        await scanPages(TMP);

        expect(pages.map((page) => page.componentId)).toEqual(['shadow/[id]', 'shadow/[slug]']);
        expect(log).toHaveBeenCalledOnce();
        expect(log.mock.calls[0][0]).toContain(
          "pages: Page 'shadow/[slug].tsx' (/shadow/:slug) is never used: 'shadow/[id].tsx' (/shadow/:id) matches the same URLs first. Remove one of them.",
        );
      } finally {
        log.mockRestore();
      }
    });

    it('allows the same param under different names on different routes', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        writeFile('users/[id].tsx', 'export default () => null;');
        writeFile('users/[id]/edit.tsx', 'export default () => null;');
        writeFile('users/[userId]/posts.tsx', 'export default () => null;');
        writeFile('layout.tsx', 'export default ({ children }) => children;');
        writeFile('layout/index.tsx', 'export default () => null;');

        const { pages } = await scanPages(TMP);

        expect(pages.map((page) => page.pattern).sort()).toEqual([
          '/layout',
          '/users/:id',
          '/users/:id/edit',
          '/users/:userId/posts',
        ]);
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    });
  });
});

describe('resolveLayoutChain', () => {
  it('returns correct layout hierarchy', () => {
    const layouts = [
      { directory: '', filePath: 'layout.vue' },
      { directory: 'users', filePath: 'users/layout.vue' },
      { directory: 'users/settings', filePath: 'users/settings/layout.vue' },
    ];

    const chain = resolveLayoutChain('users/settings/profile', layouts);
    expect(chain).toHaveLength(3);
    expect(chain[0].directory).toBe('');
    expect(chain[1].directory).toBe('users');
    expect(chain[2].directory).toBe('users/settings');
  });

  it('returns only root layout for top-level pages', () => {
    const layouts = [
      { directory: '', filePath: 'layout.vue' },
      { directory: 'users', filePath: 'users/layout.vue' },
    ];

    const chain = resolveLayoutChain('about', layouts);
    expect(chain).toHaveLength(1);
    expect(chain[0].directory).toBe('');
  });

  it('returns empty array when no layouts match', () => {
    const layouts = [{ directory: 'admin', filePath: 'admin/layout.vue' }];

    const chain = resolveLayoutChain('about', layouts);
    expect(chain).toHaveLength(0);
  });

  it('skips missing intermediate layouts', () => {
    const layouts = [
      { directory: '', filePath: 'layout.vue' },
      { directory: 'users/settings', filePath: 'users/settings/layout.vue' },
    ];

    const chain = resolveLayoutChain('users/settings/profile', layouts);
    expect(chain).toHaveLength(2);
    expect(chain[0].directory).toBe('');
    expect(chain[1].directory).toBe('users/settings');
  });

  it('includes directory layouts for index page file paths', () => {
    const layouts = [
      { directory: '', filePath: 'layout.vue' },
      { directory: 'users', filePath: 'users/layout.vue' },
    ];

    const chain = resolveLayoutChain('users', layouts, 'users/index.vue');
    expect(chain).toHaveLength(2);
    expect(chain[0].directory).toBe('');
    expect(chain[1].directory).toBe('users');
  });
});

describe('resolveNamedLayout', () => {
  const namedLayouts = [
    { name: 'home', directory: '', filePath: '_layouts/home.vue' },
    { name: 'post', directory: '', filePath: '_layouts/post.vue' },
    { name: 'api', directory: 'guide', filePath: 'guide/_layouts/api.vue' },
    { name: 'post', directory: 'blog', filePath: 'blog/_layouts/post.vue' },
  ];

  it('resolves from same directory level', () => {
    const result = resolveNamedLayout('api', 'guide/intro', namedLayouts);
    expect(result).not.toBeNull();
    expect(result!.directory).toBe('guide');
  });

  it('resolves from parent directory (walks up)', () => {
    const result = resolveNamedLayout('home', 'guide/intro', namedLayouts);
    expect(result).not.toBeNull();
    expect(result!.directory).toBe('');
  });

  it('prefers closest ancestor', () => {
    const result = resolveNamedLayout('post', 'blog/article', namedLayouts);
    expect(result).not.toBeNull();
    expect(result!.directory).toBe('blog');
  });

  it('falls back to root when not in closer directory', () => {
    const result = resolveNamedLayout('post', 'about', namedLayouts);
    expect(result).not.toBeNull();
    expect(result!.directory).toBe('');
  });

  it('returns null when not found', () => {
    const result = resolveNamedLayout('missing', 'about', namedLayouts);
    expect(result).toBeNull();
  });
});

describe('resolveEffectiveLayoutChain', () => {
  const layouts = [
    { directory: '', filePath: 'layout.vue' },
    { directory: 'guide', filePath: 'guide/layout.vue' },
  ];
  const namedLayouts = [
    { name: 'home', directory: '', filePath: '_layouts/home.vue' },
    { name: 'api', directory: 'guide', filePath: 'guide/_layouts/api.vue' },
  ];

  it('returns empty chain for layout: false', () => {
    const chain = resolveEffectiveLayoutChain(
      { componentId: 'guide/intro', layout: false },
      layouts,
      namedLayouts,
    );
    expect(chain).toHaveLength(0);
  });

  it('returns named layout as sole entry when no default chain', () => {
    const chain = resolveEffectiveLayoutChain(
      { componentId: 'about', layout: 'home' },
      [{ directory: 'guide', filePath: 'guide/layout.vue' }], // no root layout
      namedLayouts,
    );
    expect(chain).toHaveLength(1);
    expect((chain[0] as { name: string }).name).toBe('home');
  });

  it('falls back to default chain for unresolvable named layout', () => {
    const chain = resolveEffectiveLayoutChain(
      { componentId: 'guide/intro', layout: 'missing' },
      layouts,
      namedLayouts,
    );
    expect(chain).toHaveLength(2);
    expect(chain[0].directory).toBe('');
    expect(chain[1].directory).toBe('guide');
  });
});

describe('resolveLayoutIds', () => {
  const layouts = [
    { directory: '', filePath: 'layout.vue' },
    { directory: 'guide', filePath: 'guide/layout.vue' },
  ];
  const namedLayouts = [
    { name: 'home', directory: '', filePath: '_layouts/home.vue' },
    { name: 'api', directory: 'guide', filePath: 'guide/_layouts/api.vue' },
  ];

  it('returns default layout ids', () => {
    expect(resolveLayoutIds({ componentId: 'guide/intro' }, layouts, namedLayouts)).toEqual([
      'layout',
      'guide/layout',
    ]);
  });

  it('returns directory layout ids for index page file paths', () => {
    expect(
      resolveLayoutIds(
        { componentId: 'guide', componentPath: 'guide/index.vue' },
        layouts,
        namedLayouts,
      ),
    ).toEqual(['layout', 'guide/layout']);
  });

  it('replaces the innermost layout id for named layouts', () => {
    expect(
      resolveLayoutIds({ componentId: 'guide/intro', layout: 'api' }, layouts, namedLayouts),
    ).toEqual(['layout', 'guide/_layouts/api']);
  });

  it('replaces the innermost layout id for index page named layouts', () => {
    expect(
      resolveLayoutIds(
        { componentId: 'guide', componentPath: 'guide/index.vue', layout: 'api' },
        layouts,
        namedLayouts,
      ),
    ).toEqual(['layout', 'guide/_layouts/api']);
  });

  it('returns only the exclusive named layout id', () => {
    expect(
      resolveLayoutIds({ componentId: 'guide/intro', layout: '!home' }, layouts, namedLayouts),
    ).toEqual(['_layouts/home']);
  });
});

describe('scanPages between saves', () => {
  beforeEach(() => {
    mkdirSync(join(TMP, 'pages'), { recursive: true });

    // Files written by a test are too recent to reuse; move the clock past that window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('picks up page metadata changed since the previous scan', async () => {
    writeFile('cached/post.tsx', 'export default function Post() { return null; }');
    writeFile('cached/post.server.ts', 'export const revalidate = 60;');
    writeFile('cached/notes.md', '---\ntitle: Draft\n---\n# Notes');

    const before = await scanPages(TMP);

    expect(before.pages.find((page) => page.componentId === 'cached/post')).toMatchObject({
      methods: [],
      revalidate: 60,
    });
    expect(before.pages.find((page) => page.componentId === 'cached/notes')?.metadata).toEqual({
      title: 'Draft',
    });

    writeFile('cached/post.tsx', 'export const layout = false;\nexport default function Post() {}');
    writeFile('cached/post.server.ts', 'export const loader = () => ({});');
    writeFile('cached/notes.md', '---\ntitle: Published\n---\n# Notes');

    const after = await scanPages(TMP);

    expect(after.pages.find((page) => page.componentId === 'cached/post')).toMatchObject({
      methods: ['loader'],
      layout: false,
    });
    expect(after.pages.find((page) => page.componentId === 'cached/notes')?.metadata).toEqual({
      title: 'Published',
    });
  });
});
