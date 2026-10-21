import { execSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkerConfigPath } from '@cloudflare/build-output-utils';
import spawn from 'cross-spawn';
import { chromium, type Browser, type Page } from 'playwright';
import { describe, expect, it, beforeAll, afterAll } from 'vite-plus/test';
import { killChild, startServer } from '../../../../test/integration-helpers.ts';

declare global {
  interface Window {
    __SPA_MARKER?: boolean;
  }
}

type NavElement = HTMLElement & { __stamp?: number };

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

let BASE: string;
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

async function newPage(): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  return page;
}

async function waitForHydration(page: Page) {
  await page.waitForSelector('#app[data-hydrated="true"]', { timeout: 20_000 });
}

describe('playground/kitchen-sink', () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    // Build first so every dependency is resolved before the server starts;
    // dev-mode dependency optimization makes browser checks unreliable.
    const pg = join(ROOT, 'playground/kitchen-sink');
    rmSync(join(pg, 'dist'), { recursive: true, force: true });
    execSync('vp run --filter ./playground/kitchen-sink build', {
      cwd: ROOT,
      stdio: 'pipe',
    });
    const previewDatabaseId = preparePreviewWranglerConfig(pg);

    // Start preview server — pre-built assets, no lazy optimization.
    const server = await startServer(
      (port) => {
        child = spawn(
          'vp',
          [
            'run',
            '--filter',
            './playground/kitchen-sink',
            'preview',
            '--host',
            '127.0.0.1',
            '--port',
            String(port),
            '--strictPort',
          ],
          {
            cwd: ROOT,
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
      { expectBody: 'Kitchen Sink' },
    );
    BASE = server.base;

    // Preview mode doesn't auto-run migrations (dev mode's migrationPlugin
    // handles this via configureServer). Apply them directly to the local
    // D1 database so pages that query DB/Auth tables work.
    const { runMigrations, getMiniflareDatabasePath } =
      await import('../../src/migrations/runner.ts');
    const dbPath = getMiniflareDatabasePath(join(pg, '.void'), previewDatabaseId);
    await runMigrations(join(pg, 'db', 'migrations'), dbPath);

    const { runLocalVoidAuthMigrations } = await import('../../src/auth/node.ts');
    await runLocalVoidAuthMigrations(pg, 'sqlite', join(pg, '.void'), previewDatabaseId, null);
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
  });

  it('serves SSR home page and hydrates', async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/`);
      await waitForHydration(page);

      const text = await page.textContent('body');
      expect(text).toContain('Kitchen Sink');
      expect(text).toContain('Auth');
    } finally {
      await page.context().close();
    }
  });

  it('SPA navigates between pages without full reload', async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/`);
      await waitForHydration(page);

      await page.evaluate(() => {
        window.__SPA_MARKER = true;
      });

      await page.click('a[href="/db"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('DB'));
      expect(page.url()).toBe(`${BASE}/db`);

      // Marker survives = SPA navigation (no reload)
      const marker = await page.evaluate(() => window.__SPA_MARKER);
      expect(marker).toBe(true);

      await page.click('a[href="/kv"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('KV'));
      expect(page.url()).toBe(`${BASE}/kv`);
    } finally {
      await page.context().close();
    }
  });

  it('layout persists across navigation', async () => {
    const page = await newPage();
    try {
      await page.goto(`${BASE}/`);
      await waitForHydration(page);

      await page.evaluate(() => {
        (document.querySelector('nav') as NavElement | null)!.__stamp = 1;
      });

      await page.click('a[href="/env"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Env'));

      const stamp = await page.evaluate(
        () => (document.querySelector('nav') as NavElement | null)?.__stamp,
      );
      expect(stamp).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  it('DB: create and delete a note via the UI', async () => {
    const page = await newPage();
    const title = `e2e-${Date.now()}`;

    try {
      await page.goto(`${BASE}/db`);
      await waitForHydration(page);

      await page.fill('input[placeholder="Note title"]', title);
      await page.fill('input[placeholder="Note body"]', 'test body');
      await page.click('button:has-text("Add Note")');

      await page.waitForFunction((t) => document.body.textContent?.includes(t), title);
      const text = await page.textContent('body');
      expect(text).toContain(title);
      expect(text).toContain('test body');

      const row = page.locator('tr', { hasText: title });
      await row.locator('button:has-text("Delete")').click();

      await page.waitForFunction((t) => !document.body.textContent?.includes(t), title);
    } finally {
      await page.context().close();
    }
  });

  it('KV: set and delete a key via the UI', async () => {
    const page = await newPage();
    const key = `e2e-kv-${Date.now()}`;

    try {
      await page.goto(`${BASE}/kv`);
      await waitForHydration(page);

      await page.fill('input[placeholder="my-key"]', key);
      await page.fill('input[placeholder="my-value"]', 'hello');
      await page.click('button:has-text("Set")');

      await page.waitForFunction((k) => document.body.textContent?.includes(k), key);
      let text = await page.textContent('body');
      expect(text).toContain(key);

      const row = page.locator('tr', { hasText: key });
      await row.locator('button:has-text("Delete")').click();

      await page.waitForFunction((k) => !document.body.textContent?.includes(k), key);
      text = await page.textContent('body');
      expect(text).not.toContain(key);
    } finally {
      await page.context().close();
    }
  });

  it('Storage: upload and delete a file via the UI', async () => {
    const page = await newPage();

    try {
      await page.goto(`${BASE}/storage`);
      await waitForHydration(page);

      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.click('input[type="file"]');
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: 'e2e-test.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('hello world'),
      });

      await page.click('button:has-text("Upload")');

      await page.waitForFunction(() => document.body.textContent?.includes('e2e-test.txt'));
      const text = await page.textContent('body');
      expect(text).toContain('e2e-test.txt');

      const row = page.locator('tr', { hasText: 'e2e-test.txt' });
      await row.locator('button:has-text("Delete")').click();

      await page.waitForFunction(() => !document.body.textContent?.includes('e2e-test.txt'));
    } finally {
      await page.context().close();
    }
  });

  it('Env: displays bindings including DB and KV', async () => {
    const page = await newPage();

    try {
      await page.goto(`${BASE}/env`);
      await waitForHydration(page);

      const text = await page.textContent('body');
      expect(text).toContain('DB');
      expect(text).toContain('KV');
    } finally {
      await page.context().close();
    }
  });

  it('Queues: send message and see consumer result', async () => {
    const page = await newPage();
    const key = `e2e-q-${Date.now()}`;

    try {
      await page.goto(`${BASE}/queues`);
      await waitForHydration(page);

      await page.fill('input[placeholder="my-key"]', key);
      await page.fill('input[placeholder="my-value"]', 'queued');
      await page.click('button:has-text("Send to Queue")');

      // Poll for the result — the consumer writes to KV and the page
      // shows it under "Processed Results". Reload to pick up the result.
      const start = Date.now();
      let found = false;
      while (Date.now() - start < 15_000) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await page.goto(`${BASE}/queues`);
        await waitForHydration(page);
        const text = await page.textContent('body');
        if (text?.includes(key)) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it('Auth: register, login, protected route, logout via the UI', async () => {
    const page = await newPage();
    const email = `e2e-${Date.now()}@example.com`;
    const password = 's3cureP@ss!';

    try {
      await page.goto(`${BASE}/auth`);
      await waitForHydration(page);

      await page.waitForFunction(() => document.body.textContent?.includes('Not logged in'));

      const registerTab = page.locator('button', { hasText: 'Register' }).first();
      await registerTab.click();
      await page.waitForSelector('input[placeholder="Email"][type="email"]');

      const regSection = page.locator('section', {
        has: page.locator('h2:has-text("Email Register")'),
      });
      await regSection.locator('input[type="email"]').fill(email);
      await regSection.locator('input[type="password"]').fill(password);
      await regSection.locator('input[type="text"]').fill('E2E User');
      await regSection.locator('button[type="submit"]').click();

      await page.waitForFunction(() => !document.body.textContent?.includes('Not logged in'));
      const statusText = await page.textContent('body');
      expect(statusText).toContain(email);

      await page.click('button:has-text("GET /api/profile")');
      await page.waitForFunction(() =>
        document.querySelector('pre')?.textContent?.includes('"user"'),
      );
      const responseText = await page.textContent('pre');
      expect(responseText).toContain(email);

      await page.click('button:has-text("Logout")');
      await page.waitForFunction(() => document.body.textContent?.includes('Not logged in'));

      const loginTab = page.locator('button', { hasText: 'Login' }).first();
      await loginTab.click();

      const loginSection = page.locator('section', {
        has: page.locator('h2:has-text("Email Login")'),
      });
      await loginSection.locator('input[type="email"]').fill(email);
      await loginSection.locator('input[type="password"]').fill(password);
      await loginSection.locator('button[type="submit"]').click();

      await page.waitForFunction(() => !document.body.textContent?.includes('Not logged in'));
    } finally {
      await page.context().close();
    }
  });

  it('Reset: clears Better Auth users so the same email can register again', async () => {
    const page = await newPage();
    const email = `reset-${Date.now()}@example.com`;
    const password = 's3cureP@ss!';

    try {
      await page.goto(`${BASE}/auth`);
      await waitForHydration(page);
      await page.waitForFunction(() => document.body.textContent?.includes('Not logged in'));

      const registerTab = page.locator('button', { hasText: 'Register' }).first();
      await registerTab.click();
      await page.waitForSelector('input[placeholder="Email"][type="email"]');

      const regSection = page.locator('section', {
        has: page.locator('h2:has-text("Email Register")'),
      });
      await regSection.locator('input[type="email"]').fill(email);
      await regSection.locator('input[type="password"]').fill(password);
      await regSection.locator('input[type="text"]').fill('Reset User');
      await regSection.locator('button[type="submit"]').click();

      await page.waitForFunction(() => !document.body.textContent?.includes('Not logged in'));
      expect(await page.textContent('body')).toContain(email);

      const resetResult = await page.evaluate(async () => {
        const res = await fetch('/api/reset', { method: 'POST' });
        return {
          status: res.status,
          body: await res.json(),
        };
      });
      expect(resetResult.status).toBe(200);
      expect(resetResult.body).toEqual({ ok: true });

      await page.goto(`${BASE}/auth`);
      await waitForHydration(page);
      await page.waitForFunction(() => document.body.textContent?.includes('Not logged in'));

      await registerTab.click();
      await page.waitForSelector('input[placeholder="Email"][type="email"]');
      await regSection.locator('input[type="email"]').fill(email);
      await regSection.locator('input[type="password"]').fill(password);
      await regSection.locator('input[type="text"]').fill('Reset User');
      await regSection.locator('button[type="submit"]').click();

      await page.waitForFunction(() => !document.body.textContent?.includes('Not logged in'));
      expect(await page.textContent('body')).toContain(email);
    } finally {
      await page.context().close();
    }
  });

  it.each([
    '/missing.css',
    '/.env',
    '/laravel/.env',
    '/.well-known/traffic-advice',
    '/.git/HEAD',
    '/.htaccess',
    '/wp-login.php',
    '/xmlrpc.php',
    '/robots.txt',
    '/favicon.ico',
    '/api/nonexistent',
  ])('returns 404 for %s', async (path) => {
    const res = await fetch(`${BASE}${path}`);
    expect(res.status).toBe(404);
  });

  // Paths without a dot fall through to the notFound page.
  it('returns an HTML Not Found page for /wp-admin', async () => {
    const res = await fetch(`${BASE}/wp-admin`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Not Found');
  });

  it.each(['/phpmyadmin', '/foo/bar/baz', '/wp-content/plugins/exploit'])(
    'returns the Not Found page for %s',
    async (path) => {
      const res = await fetch(`${BASE}${path}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('Not Found');
    },
  );

  it('returns 404 for POST to unknown paths', async () => {
    const res = await fetch(`${BASE}/nonexistent`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('redirects trailing slash to non-trailing-slash path', async () => {
    const res = await fetch(`${BASE}/wp-content/`, { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toContain('/wp-content');
  });
});

// Preview runs without Cloudflare credentials: containers need a local Docker build and Workers AI
// is remote-only, so turn both off. kitchen-sink-build.test.ts covers them.
function preparePreviewWranglerConfig(pg: string): string {
  const wranglerPath = join(pg, 'dist', 'ssr', 'wrangler.json');
  const wranglerConfig = JSON.parse(readFileSync(wranglerPath, 'utf-8')) as {
    dev?: Record<string, unknown>;
    ai?: unknown;
    d1_databases?: Array<{ binding?: unknown; database_id?: unknown }>;
    vars?: Record<string, unknown>;
  };
  const databaseId = wranglerConfig.d1_databases?.find(
    (binding) => binding.binding === 'DB',
  )?.database_id;
  if (typeof databaseId !== 'string' || databaseId.length === 0) {
    throw new Error('Kitchen-sink preview build did not emit the DB binding database_id.');
  }
  wranglerConfig.dev = {
    ...(wranglerConfig.dev ?? {}),
    enable_containers: false,
  };
  // Preview executes the production build, which requires an auth secret.
  wranglerConfig.vars = {
    ...(wranglerConfig.vars ?? {}),
    BETTER_AUTH_SECRET: 'void-preview-test-secret-1234567890',
  };
  delete wranglerConfig.ai;
  writeFileSync(wranglerPath, `${JSON.stringify(wranglerConfig, null, 2)}\n`);
  const nativePath = getWorkerConfigPath(pg);
  const native = JSON.parse(readFileSync(nativePath, 'utf8'));
  native.env.BETTER_AUTH_SECRET = { type: 'text', value: 'void-preview-test-secret-1234567890' };
  delete native.env.AI;
  writeFileSync(nativePath, `${JSON.stringify(native, null, 2)}\n`);
  return databaseId;
}
