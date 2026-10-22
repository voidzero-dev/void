---
outline: deep
---

# Quickstart

Create a Void app, run it locally, and deploy it. You can also [add Void to an existing Vite app](#adding-to-an-existing-vite-app).

## Create an app

In an empty directory, install Void and run setup:

::: code-group

```sh [npm]
npm install -D void
npx void init
```

```sh [pnpm]
pnpm add -D void
pnpm void init
```

```sh [yarn]
yarn add -D void
yarn void init
```

```sh [bun]
bun add -D void
bunx void init
```

```sh [vite+]
vp add -D void
vpx void init
```

:::

Choose your UI framework, a starter, and a deployment target. Vite+ is the default build tool. D1 is a good first database: it runs locally without a separate database server. Choose Cloudflare to deploy to your own account, or skip deployment setup for now.

You do not need to install Vite+ globally. Setup preserves your existing package-manager versions and lockfiles.

With pnpm, `pnpm create void my-app` also creates the project directory and configures native build permissions for you.

## Run locally

::: code-group

```sh [npm]
npm run dev
```

```sh [pnpm]
pnpm run dev
```

```sh [yarn]
yarn run dev
```

```sh [bun]
bun run dev
```

```sh [vite+]
vpr dev
```

:::

Open `http://localhost:5173`. In a Pages starter, `pages/` contains your UI and companion `.server.ts` files contain its server loaders and actions. Loaders return data to page components as typed props.

## Call a server route

Edit `routes/api/hello.ts`, or create it if your starter doesn't include it:

```ts
import { defineHandler } from 'void';

export const GET = defineHandler(() => {
  return { message: 'Hello from Void' };
});
```

Visit `http://localhost:5173/api/hello` to see the response. From your client code, call it with Void's typed fetch:

```ts
import { fetch } from 'void/client';

const { message } = await fetch('/api/hello');
```

The file path defines the URL, and the handler defines the response type. Change `message` in the handler and TypeScript checks the client against the new shape.

Database starters also include `db/schema.ts`. Its Drizzle schema defines your tables and query types; Void runs a local database and provisions one when you deploy.

## Deploy

If you chose a target during setup:

```sh
npx void deploy
```

If you skipped setup, select your Cloudflare account:

```sh
npx void deploy --platform cloudflare
```

Void opens your browser to sign in when needed, builds the app, provisions resources, applies migrations, and prints the deployed URL. Later deploys use the saved target. See [Deployment](./deployment.md) for team platforms, CI, and rollback.

## Adding to an existing Vite app

Install Void and run `void init` with your package manager as shown [above](#create-an-app). Setup adds `voidPlugin()` to your Vite config and creates the remaining project files. If the config needs a manual edit, the CLI shows the change to make.

For a meta framework such as TanStack Start, React Router, or SvelteKit, follow its [integration guide](../integrations/frameworks/overview.md).

## Next steps

- [Pages Routing](./pages-routing/overview.md): loaders, layouts, and forms
- [Server Routing](./server-routing.md): params, middleware, and validation
- [Database](./database.md): queries and migrations
- [Environment Variables](./env-vars.md): local values and production secrets
- [Coding Agents](../integrations/agents.md): use Void's bundled docs and skills

If a manual pnpm install reports blocked build scripts, run `pnpm approve-builds` for `esbuild`, `sharp`, and `workerd`. Set `better-sqlite3: false` in `pnpm-workspace.yaml`'s `allowBuilds`; Void uses its bundled binaries.
