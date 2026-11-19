# ImageResponse Playground

Playground for `ImageResponse` from `void/image`, with Browser Run and Takumi examples.

To start dev server, run the repository root:

```sh
vp run --filter ./playground/image-gen dev
```

## Live type checking

Run these commands from the repository root in separate terminals:

```sh
vp run --filter ./packages/void build:watch
vp run --filter ./packages/image-renderer-takumi build:watch
vp run --filter ./playground/image-gen typecheck:watch
```

The build watchers refresh the `dist` declarations that the playground imports.
Start the type checker after both initial builds finish.

## Font cache memory reproduction

```sh
vp run --filter ./packages/void build
vp run --filter ./playground/image-gen dev:memory
```

Open http://127.0.0.1:5176/font-memory. This command runs the playground on Node
with explicit garbage collection enabled. Other dev/build commands keep the
Cloudflare target. The memory endpoint is development-only.

Click **Warm up & set baseline**, select a font count, then load several batches.
Each image registers different font bytes under the same family through the
public `ImageResponse` API. The fixture changes only the TTF modification timestamp
and repairs its checksums; every image must have the same PNG hash. Generated
fonts/images are discarded, so the demo itself does not retain the workload.
The first launch downloads [Roboto](https://github.com/google/fonts/tree/5bd87dfc525c8a0d1d8529d3684716e00c3fc59a/ofl/roboto)
and its SIL Open Font License into the ignored `.font-memory/` directory.

The page polls `/api/font-memory` for RSS, JS heap, external memory (including
Wasm), and array-buffer memory. Before the fix, repeated batches grow retained
font memory. With the fix, memory should level off. Wasm allocations do not shrink
when fonts are evicted: compare growth across equal batches, not whether RSS drops.

To compare a stashed fix, stop the server, apply that stash, rebuild `void` with
the first command, and restart. Always compare fresh processes; HMR cannot reset
the renderer's memory. The largest batches intentionally consume substantial
memory on the unfixed version. **Stop batch** stops after the current image.
