import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vite-plus/test';

const MD_PLUGIN = join(import.meta.dirname, '../packages/md/dist/plugin.mjs');

type IslandCssApp = {
  /** The adapter package directory, e.g. `packages/react`. */
  packageDir: string;
  /** The adapter's plugin export in `dist/plugin.mjs`, e.g. `voidReact`. */
  pluginName: string;
  /** App files by path. `index` and `about` must ship no JavaScript. */
  files: Record<string, string>;
  /** Rules (as minified CSS) every page must link, found once in the client build. */
  expectedCss: Array<string>;
  /** Extra assertions for each page. */
  check?: (page: { file: string; html: string; css: string }) => void;
};

/** The stylesheet links of a page, without a regular expression. */
function stylesheetHrefs(html: string): Array<string> {
  const marker = '<link rel="stylesheet" href="';
  return html
    .split(marker)
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf('"')));
}

/**
 * Builds the app for production with the built Void packages. The app has no
 * package.json, so `@void/<adapter>` resolves to the adapter package itself.
 */
export function buildIslandApp(app: Omit<IslandCssApp, 'expectedCss' | 'check'>): {
  root: string;
  page(file: string): { html: string; css: string };
  /** The text of every built file under `dist/<dir>`, by path. */
  output(dir: 'client' | 'ssr'): Map<string, string>;
  cleanup(): void;
} {
  const root = mkdtempSync(join(app.packageDir, 'test/integration/__tmp_island_css_'));
  try {
    const plugin = pathToFileURL(join(app.packageDir, 'dist/plugin.mjs')).href;
    const files: Record<string, string> = {
      'vite.config.mjs': `import { voidPlugin } from 'void';
import { ${app.pluginName} } from ${JSON.stringify(plugin)};
import { voidMarkdown } from ${JSON.stringify(pathToFileURL(MD_PLUGIN).href)};
export default { plugins: [voidPlugin(), ${app.pluginName}(), voidMarkdown()] };
`,
      'void.config.ts': `import { defineConfig } from 'void/config';
export default defineConfig({ output: 'static', worker: { compatibility_date: '2026-02-24' } });
`,
      'pages/about.md': '---\ntitle: About\n---\n\n# About\n',
      ...app.files,
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    // The native loader keeps the config's imports in the adapter package scope.
    execSync('vp build --configLoader native', { cwd: root, stdio: 'pipe' });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const client = join(root, 'dist/client');
  return {
    root,
    page(file) {
      const html = readFileSync(join(client, file), 'utf-8');
      const css = stylesheetHrefs(html)
        .map((href) => readFileSync(join(client, href), 'utf-8'))
        .join('\n');
      return { html, css };
    },
    output(dir) {
      const out = join(root, 'dist', dir);
      const files = new Map<string, string>();
      for (const file of readdirSync(out, { recursive: true, encoding: 'utf-8' })) {
        if (file.endsWith('.js') || file.endsWith('.css') || file.endsWith('.html')) {
          files.set(file, readFileSync(join(out, file), 'utf-8'));
        }
      }
      return files;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** How many times `text` contains `part`. */
export function countOf(text: string, part: string): number {
  return text.split(part).length - 1;
}

/**
 * Shared by the four adapters: a layout renders a component that imports CSS.
 * Production must link that CSS on island and Markdown pages, as dev does,
 * even though the pages ship no JavaScript.
 */
export function defineIslandCssBuildTest(app: IslandCssApp): void {
  it('links the CSS that a layout component imports on island and Markdown pages', () => {
    const build = buildIslandApp(app);
    try {
      for (const file of ['index.html', 'about.html']) {
        const { html, css } = build.page(file);
        for (const rule of app.expectedCss) {
          expect(countOf(css, rule), `${file}: ${rule}`).toBe(1);
        }
        expect(html, file).not.toContain('<script');
        app.check?.({ file, html, css });
      }
      // Rolldown keeps each stylesheet module in one chunk, so no rule repeats.
      const clientCss = [...build.output('client')]
        .filter(([file]) => file.endsWith('.css'))
        .map(([, text]) => text)
        .join('\n');
      for (const rule of app.expectedCss) {
        expect(countOf(clientCss, rule), rule).toBe(1);
      }
    } finally {
      build.cleanup();
    }
  }, 120_000);
}
