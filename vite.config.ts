import { globSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import cloudflare from '@cloudflare/oxlint-config/vite-plus';
import { defineConfig } from 'vite-plus';
import { integrationTestDirs, listIntegrationTestFiles } from './test/integration-files.ts';
import { SuiteSequencer } from './test/sequencer.ts';
import { chunkTestFiles } from './test/test-chunks.ts';

const typeScriptTestFiles = [
  '**/*.{test,spec,integration,e2e}.{ts,tsx,mts,cts}',
  '**/__tests__/**/*.{ts,tsx,mts,cts}',
];
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
  'packages/void/test/unit/cloudflare-operation-process*.test.ts',
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
// VOID_E2E_CF_ACCOUNT_ID and VOID_E2E_NAMESPACE are dropped. The gated live Cloudflare deploy e2e
// (packages/void/test/e2e/cloudflare-deploy-live.test.ts) needs all three, so forward them into the
// core-markdown workers explicitly from this main config process (which has the runner's step env).
// Absent credentials become empty strings so ordinary test runs skip the live suite.
const e2eWorkerEnv = {
  VOID_TEST_BROWSER: process.env.VOID_TEST_BROWSER ?? 'chromium',
  VOID_E2E_CF_TOKEN: process.env.VOID_E2E_CF_TOKEN ?? '',
  VOID_E2E_CF_ACCOUNT_ID: process.env.VOID_E2E_CF_ACCOUNT_ID ?? '',
  VOID_E2E_NAMESPACE: process.env.VOID_E2E_NAMESPACE ?? '',
};

// Windows CI runners are 2-3x slower for builds and server startup.
const ciTimeoutScale = process.platform === 'win32' ? 3 : 1;
const testTimeout = 120_000 * ciTimeoutScale;
const hookTimeout = 120_000 * ciTimeoutScale;

const platformAlias = {
  'void/_sandbox-container': fileURLToPath(
    new URL('packages/void/src/runtime/sandbox/container.ts', import.meta.url),
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

// Each Vitest project belongs to exactly one cached test group of `vp run test`. The check at
// the end of this file fails when a project is in no group, so a new project cannot be left out.
const testGroups = {
  platform: [
    'platform-unit',
    'platform-unit-pglite',
    'platform-api-integration',
    'platform-api-integration-threads',
  ],
  unit: ['unit', 'unit-pglite', 'cli-unit'],
  integration: ['parallel-integration'],
};

// The files a cached test task reads are its inputs. Two trees are left out: Node's compile
// cache, which every run rewrites, and the temporary playground copies. A copy is made from
// tracked files, and some frameworks list the directory that holds the copies of other tests.
const testGroupInput = [{ auto: true }, '!node_modules/.cache/**', '!playground-local/**'];

function testGroupCommand(group: keyof typeof testGroups): string {
  return `vp test run ${testGroups[group].map((name) => `--project ${name}`).join(' ')}`;
}

// The integration group runs one cached task per test file. Each task records the files its test
// reads, so a change reruns only the files that depend on it and the others are replayed.
const e2eEnvNames = ['VOID_E2E_CF_TOKEN', 'VOID_E2E_CF_ACCOUNT_ID', 'VOID_E2E_NAMESPACE'];
const integrationFileTasks = Object.fromEntries(
  listIntegrationTestFiles(import.meta.dirname).map((file) => [
    `test:integration:${file}`,
    {
      command: `vp test run --project parallel-integration ${file}`,
      cache: { input: testGroupInput, output: [], untrackedEnv: e2eEnvNames },
    },
  ]),
);

// The unit and platform groups run as cached chunks of related files. One Vitest run per file
// would cost more than the tests themselves, so files are chunked by directory instead.
//
// A large directory of unit tests is divided further by file name: a source change then reruns
// the chunks that import it. The platform group is not divided, because every API integration
// test loads the whole API and an API change reruns all of them anyway.
//
// Chunks run side by side. A chunk gets workers for its size, and at least two: most are small.
const unitTestGlobs = ['docs/test/unit/**/*.test.ts', 'packages/*/test/unit/**/*.test.ts'];
const platformTestGlobs = ['platform/packages/*/test/**/*.test.ts'];
const chunkConcurrency = Math.max(2, maxWorkers - 1);

function chunkTasks(group: 'unit' | 'platform', globs: Array<string>) {
  const files = globSync(globs, { cwd: import.meta.dirname }).map((file) =>
    file.replaceAll('\\', '/'),
  );
  const divideLargeDirectories = group === 'unit';
  return Object.fromEntries(
    [...chunkTestFiles(files, { divideLargeDirectories })].map(([chunk, chunkFiles]) => {
      const workers = divideLargeDirectories
        ? 2
        : Math.min(maxWorkers, Math.max(2, Math.ceil(chunkFiles.length / 12)));
      return [
        `test:${group}:${chunk}`,
        {
          command: `${testGroupCommand(group)} --maxWorkers ${workers} ${chunkFiles.join(' ')}`,
          cache: { input: testGroupInput, output: [] },
        },
      ];
    }),
  );
}

const unitChunkTasks = chunkTasks('unit', unitTestGlobs);
const platformChunkTasks = chunkTasks('platform', platformTestGlobs);

const config = defineConfig({
  run: {
    tasks: {
      'build:all': {
        command:
          "vp run build && vp run --filter './platform/packages/**' build && vp run --filter './playground/**' --parallel build",
      },
      'lint:platform': {
        command: 'vp lint platform --type-aware --tsconfig platform/tsconfig.json',
      },
      // One cached task per test group, so `test:all` replays a group whose inputs did not change.
      // Test output is not restored on a hit.
      ...platformChunkTasks,
      'test:platform:chunks': {
        command: 'node test/check-test-tasks.mjs platform',
        dependsOn: Object.keys(platformChunkTasks),
      },
      'test:group:platform': {
        command: `vp run --concurrency-limit ${chunkConcurrency} test:platform:chunks`,
      },
      ...unitChunkTasks,
      'test:unit:chunks': {
        command: 'node test/check-test-tasks.mjs unit',
        dependsOn: Object.keys(unitChunkTasks),
      },
      'test:group:unit': {
        command: `vp run --concurrency-limit ${chunkConcurrency} test:unit:chunks`,
      },
      ...integrationFileTasks,
      // The check runs after every file passed and fails when a collected file has no task.
      'test:integration:files': {
        command: 'node test/check-test-tasks.mjs integration',
        dependsOn: Object.keys(integrationFileTasks),
      },
      'test:group:integration': {
        command: `vp run --concurrency-limit ${maxWorkers} test:integration:files`,
        cache: { untrackedEnv: e2eEnvNames },
      },
      // Local verification without the static checks: build the packages, then the cached test
      // groups. Tests copy and build the playgrounds they use, so the playground builds of
      // `build:all` are only needed by the artifact and type checks in `test:all`.
      test: {
        command:
          "vp run --cache build && vp run --cache --filter './platform/packages/**' build && vp run test:group:platform && vp run test:group:unit && vp run test:group:integration",
        cache: {
          untrackedEnv: ['VOID_E2E_CF_TOKEN', 'VOID_E2E_CF_ACCOUNT_ID', 'VOID_E2E_NAMESPACE'],
        },
      },
      'test:all': {
        command:
          'vp run --cache build:all && node test/check-playground-build-artifacts.mjs && vp check && vp run --cache check:types && vp run test:group:platform && vp run test:group:unit && vp run test:group:integration',
        // `vp run` passes ONLY the env vars a task declares to that task — not the full environment.
        // Without this, the gated live Cloudflare e2e's credentials never reach `vp test run`, so it
        // skips even when the CI job injects them. `untrackedEnv` forwards them without folding them
        // into the task's cache fingerprint (credentials must not bust the cache).
        cache: {
          untrackedEnv: ['VOID_E2E_CF_TOKEN', 'VOID_E2E_CF_ACCOUNT_ID', 'VOID_E2E_NAMESPACE'],
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
    extends: [cloudflare],
    env: cloudflare.env,
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
      {
        name: 'react-hooks-js',
        specifier: 'eslint-plugin-react-hooks',
      },
    ],
    overrides: [
      {
        // Platform scripts and build config operate on native host paths.
        files: ['platform/**/scripts/**/*', 'platform/**/vite.config.ts'],
        rules: { 'no-restricted-imports': 'off' },
      },
      {
        // Filesystem assertions use Node paths independently of the production wrapper.
        files: ['**/test/**/*'],
        rules: {
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
        // Keep fixture builders and partial runtime mocks next to their tests.
        files: [
          '**/test/**/*',
          '**/*.test.*',
          '**/*.typecheck.*',
          'platform/scripts/fixtures/**/*',
        ],
        rules: {
          'quality/no-chained-type-assertions': 'off',
          'unicorn/consistent-function-scoping': 'off',
        },
      },
      {
        // Guard explicit any in TypeScript tests as well as production.
        files: ['**/*.{ts,tsx,mts,cts}'],
        rules: { 'typescript/no-explicit-any': 'error' },
      },
      {
        files: typeScriptTestFiles,
        rules: { 'typescript/only-throw-error': 'error' },
      },
      {
        files: typeScriptTestFiles,
        excludeFiles: ['packages/void/test/**/*', 'platform/packages/api/test/**/*'],
        rules: { 'typescript/no-unsafe-argument': 'error' },
      },
      {
        // These adapters accept objects as weak keys or opaque identities.
        files: [
          'packages/void/src/{plugin-cloudflare-config,runtime/env/runtime,runtime/env/public}.ts',
        ],
        rules: { 'quality/no-object-parameters': 'off' },
      },
      {
        // Proxy traps use Reflect.get to preserve the receiver.
        files: [
          'packages/void/src/runtime/{db/index,db/session,env/runtime,routing/worker,storage/index}.ts',
        ],
        rules: { 'quality/no-reflect-get': 'off' },
      },
      {
        // Code generation augments these interfaces with app-specific types.
        files: [
          'packages/void/src/routes-stub.ts',
          'packages/void/src/runtime/{auth,queues}/index.ts',
        ],
        rules: {
          'typescript/no-empty-object-type': [
            'error',
            {
              allowWithName:
                '^(RoutePathMap|PagePathMap|EncodedRoutePathMap|RouteTypesConfig|RouteMap|WebSocketRouteMap|PageActionMap|VoidAuthTypes|QueueMap)$',
            },
          ],
        },
      },
      {
        // Fate emits imports and empty route shapes. Keep checking the generated client.
        files: ['platform/packages/api/src/admin/fate/client.generated.ts'],
        rules: {
          'import/consistent-type-specifier-style': 'off',
          'no-unused-vars': 'off',
          'typescript/no-empty-object-type': 'off',
        },
      },
      {
        // The import resolver cannot follow these dependency re-exports.
        files: [
          'packages/void/src/runtime/db/{schema/{d1,mysql,postgres},validators/drizzle-{arktype,valibot,zod}}.ts',
          'packages/void/src/runtime/sandbox/index.ts',
        ],
        rules: { 'import/export': 'off' },
      },
      {
        // Workers types give DOM append a different signature in these modules.
        files: ['packages/void/src/pages/{boundary-client,navigation-engine}.ts'],
        rules: { 'unicorn/prefer-dom-node-append': 'off' },
      },
      {
        files: ['**/*.{svelte,vue}'],
        rules: { 'no-undef': 'off' },
      },
      {
        // Signals, composition helpers, and compile-only hook calls follow other conventions.
        files: ['packages/{svelte,solid,vue}/**/*', '**/*.typecheck.ts'],
        rules: { 'react/rules-of-hooks': 'off' },
      },
      {
        // Solid uses native DOM names, mutable refs, and one-time initializers.
        files: ['packages/solid/**/*', 'playground/solid-pages/**/*'],
        rules: {
          'react/immutability': 'off',
          'react/no-unknown-property': 'off',
          'react/purity': 'off',
        },
      },
      {
        files: [
          'packages/react/**/*',
          'playground/{named-layouts,node-app,node-static,pg-test,react-pages,react-router,spa,ssr,tanstack-start,vinext-app,vinext-pages,websockets}/**/*',
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
        files: ['**/*.{js,jsx,mjs,cjs}'],
        rules: { 'typescript/no-unsafe-return': 'error' },
      },
      {
        files: [
          'packages/void/src/runtime/routing/error-pages/script.js',
          'platform/packages/api/container/build-agent.mjs',
        ],
        rules: {
          'typescript/no-unsafe-argument': 'error',
          'typescript/no-unsafe-assignment': 'error',
          'typescript/no-unsafe-call': 'error',
          'typescript/no-unsafe-member-access': 'error',
        },
      },
      // Enforce the staged type rules where the SDK and platform have typed contracts.
      {
        files: ['packages/**/*', 'platform/packages/{dashboard,email-gateway,tail}/**/*'],
        excludeFiles: ['packages/void/**/*'],
        rules: {
          'quality/no-known-value-widening': 'error',
          'quality/no-unknown-returns': 'error',
        },
      },
      {
        files: [
          'packages/void/src/**/*',
          'platform/packages/dispatch/**/*',
          'platform/packages/proxy/src/**/*',
          'platform/packages/api/src/**/*',
        ],
        excludeFiles: ['packages/void/src/{pages,runtime}/**/*'],
        rules: { 'quality/no-unknown-returns': 'error' },
      },
      {
        files: ['packages/void/src/**/*', 'platform/packages/*/src/**/*'],
        rules: { 'quality/no-known-value-widening': 'error' },
      },
      {
        files: [
          'packages/{create-void,deploy-core,edge,isr}/src/**/*',
          'platform/packages/{dashboard,dispatch,email-gateway,tail}/src/**/*',
        ],
        rules: { 'quality/no-unsafe-dictionary-type': 'error' },
      },
      {
        files: [
          'packages/{create-void,deploy-cloudflare,deploy-core,edge,isr,platform,react,svelte}/src/**/*',
          'platform/packages/email-gateway/src/**/*',
        ],
        rules: { 'typescript/no-unsafe-type-assertion': 'error' },
      },
    ],
    rules: {
      // Framework callback and JSX types use void for handlers that may be async.
      'typescript/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      // Keep type queries for ambient declarations and inferred mock module types.
      'typescript/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
      // Project-wide exceptions for existing code.
      // Keep runtime dispatch and error classification based on native and framework class identity. Review cross-realm cases separately.
      '@nkzw/no-instanceof': 'off',
      // CLI output, platform Worker logging, and output-capture fixtures intentionally use the console across the workspace.
      'no-console': 'off',
      // Conditional spreads are used to omit optional config and manifest keys. Preserve omission and property order in follow-up refactors.
      'quality/no-conditional-empty-object-spread': 'off',
      // Validation helpers deliberately accept unknown, including when tests pass values whose concrete types are known.
      'quality/no-known-value-widening': 'off',
      // Decoders and dynamic adapters expose unknown until the caller validates it against the relevant schema.
      'quality/no-unknown-returns': 'off',
      // Environment dictionaries, manifest parsers, and schema inputs carry unknown values until each entry has been validated.
      'quality/no-unsafe-dictionary-type': 'off',
      // Adapter, provider, and fixture assertions need separate schema and contract work across the SDK and platform.
      'typescript/no-unsafe-type-assertion': 'off',
      // Existing catch names distinguish nested provider and cleanup failures. The bulk rename also changed shorthand payload keys.
      'unicorn/catch-error-name': 'off',
      'import/default': 'error',
      'import/namespace': 'error',
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
      // Also covers packages without TypeScript's `noUnusedLocals` and plain JS scripts.
      // An options object drops oxlint's default `^_` ignore pattern, so restate it.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
      // Import test APIs from `vite-plus/test`, not `vitest`.
      'vite-plus/prefer-vite-plus-imports': 'error',
      // Vitest rejects `.only` only in CI; catch it locally and in pre-commit too.
      'vitest/no-focused-tests': 'error',
    },
    options: { typeCheck: true },
  },
  resolve: { alias: platformAlias },
  test: {
    fsModuleCache: true,
    // Reuse Node's compiled JS/TypeScript across real subprocesses and forks.
    // Vitest disables it for V8 coverage; also honor standalone Node coverage.
    env: {
      NODE_COMPILE_CACHE:
        process.env.NODE_COMPILE_CACHE ??
        fileURLToPath(new URL('./node_modules/.cache/node-compile', import.meta.url)),
      ...(process.env.NODE_V8_COVERAGE ? { NODE_DISABLE_COMPILE_CACHE: '1' } : {}),
    },
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
          // These files run their real subprocess tests concurrently. A test then also waits
          // while its neighbours block the thread in a synchronous spawn, so Vitest's 5-second
          // default is too short on a busy machine.
          testTimeout: 20_000,
        },
      },
      {
        extends: false,
        test: {
          name: 'unit',
          fsModuleCache: true,
          css: { include: [/starter-ui\.css(?:\?|$)/] },
          include: unitTestGlobs,
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
          // PGlite's Wasm JIT teardown can crash Node 24 worker threads, including Windows.
          // Keep each database in a separate process on every platform.
          pool: 'forks',
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
          include: platformTestGlobs,
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
          pool: 'forks',
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
          include: integrationTestDirs.map((dir) => `${dir}/**/*.test.ts`),
          maxWorkers,
        },
      },
    ],
  },
});

const groupedProjects = Object.values(testGroups).flat();
for (const project of config.test?.projects ?? []) {
  const name = typeof project === 'object' && 'test' in project ? project.test?.name : undefined;
  if (
    typeof name !== 'string' ||
    groupedProjects.filter((grouped) => grouped === name).length !== 1
  ) {
    throw new Error(
      `Vitest project ${JSON.stringify(name)} must be listed in exactly one entry of testGroups in vite.config.ts.`,
    );
  }
}

export default config;
