import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { collectBrowserDiagnostics } from '../../../../test/browser-helpers.ts';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
let DEV_BASE: string;

function removeWranglerConfig(root: string) {
  rmSync(join(root, 'wrangler.jsonc'), { force: true });
  rmSync(join(root, 'wrangler.json'), { force: true });
}

describe(
  'playground/nuxt dev',
  () => {
    let fixture: IsolatedPlayground;
    let child: ReturnType<typeof spawn> | undefined;
    let serverOutput = () => '';

    beforeAll(
      async () => {
        fixture = createIsolatedPlayground(ROOT, 'playground/nuxt');
        // Dev must generate the inferred binding config itself in a fresh fixture.
        rmSync(join(fixture.root, '.void-wrangler.jsonc'), { force: true });
        removeWranglerConfig(fixture.root);

        // Nuxt has no strict port option: if its port is taken, it moves to a random port
        // without saying so, and this start times out instead of retrying. It also prints no
        // URL under Vitest, so only the page body shows that the answer comes from this app.
        const server = await startServer(
          (port) => {
            child = spawn('vp', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port)], {
              cwd: fixture.root,
              stdio: ['ignore', 'pipe', 'pipe'],
              env: {
                ...process.env,
                VOID_INSPECTOR_PORT: 'false',
              },
            });
            return child;
          },
          30_000,
          { expectStatus: 200, expectBody: 'Nuxt + Void', printsUrl: false },
        );
        DEV_BASE = server.base;
        serverOutput = server.output;
      },
      process.platform === 'win32' ? 120_000 : 45_000,
    );

    afterAll(async () => {
      try {
        if (child) {
          await killChild(child);
        }
      } finally {
        fixture?.cleanup();
      }
    });

    it('syncs the generated Cloudflare config with bindings from void.config.ts', () => {
      const wranglerConfig = JSON.parse(
        readFileSync(join(fixture.root, '.void-wrangler.jsonc'), 'utf-8'),
      ) as {
        d1_databases?: Array<{ binding: string }>;
        kv_namespaces?: Array<{ binding: string }>;
      };

      expect(wranglerConfig.d1_databases?.some((b) => b.binding === 'DB')).toBe(true);
      expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
      expect(existsSync(join(fixture.root, 'wrangler.jsonc'))).toBe(false);
    });

    it('renders home page with SSR', async () => {
      const response = await fetch(`${DEV_BASE}/`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Nuxt + Void');
    });

    it('does not serve the dev-trigger token', async () => {
      const pg = fixture.root;
      const token = readFileSync(join(pg, '.void/dev-trigger-token'), 'utf8').trim();

      const tokenFile = await fetch(`${DEV_BASE}/_nuxt/.void/dev-trigger-token`);
      expect(tokenFile.status).toBe(404);
      expect(await tokenFile.text()).not.toContain(token);

      // Nitro's dev bundle inlines the trigger dispatch module.
      expect(existsSync(join(pg, '.nuxt/dev/index.mjs'))).toBe(true);
      const fsPath = pg.replaceAll('\\', '/').replace(/^\/+/, '');
      const bundle = await fetch(`${DEV_BASE}/_nuxt/@fs/${fsPath}/.nuxt/dev/index.mjs`);
      expect(await bundle.text()).not.toContain(token);
    });

    it("serves void/db with the app's schema to server routes", async () => {
      const response = await fetch(`${DEV_BASE}/api/smoke`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ firstUser: { name: 'Alice' } });
    });

    it('navigates to smoke route via SPA from home page', async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch();
      let diagnostics = () => '';
      try {
        const page = await browser.newPage();
        diagnostics = collectBrowserDiagnostics(page);
        await page.goto(DEV_BASE);
        // SSR and network inactivity do not mean Nuxt has installed its router yet.
        await page.waitForSelector('h1[data-hydrated="true"]');

        // Mark the document to detect full page reloads
        await page.evaluate(() => {
          (window as Window & { __spa_marker?: boolean }).__spa_marker = true;
        });

        await page.click('a[href="/smoke"]');
        await page.waitForURL('**/smoke');
        await page.waitForSelector('[data-testid="d1-user"]');

        // Assert SPA navigation (no full reload)
        const spaMarker = await page.evaluate(
          () => (window as Window & { __spa_marker?: boolean }).__spa_marker,
        );
        expect(spaMarker).toBe(true);

        const d1User = await page.textContent('[data-testid="d1-user"]');
        const kvValue = await page.textContent('[data-testid="kv-value"]');
        expect(d1User).toBe('Alice');
        expect(kvValue).toBe('ok');
      } catch (error) {
        throw new Error(`${diagnostics()}\nDev server:\n${serverOutput()}`, { cause: error });
      } finally {
        await browser.close();
      }
    });
  },
  process.platform === 'win32' ? 120_000 : 60_000,
);
