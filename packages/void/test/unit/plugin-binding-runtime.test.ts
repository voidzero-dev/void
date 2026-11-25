import { describe, expect, it } from 'vite-plus/test';
import { bindingRuntimePlugin } from '../../src/plugin-binding-runtime.ts';
import { getHookHandler, loadVirtualModule } from '../helpers/vite-hooks.ts';

describe('bindingRuntimePlugin', () => {
  it('uses custom binding names in KV and R2 runtime helpers', () => {
    const plugin = bindingRuntimePlugin({ kv: 'myapp_kv', r2: 'myapp_storage' });
    const resolveId = getHookHandler(plugin.resolveId) as (
      this: { environment: { name: string } },
      source: string,
      importer: string | undefined,
      options: { isEntry: boolean },
    ) => string | undefined;

    const kvId = resolveId.call({ environment: { name: 'ssr' } }, 'void/kv', undefined, {
      isEntry: false,
    });
    expect(kvId).toBe('\0virtual:void-kv');
    expect(
      resolveId.call({ environment: { name: 'client' } }, 'void/kv', undefined, {
        isEntry: false,
      }),
    ).toBeUndefined();
    const kvCode = loadVirtualModule(plugin.load, kvId!);
    expect(kvCode).toContain('requireRuntimeBinding("myapp_kv")');
    expect(kvCode).not.toContain('requireRuntimeBinding("KV")');

    const storageId = resolveId.call({ environment: { name: 'ssr' } }, 'void/storage', undefined, {
      isEntry: false,
    });
    expect(storageId).toBe('\0virtual:void-storage');
    const storageCode = loadVirtualModule(plugin.load, storageId!);
    expect(storageCode).toContain('requireRuntimeBinding("myapp_storage")');
    expect(storageCode).not.toContain('requireRuntimeBinding("STORAGE")');
  });
});
