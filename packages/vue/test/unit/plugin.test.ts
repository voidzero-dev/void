import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { packageFixturePath } from '../../../../test/fixture-dir.ts';
import { voidVue } from '../../src/plugin.ts';

const TMP = packageFixturePath(import.meta.dirname, '__tmp_vue_plugin__');

type LoadHook = (id: string) => Promise<string | undefined> | string | undefined;

function getLoad(plugin: Plugin): LoadHook {
  const hook = plugin.load as LoadHook | { handler: LoadHook } | undefined;
  if (typeof hook === 'function') {
    return hook;
  }
  if (hook && 'handler' in hook) {
    return hook.handler;
  }
  throw new Error('Expected load hook.');
}

describe('voidVue prefetch option', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('passes prefetch settings into the generated client entry', async () => {
    mkdirSync(join(TMP, 'pages'), { recursive: true });
    writeFileSync(join(TMP, 'pages', 'index.vue'), '<template><h1>Home</h1></template>\n');
    vi.spyOn(process, 'cwd').mockReturnValue(TMP);

    const plugin = voidVue({ prefetch: { hoverDelay: 10, cacheFor: '1m' } }).find(
      (p) => p.name === 'void-vue:pages',
    );
    if (!plugin) {
      throw new Error('Expected void-vue:pages plugin.');
    }
    const client = await getLoad(plugin).call({} as never, '\0virtual:void-pages-client');

    expect(client).toContain('prefetchHoverDelay: 10,');
    expect(client).toContain('prefetchDefaultCacheFor: parseCacheFor("1m"),');
  });
});
