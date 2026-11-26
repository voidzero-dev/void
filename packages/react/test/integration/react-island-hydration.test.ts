import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from '../../../../test/browser-helpers.ts';
import { createPackageFixtureDir } from '../../../../test/integration-helpers.ts';
import { islandsPlugin } from '../../src/plugin-islands.ts';

declare global {
  interface Window {
    __releaseHydration: () => void;
  }
}

it('marks a React island hydrated only after its first commit', async () => {
  const root = createPackageFixtureDir(join(import.meta.dirname, '../..'), '__tmp_hydration_');
  const pages = join(root, 'pages');
  mkdirSync(pages);
  writeFileSync(
    join(pages, 'index.island.tsx'),
    'import Counter from "./Counter" with { island: "load" }; export default function Page() { return <Counter />; }',
  );
  writeFileSync(
    join(pages, 'Counter.tsx'),
    `import { createElement, useState } from 'react';
let ready = false;
const pending = new Promise((resolve) => {
  window.__releaseHydration = () => { ready = true; resolve(); };
});
export default function Counter() {
  window.__hydrationAttempted = true;
  if (!ready) throw pending;
  const [count, setCount] = useState(0);
  return createElement('button', { onClick: () => setCount(count + 1) }, 'Count: ' + count);
}`,
  );
  writeFileSync(
    join(root, 'index.html'),
    '<div data-island="pages/Counter" data-props="{}" data-hydrate="load"><button>Count: 0</button></div><script type="module" src="/entry.js"></script>',
  );
  writeFileSync(join(root, 'entry.js'), 'import "virtual:void-islands-client";');

  const browser = await chromium.launch();
  const server = await createServer({
    root,
    configFile: false,
    // Default cacheDir is packages/react/node_modules/.vite, which the
    // navigation-fallback suite also uses with a different config.
    cacheDir: join(root, '.vite'),
    logLevel: 'silent',
    plugins: [...islandsPlugin(pages)],
    server: { port: 0, host: '127.0.0.1' },
  });
  try {
    await server.listen();
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls!.local[0]);
    await page.waitForFunction(() => '__hydrationAttempted' in window);
    // The component is still suspended: scheduling hydrateRoot is not readiness.
    expect(await page.getAttribute('[data-island]', 'data-hydrated')).toBeNull();
    await page.evaluate(() => {
      window.__releaseHydration();
    });
    await waitForIslandsHydrated(page);
    await page.click('button');
    await expect.poll(() => page.textContent('button')).toBe('Count: 1');
  } finally {
    await server.close();
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
});
