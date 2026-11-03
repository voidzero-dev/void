---
outline: deep
---

# Analog

Use Void with [Analog](https://analogjs.org/) for resource detection, typed database queries, and migrations. Analog keeps its own build and Cloudflare integration; Void plugs into its Vite configuration.

## Setup

### 1. Create a new project

```bash
npx create-analog@latest my-app
cd my-app
```

### 2. Install dependencies

```bash
npm install -D void nitro-cloudflare-dev
```

Void provides the local Cloudflare binding runtime. `nitro-cloudflare-dev` creates the platform proxy during development so that `void/db`, `void/kv`, and other runtime helpers can access bindings.

### 3. Configure `vite.config.ts`

```ts
import analog from '@analogjs/platform';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  resolve: {
    mainFields: ['module'],
  },
  plugins: [
    analog({
      ssr: true,
      nitro: {
        preset: 'cloudflare-module',
        cloudflareDev: { configPath: './.void-wrangler.jsonc' },
        modules: ['nitro-cloudflare-dev', 'void/nitro'],
      },
    }),
    voidPlugin(),
  ],
});
```

The `void/nitro` module gives Analog API routes and page server loads your app's `void/db` and `@schema`.

### 4. Create `void.config.ts`

Void generates the Cloudflare config used by Analog's development runtime:

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

`nodejs_compat` is required for Nitro's Cloudflare runtime. `nodejs_als` is required for `void/*` runtime helpers (e.g. `void/db`, `void/kv`).

### 5. Deploy

```bash
void auth login
void deploy
```

## Using Void Features

Most [Void platform features](../../guide/app-types.md#void-apps) work with Analog. Use them in page server loaders, actions, and API routes:

Void-managed auth is not supported in framework mode yet. Use Better Auth's official integration directly for now.

### Database

```ts
// src/app/pages/users.server.ts
import type { PageServerLoad } from '@analogjs/router';
import { users } from '@schema';
import { db } from 'void/db';

export const load = async ({ event }: PageServerLoad) => {
  return { users: await db.select().from(users) };
};
```

### Other resources

Use [KV](../../guide/kv.md), [object storage](../../guide/storage.md), and [AI](../../guide/ai.md) from server-side code with the same imports as a Void app. Add [cron jobs](../../guide/jobs.md) in `crons/` and [queue consumers](../../guide/queues.md) in `queues/`.

### Environment Variables

Declare variables in `env.ts` and read them with `import { env } from "void/env"`. See [Environment Variables](../../guide/env-vars.md) for local values, production secrets, and public `VITE_*` values.

`void/env` replaces the H3 event context and `import { env } from "cloudflare:workers"` for env-var access. Keep those around when you need raw binding access (D1, KV, R2, etc.).

## Accessing Bindings Directly

You can also access raw Cloudflare bindings via the H3 event context or the `cloudflare:workers` module:

```ts
// src/server/routes/api/users.ts
import { env } from 'cloudflare:workers';
import { eventHandler } from 'h3';

export default eventHandler(async () => {
  const { results } = await env.DB.prepare('SELECT * FROM users').all();
  return results;
});
```
