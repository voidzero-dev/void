// The Markdown plugin source needs its ambient module declarations in this package's typecheck.
// eslint-disable-next-line typescript/triple-slash-reference -- env.d.ts has no exports to import.
/// <reference path="../../../md/src/env.d.ts" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import { expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from '../../../../test/browser-helpers.ts';
import { openIslandPage, type IslandPageVisit } from '../../../../test/island-page-browser.ts';
import { voidMarkdown } from '../../../md/src/plugin.ts';
import { islandsPlugin } from '../../src/plugin-islands.ts';
import { CLIENT_OPTIMIZE_DEPS } from '../../src/plugin-pages.ts';

// The island renderer imports the adapter's server entry, so the more specific id comes first.
const ADAPTER_ALIAS = {
  '@void/hono/pages-server': join(import.meta.dirname, '../../src/runtime/pages-server.ts'),
  '@void/hono': join(import.meta.dirname, '../../src/runtime/index.ts'),
};

// The Markdown plugin picks its output from the adapter's pages plugin name. As in
// voidHono(), that plugin pre-bundles the Hono JSX runtime: found only when the
// first island hydrates, it would re-optimize and reload the page under test.
const PAGES_PLUGIN = {
  name: 'void-hono:pages',
  config: () => ({ optimizeDeps: { include: [...CLIENT_OPTIMIZE_DEPS] } }),
};

const ISLAND_FRONTMATTER_SCRIPT =
  '<script type="application/json" id="__void_frontmatter">{"title":"Hello from frontmatter"}</script>';

type IslandRenderer = {
  renderIslandPage(
    page: { component: string; props: Record<string, unknown> },
    assetTags: { css: string; preloads: string; body: string },
  ): Promise<string>;
};

it('a layout reads the frontmatter of the Markdown page it wraps', async () => {
  const root = mkdtempSync(join(import.meta.dirname, '__tmp_md_frontmatter_'));
  const pages = join(root, 'pages');
  mkdirSync(pages);
  writeFileSync(
    join(pages, 'layout.tsx'),
    `import { useFrontmatter } from "@void/md";
export default function Layout({ children }) {
  return <div><p id="fm">{useFrontmatter().title}</p>{children}</div>;
}`,
  );
  writeFileSync(join(pages, 'index.md'), '---\ntitle: Hello from frontmatter\n---\n\n# Body\n');

  const server = await createServer({
    root,
    configFile: false,
    cacheDir: join(root, '.vite'),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, ws: false },
    resolve: { alias: ADAPTER_ALIAS },
    plugins: [...voidMarkdown(), PAGES_PLUGIN, ...islandsPlugin(pages)],
  });
  try {
    const renderer = (await server.ssrLoadModule(
      'virtual:void-islands-renderer',
    )) as IslandRenderer;
    const html = await renderer.renderIslandPage(
      { component: 'index', props: {} },
      { css: '', preloads: '', body: '' },
    );
    expect(html).toContain('<p id="fm">Hello from frontmatter</p>');
    expect(html).toContain('Body</h1>');
    // No island on the page, so the frontmatter stays on the server.
    expect(html).not.toContain('__void_frontmatter');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('an island reads the same frontmatter in the browser as on the server', async () => {
  const root = mkdtempSync(join(import.meta.dirname, '__tmp_md_island_frontmatter_'));
  mkdirSync(join(root, 'pages'));
  mkdirSync(join(root, 'components'));
  writeFileSync(
    join(root, 'pages', 'layout.island.tsx'),
    `import Title from "../components/Title" with { island: "load" };
export default function Layout({ children }) {
  return <div><Title />{children}</div>;
}`,
  );
  writeFileSync(
    join(root, 'components', 'Title.tsx'),
    `import { jsx } from "hono/jsx";
import { useFrontmatter } from "@void/md";
export default function Title() {
  return jsx("p", { id: "island-fm" }, String(useFrontmatter().title));
}`,
  );
  writeFileSync(
    join(root, 'pages', 'index.md'),
    '---\ntitle: Hello from frontmatter\n---\n\n# Body\n',
  );

  let visit: IslandPageVisit | undefined;
  try {
    visit = await openIslandPage(root, {
      alias: ADAPTER_ALIAS,
      plugins: [...voidMarkdown(), PAGES_PLUGIN, ...islandsPlugin(join(root, 'pages'))],
    });
    expect(visit.html).toContain(ISLAND_FRONTMATTER_SCRIPT);
    await waitForIslandsHydrated(visit.page);
    expect(await visit.page.textContent('#island-fm')).toBe('Hello from frontmatter');
    expect(visit.diagnostics().toLowerCase()).not.toContain('hydrat');
    expect(visit.diagnostics()).not.toContain('pageerror');
    expect(visit.diagnostics()).not.toContain('full-reload');
  } finally {
    await visit?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('an island that only the Markdown page imports hydrates', async () => {
  const root = mkdtempSync(join(import.meta.dirname, '__tmp_md_page_island_'));
  mkdirSync(join(root, 'pages'));
  mkdirSync(join(root, 'components'));
  writeFileSync(
    join(root, 'components', 'Title.tsx'),
    `import { jsx } from "hono/jsx";
import { useFrontmatter } from "@void/md";
export default function Title() {
  return jsx("p", { id: "island-fm" }, String(useFrontmatter().title));
}`,
  );
  writeFileSync(
    join(root, 'pages', 'index.md'),
    `<script>
import Title from "../components/Title" with { island: "load" };
</script>

---
title: Hello from frontmatter
---

<Title />
`,
  );

  let visit: IslandPageVisit | undefined;
  try {
    visit = await openIslandPage(root, {
      alias: ADAPTER_ALIAS,
      plugins: [...voidMarkdown(), PAGES_PLUGIN, ...islandsPlugin(join(root, 'pages'))],
    });
    expect(visit.html).toContain(ISLAND_FRONTMATTER_SCRIPT);
    await waitForIslandsHydrated(visit.page);
    expect(await visit.page.textContent('#island-fm')).toBe('Hello from frontmatter');
    expect(visit.diagnostics().toLowerCase()).not.toContain('hydrat');
    expect(visit.diagnostics()).not.toContain('pageerror');
    expect(visit.diagnostics()).not.toContain('full-reload');
  } finally {
    await visit?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
