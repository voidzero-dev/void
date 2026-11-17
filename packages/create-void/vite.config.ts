import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: 'vp pack',
        dependsOn: [{ task: 'build', from: ['dependencies', 'devDependencies'] }],
      },
    },
  },
  pack: {
    entry: ['src/index.ts'],
    format: 'esm',
    dts: false,
    clean: true,
    minify: true,
    deps: {
      resolveDepSubpath: true,
      onlyBundle: [
        '@voidzero-dev/vite-plus-prompts',
        '@clack/core',
        'fast-string-truncated-width',
        'fast-string-width',
        'fast-wrap-ansi',
        'sisteransi',
        'pathslash',
        'picocolors',
      ],
    },
  },
});
