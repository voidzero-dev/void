import { defineConfig } from 'vite-plus';

export default defineConfig({
  run: {
    tasks: {
      // The middle step of the `build` script. It empties dist/runtime before writing it, which
      // the task cache records as reading those files. `build:stamp` then edits the manifest in
      // that directory, so without this exclusion the runtime build would never be a cache hit.
      'build:runtime': {
        command: 'node scripts/build-runtime.mjs',
        cache: {
          input: [{ auto: true }, '!dist/runtime/**'],
        },
      },
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
      'src/ai-logging.ts',
      'src/browser-page.ts',
    ],
    format: 'esm',
    dts: true,
    clean: true,
  },
});
