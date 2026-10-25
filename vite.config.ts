import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import { SuiteSequencer } from './test/sequencer.ts';

const maxWorkers = process.env.CI ? 2 : Math.max(2, Math.floor(availableParallelism() * 0.75));
const apiTimezoneTests = [
  'platform/packages/api/test/integration/api-delete-accounting.test.ts',
  'platform/packages/api/test/integration/email-connections.test.ts',
];
// Platform unit files that start PGlite. Add new PGlite unit files here.
const pgliteUnitTests = [
  'platform/packages/api/test/unit/admin-upgrade-compatibility.test.ts',
  'platform/packages/api/test/unit/email-migration.test.ts',
  'platform/packages/api/test/unit/email-shared-recipient-migration.test.ts',
  'platform/packages/api/test/unit/github-authority-constraints-migration.test.ts',
  'platform/packages/api/test/unit/github-authority-migration.test.ts',
];
const cliUnitTests = [
  'packages/void/test/unit/cf-*.test.ts',
  'packages/void/test/unit/provision-*.test.ts',
  'packages/void/test/unit/deploy-drift.test.ts',
];
// SDK unit files that start PGlite. Add new PGlite unit files here.
const sdkPgliteUnitTests = [
  'packages/void/test/unit/auth-migrations.test.ts',
  'packages/void/test/unit/db-export-roundtrip.test.ts',
  'packages/void/test/unit/db-request-pool.test.ts',
  'packages/void/test/unit/db-reset-pg.test.ts',
  'packages/void/test/unit/platform-database-lock.test.ts',
  'packages/void/test/unit/platform-database-migrations.test.ts',
  'packages/void/test/unit/runner-pg.test.ts',
  'packages/void/test/unit/sveltekit-worker-build.test.ts',
  'packages/void/test/unit/wrapper.test.ts',
];

// Vitest forwards a FILTERED env to test workers — in CI only VOID_E2E_CF_TOKEN survives, while
// VOID_E2E_CF_ACCOUNT_ID and VOID_E2E_RUN_ID are dropped. The gated live Cloudflare deploy e2e
// (packages/void/test/e2e/cloudflare-deploy-live.test.ts) needs all three, so forward them into the
// core-markdown workers explicitly from this main config process (which has the runner's step env).
// Absent/unset → empty strings → the suite skips itself as designed.
const e2eWorkerEnv = {
  VOID_TEST_BROWSER: process.env.VOID_TEST_BROWSER ?? 'chromium',
  VOID_E2E_CF_TOKEN: process.env.VOID_E2E_CF_TOKEN ?? '',
  VOID_E2E_CF_ACCOUNT_ID: process.env.VOID_E2E_CF_ACCOUNT_ID ?? '',
  VOID_E2E_RUN_ID: process.env.VOID_E2E_RUN_ID ?? '',
};

// Windows CI runners are 2-3x slower for builds and server startup.
const ciTimeoutScale = process.platform === 'win32' ? 3 : 1;
const testTimeout = 120_000 * ciTimeoutScale;
const hookTimeout = 120_000 * ciTimeoutScale;

const platformAlias = {
  'void/_sandbox-container': fileURLToPath(
    new URL('packages/void/src/runtime/sandbox-container.ts', import.meta.url),
  ),
  'void:sandbox-controller-source': fileURLToPath(
    new URL('platform/packages/api/test/__mocks__/sandbox-controller-source.ts', import.meta.url),
  ),
  // cloudflare:workers is only available in the Workers runtime.
  'cloudflare:workers': fileURLToPath(
    new URL('platform/packages/api/test/__mocks__/cloudflare-workers.ts', import.meta.url),
  ),
  // cloudflare:email is a workerd built-in with no npm shim, so any module
  // importing it is unloadable in the plain-node unit runner.
  'cloudflare:email': fileURLToPath(
    new URL('platform/packages/api/test/__mocks__/cloudflare-email.ts', import.meta.url),
  ),
  'vite-plus/test': fileURLToPath(
    new URL('node_modules/vite-plus/dist/test/index.js', import.meta.url),
  ),
};

export default defineConfig({
  run: {
    tasks: {
      'build:all': {
        command:
          "vp run build && vp run --filter './platform/packages/**' build && vp run --filter './playground/**' --parallel build",
      },
      'lint:platform': {
        command: 'vp lint platform --type-aware --tsconfig platform/tsconfig.json',
      },
      'test:all': {
        command:
          'vp fmt --check && vp lint && vp run build:all && node test/check-playground-build-artifacts.mjs && vp run lint:platform && vp run check && vp test run',
        // `vp run` passes ONLY the env vars a task declares to that task — not the full environment.
        // Without this, the gated live Cloudflare e2e's credentials never reach `vp test run`, so it
        // skips even when the CI job injects them. `untrackedEnv` forwards them without folding them
        // into the task's cache fingerprint (credentials must not bust the cache).
        cache: {
          untrackedEnv: ['VOID_E2E_CF_TOKEN', 'VOID_E2E_CF_ACCOUNT_ID', 'VOID_E2E_RUN_ID'],
        },
      },
    },
  },
  staged: {
    '*': 'vp fmt --no-error-on-unmatched-pattern',
    '*.{js,jsx,ts,tsx,mjs,cjs}': 'vp lint',
  },
  fmt: {
    singleQuote: true,
    experimentalSortImports: {
      newlinesBetween: false,
    },
    experimentalSortPackageJson: {
      sortScripts: true,
    },
    ignorePatterns: [
      '.svelte-kit/**',
      'packages/void/docs/**',
      'packages/void/skills/void/docs/**',
      'platform/packages/api/src/admin/fate/client.generated.ts',
      'playground/**/.astro/**',
      'playground/**/.nuxt/**',
      'playground/**/.output/**',
      'playground/**/.react-router/**',
      'playground/**/.svelte-kit/**',
      'playground/**/build/**',
      'playground/**/src/routeTree.gen.ts',
      'playground/**/wrangler.json',
      'playground/**/wrangler.jsonc',
      'playground/vinext-app/.next/**',
      'playground/vinext-app/next-env.d.ts',
    ],
  },
  lint: {
    categories: {
      correctness: 'off',
    },
    env: {
      browser: true,
      builtin: true,
      es2024: true,
      node: true,
    },
    jsPlugins: [
      {
        name: 'react-hooks-js',
        specifier: 'eslint-plugin-react-hooks',
      },
    ],
    plugins: ['typescript', 'import', 'react', 'unicorn', 'vitest', 'node', 'jsdoc', 'oxc'],
    ignorePatterns: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.void/**',
      '**/.vite-cloud/**',
      '**/.wrangler/**',
      '**/.tanstack/**',
      '**/.vitepress/cache/**',
      '**/*.tsbuildinfo',
      '.pnpm-store/**',
      'playground-local/**',
      '.worktrees/**',
    ],
    overrides: [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        rules: {
          'constructor-super': 'off',
          'getter-return': 'off',
          'no-class-assign': 'off',
          'no-const-assign': 'off',
          'no-dupe-class-members': 'off',
          'no-dupe-keys': 'off',
          'no-func-assign': 'off',
          'no-import-assign': 'off',
          'no-new-native-nonconstructor': 'off',
          'no-obj-calls': 'off',
          'no-redeclare': 'off',
          'no-setter-return': 'off',
          'no-this-before-super': 'off',
          'no-undef': 'off',
          'no-unreachable': 'off',
          'no-unsafe-negation': 'off',
          'no-with': 'off',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error',
        },
      },
      {
        files: [
          'packages/react/**/*',
          'playground/named-layouts/**/*',
          'playground/node-app/**/*',
          'playground/node-static/**/*',
          'playground/pg-test/**/*',
          'playground/react-pages/**/*',
          'playground/react-router/**/*',
          'playground/spa/**/*',
          'playground/ssr/**/*',
          'playground/tanstack-start/**/*',
          'playground/vinext-app/**/*',
          'playground/vinext-pages/**/*',
          'playground/websockets/**/*',
        ],
        rules: {
          'react-hooks-js/component-hook-factories': 'error',
          'react-hooks-js/config': 'error',
          'react-hooks-js/error-boundaries': 'error',
          'react-hooks-js/gating': 'error',
          'react-hooks-js/globals': 'error',
          'react-hooks-js/immutability': 'error',
          'react-hooks-js/incompatible-library': 'error',
          'react-hooks-js/preserve-manual-memoization': 'error',
          'react-hooks-js/purity': 'error',
          'react-hooks-js/refs': 'error',
          'react-hooks-js/set-state-in-effect': 'error',
          'react-hooks-js/set-state-in-render': 'error',
          'react-hooks-js/static-components': 'error',
          'react-hooks-js/unsupported-syntax': 'error',
          'react-hooks-js/use-memo': 'error',
        },
      },
      {
        files: ['**/*.svelte'],
        rules: {
          'no-undef': 'off',
          'prefer-const': 'off',
        },
      },
      {
        files: ['**/*.vue'],
        rules: {
          'no-undef': 'off',
        },
      },
      {
        files: ['platform/**/*'],
        rules: {
          // The hosted platform historically used Node's native path module.
          // Keep its existing lint contract while shared SDK code uses pathslash.
          'no-restricted-imports': 'off',
        },
      },
      {
        files: ['**/test/**/*.{js,jsx,ts,tsx,mjs,cjs}'],
        rules: {
          // Tests must derive expected paths independently of production's
          // forward-slash wrapper, including on Windows.
          'no-restricted-imports': [
            'error',
            {
              paths: [
                {
                  name: 'pathslash',
                  importNames: [
                    'dirname',
                    'extname',
                    'isAbsolute',
                    'join',
                    'normalize',
                    'relative',
                    'resolve',
                  ],
                  message:
                    'Use node:path for filesystem paths in tests; reserve pathslash for toSlash.',
                },
              ],
            },
          ],
        },
      },
      {
        files: ['playground/vinext-app/.next/**/*.ts'],
        rules: {
          '@typescript-eslint/array-type': 'off',
        },
      },
    ],
    rules: {
      '@typescript-eslint/array-type': [
        'error',
        {
          default: 'generic',
        },
      ],
      '@typescript-eslint/no-duplicate-enum-values': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-extra-non-null-assertion': 'error',
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-unnecessary-type-constraint': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
      '@typescript-eslint/no-wrapper-object-types': 'error',
      '@typescript-eslint/prefer-as-const': 'error',
      '@typescript-eslint/prefer-namespace-keyword': 'error',
      '@typescript-eslint/triple-slash-reference': 'error',
      curly: 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'import/default': 'error',
      'import/namespace': 'error',
      'jest/no-focused-tests': 'error',
      'no-array-constructor': 'error',
      'no-async-promise-executor': 'error',
      'no-case-declarations': 'error',
      'no-class-assign': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': 'error',
      'no-const-assign': 'error',
      'no-constant-binary-expression': 'error',
      'no-constant-condition': 'error',
      'no-control-regex': 'error',
      'no-debugger': 'error',
      'no-delete-var': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty-character-class': 'error',
      'no-empty-pattern': 'error',
      'no-empty-static-block': 'error',
      'no-empty': 'error',
      'no-ex-assign': 'error',
      'no-extra-boolean-cast': 'error',
      'no-fallthrough': 'error',
      'no-func-assign': 'error',
      'no-global-assign': 'error',
      'no-import-assign': 'error',
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-loss-of-precision': 'error',
      'no-misleading-character-class': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-nonoctal-decimal-escape': 'error',
      'no-obj-calls': 'error',
      'no-prototype-builtins': 'error',
      'no-redeclare': 'error',
      'no-regex-spaces': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:path',
              message:
                "Use `pathslash` instead. It re-exports the same API but always emits forward slashes, which avoids cross-platform breakage when paths are embedded in module specifiers, generated source, or compared against Vite's normalized watcher events. If you genuinely need format-specific behavior, import `node:path/win32` or `node:path/posix` explicitly.",
            },
            {
              name: 'path',
              message:
                'Use `pathslash` instead of the unprefixed `path` import (and prefer `node:path/win32` / `node:path/posix` for explicit format-specific behavior).',
            },
          ],
        },
      ],
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-shadow-restricted-names': 'error',
      'no-sparse-arrays': 'error',
      'no-this-before-super': 'error',
      'no-undef': 'error',
      'no-unexpected-multiline': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-unused-expressions': 'error',
      'no-unused-labels': 'error',
      'no-unused-private-class-members': 'error',
      'no-useless-backreference': 'error',
      'no-useless-catch': 'error',
      'no-useless-escape': 'error',
      'no-useless-rename': 'error',
      'no-var': 'error',
      'no-warning-comments': [
        'error',
        {
          terms: ['@nocommit'],
        },
      ],
      'no-with': 'error',
      'oxc/no-accumulating-spread': 'error',
      'prefer-const': 'error',
      'react/exhaustive-deps': 'error',
      'react/jsx-key': 'error',
      'react/jsx-no-duplicate-props': 'error',
      'react/jsx-no-target-blank': 'error',
      'react/jsx-no-undef': 'error',
      'react/no-children-prop': 'error',
      'react/no-danger-with-children': 'error',
      'react/no-direct-mutation-state': 'error',
      'react/no-find-dom-node': 'error',
      'react/no-is-mounted': 'error',
      'react/no-render-return-value': 'error',
      'react/no-string-refs': 'error',
      'react/require-render-return': 'error',
      'require-yield': 'error',
      'unicorn/consistent-empty-array-spread': 'error',
      'unicorn/no-abusive-eslint-disable': 'error',
      'unicorn/no-invalid-fetch-options': 'error',
      'unicorn/no-typeof-undefined': 'error',
      'unicorn/no-unnecessary-slice-end': 'error',
      'unicorn/no-useless-promise-resolve-reject': 'error',
      'unicorn/no-useless-spread': 'error',
      'unicorn/prefer-array-flat-map': 'error',
      'unicorn/prefer-array-index-of': 'error',
      'unicorn/prefer-array-some': 'error',
      'unicorn/prefer-native-coercion-functions': 'error',
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/prefer-optional-catch-binding': 'error',
      'unicorn/prefer-set-size': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
    options: {
      typeAware: false,
      typeCheck: false,
    },
  },
  resolve: { alias: platformAlias },
  test: {
    fsModuleCache: true,
    silent: 'passed-only',
    sequence: { sequencer: SuiteSequencer },
    // Node 24 bundles undici 7. Its fetch() calls socket.setTypeOfService() on each new
    // connection and does not catch errors. On macOS this throws EINVAL when the server has
    // already reset the connection, e.g. when a test polls a port while Vite briefly binds it
    // to check that it is free. The fetch still rejects and the caller sees that; only this
    // stray uncaught copy is dropped. undici 8.8+ ignores the error itself.
    onUnhandledError(error) {
      const { code, syscall } = error as { code?: unknown; syscall?: unknown };
      return !(syscall === 'setTypeOfService' && code === 'EINVAL');
    },
    projects: [
      {
        extends: false,
        test: {
          name: 'cli-unit',
          fsModuleCache: true,
          css: { include: [/starter-ui\.css(?:\?|$)/] },
          include: cliUnitTests,
          pool: 'threads',
          maxWorkers,
          ...(process.platform === 'win32' ? { testTimeout: 20_000 } : {}),
        },
      },
      {
        extends: false,
        test: {
          name: 'unit',
          fsModuleCache: true,
          css: { include: [/starter-ui\.css(?:\?|$)/] },
          include: ['packages/*/test/unit/**/*.test.ts'],
          exclude: [...cliUnitTests, ...sdkPgliteUnitTests],
          sequence: { groupOrder: 2 },
          pool: 'threads',
          maxWorkers,
          // Windows unit tests that import the plugin or spawn a CLI can exceed Vitest's
          // 5-second default under CI load. Keep the faster default on other platforms.
          ...(process.platform === 'win32' ? { testTimeout: 20_000 } : {}),
        },
      },
      {
        extends: false,
        test: {
          name: 'unit-pglite',
          fsModuleCache: true,
          include: sdkPgliteUnitTests,
          sequence: { groupOrder: 2 },
          // Native Node 24 worker crashes can abort the run on Linux and macOS.
          // Keep PGlite's Wasm heap in a separate process for each database.
          pool: ['linux', 'darwin'].includes(process.platform) ? 'forks' : 'threads',
          maxWorkers,
          ...(process.platform === 'win32' ? { testTimeout: 20_000 } : {}),
        },
      },
      {
        extends: false,
        resolve: { alias: platformAlias },
        test: {
          name: 'platform-unit',
          fsModuleCache: true,
          pool: 'threads',
          include: ['platform/packages/*/test/**/*.test.ts'],
          exclude: ['platform/packages/api/test/integration/**', ...pgliteUnitTests],
          maxWorkers,
        },
      },
      {
        extends: false,
        resolve: { alias: platformAlias },
        test: {
          name: 'platform-unit-pglite',
          fsModuleCache: true,
          // Native Node 24 worker crashes can abort the run on Linux and macOS.
          // Keep PGlite's Wasm heap in a separate process for each database.
          pool: ['linux', 'darwin'].includes(process.platform) ? 'forks' : 'threads',
          include: pgliteUnitTests,
          maxWorkers,
        },
      },
      {
        extends: false,
        resolve: { alias: platformAlias },
        test: {
          name: 'platform-api-integration',
          fsModuleCache: true,
          include: apiTimezoneTests,
          globalSetup: ['platform/packages/api/test/integration/global-setup.ts'],
          setupFiles: ['platform/packages/api/test/integration/setup.ts'],
          ...(process.env.VOID_TEST_DATABASE_URL ? { fileParallelism: false } : {}),
          maxWorkers,
        },
      },
      {
        extends: false,
        resolve: { alias: platformAlias },
        test: {
          name: 'platform-api-integration-threads',
          fsModuleCache: true,
          // Native Node 24 worker crashes can abort the run on Linux and macOS.
          // Keep PGlite's Wasm heap in a separate process for each database.
          pool: ['linux', 'darwin'].includes(process.platform) ? 'forks' : 'threads',
          include: ['platform/packages/api/test/integration/**/*.test.ts'],
          exclude: apiTimezoneTests,
          globalSetup: ['platform/packages/api/test/integration/global-setup.ts'],
          setupFiles: ['platform/packages/api/test/integration/setup.ts'],
          ...(process.env.VOID_TEST_DATABASE_URL ? { fileParallelism: false } : {}),
          maxWorkers,
        },
      },
      {
        extends: false,
        test: {
          // Every integration file here owns its fixture directory, so one worker pool can
          // schedule the longest files first and fill idle slots across package boundaries.
          name: 'parallel-integration',
          fsModuleCache: true,
          // Bound simultaneous database engines and framework compilers locally.
          // Unit tests still fill unused integration workers in the same phase.
          sequence: { groupOrder: 2 },
          // maxWorkers limits files, not describe.concurrent tests. On Windows CI, two files
          // at Vitest's default concurrency open up to ten isolated browser contexts at once.
          // Reduce socket pressure while keeping file-level parallelism and other OSes unchanged.
          ...(process.platform === 'win32'
            ? { maxConcurrency: 2, setupFiles: ['test/windows-integration-setup.ts'] }
            : {}),
          testTimeout,
          hookTimeout,
          // Kept alongside the e2e glob below so a newly added e2e file gets its credentials
          // forwarded past vitest's worker env filter here too (see e2eWorkerEnv). The one
          // existing e2e file drives playground/spa, while the other SPA integration uses an
          // isolated playground-local copy so both remain safe when credentials are present.
          env: e2eWorkerEnv,
          include: [
            'packages/void/test/integration/**/*.test.ts',
            // Gated live-account e2e (test/e2e/**). Collected here so it is skipped cleanly in CI
            // (no token) rather than silently undiscovered; runs only when its env vars are set.
            'packages/void/test/e2e/**/*.test.ts',
            'packages/md/test/integration/**/*.test.ts',
            'packages/react/test/integration/**/*.test.ts',
            'packages/vue/test/integration/**/*.test.ts',
            'packages/svelte/test/integration/**/*.test.ts',
            'packages/solid/test/integration/**/*.test.ts',
          ],
          maxWorkers,
        },
      },
    ],
  },
});
