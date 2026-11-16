# @void/react

React adapter for [Void](https://void.cloud). Build server-rendered pages with typed server loaders, forms, layouts, and interactive islands.

Requires React 19. Navigation uses transitions and Suspense to keep the UI responsive while the next page loads.

## Setup

For a new app, run `npx void init` and choose React. To add the adapter to an existing Void app:

```sh
npm install @void/react
```

Add the adapter to your Vite config. It includes the framework's Vite plugin:

```ts
import { voidReact } from '@void/react/plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidReact()],
});
```

## Documentation

Follow [Pages Routing](https://void.cloud/guide/pages-routing/overview) to add pages, then use [loaders](https://void.cloud/guide/pages-routing/loaders), [forms](https://void.cloud/guide/pages-routing/actions-and-forms), and [layouts](https://void.cloud/guide/pages-routing/layouts). Use [not-found and error components](https://void.cloud/guide/pages-routing/errors) to recover inside your layouts. See the [adapter API reference](https://void.cloud/reference/api/pages) for plugin options and runtime helpers.

Read the [Void documentation](https://void.cloud) online or use the Markdown guides and references in `node_modules/void/docs/`, included with the `void` package.
