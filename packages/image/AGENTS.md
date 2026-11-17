# @void/image

Image generation and Open Graph image responses for Void.

The public entry is `@void/image/generate`; do not add generation exports to the package root.
Keep `void/html` in the core package and import only public Void APIs across the package boundary.

Own the public input, style, and option types; keep Takumi types behind the input adapter.
The optional `@void/image/react` entry owns React augmentations. Generation declarations must
typecheck without loading React or Takumi declarations; test both React opt-in mechanisms.

`renderImage` and `renderOgImage` return PNG bytes and reject rendering failures directly.
Response constructors must not start rendering: use `pull` with `highWaterMark: 0`, and guard
completion after cancellation. Keep rendering-only options separate from HTTP response options.

Takumi stays an external runtime dependency of this package. Always pass the explicitly initialized
WASM renderer to `render`; the default Takumi backend uses native addons on Node.js and Bun.
Cloudflare bundles the WASM into its Worker; Node.js and Bun use installed production dependencies.

Retain renderer registrations only for an identical ordered font list. Downloaded font bytes have
a separate bounded cache; cache raw downloads before per-image fallback failure bookkeeping.

Keep the embedded Inter module, generation script, and `licenses/Inter.txt` together. Normal builds
must remain offline; only `node packages/image/scripts/embed-inter.mjs` downloads font sources.

Tests live in `test/unit` and `test/integration`. Follow [TESTING.md](../../TESTING.md) for
verification, including packed npm/pnpm consumers and real Bun execution. Keep renderer retention,
concurrent font loading, HTML escaping, no-React, and no-image consumer coverage.
