---
outline: deep
---

# SvelteKit

Use Void with [SvelteKit](https://svelte.dev/docs/kit) for resource detection, typed database queries, and migrations. SvelteKit keeps its own build and Cloudflare integration; Void plugs into its Vite configuration.

Void supports SvelteKit 3 and SvelteKit 2.62 or later. The setup below uses SvelteKit 3 with `@sveltejs/adapter-cloudflare` 8.

## Setup

### 1. Create a new project

```bash
npx sv create my-app
cd my-app
```

### 2. Install dependencies

```bash
npm install -D @sveltejs/adapter-cloudflare void
```

### 3. Configure `vite.config.ts`

```ts
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { voidPlugin } from 'void';

export default {
  plugins: [
    voidPlugin(),
    sveltekit({
      adapter: adapter({
        config: './.void-wrangler.jsonc',
        platformProxy: { configPath: './.void-wrangler.jsonc' },
      }),
    }),
  ],
};
```

### 4. Create `void.config.ts`

Point SvelteKit's adapter at Void's generated Cloudflare config as shown above. Add your Cloudflare settings to `void.config.ts`:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: {
    name: 'my-app',
    compatibility_date: '2026-02-24',
    compatibility_flags: ['nodejs_compat'],
  },
});
```

### 5. Configure `tsconfig.json`

Extend SvelteKit’s generated config and Void’s generated types and database aliases:

```json
{
  "extends": ["$app/tsconfig", "./.void/tsconfig.json"],
  "compilerOptions": {
    "types": ["$app/types", "void/env"]
  },
  "include": ["src", "db", "crons", "queues", "*.ts"]
}
```

Run `void prepare` after a fresh clone or before typechecking in CI so `.void/tsconfig.json` exists before SvelteKit syncs its config. Use `package.json` subpath imports for aliases such as SvelteKit 3's `#lib`.

### 6. Deploy

```bash
void auth login
void deploy
```

## Using Void Features

Most [Void platform features](../../guide/app-types.md#void-apps) work with SvelteKit. Use them in server load functions, actions, and API routes:

Void-managed auth is not supported in framework mode yet. Use Better Auth's official SvelteKit integration directly for now.

### Database

```ts
// src/routes/users/+page.server.ts
import { users } from '@schema';
import { db } from 'void/db';

export async function load() {
  return { users: await db.select().from(users) };
}
```

### Other resources

Use [KV](../../guide/kv.md), [object storage](../../guide/storage.md), and [AI](../../guide/ai.md) from server-side code with the same imports as a Void app. Add [cron jobs](../../guide/jobs.md) in `crons/` and [queue consumers](../../guide/queues.md) in `queues/`.

### Environment Variables

Declare variables in `env.ts` and read them with `import { env } from "void/env"`. See [Environment Variables](../../guide/env-vars.md) for local values, production secrets, and public `VITE_*` values.

## Accessing Bindings Directly

In SvelteKit 3, use the `cloudflare:workers` module in server-side code:

```ts
import { env } from 'cloudflare:workers';

const { results } = await env.DB.prepare('SELECT * FROM users').all();
```

## Existing SvelteKit 2 apps

Use SvelteKit 2.62 or later with `@sveltejs/adapter-cloudflare` 7. The Vite configuration above also works with Kit 2; add Void's tsconfig hook to the `sveltekit()` options:

```ts
import { withVoidTSConfig } from 'void/sveltekit';

sveltekit({
  adapter: adapter({
    config: './.void-wrangler.jsonc',
    platformProxy: { configPath: './.void-wrangler.jsonc' },
  }),
  typescript: {
    config: withVoidTSConfig(),
  },
});
```

Keep the Kit 2 tsconfig setup:

```json
{
  "extends": "./.svelte-kit/tsconfig.json",
  "compilerOptions": {
    "types": ["void/env"]
  }
}
```

If your app uses `svelte.config.js` or `svelte.config.ts`, keep its configuration and add `typescript.config: withVoidTSConfig()` under `kit`. Kit 2's `platform.env` remains available in hooks and load functions.
