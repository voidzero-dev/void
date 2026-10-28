---
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

### 4. Deploy

```bash
void auth login
void deploy
```

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

### Environment Variables

Declare variables in `env.ts` and read them with `import { env } from "void/env"`. See [Environment Variables](../../guide/env-vars.md) for local values, production secrets, and public `VITE_*` values.

Read server secrets in a `.server.ts` companion module and import it into your loader or action. Void rejects server-secret reads in route files that also contain browser components.

## Accessing Bindings Directly

You can also access Cloudflare bindings via the `cloudflare:workers` module:

```tsx
import { env } from 'cloudflare:workers';

const { results } = await env.DB.prepare('SELECT * FROM users').all();
```
