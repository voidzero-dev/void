---
outline: deep
---

# Nuxt

Use Void with [Nuxt](https://nuxt.com/) for resource detection, typed database queries, and migrations. Nuxt keeps its own build and Cloudflare integration; Void plugs into its Vite configuration.

## Setup

### 1. Create a new project

```bash
npm create nuxt@latest my-app
cd my-app
```

### 2. Install dependencies

```bash
npm install -D void
```

Void includes the Cloudflare tooling used by Nuxt's platform proxy during development.

### 3. Configure `nuxt.config.ts`

```ts
import { resolve } from 'node:path';
import { voidPlugin } from 'void';

export default defineNuxtConfig({
  alias: {
    '@schema': resolve(import.meta.dirname, 'db/schema.ts'),
  },
  nitro: {
    preset: 'cloudflare-module',
    modules: ['void/nitro'],
    cloudflare: { dev: { configPath: './.void-wrangler.jsonc' } },
    // Required for Nuxt 4.6.0 on Windows.
    externals: {
      inline: [/[\\/]node_modules[\\/]nuxt[\\/]dist[\\/]/],
    },
  },
  vite: { plugins: [voidPlugin()] },
});
```

The `void/nitro` module gives Nuxt server routes your app's `void/db` and `@schema`. The top-level `alias` lets `nuxi typecheck` resolve `@schema`, because Nuxt also checks server routes with the app's types. `cloudflare.dev` gives the development server the bindings from Void's generated Cloudflare config; Nuxt runs it in development when `compatibilityDate` is `2025-07-15` or later.

### 4. Create `void.config.ts`

Void generates the Cloudflare config used by Nuxt's development runtime:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: {
    name: 'my-app',
    compatibility_date: '2026-02-24',
    compatibility_flags: ['nodejs_compat', 'nodejs_als'],
  },
});
```

### 5. Deploy

```bash
void auth login
void deploy
```

## Using Void Features

Most [Void platform features](../../guide/app-types.md#void-apps) work with Nuxt. Use them in server routes, API handlers, and middleware:

Void-managed auth is not supported in framework mode yet. Use Better Auth's official Nuxt integration directly for now.

### Database

```ts
// server/api/users.get.ts
import { users } from '@schema';
import { db } from 'void/db';

export default defineEventHandler(async () => {
  return db.select().from(users);
});
```

### Other resources

Use [KV](../../guide/kv.md), [object storage](../../guide/storage.md), and [AI](../../guide/ai.md) from server-side code with the same imports as a Void app. Add [cron jobs](../../guide/jobs.md) in `crons/` and [queue consumers](../../guide/queues.md) in `queues/`.

### Environment Variables

Declare variables in `env.ts` and read them with `import { env } from "void/env"`. See [Environment Variables](../../guide/env-vars.md) for local values, production secrets, and public `VITE_*` values.

`void/env` replaces `useRuntimeConfig()` and `event.context.cloudflare.env` for env-var access. Keep `event.context.cloudflare.env` around when you need raw binding access (D1, KV, R2, etc.), and `useRuntimeConfig()` when you need non-env runtime config.

## Accessing Bindings Directly

You can also access raw Cloudflare bindings via Nitro's event context:

```ts
// server/api/users.get.ts
export default defineEventHandler(async (event) => {
  const { DB } = event.context.cloudflare.env;
  const { results } = await DB.prepare('SELECT * FROM users').all();
  return results;
});
```
