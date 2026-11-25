import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UserConfig } from 'vite';
import { expect, it } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { definePagesPluginTests } from '../../../../test/pages-plugin-contract.ts';
import { pagesPlugin } from '../../src/plugin-pages.ts';

definePagesPluginTests(
  pagesPlugin,
  packageFixturePath(import.meta.dirname, '__tmp_pages_plugin__'),
);

it('names the Solid entries for the client and the Worker in dev', async () => {
  const pagesDir = packageFixturePath(import.meta.dirname, '__tmp_pages_dev_config__');
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(join(pagesDir, 'index.tsx'), 'export default () => <h1>Home</h1>;');
  try {
    type ConfigHook = (config: UserConfig, env: { command: 'serve' }) => Promise<UserConfig | void>;
    const hook = (pagesPlugin(pagesDir) as { config?: unknown }).config as
      | ConfigHook
      | { handler: ConfigHook };
    const config = await (typeof hook === 'function' ? hook : hook.handler)(
      {},
      { command: 'serve' },
    );
    const entries = ['solid-js', 'solid-js/web', 'solid-js/store'];

    expect(config).toMatchObject({
      optimizeDeps: { include: entries },
      environments: { void_worker: { optimizeDeps: { include: entries } } },
    });
  } finally {
    rmSync(pagesDir, { recursive: true, force: true });
  }
});
