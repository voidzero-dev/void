import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { killChild, startServer } from '../../../../test/integration-helpers.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

let browser: Browser;
let base: string;

async function newPage(): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  return page;
}

async function waitForHydration(page: Page) {
  await page.waitForSelector('#app[data-hydrated="true"]');
}

async function waitForBodyText(page: Page, text: string) {
  await page.waitForFunction((expected) => document.body.textContent?.includes(expected), text);
}

async function goto(page: Page, url: string) {
  const attempts = process.platform === 'win32' ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(url);
      return;
    } catch (error) {
      const isTransientWindowsSocketExhaustion =
        error instanceof Error && error.message.includes('net::ERR_NO_BUFFER_SPACE');
      if (!isTransientWindowsSocketExhaustion || attempt === attempts) {
        throw error;
      }
      // Windows can keep recently closed browser sockets in rundown long enough for Chromium's
      // next navigation to fail before it reaches the dev server. Retry only that OS error.
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
}

function collectUnexpectedBrowserErrors(page: Page) {
  const errors: Array<string> = [];

  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') {
      return;
    }

    const text = message.text();
    if (text.includes('favicon.ico')) {
      return;
    }

    errors.push(text);
  });

  page.on('pageerror', (error) => {
    errors.push(error.message);
  });

  return errors;
}

describe('playground/websockets', () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    const playground = join(ROOT, 'playground/websockets');
    rmSync(join(playground, 'dist'), { recursive: true, force: true });
    const build = spawn.sync('vp', ['run', '--filter', './playground/websockets', 'build'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, VOID_INSPECTOR_PORT: 'false' },
    });
    expect(build.status).toBe(0);

    browser = await chromium.launch();

    const server = await startServer((port) => {
      child = spawn(
        'vp',
        [
          'run',
          '--filter',
          './playground/websockets',
          'dev',
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
            VITE_VOID_NOTIFICATION_STREAM_DELAY_MS: '10',
            VOID_INSPECTOR_PORT: 'false',
          },
        },
      );
      return child;
    }, 20_000);
    base = server.base;
  });

  it('builds WebSocket routes as SQLite-backed Durable Objects', () => {
    const config = JSON.parse(
      readFileSync(join(ROOT, 'playground/websockets/dist/ssr/wrangler.json'), 'utf8'),
    );
    expect(config.durable_objects.bindings).toEqual(
      expect.arrayContaining([
        { name: 'WsChatRoomWs', class_name: 'WsChatRoomWs' },
        { name: 'WsNotificationsWs', class_name: 'WsNotificationsWs' },
      ]),
    );
    expect(config.migrations).toContainEqual({
      tag: 'void-ws-v1',
      new_sqlite_classes: ['WsChatRoomWs', 'WsNotificationsWs'],
    });
    expect(
      config.migrations.some((migration: Record<string, unknown>) => 'new_classes' in migration),
    ).toBe(false);
  });

  afterAll(async () => {
    if (child) {
      await killChild(child);
    }
    await browser?.close();
  });

  it('chat reconnects to a fresh room and sends a typed message', async () => {
    const page = await newPage();
    const errors = collectUnexpectedBrowserErrors(page);
    const room = `e2e-room-${Date.now().toString(36)}`;
    const name = 'e2e-user';
    const message = `hello-${room}`;

    try {
      await goto(page, `${base}/chat`);
      await waitForHydration(page);
      await waitForBodyText(page, 'Connected to room "general"');

      await page.getByLabel('Room:').fill(room);
      await page.getByLabel('Display name:').fill(name);
      await page.getByRole('button', { name: 'Reconnect' }).click();

      await page.waitForFunction(
        ([expectedRoom, expectedName]) => {
          const text = document.body.textContent || '';
          return (
            text.includes(`room: ${expectedRoom}`) &&
            text.includes(`name: ${expectedName}`) &&
            text.includes(`Connected to room "${expectedRoom}"`) &&
            text.includes(`${expectedName} joined ${expectedRoom}`)
          );
        },
        [room, name],
      );

      await page.getByLabel('Message:').fill(message);
      await page.getByRole('button', { name: 'Send' }).click();
      await waitForBodyText(page, message);

      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  it('notifications stream typed items and acknowledge one', async () => {
    const page = await newPage();
    const errors = collectUnexpectedBrowserErrors(page);

    try {
      await goto(page, `${base}/notifications`);
      await waitForHydration(page);
      await page.waitForFunction(() => {
        const text = document.body.textContent || '';
        return text.includes('status: open') && text.includes('stream idle');
      });

      await page.getByLabel('Items per stream:').selectOption('3');
      await page.getByRole('button', { name: 'Start stream' }).click();

      await page.waitForFunction(() => {
        const text = document.body.textContent || '';
        return (
          text.includes('stream active, 3 notifications remaining') &&
          text.includes('Notification 1')
        );
      });

      await page.waitForFunction(() => {
        const text = document.body.textContent || '';
        return (
          text.includes('stream finished after 3 items') &&
          text.includes('Notification 1') &&
          text.includes('Notification 2') &&
          text.includes('Notification 3')
        );
      });

      const latestItem = page.locator('li', { hasText: 'Notification 3' }).first();
      await latestItem.getByRole('button', { name: 'Acknowledge' }).click();

      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('li')).some(
          (item) =>
            item.textContent?.includes('Notification 3') && item.textContent?.includes('Acked'),
        ),
      );
      await page.waitForFunction(() => document.body.textContent?.includes('acknowledged '));

      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  });
});
