---
outline: deep
---

# Resource Inference

Void automatically detects which Cloudflare resources your project uses by scanning source files at startup. In most cases, there is no manual configuration. Use a resource in code, and Void provisions the matching binding for local development.

## Detected Bindings

| Binding          | Type                       | Detected by import                                                                                                                                               | Detected by env access                                                         |
| ---------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `DB`             | `D1Database`               | `import { db } from "void/db"`                                                                                                                                   | `env.DB` or `c.env.DB`                                                         |
| `KV`             | `KVNamespace`              | `import { kv } from "void/kv"`                                                                                                                                   | `env.KV` or `c.env.KV`                                                         |
| `STORAGE`        | `R2Bucket`                 | `import { storage } from "void/storage"`                                                                                                                         | `env.STORAGE` or `c.env.STORAGE`                                               |
| `AI`             | `Ai`                       | `import { ai } from "void/ai"`                                                                                                                                   | `env.AI` or `c.env.AI`                                                         |
| `SANDBOX`        | Managed Sandbox capability | `import { getSandbox } from "void/sandbox"`                                                                                                                      | `getSandbox()`; native Cloudflare also exposes `env.SANDBOX` / `c.env.SANDBOX` |
| Auth             | none                       | `import { ... } from "void/auth"` or `import { auth } from "void/client"` / `void/client/react` / `void/client/vue` / `void/client/svelte` / `void/client/solid` | none                                                                           |
| `QUEUE_*`        | `Queue`                    | `import { queues } from "void/queues"`                                                                                                                           | `env.QUEUE_*`                                                                  |
| `VOID_LIVE`      | `DurableObjectNamespace`   | `import { defineLiveStream } from "void/live"`                                                                                                                   | n/a                                                                            |
| filename-derived | `DurableObjectNamespace`   | A default-exported `defineDurableState()` module in `durable-objects/`                                                                                           | n/a                                                                            |

Auth detection also triggers when importing the `auth` specifier from `void/client` or a framework-specific client subpath such as `void/client/react` (but not when importing only `fetch`).

Static bracket access such as `c.env['KV']` and destructured properties such as
`const { DB, KV: cache } = c.env` are also detected. For keys chosen at runtime,
use [explicit binding overrides](#explicit-binding-overrides).

Durable state is inferred from files in `durable-objects/`. For example, `durable-objects/shopping-cart.ts` creates the `SHOPPING_CART` binding, exports `ShoppingCartDurableObject`, and records its migration. See [Durable State](../guide/durable-state.md).

## Scanned Directories

### Standard mode

Native Void apps scan these directories by default. With [`sourceDir`](./config.md#sourcedir) configured, Void scans that source tree instead:

| Directory     | Contains                                    |
| ------------- | ------------------------------------------- |
| `routes/`     | API route handlers                          |
| `middleware/` | Hono middleware                             |
| `queues/`     | Queue consumers                             |
| `pages/`      | Page components and `.server.ts` companions |
| `crons/`      | Scheduled job handlers                      |
| `email/`      | Inbound email handlers                      |
| `src/`        | Application source                          |

### Framework mode

For [supported meta frameworks](../integrations/frameworks/overview.md), Void scans these directories:

| Directory | Contains                |
| --------- | ----------------------- |
| `src/`    | Application source      |
| `app/`    | Framework app directory |
| `routes/` | Framework routes        |
| `server/` | Server-side code        |
| `pages/`  | Framework pages         |
| `crons/`  | Scheduled job handlers  |
| `queues/` | Queue consumers         |

Framework detection uses `package.json` dependencies and dev dependencies. Add `voidPlugin()` to your framework's Vite config to enable inference during development. The integration guides show the setup for each framework.

### Always scanned

Regardless of mode, these are always checked:

- **SSR entry** such as `src/main.ssr.ts`, for SSR apps that access bindings during rendering
- **Application source** in `src/` or your configured `sourceDir`, including resource and auth imports
- **`durable-objects/`**, which is scanned for typed Durable Object state modules in native Void apps

## Custom Scan Directories

If your project organizes code in non-standard directories, you can override which directories are scanned:

```json
{
  "inference": {
    "scanDirs": ["src", "lib", "workers"]
  }
}
```

Paths are relative to the project root. When `inference.scanDirs` is set, it replaces the default directories entirely. The SSR entry and application source scan still apply.

## Explicit Binding Overrides

Use [`inference.bindings`](./config.md#inference-bindings) to enable, disable, or rename a binding when inference does not match your setup. It overrides only the bindings you name; the rest are still inferred.

## File Types

Inference scans `.ts`, `.tsx`, `.mts`, `.js`, `.jsx`, `.mjs`, and Astro frontmatter. Put server resource imports in these files or a page's `.server.ts` companion; Vue and Svelte component files are not scanned directly.
