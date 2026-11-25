import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { collectBrowserDiagnostics } from '../../../../test/browser-helpers.ts';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
} from '../../../../test/integration-helpers.ts';
import type { IsolatedPlayground } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLAYGROUND = 'playground/sveltekit';
// Kit 2 uses the JavaScript TypeScript compiler. Its Windows CI subprocess hit the
// 20s deadline; give it the same 3× allowance as integration server startup.
const TYPECHECK_TIMEOUT = process.platform === 'win32' ? 60_000 : 20_000;
describe.each([2, 3])('SvelteKit %i compatibility', (major) => {
  let child: ReturnType<typeof spawn>;
  let fixture: IsolatedPlayground;
  let DEV_BASE: string;
  let serverOutput = () => '';

  beforeAll(async () => {
    fixture = createIsolatedPlayground(ROOT, PLAYGROUND);
    const pg = fixture.root;
    if (major === 2) {
      const dependencies = createIsolatedPlayground(ROOT, 'test/fixtures/sveltekit-v2');
      try {
        rmSync(join(pg, 'node_modules'), { recursive: true, force: true });
        renameSync(join(dependencies.root, 'node_modules'), join(pg, 'node_modules'));
        writeFileSync(
          join(pg, 'tsconfig.json'),
          JSON.stringify({
            extends: './.svelte-kit/tsconfig.json',
            compilerOptions: { types: ['void/env'], skipLibCheck: true },
          }),
        );
        const pkg = JSON.parse(readFileSync(join(pg, 'package.json'), 'utf8'));
        pkg.dependencies['@sveltejs/kit'] = '2.62.0';
        pkg.dependencies['@sveltejs/adapter-cloudflare'] = '7.2.10';
        writeFileSync(join(pg, 'package.json'), JSON.stringify(pkg));
        const viteConfig = readFileSync(join(pg, 'vite.config.ts'), 'utf8');
        writeFileSync(
          join(pg, 'vite.config.ts'),
          `import { withVoidTSConfig } from 'void/sveltekit';\n` +
            viteConfig.replace(
              'sveltekit({',
              'sveltekit({ typescript: { config: withVoidTSConfig() },',
            ),
        );
      } finally {
        dependencies.cleanup();
      }
    }
    rmSync(join(pg, 'wrangler.jsonc'), { force: true });
    writeFileSync(
      join(pg, 'src/void-bindings.typecheck.ts'),
      `import { db } from 'void/db';
import { users } from '@schema';
export function checkSchema() {
  db.select({ name: users.name }).from(users);
  // @ts-expect-error The generated schema has no missing column.
  users.missing;
  // @ts-expect-error Generated database types preserve column value types.
  db.insert(users).values({ name: 123, email: 'test@example.com' });
}
`,
    );

    const prepare = spawn.sync(
      process.execPath,
      [join(ROOT, 'packages/void/dist/cli/cli.mjs'), 'prepare'],
      {
        cwd: pg,
        encoding: 'utf8',
        timeout: 20_000,
      },
    );
    expect(prepare.status, prepare.stdout + prepare.stderr).toBe(0);

    // Kit 3 checks Vite environment identity; use the fixture's Vite+ instance
    // even when the smart runner puts the workspace's binaries first on PATH.
    const server = await startServer(
      (port) => {
        child = spawn(
          process.execPath,
          [
            join(pg, 'node_modules/vite-plus/bin/vp'),
            'dev',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--strictPort',
          ],
          {
            cwd: pg,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              VOID_INSPECTOR_PORT: 'false',
            },
          },
        );
        return child;
      },
      30_000,
      { expectStatus: 200, expectBody: 'SvelteKit + Void' },
    );
    DEV_BASE = server.base;
    serverOutput = server.output;
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    fixture?.cleanup();
  });

  it('syncs the generated Cloudflare config with inferred bindings', () => {
    const wranglerConfig = JSON.parse(
      readFileSync(join(fixture.root, '.void-wrangler.jsonc'), 'utf8'),
    ) as {
      d1_databases?: Array<{ binding: string }>;
      kv_namespaces?: Array<{ binding: string }>;
    };

    expect(wranglerConfig.d1_databases?.some((b) => b.binding === 'DB')).toBe(true);
    expect(wranglerConfig.kv_namespaces?.some((b) => b.binding === 'KV')).toBe(true);
    expect(existsSync(join(fixture.root, 'wrangler.jsonc'))).toBe(false);
  });

  it('typechecks generated database and schema imports', () => {
    const started = performance.now();
    const result = spawn.sync(
      process.execPath,
      [join(fixture.root, 'node_modules/tsrs/bin/tsrs'), '--noEmit'],
      { cwd: fixture.root, encoding: 'utf8', timeout: TYPECHECK_TIMEOUT },
    );
    const diagnostics = [
      `TypeScript finished after ${Math.round(performance.now() - started)}ms (status=${result.status}, signal=${result.signal}).`,
      result.error?.stack,
      result.stdout,
      result.stderr,
    ]
      .filter(Boolean)
      .join('\n');
    expect(result.error, diagnostics).toBeFalsy();
    expect(result.status, diagnostics).toBe(0);
  });

  it('renders home page with SSR', async () => {
    const response = await fetch(`${DEV_BASE}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('SvelteKit + Void');
  });

  it('navigates to smoke route via SPA from home page', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    let diagnostics = () => '';
    try {
      const page = await browser.newPage();
      diagnostics = collectBrowserDiagnostics(page);
      await page.goto(DEV_BASE);
      // Wait for client mounting before clicking the server-rendered link.
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

  it('dispatches authenticated cron jobs with D1 and KV bindings', async () => {
    const token = readFileSync(join(fixture.root, '.void/dev-trigger-token'), 'utf8').trim();
    const request = (authorized: boolean) =>
      fetch(`${DEV_BASE}/__void/scheduled`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorized ? { 'x-void-dev-trigger': token } : {}),
        },
        body: JSON.stringify({ cron: '0 * * * *', scheduledTime: Date.now() }),
      });
    expect((await request(false)).status).toBe(401);
    const response = await request(true);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  // build:all covers the Kit 3 playground; build the shared app with Kit 2 here.
  it.runIf(major === 2)('builds a deployable Cloudflare Worker', async () => {
    await killChild(child);
    const result = spawn.sync(
      process.execPath,
      [join(fixture.root, 'node_modules/vite-plus/bin/vp'), 'build'],
      {
        cwd: fixture.root,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(join(fixture.root, '.svelte-kit/cloudflare/_worker.js'))).toBe(true);
  });
});
