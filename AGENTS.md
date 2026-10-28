# Void

Full-stack framework for Cloudflare Workers, powered by Vite.

## Context Overview

- Documentation source lives in `docs/`.
  - English and Simplified Chinese pages live in parallel `docs/en/` and `docs/zh/` trees. Follow `docs/README.md` for translation maintenance. The site rewrites English source paths to keep public URLs unchanged; bundled English docs keep their existing package paths.
  - Docs is a Vitepress project using our custom theme. When asked to "link the theme", temporarily edit `docs/package.json` so that `@voidzero-dev/vitepress-theme` point to `link:../../../theme`. Rerun `vp install` to link it. Revert these when asked to "unlink the theme".
- Packages publish to npm as `void` and `@void/*`. Consumer-facing code, docs examples, playground source, and package manifests should use only those public package names.
- Published external runtime dependencies use compatible semver ranges. Preserve `workspace:*` for dependencies and peers between Void packages. The lockfile fixes the versions tested in this repository. Keep Miniflare's dated alpha coordinated with the Cloudflare toolchain: a caret does not accept the next date's alpha. Keep the Sandbox SDK version aligned with its packaged Docker helper and verified platform helper layer.

## Important Note for Release Workflows

The `void` package on npm has these previous versions: '0.0.1', '0.1.0', '0.1.2', '0.1.3', '0.1.5', '0.1.6', '1.0.0', '1.0.1', '1.0.2', '3.0.0', '3.0.1'. We have unpublished these versions but they cannot be published again. In package release workflows, make sure to avoid / skip these versions for `packages/void`.

Deploy hosted production before publishing the npm packages: the CLI checks the platform version. See [operations](./platform/meta/operations.md#github-actions).

## Best Practices That Must Be Followed

- **Do not use Python for repository scripts or automation**, including inline CI scripts and ad-hoc maintenance commands. Use Node.js with TypeScript/JavaScript, or shell/PowerShell where appropriate.
- **Keep user-facing documentation focused on using Void.** Explain public APIs, configuration, observable behavior, and actions users need to take. Do not add implementation details, internal workarounds, defensive checks, normalization rules, or bug-fix history unless they help users make a decision or resolve an actionable problem. Maintainer-only knowledge belongs in source comments, repository/package `AGENTS.md`, or contributor guides. This applies to app guides, API/CLI references, consumer-facing READMEs, and shipped app-development skills.
- **Keep native Cloudflare deploys Workers Free-compatible by default.** New public Void SDK/runtime features must work with `void deploy --platform cloudflare` on Workers Free unless the underlying Cloudflare product has no Free offering. Paid-only functionality must be explicitly opt-in, inferred and emitted only when the app uses it, and checked before provisioning or building. Its documentation and deploy error must name the required Cloudflare product/plan, link to enable it, and explain any API-token permissions. Platform-internal paid services must never become requirements of a single-app native Cloudflare deploy. Add regression coverage proving that an app which does not use the paid feature emits no paid binding and performs no entitlement probe.
- Every implementation plan should include the following:
  - During plan generation: ask clarifying questions when necessary, especially around developer-experience defining design decisions.
  - Verification:
    - Run `vp run check` for package typechecking after completing a batch of tasks.
    - During development, run an exact test file (and `-t` for a focused case) first. Use `vp run test --list` to inspect affected coverage, then `vp run test` for changed-file validation. Use `--base <ref>` when changes are already committed; the default includes only staged, unstaged, and untracked files.
    - `vp run test --unit` is an iteration-only shortcut, not integration verification. Native `vp test related --run <source>` misses filesystem/subprocess inputs; prefer the smart runner's conservative fallbacks before handing off. See `TESTING.md` for builds, integration selection, and import profiling.
    - Run `vp test run` once when everything is done for final verification. CI and `vpr test:all` retain full-suite coverage. Do not repeatedly run the full suite during iteration, enable result caching for the smart selector, or disable module isolation to make tests faster.
    - If there are tests hanging or running particularly slow, investigate right there and attempt to fix. Testing velocity is something that should be maintained or improved at every opportunity.
  - Documentation: after verification, update the relevant docs only when public behavior, configuration, or user workflows change. An internal fix often needs no user-facing documentation change:
    - `README.md`
    - affected packages's `README.md` or `AGENTS.md`
    - relevant docs md files in `docs`
    - `packages/void/skills/void` (if change affects skill/CLI guidance)
    - `packages/void/AGENTS_TEMPLATE.md` (keep at most four brief bullets; detailed guidance belongs in docs)
- When adding new CLI commands, always remember to update the following:
  - CLI help message
  - The hint message for command groups in the interactive list when running `void` with no args
  - `docs/en/reference/cli.md`

## Quick Reference

```
vp run build                        # Build all packages
vp run build:all                    # Build packages and playgrounds
vp run build:core                   # Build shared packages, CLI, and platform runtime
vp run test                         # Affected local tests, with integration fallbacks
vp run test --list                  # Preview affected test files without builds/hooks
vp run test --base origin/main      # Include committed branch changes
vp test run                         # Run tests (unit + integration tests)
vpr test:all                        # Format, lint, build, typecheck, and run all SDK/platform tests
vp test run packages/void           # Only test the core plugin
vp lint                             # Oxlint through Vite+
vp fmt                              # Oxfmt through Vite+
vp run check                        # Typecheck all packages with TypeScript
vp run --filter ./packages/vue typecheck # Typecheck a specific package
```

## Monorepo Structure

pnpm workspaces managed through Vite+. Shared dependency versions use the **pnpm catalog** in `pnpm-workspace.yaml` (`typescript`, `vite-plus`, Vite+/Vitest aliases, `@cloudflare/workers-types`, wrangler). Make sure to run `vp install` after making package structure changes.

| Package                                                      | npm name                  | Purpose                                                           |
| ------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------- |
| [`packages/deploy-core`](./packages/deploy-core)             | `@void/deploy-core`       | Shared deployment manifests, events, and target-neutral contracts |
| [`packages/deploy-cloudflare`](./packages/deploy-cloudflare) | `@void/deploy-cloudflare` | Direct Cloudflare config and verified upload primitives           |
| [`packages/edge`](./packages/edge)                           | `@void/edge`              | Shared routing, headers, and static edge runtime                  |
| [`packages/isr`](./packages/isr)                             | `@void/isr`               | Shared ISR protocol, core logic, and direct runtime               |
| [`packages/platform`](./packages/platform/README.md)         | `@void/platform`          | Self-hosted installation contracts and packaged platform runtime  |
| [`packages/void`](./packages/void/AGENTS.md)                 | `void`                    | Core Vite plugin — routing, inference, migrations, CLI            |
| [`packages/react`](./packages/react/README.md)               | `@void/react`             | React framework adapter for Pages mode (SSR, Link, useForm)       |
| [`packages/vue`](./packages/vue/README.md)                   | `@void/vue`               | Vue framework adapter for Pages mode (SSR, Link, useForm)         |
| [`packages/svelte`](./packages/svelte/README.md)             | `@void/svelte`            | Svelte 5 framework adapter for Pages mode (SSR, Link, useForm)    |
| [`packages/solid`](./packages/solid/README.md)               | `@void/solid`             | SolidJS framework adapter for Pages mode (SSR, Link, useForm)     |
| [`docs`](./docs)                                             | (private)                 | Documentation site (VitePress)                                    |
| [`platform`](./platform/README.md)                           | (private)                 | Self-hosted platform source, routing, proxy, logs, and dashboard  |
| `playground/*`                                               | (private)                 | local apps for testing                                            |

The platform source is part of this repository. Its workspace-only packages keep `private: true` to prevent accidental npm publication; this does not mean the platform source is private. Use `docs/en/guide/platform-development.md` for contributor/fork setup and `docs/en/guide/self-hosted-platform.md` for installation.

Platform packages live under `platform/packages/*` and may depend on public/shared root packages. Public SDK packages under `packages/*` must not import from `platform/`.

## Package guidance

Read [the core package instructions](./packages/void/AGENTS.md) for plugin,
runtime, code-generation and CLI invariants. Each framework adapter has its
own README under `packages/{react,vue,svelte,solid}`.
The [API reference](./docs/en/reference/api.md) and
[CLI reference](./docs/en/reference/cli.md) describe the supported public surface.

`packages/void/docs` is ignored by Git and copied from `docs/`
during the build. Edit the source documentation instead.

## Tooling

Use the versions declared in `.node-version`, the root `package.json`
and `pnpm-workspace.yaml`. Vite+ supplies build, test, lint, formatting and
packaging commands. Node supports TypeScript stripping without `tsx`.

The Analog playground's TypeScript version follows Angular's compiler
compatibility range independently of the workspace compiler.

Dependency compatibility pins: Analog and SvelteKit use TypeScript 6.

## Testing

Run affected local tests from root with `vp run test`; `vp test run` always runs the full suite.
See `TESTING.md` for minimal agent verification and profiling, and each package README for test listings.

## Playground

Local apps for testing features end-to-end. Run scripts with `vp run --filter ./playground/<app> <script>` (e.g. `vp run --filter ./playground/spa dev`).

Use the README and manifest in the relevant playground for its supported
commands and dependencies. See [TESTING.md](./TESTING.md) for focused test
targets and the shared browser fixtures.

`playground-local/` is gitignored and used for ad-hoc local testing apps that are not part of the codebase.

## Pitfalls / Things That Broke

- **`import.meta.resolve()`** is the right way to resolve subpath exports from ESM plugin code. `createRequire().resolve()` fails for ESM-only exports (no `require` condition).
- **Worker bundles are sensitive to transitive imports.** A single re-export of `defineHandler` from the main plugin entry drags in vite + lightningcss + wrangler. The `resolveId` redirect is critical.
- **Miniflare D1 SQLite path** is NOT `<persist>/d1/<id>.db`. It's `<persist>/v3/d1/miniflare-D1DatabaseObject/<hmac-hash>.sqlite` where the hash is derived from `database_id`.
- **Miniflare D1 `exec()` with multi-statement SQL** fails with `Cannot read properties of undefined (reading 'duration')`. Split into individual statements and use `db.batch(stmts.map(s => db.prepare(s)))` instead.
- **ArkType `ArkErrors.map()` returns `ArkErrors`** (not a plain array), causing `Response.json()` serialization to crash via its custom `toJSON()`. Use `Array.from(issues, mapper)` instead of `issues.map(mapper)` when flattening Standard Schema issues.
- **tsconfig `extends` does NOT merge `include`/`files`** — the child completely replaces the parent's. To make generated types discoverable, the `.void/tsconfig.json` uses `"files"` (inherited when the child doesn't specify `files`) rather than `"include"` (overridden by the child's `include`).
- **`declare module` augmentation requires `export {}`** at the top of the generated file. Without a top-level export/import, TypeScript treats it as an ambient module declaration (replaces the module entirely) rather than an augmentation (merges with existing exports). This hides runtime exports like `db` and `createDb`. Both `routes.d.ts` and `db.d.ts` use `export {}` to ensure augmentation semantics.
- **tsconfig `lib` must be explicit** for CF Workers packages. Without `"lib": ["ES2022"]`, TS defaults to including `lib.dom.d.ts` which shadows `@cloudflare/workers-types` globals (e.g. `CacheStorage.default`). Applied to `void`.
- **D1 does not allow `PRAGMA foreign_keys=OFF`** — D1 enforces `foreign_keys=ON` always. Drizzle-generated migrations that do table rebuilds (e.g. adding NOT NULL to an existing column) use `PRAGMA foreign_keys=OFF/ON`, which silently fails on D1. Hand-edit these to `PRAGMA defer_foreign_keys=on/off` instead, which defers FK checks to the end of the current transaction.
- **Vite config plugins option accepts array of plugins by default** - there is no need to spread plugins that export an array of plugins.
- **Solid `createComponent()` evaluates immediately** — unlike React's JSX (which creates lazy descriptors), Solid's `createComponent(Fn, props)` calls `Fn` right away. Context providers must wrap the _evaluation_ of child components, not the evaluated result. Build layout chains inside provider `children` getters, not before wrapping in providers.
