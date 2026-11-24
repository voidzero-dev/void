import { globSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import cloudflare from '@cloudflare/oxlint-config/vite-plus';
import { defineConfig } from 'vite-plus';
import { integrationTestDirs, listIntegrationTestFiles } from './test/integration-files.ts';
import { SuiteSequencer } from './test/sequencer.ts';
import { chunkTestFiles } from './test/test-chunks.ts';

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
    categories: {
      correctness: 'off',
    },
    env: {
      ...cloudflare.env,
      browser: true,
      builtin: true,
      es2024: true,
      node: true,
    },
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
        // The production comparisons use default JavaScript order for reproducible serialized values.
        files: [
          '**/test/**/*',
          'packages/void/src/cli/cf-version-api.ts',
          'platform/packages/email-gateway/src/router.ts',
        ],
        rules: { 'typescript/require-array-sort-compare': 'off' },
      },
      {
        // These wrappers propagate original rejection values through cleanup and retries.
        files: [
          'packages/void/src/cli/{direct-r2-upload,platform-install-workers}.ts',
          'packages/void/src/runtime/live/index.ts',
          'platform/packages/api/src/{ai-logging-plans,build-manager,routing,worker-upload}.ts',
          'platform/packages/api/src/routes/projects.ts',
          'platform/packages/api/src/zero-trust/lock.ts',
        ],
        rules: { 'typescript/only-throw-error': 'off' },
      },
      {
        // Hosted admin views synchronize streamed logs and externally loaded data in effects.
        files: ['platform/packages/api/src/admin/react/views/**/*'],
        rules: { 'react/set-state-in-effect': 'off' },
      },
      {
        // These adapters and test helpers accept opaque objects for identity and weak keys.
        files: [
          '**/test/**/*',
          'packages/void/src/plugin-cloudflare-config.ts',
          'packages/void/src/runtime/env/{runtime,public}.ts',
        ],
        rules: { 'quality/no-object-parameters': 'off' },
      },
      {
        // Proxy traps preserve receiver semantics and tests inspect dynamic members.
        files: [
          '**/test/**/*',
          'packages/void/src/runtime/db/{index,session}.ts',
          'packages/void/src/runtime/env/runtime.ts',
          'packages/void/src/runtime/routing/worker.ts',
          'packages/void/src/runtime/storage/index.ts',
        ],
        rules: { 'quality/no-reflect-get': 'off' },
      },
      {
        // Tests dispatch methods on partial runtime mocks with explicit receivers.
        files: ['**/test/**/*'],
        rules: { 'quality/no-reflect-apply': 'off' },
      },
      {
        // These string scans test for substrings and delimiters.
        files: ['packages/edge/src/pattern.ts', 'platform/packages/api/container/build-agent.mjs'],
        rules: { 'unicorn/prefer-set-has': 'off' },
      },
      {
        // These mocked provider rejections exercise non-Error failure payloads.
        files: ['packages/void/test/unit/provision-resources.test.ts'],
        rules: { 'prefer-promise-reject-errors': 'off' },
      },
      {
        // Routing adapters accept component functions with framework-specific signatures.
        files: ['packages/void/src/runtime/routing/{errors,pages}.ts'],
        rules: { 'typescript/no-unsafe-function-type': 'off' },
      },
      {
        // Database tests intentionally await proxy and mock values to verify thenable handling.
        files: ['packages/void/test/unit/{db-session,plugin-drizzle}.test.ts'],
        rules: { 'typescript/await-thenable': 'off' },
      },
      {
        // Void uses empty defaults in public route and binding types and their test fixtures.
        files: [
          'platform/packages/api/src/admin/fate/client.generated.ts',
          'playground/**/env.d.ts',
          'packages/void/src/routes-stub.ts',
          'packages/void/src/runtime/{queues,handler,auth,ws}/index.ts',
          'packages/void/src/runtime/client/{fetch,fetch-stream}.ts',
          'packages/void/test/unit/{route-type-extraction,ws-room,fetch,fetch-stream.test,fetch.test,fetch.typecheck,ws-room.typecheck,route-type-extraction.typecheck}.ts',
        ],
        rules: { 'typescript/no-empty-object-type': 'off' },
      },
      {
        // The footer uses the current year when rendering the default copyright notice.
        files: ['platform/packages/dashboard/ui/components/oss/FooterNav.tsx'],
        rules: { 'react/purity': 'off' },
      },
      {
        // Solid signal initializers run once and may read the clock.
        files: ['packages/solid/**/*', 'playground/solid-pages/**/*'],
        rules: { 'react/purity': 'off' },
      },
      {
        // These compile-only fixtures call hooks to exercise their type signatures.
        files: ['**/*.typecheck.ts'],
        rules: { 'react/rules-of-hooks': 'off' },
      },
      {
        // Signal and composition helpers do not follow React hook rules.
        files: ['packages/{svelte,solid,vue}/**/*'],
        rules: { 'react/rules-of-hooks': 'off' },
      },
      {
        // The resolver reports false positives in these public dependency re-exports.
        files: [
          'packages/void/src/runtime/db/schema/{d1,mysql,postgres}.ts',
          'packages/void/src/runtime/db/validators/drizzle-{arktype,valibot,zod}.ts',
          'packages/void/src/runtime/sandbox/index.ts',
        ],
        rules: { 'import/export': 'off' },
      },
      {
        // Solid JSX uses native DOM attribute names, including label for.
        files: ['packages/solid/**/*', 'playground/solid-pages/**/*'],
        rules: { 'react/no-unknown-property': 'off' },
      },
      {
        // Solid uses mutable refs across reactive updates.
        files: ['packages/solid/**/*', 'playground/solid-pages/**/*'],
        rules: { 'react/immutability': 'off' },
      },
      {
        // Workers types overload DOM append in these shared browser modules.
        files: [
          'packages/void/src/pages/boundary-client.ts',
          'packages/void/src/pages/navigation-engine.ts',
        ],
        rules: { 'unicorn/prefer-dom-node-append': 'off' },
      },
      {
        // Fate may emit unused imports; still lint and typecheck the generated client.
        files: ['platform/packages/api/src/admin/fate/client.generated.ts'],
        rules: { 'import/consistent-type-specifier-style': 'off', 'no-unused-vars': 'off' },
      },
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        rules: {
          'constructor-super': 'off',
          'getter-return': 'off',
          'no-class-assign': 'off',
          'no-const-assign': 'off',
          'no-dupe-class-members': 'off',
          'no-dupe-keys': 'off',
          // Continue checking explicit any in TypeScript tests.
          'typescript/no-explicit-any': 'error',
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
      // Framework callback and JSX types use void for handlers that may be async.
      'typescript/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      // Keep type queries for ambient declarations and inferred mock module types.
      'typescript/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
      // Temporarily disabled during the shared preset migration.
      // Keep runtime dispatch and error classification based on native and framework class identity. Review cross-realm cases separately.
      '@nkzw/no-instanceof': 'off',
      // Several Vite, filesystem, and test integrations use namespace objects for forwarding, mocking, or optional exports.
      'import/no-namespace': 'off',
      // CLI output, platform Worker logging, and output-capture fixtures intentionally use the console across the workspace.
      'no-console': 'off',
      // Review the assignments in deploy, recovery, and cleanup flows alongside their failure-path tests before removing them.
      'no-useless-assignment': 'off',
      // Operator-facing errors often map provider failures to sanitized messages. Review nested causes for safe logging before attaching them.
      'preserve-caught-error': 'off',
      // Keep eager callbacks and array index semantics in existing filters and maps. Iterator rewrites need their own compatibility and behavior review.
      'quality/no-array-filter-map': 'off',
      // SDK adapters and test doubles use staged assertions across mismatched framework and mock types. Tighten those contracts separately.
      'quality/no-chained-type-assertions': 'off',
      'quality/no-conditional-empty-object-spread': 'off',
      'quality/no-known-value-widening': 'off',
      'quality/no-unknown-returns': 'off',
      'quality/no-unsafe-dictionary-type': 'off',
      'typescript/no-misused-spread': 'off',
      'typescript/no-non-null-assertion': 'off',
      'typescript/no-unnecessary-type-assertion': 'off',
      'typescript/no-unsafe-argument': 'off',
      'typescript/no-unsafe-assignment': 'off',
      'typescript/no-unsafe-call': 'off',
      'typescript/no-unsafe-member-access': 'off',
      'typescript/no-unsafe-return': 'off',
      'typescript/no-unsafe-type-assertion': 'off',
      'typescript/return-await': 'off',
      'typescript/unbound-method': 'off',
      'typescript/use-unknown-in-catch-callback-variable': 'off',
      'unicorn/catch-error-name': 'off',
      'unicorn/consistent-function-scoping': 'off',
      'unicorn/prefer-at': 'off',
      'unicorn/prefer-import-meta-properties': 'off',
      'unicorn/prefer-single-call': 'off',
      'unicorn/prefer-structured-clone': 'off',
      'unicorn/prefer-top-level-await': 'off',
      '@typescript-eslint/array-type': [
        'error',
        {
          default: 'generic',
        },
      ],
      '@typescript-eslint/no-duplicate-enum-values': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-extra-non-null-assertion': 'error',
      // Enforced across the workspace by both `vp check` and `vp lint`.
      '@typescript-eslint/no-floating-promises': 'error',
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
      // Also covers packages without TypeScript's `noUnusedLocals` and plain JS scripts.
      // An options object drops oxlint's default `^_` ignore pattern, so restate it.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
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
      // Import test APIs from `vite-plus/test`, not `vitest`.
      'vite-plus/prefer-vite-plus-imports': 'error',
      // Vitest rejects `.only` only in CI; catch it locally and in pre-commit too.
      'vitest/no-focused-tests': 'error',
    },
    options: {
      reportUnusedDisableDirectives: 'off',
      typeAware: true,
      typeCheck: true,
    },
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
