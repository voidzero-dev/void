---
name: void-deps-updates
description: Update direct and transitive dependencies in the Void framework repository while preserving compatibility and measuring the unpacked production install of void plus dependencies. Use for Void dependency upgrades, Cloudflare toolchain alignment, and Vite+ starter updates.
---

# Void dependency updates

Work in the Void maintainer checkout. Read its current `AGENTS.md`, `packages/void/AGENTS.md`, `TESTING.md`, `.node-version`, and catalogs. Follow the requested analysis/update and local/push scope; prefer local main for implementation unless instructed otherwise.

## Update

- Capture a fresh production-install baseline **before editing**. Build and pack the complete public release cohort, including the platform runtime. Use [the measurement helper](#measure).
- Update direct and transitive dependencies recursively through Vite+. Preserve explicitly held TypeScript/Svelte versions and their framework-specific catalogs; inspect current compatibility constraints rather than freezing historical versions forever.
- Coordinate `cf`, Cloudflare Vite plugin, Wrangler, Miniflare/workerd, and Cloudflare support packages using their actual registry ranges and dist-tags. Dated prereleases need explicit alignment; stable `latest` can be an older major than an intended beta.
- Preserve compatible published ranges, `workspace:*`, strict catalogs, intentional overrides, and package extensions. Avoid unnecessary pins or forcing incompatible runtime versions. Run `vp dedupe` and inspect remaining outdated packages.
- Update `void init`/Vite+ scaffold and bootstrap expectations. Match the React compiler dependency to the installed React plugin's peer range. Keep Sandbox SDK, Docker helper, and verified helper layer aligned.
- Keep prerender architecture changes separate from routine dependency alignment.

## Verify and deliver

Start with exact affected tests, then `vp run test --list`, affected tests, and `vp run check`. Follow `TESTING.md` for builds, artifact validation, lint, and final full tests. Do not overlap builds with checks reading the same generated output.

Manifest/lockfile updates require the full npm/pnpm × React/Vue/Svelte/Solid packed matrix, plus Vite+ starters:

```sh
vp run build
VOID_PACKED_SUITE=full node .github/scripts/packed-consumer.mjs
VOID_PACKED_TOOLCHAIN=vite-plus node .github/scripts/packed-consumer.mjs
```

Repeat the fresh size measurement. Inspect installed runtime paths/versions, not just the workspace lockfile or Void's own tarball. Report file contents in MiB with hardlinks counted once; identify platform, architecture, Node, cohort, and baseline. Keep disk allocation separate. Read [measurement notes](references/measurement.md) for interpretation and a dated example.

When committing, use `Update deps.` unless the user specifies otherwise. Preserve unrelated work. Push only within the current task's authorization; if CI monitoring is requested, follow the exact pushed revision through relevant checks until green. Report commit, size delta, held-back versions, verification, and publishing status.

## Measure

Run from the repository root with its Node version and a **new output directory outside the checkout**:

```sh
node .agents/skills/void-deps-updates/scripts/measure-install.mjs --repo . --out /tmp/void-deps-before
# After the update/build, use a different fresh directory:
node .agents/skills/void-deps-updates/scripts/measure-install.mjs --repo . --out /tmp/void-deps-after
```

The helper uses the checkout's packed registry and `vp pm pack`, installs with npm `--omit=dev`, checks packaged platform integrity, and writes `footprint.json`. `--archives <dir>` reuses captured tarballs; external resolutions can still change unless their lockfile is preserved. It does not publish or deploy.
