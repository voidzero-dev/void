import type { Plugin, UserConfig } from 'vite';
import { describe, expectTypeOf, it } from 'vite-plus/test';
import type { voidPlugin } from 'void';
import type { voidVue } from '../../src/plugin.ts';

type VitePlugins = NonNullable<UserConfig['plugins']>;

describe('voidVue plugin types', () => {
  it('returns a mutable plugin array for Vite config compatibility', () => {
    expectTypeOf<ReturnType<typeof voidVue>>().toEqualTypeOf<Array<Plugin>>();
  });

  it('supports the scaffolded nested Vite plugins shape', () => {
    expectTypeOf<
      [ReturnType<typeof voidPlugin>, ReturnType<typeof voidVue>]
    >().toMatchTypeOf<VitePlugins>();
  });
});
