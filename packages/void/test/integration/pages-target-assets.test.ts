import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  killChild,
  startServer,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { renderVoidConfig } from '../../src/config-write.ts';
import { readConfig } from '../../src/config.ts';

const repository = join(import.meta.dirname, '..', '..', '..', '..');
const targets = [
  { target: 'node', command: process.execPath, args: [] },
  { target: 'bun', command: process.env.VOID_TEST_BUN_BIN ?? 'bun', args: [] },
  { target: 'deno', command: process.env.VOID_TEST_DENO_BIN ?? 'deno', args: ['run', '-A'] },
];

for (const { target, command, args } of targets) {
  // Node is the runtime executing this suite: its coverage is required, even if
  // an availability subprocess would time out. Only Bun and Deno are optional.
  let available =
    target === 'node' ||
    spawn.sync(command, ['--version'], { timeout: 10_000, killSignal: 'SIGKILL' }).status === 0;
  if (target === 'deno' && available) {
    // Deno resolves the user's npm configuration before evaluating even a
    // no-import script. Check that optional runtime without altering registries;
    // failures in the built app still fail normally after this probe succeeds.
    const probe = spawn.sync(
      command,
      ['eval', '--no-config', '--no-npm', '--no-remote', 'void 0;'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    if (probe.status !== 0) {
      if (probe.stderr?.includes('Failed to resolve .npmrc options')) {
        available = false;
        console.warn(
          'Skipping optional Deno Pages tests: the installed runtime cannot resolve user .npmrc configuration in a no-import preflight. No registry settings were changed.',
        );
      } else {
        throw new Error(`Deno no-import preflight failed (exit ${probe.status ?? 'unknown'}).`);
      }
    }
  }
  describe.skipIf(!available)(`${target} production Pages assets`, () => {
    let root: string;
    let playground: IsolatedPlayground;
    let base: string;
    let child: ReturnType<typeof spawn>;

    beforeAll(async () => {
      // Keep the copy on the same drive as the installed dependency links.
      playground = createIsolatedPlayground(repository, 'playground/node-app');
      root = playground.root;
      const config = readConfig(root);
      writeFileSync(
        join(root, 'void.config.ts'),
        renderVoidConfig({ ...config, target: target as 'node' | 'bun' | 'deno' }),
      );
      writeFileSync(
        join(root, 'pages/index.tsx'),
        `
import { useState } from 'react';
import './index.css';
export default function Home() {
  const [count, setCount] = useState(0);
  return <button className="counter" onClick={() => setCount(count + 1)}>Count {count}</button>;
}
`,
      );
      writeFileSync(join(root, 'pages/index.css'), '.counter { color: rgb(12, 34, 56); }');
      mkdirSync(join(root, 'public'));
      writeFileSync(join(root, 'public/health.txt'), 'public asset');
      execFileSync('vp', ['build'], { cwd: root, stdio: 'pipe' });
      const server = await startServer((port) => {
        child = spawn(command, [...args, 'dist/ssr/index.js'], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PORT: String(port) },
        });
        return child;
      }, 20_000);
      base = server.base;
    });

    afterAll(async () => {
      if (child) {
        await killChild(child);
      }
      playground?.cleanup();
    });

    it('loads the real manifest and serves every referenced script and stylesheet from app-root startup', async () => {
      const response = await fetch(base);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain('/@vite/');
      const scripts = Array.from(html.matchAll(/<script[^>]*src="([^"]+)"/g), (match) => match[1]);
      const styles = Array.from(
        html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g),
        (match) => match[1],
      );
      expect(scripts.length).toBeGreaterThan(0);
      expect(styles.length).toBeGreaterThan(0);
      for (const [urls, mime] of [
        [scripts, /javascript/],
        [styles, /text\/css/],
      ] as const) {
        for (const url of urls) {
          const asset = await fetch(new URL(url, base));
          expect(asset.status, url).toBe(200);
          expect(asset.headers.get('content-type'), url).toMatch(mime);
          expect((await asset.text()).length).toBeGreaterThan(0);
        }
      }
      const head = await fetch(new URL(scripts[0], base), { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      expect(await (await fetch(`${base}/health.txt`)).text()).toBe('public asset');
      expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
      expect((await fetch(`${base}/assets/..%2f..%2fssr/app.js`)).status).toBe(404);
      expect((await fetch(`${base}/assets/missing.js`, { method: 'POST' })).status).toBe(404);
      expect((await fetch(`${base}/api/hello`)).status).toBe(200);
    });

    it('resolves assets from the emitted module when the working directory changes', async () => {
      const elsewhere = join(root, 'another-working-directory');
      mkdirSync(elsewhere);
      const relocated = await startServer(
        (port) =>
          spawn(command, [...args, join(root, 'dist/ssr/index.js')], {
            cwd: elsewhere,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PORT: String(port) },
          }),
        20_000,
      );
      const relocatedBase = relocated.base;
      try {
        const html = await (await fetch(relocatedBase)).text();
        const script = html.match(/<script[^>]*src="([^"]+)"/);
        expect(script).not.toBeNull();
        expect((await fetch(new URL(script![1], relocatedBase))).status).toBe(200);
        expect(await (await fetch(`${relocatedBase}/health.txt`)).text()).toBe('public asset');
      } finally {
        await killChild(relocated.child);
      }
    });

    it('hydrates an interactive page and applies its emitted CSS in a real browser', async () => {
      const browser = await chromium.launch();
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      try {
        await page.goto(base);
        await page.waitForSelector('#app[data-hydrated="true"]');
        await page.getByRole('button', { name: 'Count 0' }).click();
        await page.getByRole('button', { name: 'Count 1' }).waitFor();
        expect(
          await page.locator('.counter').evaluate((element) => getComputedStyle(element).color),
        ).toBe('rgb(12, 34, 56)');
      } finally {
        await browser.close();
      }
    });
  });
}
