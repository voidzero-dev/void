import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: { generate: 'src/generate/index.ts' },
    format: 'esm',
    dts: true,
    clean: true,
    deps: {
      resolveDepSubpath: true,
      neverBundle: ['void', /^takumi-js(?:\/|$)/],
    },
  },
});
