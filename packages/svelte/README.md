# @void/svelte

Svelte adapter for [Void](https://void.cloud). Build server-rendered pages with typed server loaders, forms, layouts, and interactive islands.

Requires Svelte 5.

## Setup

For a new app, run `npx void init` and choose Svelte. To add the adapter to an existing Void app:

```sh
npm install @void/svelte
```

Add the adapter to your Vite config. It includes the framework's Vite plugin:

```ts
import { voidSvelte } from '@void/svelte/plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte()],
});
```

## Documentation

Follow [Pages Routing](https://void.cloud/guide/pages-routing/overview) to add pages, then use [loaders](https://void.cloud/guide/pages-routing/loaders), [forms](https://void.cloud/guide/pages-routing/actions-and-forms), and [layouts](https://void.cloud/guide/pages-routing/layouts). Use [not-found and error components](https://void.cloud/guide/pages-routing/errors) to recover inside your layouts. See the [adapter API reference](https://void.cloud/reference/api/pages) for plugin options and runtime helpers.

Read the [Void documentation](https://void.cloud) online or use the Markdown guides and references in `node_modules/void/docs/`, included with the `void` package.
