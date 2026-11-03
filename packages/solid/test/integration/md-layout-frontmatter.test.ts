// The Markdown plugin source needs its ambient module declarations in this package's typecheck.
// eslint-disable-next-line typescript/triple-slash-reference -- env.d.ts has no exports to import.
/// <reference path="../../../md/src/env.d.ts" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import solid from 'vite-plugin-solid';
import { expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from '../../../../test/browser-helpers.ts';
import { openIslandPage, type IslandPageVisit } from '../../../../test/island-page-browser.ts';
import { voidMarkdown } from '../../../md/src/plugin.ts';
import { islandsPlugin } from '../../src/plugin-islands.ts';

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
export default function Layout(props) {
  return <div><p id="fm">{useFrontmatter().title}</p>{props.children}</div>;
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
    resolve: { alias: { '@void/solid': join(import.meta.dirname, '../../src/runtime/index.ts') } },
    // The Markdown plugin picks its output from the adapter's pages plugin name.
    plugins: [
      ...voidMarkdown(),
      solid({ ssr: true }),
      { name: 'void-solid:pages' },
      ...islandsPlugin(pages),
    ],
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
    join(root, 'pages/layout.island.tsx'),
    `import Title from "../components/Title" with { island: "load" };
export default function Layout(props) {
  return <div><Title />{props.children}</div>;
}`,
  );
  writeFileSync(
    join(root, 'components/Title.tsx'),
    `import { useFrontmatter } from "@void/md";
export default function Title() {
  return <p id="island-fm">{String(useFrontmatter().title)}</p>;
}`,
  );
  writeFileSync(
    join(root, 'pages', 'index.md'),
    '---\ntitle: Hello from frontmatter\n---\n\n# Body\n',
  );

  let visit: IslandPageVisit | undefined;
  try {
    visit = await openIslandPage(root, {
      alias: { '@void/solid': join(import.meta.dirname, '../../src/runtime/index.ts') },
      plugins: [
        ...voidMarkdown(),
        solid({ ssr: true }),
        { name: 'void-solid:pages' },
        ...islandsPlugin(join(root, 'pages')),
      ],
    });
    expect(visit.html).toContain(ISLAND_FRONTMATTER_SCRIPT);
    await waitForIslandsHydrated(visit.page);
    expect(await visit.page.textContent('#island-fm')).toBe('Hello from frontmatter');
    expect(visit.diagnostics()).not.toContain('pageerror');
  } finally {
    await visit?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
