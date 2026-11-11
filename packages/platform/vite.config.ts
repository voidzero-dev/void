import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    tasks: {
      // The last step of the `build` script: records the source revision in the runtime manifest.
      // It isn't cached, so a new revision reruns only this step, and it gets the full
      // environment, including VOID_PLATFORM_SOURCE_REVISION.
      'build:stamp': {
        command: 'node scripts/stamp-source-revision.mjs',
        cache: false,
      },
    },
  },
  pack: {
    entry: [
      'src/index.ts',
      'src/installer.ts',
      'src/email-protocol.ts',
      'src/plans.ts',
      'src/browser-page.ts',
    ],
    format: 'esm',
    dts: true,
    clean: true,
  },
});
