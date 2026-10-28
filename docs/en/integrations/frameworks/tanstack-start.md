---
outline: deep
---

# TanStack Start

Add `voidPlugin()` alongside the [TanStack Start](https://tanstack.com/start/latest) Vite plugin to use Void's database, storage, and deployment features. You don't need a separate Cloudflare adapter.

## Setup

### 1. Create a new project

```bash
npm create @tanstack/start@latest my-app
cd my-app
```

### 2. Install dependencies

```bash
npm install -D void
```

### 3. Configure `vite.config.ts`

```ts
import { tanstackStart } from '@tanstack/react-start/plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [
    voidPlugin(), // must come before the framework plugin
    tanstackStart(),
    react(),
  ],
});
```

### 4. Deploy

```bash
void auth login
void deploy
```

## Using Void Features

Most [Void platform features](../../guide/app-types.md#void-apps) work with TanStack Start. Use them in server functions:

Void-managed auth is not supported in framework mode yet. Use Better Auth's official TanStack Start integration directly for now.

### Database

```tsx
import { users } from '@schema';
import { createServerFn } from '@tanstack/react-start';
import { db } from 'void/db';

const getUsers = createServerFn().handler(async () => {
  return db.select().from(users);
});
```

### Other resources

Use [KV](../../guide/kv.md), [object storage](../../guide/storage.md), and [AI](../../guide/ai.md) from server-side code with the same imports as a Void app. Add [cron jobs](../../guide/jobs.md) in `crons/` and [queue consumers](../../guide/queues.md) in `queues/`.

### Environment Variables

Declare variables in `env.ts` and read them with `import { env } from "void/env"`. See [Environment Variables](../../guide/env-vars.md) for local values, production secrets, and public `VITE_*` values.

## Custom Worker Entry

Set `cloudflare.main` in `void.config.ts` when your Worker needs its own entry module, for example to export a Durable Object class:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  cloudflare: { main: './server.ts' },
});
```

The path is relative to your app root. Default-export the TanStack request handler and add your named exports in that module:

```ts
import handler from '@tanstack/react-start/server-entry';

export { Counter } from './counter';
export default handler;
```

Void preserves these named exports in development, production builds, and deploys. Without `cloudflare.main`, Void uses TanStack's default server entry. A package entry such as `@tanstack/react-start/server-entry` is resolved as a module.

Bind an exported Durable Object or Workflow class under `cloudflare` as well, for example in `cloudflare.durable_objects`. These settings apply when you deploy with `void deploy --platform cloudflare`. On a Void platform, use [Durable State](../../guide/durable-state.md) instead.

## Accessing Bindings Directly

You can also access Cloudflare bindings via the `cloudflare:workers` module:

```tsx
import { env } from 'cloudflare:workers';

const { results } = await env.DB.prepare('SELECT * FROM users').all();
```
