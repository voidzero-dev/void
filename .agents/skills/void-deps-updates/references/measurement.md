# Install-size interpretation

Use the checkout's current package structure and policies; dated versions are evidence, not permanent pins.

## Comparable measurements

- Build and pack every public Void package as one cohort, including `@void/platform` runtime artifacts. Resolve public sibling names through `.github/scripts/packed-registry.mjs`.
- Install in a fresh directory with npm `--omit=dev`, no consumer overrides/workspace links, and normal required install behavior. Compare the same Node/npm, OS, architecture, and options before/after. Keep archives, lockfile, registry/time, and footprint JSON.
- The primary metric is unpacked regular-file bytes under consumer `node_modules`, counting each hardlinked inode once and not following symlinks. MiB means bytes / 1,048,576. Filesystem allocation (`du`) is separate and can vary with unpacking/storage. Neither the monorepo nor Void's own tarball represents this metric.
- Enumerate actual installed Miniflare/workerd paths and versions; compatible identical copies can be deduplicated, incompatible ranges cannot. An old development runtime in the workspace lock does not establish production duplication.
- A fresh install measures what published ranges resolve to now; a frozen workspace install measures the tested repository graph. Preserve historical locks because external resolutions can change even when reusing Void tarballs.

## Proven result: November 9, 2026

Commit `8b888f4d7` (`Update deps.`), baseline `11d73a6a1`, locally packed Void 1.6.2 cohort, Node 24.22.1, macOS arm64:

| Metric                         |       Before |        After |
| ------------------------------ | -----------: | -----------: |
| Unpacked regular-file contents | 563.6326 MiB | 368.8433 MiB |
| Final recorded disk allocation | 601.0859 MiB | 403.0938 MiB |

Content reduction: 194.7894 MiB / 34.5596%. Older direct Miniflare stayed on November 1 while external ranges resolved newer tools. Alignment left one Miniflare `5.20261104.0-beta` and workerd `1.20261104.1`, alongside cf `1.0.0-beta.28`, Vite plugin `2.0.0-beta.v.12`, and Wrangler `4.158.0`. The workspace still had an old development/compatibility runtime. Christoph's earlier “v1.1.12 was about 420 MB” has unspecified units/platform and is not a controlled baseline.

## Update pitfalls

- Preserve strict catalogs when recursive updates fail on a catalog mismatch: update coherent catalog entries, then retry. Deliberately select intended beta versions rather than downgrading via stable dist-tags.
- Do not substitute a prerender-engine redesign to avoid coordinating Miniflare. That architecture change was explicitly deferred.
- Vite+ changes affect initializer version strings, bootstrap expectations, and generated commands. React plugin peer-range changes can require a separate compiler scaffold update.
- Check package-extension version selectors after upstream upgrades. Analog Nitro once needed its H3 extension moved to the new exact plugin version.
- Markdown-exit 2 required a small heading-anchor typing adapter; runtime compile/metadata tests still mattered.
- Astryx moved screen-reader toast announcements separately from the visible toast; do not assume the visible surface retains `role=status`.
- Real Cloudflare build/dev tests belong in forked integration processes: macOS native watcher teardown crashed a worker-thread full run. Keep module isolation and regression assertions; do not mask crashes or stale selectors with retries/timeouts.
