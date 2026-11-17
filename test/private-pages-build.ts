import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { preview, type PreviewServer } from 'vite';
import { expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from './browser-helpers.ts';
import type { BuiltFixture } from './fixture-app.ts';

export function definePrivatePagesBuildTest(app: { build: () => BuiltFixture }): void {
  it('excludes private helpers from the Pages client and hydrates explicit private islands', async () => {
    const build = app.build();
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
      const pageFile = 'private.html';
      const { html, css } = build.page(pageFile);
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
      await page.goto(new URL(pageFile, base).href);
      await waitForIslandsHydrated(page, 1, 15_000);
      await page.getByRole('button', { name: 'Count: 0', exact: true }).click();
      await expect.poll(() => page.getByRole('button').textContent()).toBe('Count: 1');
      expect(errors).toEqual([]);
    } finally {
      await browser?.close();
      await server?.close();
    }
  }, 120_000);
}
