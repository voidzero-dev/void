---
outline: deep
---

# What is Void?

Void is a full-stack framework for Cloudflare Workers, powered by Vite. Build your UI with React, Vue, Svelte, or Solid, and write server code in the same project. Void connects routing, data access, and deployment while keeping types shared across your app.

Start with the [Quickstart](./quickstart.md) to create and deploy an app. If you already use a meta framework, follow its [integration guide](../integrations/frameworks/overview.md).

## Server routes and pages

Files define routes. A handler in `routes/api/users.ts` serves `/api/users`; a component in `pages/users/index.tsx` renders `/users`.

Each page can have a companion `.server.ts` file. Its **loader** reads data and returns typed props to the component. Its **actions** handle forms and other mutations, then update the page. Server code stays on the server; components render there initially and run in the browser for navigation and interaction.

Use [Pages routing](./pages-routing/overview.md) for a full-stack UI, or keep your own client-side router and call [server routes](./server-routing.md) with [typed fetch](./typed-fetch.md). You can also build an API without a frontend.

## Resources from your code

Import `db` from `void/db` to query your database. Void provides a local database during development and provisions one when you deploy. Imports also enable resources such as [KV](./kv.md), [object storage](./storage.md), and [queues](./queues.md). Use configuration when you need to connect existing resources.

Your Drizzle schema defines database types. Handlers infer response types, and typed fetch checks their callers. Page loaders and actions carry the same types into components and forms. Changing a field shows you which parts of the app need to change.

## From local development to production

Vite runs your app locally with Cloudflare's runtime. `void deploy` builds it, provisions resources, applies database migrations, and publishes it. [Environment variables](./env-vars.md) use a schema, local values, and production secrets.

Deploy to [your own Cloudflare account](./deployment.md#deploy-to-cloudflare), or connect to a [Void platform](./self-hosted-platform.md) run by your team. Both use the same application APIs. A platform adds shared access, deployment history, and administration.

Void also deploys [existing frameworks and static sites](./app-types.md). Your framework keeps its routing and rendering; Void handles resources and deployment.

## Next steps

- [Quickstart](./quickstart.md): create your first app
- [Pages Routing](./pages-routing/overview.md): loaders, layouts, and forms
- [Database](./database.md): schemas, queries, and migrations
- [Deployment](./deployment.md): Cloudflare, team platforms, and CI
