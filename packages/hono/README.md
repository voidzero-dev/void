# @void/hono

Hono JSX adapter for [Void](https://void.cloud). Build server-rendered pages with typed server loaders, forms, layouts, and interactive islands.

Requires Hono 4.13 or later. Pages render with `hono/jsx` on the server and hydrate with `hono/jsx/dom` in the browser.

## Setup

For a new app, run `npx void init` and choose Hono. To add the adapter to an existing Void app:

```sh
npm install @void/hono hono
```

Add the adapter to your Vite config:

```ts
import { voidHono } from '@void/hono/plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidHono()],
});
```

Set the JSX import source in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
  }
}
```

## Documentation

Follow [Pages Routing](https://void.cloud/guide/pages-routing/overview) to add pages, then use [loaders](https://void.cloud/guide/pages-routing/loaders), [forms](https://void.cloud/guide/pages-routing/actions-and-forms), and [layouts](https://void.cloud/guide/pages-routing/layouts). See the [adapter API reference](https://void.cloud/reference/api/pages) for plugin options and runtime helpers.

Read the [Void documentation](https://void.cloud) online or use the Markdown guides and references in `node_modules/void/docs/`, included with the `void` package.
