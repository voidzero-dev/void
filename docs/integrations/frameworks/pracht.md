---
outline: deep
---

# pracht

Use Void with [pracht](https://pracht.resynapse.dev/) for resource detection, typed database queries, and migrations. pracht keeps its own build and Cloudflare adapter; Void plugs into its Vite configuration.

## Setup

### 1. Create a new project

```bash
npm create pracht@latest my-app -- --adapter=cf
cd my-app
```

### 2. Install dependencies

```bash
npm install -D void
```

### 3. Configure `vite.config.ts`

Add `voidPlugin()` before `pracht()`, and point the Cloudflare adapter at the Cloudflare config Void generates:

```ts
import { cloudflareAdapter } from '@pracht/adapter-cloudflare';
import { pracht } from '@pracht/vite-plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [
    voidPlugin(),
    pracht({ adapter: cloudflareAdapter({ configPath: './.void-wrangler.jsonc' }) }),
  ],
});
```

### 4. Create `void.config.ts`

Void uses this config for the Cloudflare adapter during development and deployment. Move any bindings from the `wrangler.jsonc` that `create-pracht` wrote into it, then delete that file:

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

`nodejs_als` is required for `void/*` runtime helpers (for example `void/db`, `void/kv`) in pracht.

### 5. Deploy

```bash
void auth login
void deploy
```

`void deploy` runs `pracht build` and deploys `dist/server/worker.js` with the assets in `dist/client`.

## Using Void Features

Most [Void platform features](../../guide/app-types.md#void-apps) work with pracht in both `pracht dev` and production.

Void-managed auth is not supported in framework mode yet. Use [`@pracht/session`](https://pracht.resynapse.dev/docs/recipes-auth) or Better Auth directly for now.

`pracht build` prerenders `ssg` and `isg` routes without Cloudflare bindings, so a route whose loader uses `void/*` helpers must use `render: "ssr"`.

### Database

Use `void/db` in loaders, API routes, and middleware:

```tsx
import { users } from '@schema';
import { db } from 'void/db';

export async function loader() {
  return { users: await db.select().from(users) };
}
```

### Other resources

Use [KV](../../guide/kv.md), [object storage](../../guide/storage.md), and [AI](../../guide/ai.md) from server-side code with the same imports as a Void app. Add [cron jobs](../../guide/jobs.md) in `crons/` and [queue consumers](../../guide/queues.md) in `queues/`.

### Environment Variables

Declare variables in `env.ts` and read them with `import { env } from "void/env"`. See [Environment Variables](../../guide/env-vars.md) for local values, production secrets, and public `VITE_*` values.

## Accessing Bindings Directly

pracht's Cloudflare adapter passes the Worker `env` to loaders and API routes as `context.env`:

```ts
import type { LoaderArgs } from '@pracht/core';

export async function loader({ context }: LoaderArgs) {
  const { results } = await context.env.DB.prepare('SELECT * FROM users').all();
  return { users: results };
}
```
