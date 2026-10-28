---
outline: deep
---

# Plugin and Configuration {#plugin}

## `voidPlugin(options?)` {#voidplugin-options}

Named export from `"void"`. Returns an array of Vite plugins that set up file-based routing, migration support, and the Cloudflare Workers runtime. Application-level configuration is read from [`void.config.ts`](../config.md); the optional `options` object controls Vite/Cloudflare plugin behavior.

```ts
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin()],
});
```

| Option             | Type                      | Description                                                                                                                                                                                                                       |
| ------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistTo`        | `string`                  | Directory path for persisting local dev state (D1, KV, R2). Defaults to `.void/` in the project root.                                                                                                                             |
| `auxiliaryWorkers` | `AuxiliaryWorkerConfig[]` | Additional workers to run inside the same Miniflare instance during dev. Passed through to `@cloudflare/vite-plugin`. Useful for running multiple workers that share bindings (e.g. a separate API worker alongside a dashboard). |

## Project configuration {#project-configuration}

### `defineConfig(config)` {#defineconfig-config}

Import from `void/config` in the root `void.config.ts`. It returns the config with editor completion and TypeScript checking. Void validates the result when loading it, including values computed at runtime.

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: { name: 'my-app' },
  routing: { revalidate: 60 },
});
```

See the [config reference](../config.md) for all fields.
