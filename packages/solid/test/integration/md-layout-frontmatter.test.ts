// The Markdown plugin source needs its ambient module declarations in this package's typecheck.
// eslint-disable-next-line typescript/triple-slash-reference -- env.d.ts has no exports to import.
/// <reference path="../../../md/src/env.d.ts" />
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';
import solid from 'vite-plugin-solid';
import { expect, it } from 'vite-plus/test';
import { voidMarkdown } from '../../../md/src/plugin.ts';
import { islandsPlugin } from '../../src/plugin-islands.ts';

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
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
