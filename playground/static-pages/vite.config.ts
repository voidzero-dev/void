import { voidVue } from '@void/vue/plugin';
import { defineConfig, type Plugin } from 'vite-plus';
import { voidPlugin } from 'void';

function virtualTagsPlugin(): Plugin {
  const VIRTUAL_ID = 'virtual:tags';
  const RESOLVED_ID = '\0virtual:tags';

  return {
    name: 'virtual-tags',
    resolveId(id) {
      if (id === VIRTUAL_ID) {
        return RESOLVED_ID;
      }
    },
    load(id) {
      if (id === RESOLVED_ID) {
        return `export const tags = ["vue", "vite"];`;
      }
    },
  };
}

export default defineConfig({
  plugins: [voidPlugin(), voidVue(), virtualTagsPlugin()],
});
