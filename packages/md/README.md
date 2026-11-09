# @void/md

Markdown adapter for [Void](https://void.cloud). Build content pages with frontmatter, syntax highlighting, layouts, and interactive islands alongside your application routes.

## Setup

Install alongside `void` and your framework adapter:

```sh
npm install @void/md
```

Add `voidMarkdown()` after the adapter in your Vite config. For example, with Vue:

```ts
import { voidMarkdown } from '@void/md/plugin';
import { voidVue } from '@void/vue/plugin';
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidVue(), voidMarkdown()],
});
```

Create `.md` files in `pages/`. The plugin also works with React, Svelte, Solid, and Hono.

## Documentation

See [Markdown](https://void.cloud/guide/pages-routing/markdown) for frontmatter, themes, navigation, and plugin options, and [Islands](https://void.cloud/guide/pages-routing/islands) for interactive components.

Read the [Void documentation](https://void.cloud) online or use the Markdown guides and references in `node_modules/void/docs/`, included with the `void` package.
