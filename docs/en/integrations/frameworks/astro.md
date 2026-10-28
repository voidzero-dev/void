---
outline: deep
---

# Astro

Use Void with [Astro](https://astro.build/) for resource detection, typed database queries, and migrations. Astro keeps its own build and Cloudflare integration; Void plugs into its Vite configuration.

::: warning Astro 6 required

- [Astro 6+](https://astro.build/blog/astro-6/) is required to use `import { x } from "void/x"` helpers in Astro apps.
- You also need to enable `"nodejs_als"` under `compatibility_flags` in your Cloudflare config.
:::

## Setup

### 1. Create a new project

```bash
npm create astro@latest my-app
cd my-app
```

### 2. Install dependencies

```bash
npm install -D @astrojs/cloudflare void
```

### 3. Configure `astro.config.mjs`

```js
import cloudflare from '@astrojs/cloudflare';
import { defineConfig } from 'astro/config';
import { voidPlugin } from 'void';

export default defineConfig({
  adapter: cloudflare({ configPath: './.void-wrangler.jsonc' }),
  vite: { plugins: [voidPlugin()] },
});
```

### 4. Create `void.config.ts`

Void uses this config for the Cloudflare adapter during development and deployment:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: {
    name: 'my-app',
    compatibility_date: '2026-02-24',
    compatibility_flags: ['nodejs_als'],
  },
});
```

`nodejs_als` is required for `void/*` runtime helpers (for example `void/db`, `void/kv`) in Astro.

### 5. Deploy

```bash
void auth login
void deploy
```

## Using Void Features

Most [Void platform features](../../guide/app-types.md#void-apps) work with Astro in both local dev and production when using Astro 6+ with `nodejs_als`.

Void-managed auth is not supported in framework mode yet. Use Better Auth's official Astro integration directly for now.

Pages that access runtime bindings must opt out of prerendering:

```astro
---
export const prerender = false;
// now Astro.locals.runtime is available
---
```

### Database

Use `void/db` in API routes and server-side code:

```ts
import { users } from '@schema';
import type { APIRoute } from 'astro';
import { db } from 'void/db';

export const GET: APIRoute = async () => {
  const rows = await db.select().from(users);
  return Response.json(rows);
};
```

### Other resources

Use [KV](../../guide/kv.md), [object storage](../../guide/storage.md), and [AI](../../guide/ai.md) from server-side code with the same imports as a Void app. Add [cron jobs](../../guide/jobs.md) in `crons/` and [queue consumers](../../guide/queues.md) in `queues/`.

### Environment Variables

Declare variables in `env.ts` and read them with `import { env } from "void/env"`. See [Environment Variables](../../guide/env-vars.md) for local values, production secrets, and public `VITE_*` values.

Void always uses `VITE_*` for client-exposed schema keys, including in Astro projects. Astro's separate `PUBLIC_*` convention still applies to direct `import.meta.env` access, but it does not change the `void/env` server/client boundary.

`void/env` replaces [`astro:env`](https://docs.astro.build/en/guides/environment-variables/) and `Astro.locals.runtime.env` for env-var access. Keep `Astro.locals.runtime.env` around when you need raw binding access (D1, KV, R2, etc.).

## Accessing Bindings Directly

Access bindings via `Astro.locals.runtime.env` (works in both dev and production):

```ts
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ locals }) => {
  const { DB } = locals.runtime.env;
  const { results } = await DB.prepare('SELECT * FROM users').all();
  return Response.json(results);
};
```

In `.astro` pages (remember to set `prerender = false`):

```astro
---
export const prerender = false;
const { DB } = Astro.locals.runtime.env;
const { results } = await DB.prepare("SELECT * FROM users").all();
---
```
