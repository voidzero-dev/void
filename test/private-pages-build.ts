import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { preview, type PreviewServer } from 'vite';
import { expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from './browser-helpers.ts';
import { buildIslandApp } from './island-css-build.ts';

export function definePrivatePagesBuildTest(app: {
  packageDir: string;
  pluginName: 'voidReact' | 'voidSolid';
  counter: string;
}): void {
  it('excludes private helpers from the Pages client and hydrates explicit private islands', async () => {
    const classAttribute = app.pluginName === 'voidReact' ? 'className' : 'class';
    const build = buildIslandApp({
      packageDir: app.packageDir,
      pluginName: app.pluginName,
      files: {
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            jsx: app.pluginName === 'voidReact' ? 'react-jsx' : 'preserve',
            jsxImportSource: app.pluginName === 'voidReact' ? 'react' : 'solid-js',
          },
        }),
        'pages/_ui/frame.tsx': `import './frame.css';
export function Frame(props) {
  return <main ${classAttribute}="private-frame" data-frame="575_SERVER_FRAME">{props.children}</main>;
}`,
        'pages/_ui/frame.css': '.private-frame { outline-offset: 11px; }',
        'pages/_ui/counter.tsx': app.counter,
        'pages/_layouts/docs.tsx': `import './docs.css';
export default function Docs(props) {
  return <section ${classAttribute}="private-layout" data-layout="docs">{props.children}</section>;
}`,
        'pages/_layouts/docs.css': '.private-layout { word-spacing: 3px; }',
        'pages/index.island.tsx': `import { Frame } from './_ui/frame';
import Counter from './_ui/counter' with { island: 'load' };
export const layout = 'docs';
export default function Home() { return <Frame><Counter /></Frame>; }`,
      },
    });
    let server: PreviewServer | undefined;
    let browser: Browser | undefined;
    try {
      const manifest = JSON.parse(
        readFileSync(join(build.root, 'dist/client/.vite/manifest.json'), 'utf8'),
      );
      expect(Object.values(manifest)).not.toContainEqual(
        expect.objectContaining({ name: 'pages-client', isEntry: true }),
      );
      expect(Object.values(manifest)).toContainEqual(
        expect.objectContaining({ name: 'islands-client', isEntry: true }),
      );
      const { html, css } = build.page('index.html');
      expect(html).toContain('data-frame="575_SERVER_FRAME"');
      expect(html).toContain('data-layout="docs"');
      expect(css).toContain('.private-frame{outline-offset:11px}');
      expect(css).toContain('.private-layout{word-spacing:3px}');
      for (const [file, text] of build.output('client')) {
        if (file.endsWith('.js')) {
          expect(text, file).not.toContain('575_SERVER_FRAME');
        }
      }

      server = await preview({
        root: build.root,
        configFile: false,
        logLevel: 'silent',
        build: { outDir: 'dist/client' },
        preview: { host: '127.0.0.1', port: 0 },
      });
      const base = server.resolvedUrls?.local[0];
      if (!base) {
        throw new Error('Preview did not report a local URL.');
      }
      browser = await chromium.launch();
      const page = await browser.newPage();
      const errors: Array<string> = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base);
      await waitForIslandsHydrated(page, 1, 15_000);
      await page.getByRole('button', { name: 'Count: 0', exact: true }).click();
      await expect.poll(() => page.getByRole('button').textContent()).toBe('Count: 1');
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await server?.close();
      build.cleanup();
    }
  }, 120_000);
}
