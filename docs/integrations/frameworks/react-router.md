---
description: 'Add Void beside the React Router Vite plugin for databases, storage, and deployment, without a separate Cloudflare adapter.'
outline: deep
---

# React Router v7

Add `voidPlugin()` alongside the [React Router v7](https://reactrouter.com/) Vite plugin to use Void's database, storage, and deployment features. You don't need a separate Cloudflare adapter.

## Setup

### 1. Create a new project

```bash
npm create react-router@latest my-app
cd my-app
```

### 2. Install dependencies

```bash
npm install -D void
```

### 3. Configure `vite.config.ts`

```ts
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [
    voidPlugin(), // must come before the framework plugin
    reactRouter(),
  ],
});
```

For React Router v7, set `future.v8_viteEnvironmentApi` to `true` in `react-router.config.ts` to enable the Vite Environment API.

### 4. Deploy

```bash
void auth login
void deploy
```

If you use React Router 8 and `react-router.config.ts` sets `prerender`, tell Void to build with React Router's CLI:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  inference: { build: 'react-router build' },
});
```

Otherwise `void deploy` runs `vite build` (or `vp build` with Vite+), which doesn't exit after React Router 8 prerenders ([remix-run/react-router#15427](https://github.com/remix-run/react-router/issues/15427)), so the deploy never reaches the upload.

## Using Void Features

Most [Void platform features](../../guide/app-types.md#void-apps) work with React Router. Use them in loaders and actions:

Void-managed auth is not supported in framework mode yet. Use Better Auth's official React Router integration directly for now.

### Database

```tsx
import { users } from '@schema';
import { db } from 'void/db';
import type { Route } from './+types/users';

export async function loader({}: Route.LoaderArgs) {
  return { users: await db.select().from(users) };
}
```

### Other resources

Use [KV](../../guide/kv.md), [object storage](../../guide/storage.md), and [AI](../../guide/ai.md) from server-side code with the same imports as a Void app. Add [cron jobs](../../guide/jobs.md) in `crons/` and [queue consumers](../../guide/queues.md) in `queues/`.

In dev and preview, `send()` succeeds but doesn't run this app's queue handler. In dev, run the handler with the [manual queue trigger](../../guide/queues.md#local-development), using the dev server's port and the token in `.void/dev-trigger-token`. Preview reads `queues/` and `env.ts` from the source tree, so don't change them between the build and preview.

### Environment Variables

Declare variables in `env.ts` and read them with `import { env } from "void/env"`. See [Environment Variables](../../guide/env-vars.md) for local values, production secrets, and public `VITE_*` values.

Read server secrets in a `.server.ts` companion module and import it into your loader or action. Void rejects server-secret reads in route files that also contain browser components.

## Custom Worker Entry

To customize how your Cloudflare Worker handles requests or add named exports such as a `WorkerEntrypoint`, set `cloudflare.main` to a path relative to your app root in `void.config.ts`.

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: { main: './worker.ts' },
});
```

In `worker.ts`, default-export the Worker handler and forward page requests to React Router.

```ts
import { createRequestHandler } from 'react-router';

const handleRequest = createRequestHandler(
  // @ts-expect-error React Router's Vite plugin provides this module.
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE,
);

export default {
  fetch(request: Request) {
    return handleRequest(request);
  },
};
```

## Accessing Bindings Directly

You can also access Cloudflare bindings via the `cloudflare:workers` module:

```tsx
import { env } from 'cloudflare:workers';

const { results } = await env.DB.prepare('SELECT * FROM users').all();
```
