import { defineConfig } from 'vite-plus';

// One self-contained Node file. The API streams it into the managed scanner image
// (Engine B), and the Engine A/C images copy it in. It has no runtime dependencies.
export default defineConfig({
  pack: {
    entry: { runner: 'src/runner/main.ts' },
    format: 'esm',
    platform: 'node',
    dts: false,
    clean: true,
  },
});
