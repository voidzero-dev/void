import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { preview, type PreviewServer } from 'vite';
import { expect, it } from 'vite-plus/test';
import { waitForIslandsHydrated } from '../../../../test/browser-helpers.ts';
import { buildIslandApp } from '../../../../test/island-css-build.ts';

it('runs client scripts in a production build with no .island. file in pages/', async () => {
  const build = buildIslandApp({
    packageDir: join(import.meta.dirname, '../../../react'),
    pluginName: 'voidReact',
    files: {
      'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }),
      'components/Counter.island.tsx': `import { useState } from 'react';
export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}`,
      'pages/script.md': `<script>
document.querySelector('#out').textContent = 'set-by-script';
</script>

# Script

<span id="out">unset</span>
`,
      'pages/mixed.md': `<script>
import Counter from '../components/Counter.island.tsx' with { island: 'load' };
document.querySelector('#out').textContent = 'set-by-script';
</script>

# Mixed

<span id="out">unset</span>

<Counter />
`,
    },
  });
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    const manifest = JSON.parse(
      readFileSync(join(build.root, 'dist/client/.vite/manifest.json'), 'utf8'),
    );
    expect(manifest).toHaveProperty(['virtual:void-md-client']);
    // A page without client code still ships no JavaScript.
    expect(build.page('about.html').html).not.toContain('<script');

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

    await page.goto(new URL('script', base).href);
    await expect.poll(() => page.textContent('#out'), { timeout: 15_000 }).toBe('set-by-script');

    await page.goto(new URL('mixed', base).href);
    await expect.poll(() => page.textContent('#out'), { timeout: 15_000 }).toBe('set-by-script');
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
