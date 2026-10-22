/**
 * Kitchen Sink Playwright Smoke Test
 *
 * Standalone smoke tests against a deployed kitchen-sink app.
 * Uses node:test + node:assert — no vitest needed.
 *
 * Usage:
 *   SMOKE_URL=https://kitchen-sink.apps.example.com node platform/scripts/kitchen-sink-smoke-test.ts
 *
 * The target must be a disposable kitchen-sink deployment: this suite resets
 * its database, KV, and storage before exercising mutations.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it, before, after } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  resetKitchenSink,
  waitForChangedRender,
  waitForFreshHeartbeat,
  waitForIsrCacheHit,
  waitForRenderedText,
} from './kitchen-sink-observations.ts';

if (!process.env.SMOKE_URL) {
  throw new Error(
    'Set SMOKE_URL to a disposable kitchen-sink deployment. This suite resets its data.',
  );
}
const target = new URL(process.env.SMOKE_URL);
if (
  !['http:', 'https:'].includes(target.protocol) ||
  target.username ||
  target.password ||
  target.search ||
  target.hash ||
  target.pathname !== '/'
) {
  throw new Error(
    'SMOKE_URL must be an HTTP(S) origin without credentials, a path, query, or fragment.',
  );
}
const BASE = target.origin;
const TIMEOUT = 15_000;
const uid = Date.now().toString(36);
const testSandbox = process.env.SMOKE_SANDBOX === '1';
const acceptanceToken = process.env.SMOKE_E2E_TOKEN;
const testRuntime = process.env.SMOKE_RUNTIME === '1';

// Supply a Cloudflare Access service-token pair if the selected test app is
// protected by Access. These credentials belong to the explicit SMOKE_URL target.
const CF_ACCESS: Record<string, string> =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? {
        'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID,
        'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET,
      }
    : {};

type MarkerWindow = Window & { __SPA_MARKER?: boolean };
type StampedNav = HTMLElement & { __stamp?: number };

let browser: Browser;
let resetCompletedAt = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForHydration(page: Page) {
  await page.waitForSelector('#app[data-hydrated="true"]', { timeout: TIMEOUT });
}

async function goto(page: Page, path: string) {
  const response = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  return response;
}

function readTimestamp(page: Page, label: string): Promise<string | null> {
  return page.evaluate((field) => {
    const heading = Array.from(document.querySelectorAll('h2')).find(
      (element) => element.textContent === field,
    );
    const paragraph =
      heading?.nextElementSibling ??
      Array.from(document.querySelectorAll('p')).find((element) =>
        element.textContent?.trim().startsWith(field),
      );
    return paragraph?.querySelector('code')?.textContent || null;
  }, label);
}

/** Wait for rendered app text to include `text`, polling with page reloads. */
async function pollForText(page: Page, path: string, text: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await goto(page, path);
    const body = await page.locator('#app').innerText();
    if (body?.includes(text)) {
      return;
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for "${text}" on ${path}`);
}

/** Wait for rendered app text to stop including `text`, without reloading. */
async function waitForTextGone(page: Page, text: string, timeoutMs = TIMEOUT) {
  await waitForRenderedText(page, text, false, timeoutMs);
}

/** Wait for rendered app text to include `text`, without reloading. */
async function waitForText(page: Page, text: string, timeoutMs = TIMEOUT) {
  await waitForRenderedText(page, text, true, timeoutMs);
}

/** Click the Delete button in the table row containing `needle`. */
async function deleteRowContaining(page: Page, needle: string) {
  await page.evaluate((needleText) => {
    const row = Array.from(document.querySelectorAll('tr')).find((row) =>
      row.textContent?.includes(needleText),
    );
    if (!row) {
      throw new Error(`Row containing "${needleText}" not found`);
    }
    const button = row.querySelector('button');
    if (!button) {
      throw new Error(`No button in row containing "${needleText}"`);
    }
    button.click();
  }, needle);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

void describe(`kitchen-sink smoke (${BASE})`, { concurrency: true }, () => {
  before(async () => {
    resetCompletedAt = await resetKitchenSink(BASE, CF_ACCESS);
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
  });

  /** Create an isolated browser context + page. Caller must close ctx when done. */
  async function freshPage(): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({ extraHTTPHeaders: CF_ACCESS });
    const page = await ctx.newPage();
    return { ctx, page };
  }

  void it('1 — home SSR + asset caching', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/');

      const body = await page.textContent('body');
      assert.ok(body?.includes('Kitchen Sink'), "page contains 'Kitchen Sink'");
      assert.ok(body?.includes('Auth'), "page contains 'Auth'");

      // Find a hashed asset URL in the HTML source (hashes are base64url-like, e.g. DOjtQvIZ)
      const html = await page.content();
      const assetMatch = html.match(/\/(assets\/[^"']+[-._][A-Za-z0-9_-]{6,}\.(js|css))/);
      assert.ok(assetMatch, 'found hashed asset URL in HTML');

      const assetUrl = `${BASE}/${assetMatch![1]}?smoke=${uid}`;

      // A unique URL forces a fresh network GET without sending cache-bypass
      // directives to the origin. Omit application/Access session cookies too.
      // Cookie-bearing requests deliberately bypass the shared asset cache.
      // The browser context still supplies Access service-token headers when
      // configured; those protected requests exercise the private cache policy.
      const asset = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'omit' });
        return {
          status: res.status,
          cacheControl: res.headers.get('cache-control') || '',
          contentType: res.headers.get('content-type'),
          cfCacheStatus: res.headers.get('cf-cache-status'),
        };
      }, assetUrl);

      assert.equal(asset.status, 200, `asset GET succeeds (got ${asset.status})`);
      const accessProtected = Object.keys(CF_ACCESS).length > 0;
      const expectedDirective = accessProtected ? 'private' : 'immutable';
      const directives = asset.cacheControl
        .toLowerCase()
        .split(',')
        .map((part) => part.trim());
      assert.ok(
        directives.includes(expectedDirective),
        `Cache-Control includes ${expectedDirective} for ${assetUrl} (got: ${JSON.stringify(asset)})`,
      );
      assert.ok(
        directives.includes('immutable') &&
          !directives.some((directive) =>
            ['no-store', 'no-cache', accessProtected ? 'public' : 'private'].includes(directive),
          ),
        `Cache-Control has no contradictory directives (got: ${asset.cacheControl})`,
      );
    } finally {
      await ctx.close();
    }
  });

  void it('2 — SPA navigation', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/');

      // Set a marker on window — survives SPA nav, lost on full reload
      await page.evaluate(() => {
        (window as MarkerWindow).__SPA_MARKER = true;
      });

      await page.click('a[href="/db"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('DB'), {
        timeout: TIMEOUT,
      });
      assert.ok(page.url().endsWith('/db'), `URL is /db (got: ${page.url()})`);

      // Marker must still be present (no full reload)
      const marker = await page.evaluate(() => (window as MarkerWindow).__SPA_MARKER);
      assert.strictEqual(marker, true, 'SPA marker survived navigation');

      await page.click('a[href="/kv"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('KV'), {
        timeout: TIMEOUT,
      });
      assert.ok(page.url().endsWith('/kv'), `URL is /kv (got: ${page.url()})`);
    } finally {
      await ctx.close();
    }
  });

  void it('3 — layout persistence', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/');

      await page.evaluate(() => {
        const nav = document.querySelector('nav') as StampedNav | null;
        if (nav) {
          nav.__stamp = 1;
        }
      });

      await page.click('a[href="/env"]');
      await page.waitForFunction(() => document.querySelector('h1')?.textContent?.includes('Env'), {
        timeout: TIMEOUT,
      });

      // Nav stamp must survive (layout DOM not recreated)
      const stamp = await page.evaluate(() => {
        const nav = document.querySelector('nav') as StampedNav | null;
        return nav?.__stamp;
      });
      assert.strictEqual(stamp, 1, 'nav stamp survived navigation');
    } finally {
      await ctx.close();
    }
  });

  void it('4 — DB CRUD', async () => {
    const { ctx, page } = await freshPage();
    try {
      const title = `smoke-${uid}`;

      await goto(page, '/db');

      await page.fill('input[placeholder="Note title"]', title);
      await page.fill('input[placeholder="Note body"]', 'test body');
      await page.click('button:has-text("Add Note")');

      await waitForText(page, title);
      const body = await page.textContent('body');
      assert.ok(body?.includes('test body'), 'page contains note body');

      try {
        await deleteRowContaining(page, title);
        await waitForTextGone(page, title);
      } catch {
        // Cleanup on best-effort basis
      }
    } finally {
      await ctx.close();
    }
  });

  void it('5 — KV set/lookup/delete', async () => {
    const { ctx, page } = await freshPage();
    try {
      const key = `smoke-kv-${uid}`;

      await goto(page, '/kv');

      // Set key — wait for the POST response before navigating away,
      // otherwise the navigation cancels the in-flight form submission
      await page.fill('input[placeholder="my-key"]', key);
      await page.fill('input[placeholder="my-value"]', 'hello');
      await Promise.all([
        page.waitForResponse(
          (response) => response.url().includes('/kv') && response.request().method() === 'POST',
        ),
        page.click('button:has-text("Set")'),
      ]);

      // Lookup the key we just set (kv.get is strongly consistent)
      await goto(page, `/kv?lookup=${encodeURIComponent(key)}`);
      const body = await page.textContent('body');
      assert.ok(body?.includes('hello'), 'lookup shows value');

      // Cleanup: delete via JSON POST (same as useForm.post())
      await page.evaluate(
        (keyToDelete) =>
          fetch('/kv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ intent: 'delete', key: keyToDelete }),
          }),
        key,
      );
    } finally {
      await ctx.close();
    }
  });

  void it('6 — Storage upload/delete', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/storage');

      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.click('input[type="file"]'),
      ]);
      await fileChooser.setFiles({
        name: 'smoke-test.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('hello world'),
      });

      await page.click('button:has-text("Upload")');
      await waitForText(page, 'smoke-test.txt');

      try {
        await deleteRowContaining(page, 'smoke-test.txt');
        await waitForTextGone(page, 'smoke-test.txt');
      } catch {
        // Cleanup on best-effort basis
      }
    } finally {
      await ctx.close();
    }
  });

  void it('7 — Env bindings', async () => {
    const { ctx, page } = await freshPage();
    try {
      await goto(page, '/env');

      const body = await page.textContent('body');
      assert.ok(body?.includes('DB'), 'page lists DB binding');
      assert.ok(body?.includes('KV'), 'page lists KV binding');
    } finally {
      await ctx.close();
    }
  });

  void it('8 — Queues', async () => {
    const { ctx, page } = await freshPage();
    try {
      const key = `smoke-q-${uid}`;

      await goto(page, '/queues');

      // Send message — wait for the POST response to confirm the queue write completed
      await page.fill('input[placeholder="my-key"]', key);
      await page.fill('input[placeholder="my-value"]', 'queued');
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes('/queues') && response.request().method() === 'POST',
        ),
        page.click('button:has-text("Send to Queue")'),
      ]);

      // Submission alone does not establish end-to-end queue delivery.
      await pollForText(page, '/queues', key, 60_000).catch(() => {
        throw new Error(
          'Queue consumer did not process the submitted message within 60s; check queue registration and dispatch logs, then the fixture D1 queue_results table.',
        );
      });
      await deleteRowContaining(page, key);
      await waitForTextGone(page, key);
    } finally {
      await ctx.close();
    }
  });

  void it('9 — Auth flow', async () => {
    const { ctx, page } = await freshPage();
    try {
      const email = `smoke-${uid}@example.com`;
      const password = 's3cureP@ss!';

      await goto(page, '/auth');

      const body = await page.textContent('body');
      assert.ok(body?.includes('Not logged in'), "shows 'Not logged in'");

      await page.click('button:has-text("Register")');
      await page.waitForSelector('input[placeholder="Name"]', { timeout: TIMEOUT });

      await page.fill('input[placeholder="Email"]', email);
      await page.fill('input[placeholder="Password"]', password);
      await page.fill('input[placeholder="Name"]', 'Smoke User');
      await page.click('section:has(h2:has-text("Email Register")) button[type="submit"]');

      await waitForTextGone(page, 'Not logged in');
      const afterReg = await page.textContent('body');
      assert.ok(afterReg?.includes(email), 'shows email after registration');

      await page.click('button:has-text("GET /api/profile")');
      await page.waitForFunction(
        () => document.querySelector('pre')?.textContent?.includes('user'),
        {
          timeout: TIMEOUT,
        },
      );
      const pre = await page.textContent('pre');
      assert.ok(pre?.includes('user'), "profile response contains 'user'");
      assert.ok(pre?.includes(email), 'profile response contains email');

      await page.click('button:has-text("Logout")');
      await waitForText(page, 'Not logged in');

      await page.click('button:has-text("Login")');
      await page.waitForSelector(
        'section:has(h2:has-text("Email Login")) input[placeholder="Email"]',
        {
          timeout: TIMEOUT,
        },
      );
      await page.fill('input[placeholder="Email"]', email);
      await page.fill('input[placeholder="Password"]', password);
      await page.click('section:has(h2:has-text("Email Login")) button[type="submit"]');

      await waitForTextGone(page, 'Not logged in');
      const afterLogin = await page.textContent('body');
      assert.ok(afterLogin?.includes(email), 'shows email after re-login');
    } finally {
      await ctx.close();
    }
  });

  void it('10 — Cron heartbeat', async () => {
    const { ctx, page } = await freshPage();
    try {
      await waitForFreshHeartbeat(
        async () => {
          await goto(page, '/cron');
          return readTimestamp(page, 'Last Heartbeat');
        },
        { timeoutMs: 150_000, notBefore: resetCompletedAt },
      );
    } finally {
      await ctx.close();
    }
  });

  void it('11 — ISR revalidation', async () => {
    const { ctx, page } = await freshPage();
    try {
      if (Object.keys(CF_ACCESS).length === 0) {
        await waitForIsrCacheHit(
          async () => {
            const response = await goto(page, '/revalidate');
            return response?.headers()['x-isr-cache'] ?? null;
          },
          { timeoutMs: 15_000, intervalMs: 500 },
        );
      } else {
        await goto(page, '/revalidate');
      }
      const renderedAt = await readTimestamp(page, 'Rendered at:');
      assert.ok(
        renderedAt && Number.isFinite(Date.parse(renderedAt)),
        'initial rendered timestamp is valid',
      );

      const completed = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/revalidate' &&
          response.request().method() === 'POST',
        { timeout: TIMEOUT },
      );
      await page.click('button:has-text("Revalidate /revalidate")');
      const actionResponse = await completed;
      assert.ok(
        actionResponse.ok(),
        `Revalidation action failed (HTTP ${actionResponse.status()}); inspect the app and provider purge logs.`,
      );

      await page.waitForFunction(
        () => {
          const button = Array.from(document.querySelectorAll('button')).find((candidateButton) =>
            candidateButton.textContent?.includes('Revalidate /revalidate'),
          );
          return button && !button.disabled;
        },
        { timeout: TIMEOUT },
      );

      await waitForChangedRender(
        async () => {
          await goto(page, '/revalidate');
          return readTimestamp(page, 'Rendered at:');
        },
        renderedAt,
        { timeoutMs: 15_000, intervalMs: 500 },
      );
    } finally {
      await ctx.close();
    }
  });

  void describe('Sandbox', { concurrency: false, skip: !testSandbox }, () => {
    void it('12 — Sandbox files, command execution, and output', async () => {
      const { ctx, page } = await freshPage();
      try {
        await goto(page, '/sandbox');
        await page.fill(
          'textarea',
          `export default function(requests) { console.error('sandbox-smoke-${uid}'); return { marker: '${uid}', count: requests.length }; }`,
        );
        const completed = page.waitForResponse(
          (response) =>
            response.url() === `${BASE}/api/sandbox` && response.request().method() === 'POST',
          { timeout: 90_000 },
        );
        await page.click('button:has-text("Run in Sandbox")');
        const response = await completed;
        assert.equal(response.status(), 200, `Sandbox request succeeds (got ${response.status()})`);
        const body = await response.json();
        assert.equal(body.ok, true, JSON.stringify(body));
        assert.equal(body.exitCode, 0);
        assert.equal(body.output.value.marker, uid);
        assert.ok(body.output.value.count > 0, 'Sandbox reads the input file');
        assert.ok(body.stdout.includes(uid), 'Sandbox stdout includes its written result');
        assert.ok(body.stderr.includes(`sandbox-smoke-${uid}`), 'Sandbox stderr is returned');
        await waitForText(page, uid);
      } finally {
        await ctx.close();
      }
    });

    void it('13 — Sandbox runtime acceptance', { skip: !acceptanceToken }, async () => {
      const response = await fetch(`${BASE}/api/acceptance/sandbox`, {
        method: 'POST',
        headers: { ...CF_ACCESS, 'x-void-e2e-token': acceptanceToken! },
        signal: AbortSignal.timeout(180_000),
      });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.ok(
        body &&
          typeof body === 'object' &&
          'ok' in body &&
          'checks' in body &&
          Array.isArray(body.checks),
        'Sandbox runtime response must contain an ok flag and checks array',
      );
      assert.equal(body.ok, true, JSON.stringify(body));
      assert.equal(body.checks.length, 12, 'All Sandbox runtime acceptance checks completed');
    });
  });

  void it('14 — WebSocket message round trip', { skip: !testRuntime }, async () => {
    assert.ok(acceptanceToken, 'Runtime acceptance requires the configured app secret');
    const { ctx, page } = await freshPage();
    try {
      await ctx.setExtraHTTPHeaders({ ...CF_ACCESS, 'x-void-e2e-token': acceptanceToken });
      await goto(page, '/');
      const marker = `void-e2e-${randomBytes(8).toString('hex')}`;
      const echoed = await page.evaluate(
        ({ origin, marker }) =>
          new Promise<unknown>((resolve, reject) => {
            const url = new URL('/ws/acceptance', origin);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = new WebSocket(url);
            const timer = setTimeout(() => {
              socket.close();
              reject(new Error('WebSocket echo timed out'));
            }, 30_000);
            socket.addEventListener('open', () => socket.send(JSON.stringify({ marker })));
            socket.addEventListener(
              'message',
              (event) => {
                clearTimeout(timer);
                socket.close();
                try {
                  resolve(JSON.parse(String(event.data)));
                } catch {
                  reject(new Error('WebSocket echo was not JSON'));
                }
              },
              { once: true },
            );
            socket.addEventListener(
              'error',
              () => {
                clearTimeout(timer);
                socket.close();
                reject(new Error('WebSocket connection failed'));
              },
              { once: true },
            );
          }),
        { origin: BASE, marker },
      );
      assert.deepEqual(echoed, { kind: 'echo', marker });
    } finally {
      await ctx.close();
    }
  });
});
