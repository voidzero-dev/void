---
outline: deep
---

<script setup>
function mdFileItems(ext) {
  return [
    {
      name: "pages/",
      children: [
        { name: `layout.island${ext}` },
        { name: `index.island${ext}` },
        {
          name: "docs/",
          children: [
            { name: `layout.island${ext}`, description: "docs layout (sidebar, TOC)" },
            { name: "getting-started.md" },
            { name: "configuration.md" },
            {
              name: "guides/",
              children: [
                { name: "deployment.md" },
              ],
            },
          ],
        },
      ],
    },
  ]
}

</script>

# Markdown

Add `.md` files to `pages/` for Markdown routes. Pages inherit layouts and render as HTML, with JavaScript only for [islands](./islands), client scripts, and code-copy buttons.

## Setup

Install `@void/md` alongside your framework adapter:

::: code-group

```sh [React]
npm install @void/md @void/react
```

```sh [Vue]
npm install @void/md @void/vue
```

```sh [Svelte]
npm install @void/md @void/svelte
```

```sh [Solid]
npm install @void/md @void/solid
```

:::

Add the plugin to your Vite config **after** the framework adapter:

::: code-group

```ts [React]
import { voidMarkdown } from '@void/md/plugin';
import { voidReact } from '@void/react/plugin';
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidReact(), voidMarkdown()],
});
```

```ts [Vue]
import { voidMarkdown } from '@void/md/plugin';
import { voidVue } from '@void/vue/plugin';
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidVue(), voidMarkdown()],
});
```

```ts [Svelte]
import { voidMarkdown } from '@void/md/plugin';
import { voidSvelte } from '@void/svelte/plugin';
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidSvelte(), voidMarkdown()],
});
```

```ts [Solid]
import { voidMarkdown } from '@void/md/plugin';
import { voidSolid } from '@void/solid/plugin';
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin(), voidSolid(), voidMarkdown()],
});
```

:::

## Page Anatomy

A markdown page has three optional parts: a script block, frontmatter, and the body.

```md
<script>
import Counter from "../components/Counter.vue" with { island: "visible" }
</script>

---

title: Getting Started
description: Learn how to use Void

---

# Getting Started

Welcome to Void. Here's an interactive demo:

<Counter />
```

- **`<script>` block:** extracted before markdown compilation. Island imports use `with { island: "..." }` syntax (see [islands](./islands)). Any other code in the block becomes a [client script](#client-scripts) that runs in the browser.
- **Frontmatter:** YAML metadata between `---` fences. Layouts and islands can read it through [`useFrontmatter()`](#frontmatter-access).
- **Body:** standard markdown plus GFM. Uppercase tags such as `<Counter />` reference imported components and render as islands.

## Client Scripts

Use the `<script>` block for island imports and JavaScript that runs when the page loads:

```md
<script>
import Counter from "./Counter.vue" with { island: "visible" }
import { format } from "date-fns"

document.querySelector('.date').textContent = format(new Date(), 'PPP')
</script>

# My Post

<Counter />

Published: <span class="date"></span>
```

Only the current page's client script loads. Pages without client code need no additional script.

## File Structure

Markdown pages live in `pages/` alongside regular pages and route the same way:

<FileTree :items="mdFileItems" adapter-tabs default-expanded />

A `.md` file inherits layouts, supports companion `.server.ts` files for dynamic data, and [auto-prerenders](/guide/edge/prerendering) when static. The rules are the same as any other page.

## Frontmatter Access

Use `useFrontmatter()` in layout components to read the current page's frontmatter:

::: code-group

```tsx [React]
import { useFrontmatter } from '@void/md';

export default function DocsLayout({ children }) {
  const fm = useFrontmatter();
  return (
    <div>
      <h1>{fm.title}</h1>
      {children}
    </div>
  );
}
```

```vue [Vue]
<script setup>
import { useFrontmatter } from '@void/md';

const fm = useFrontmatter();
// fm.title, fm.description, etc.
</script>

<template>
  <h1>{{ fm.title }}</h1>
  <slot />
</template>
```

```svelte [Svelte]
<script>
import { useFrontmatter } from "@void/md";

const fm = useFrontmatter();
</script>

<h1>{fm.title}</h1>
<slot />
```

```tsx [Solid]
import { useFrontmatter } from '@void/md';

export default function DocsLayout(props) {
  const fm = useFrontmatter();
  return (
    <div>
      <h1>{fm.title}</h1>
      {props.children}
    </div>
  );
}
```

:::

Island components on a Markdown page can call `useFrontmatter()` too. A page with islands includes its frontmatter in the HTML for them to read in the browser. Keep private values out of the frontmatter of those pages.

## Pages Virtual Module

Import `@void/md/pages` to get metadata for all markdown pages at build time. Use it to build sidebars, navigation, or search indexes:

```ts
import pages from '@void/md/pages';
// [{ path: "/docs/getting-started", title: "Getting Started", frontmatter: {...}, headings: [...] }, ...]
```

The list holds only the pages for the current [environment](./overview.md#environment-only-pages): `.dev` pages on the dev server, `.prod` pages in builds. The suffix is dropped from `path`: `debug.dev.md` is listed as `/debug`.

Each entry has this shape:

```ts
interface MdPage {
  path: string; // route path
  title: string; // from frontmatter.title or first h1
  frontmatter: Record<string, unknown>; // full parsed frontmatter
  headings: { depth: number; slug: string; text: string }[]; // extracted headings
}
```

The array is sorted by path and updates on HMR in dev when `.md` files are added, removed, or changed.

## Default CSS Theme

The markdown plugin provides a minimal CSS theme with two entry points:

### Full theme (reset + baseline + content)

For standalone markdown sites that need a complete stylesheet, use this package. It includes a modern CSS reset, baseline body styles, and all markdown content styles:

```css
@import '@void/md/theme.css';
```

### Content only (scoped to `.void-md`)

For embedding markdown in an existing app that already has its own reset and global styles, use this one. It only includes the `.void-md`-scoped content styles:

```css
@import '@void/md/theme-content.css';
```

### Usage

Wrap your markdown content in a `.void-md` element to scope the styles:

```html
<main class="void-md">
  <slot />
</main>
```

The theme covers:

- **Prose:** headings, paragraphs, lists, blockquotes, tables, inline code, links, horizontal rules, task lists, `<kbd>`, `<mark>`, definition lists, and footnotes. Dark mode works through `prefers-color-scheme` and the `data-theme` attribute.
- **Code blocks:** Shiki dual-theme highlighting with CSS-driven switching and zero JS.
- **Containers:** styles for `:::tip`, `:::warning`, `:::danger`, `:::info`, and `:::details`.
- **GitHub alerts:** support for `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, and similar syntax.

### CSS Variables

All styles are customizable via CSS variables set on `.void-md`. Override them to match your brand:

```css
.void-md {
  --vmd-link: #8b5cf6;
  --vmd-link-hover: #7c3aed;
}
```

| Variable            | Light default                                                                  | Dark default | Description                                                            |
| ------------------- | ------------------------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------- |
| `--vmd-font-body`   | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`                     | default      | Body font stack                                                        |
| `--vmd-font-mono`   | `ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace` | default      | Monospace font stack                                                   |
| `--vmd-text`        | `#1a1a2e`                                                                      | `#e2e8f0`    | Primary text color                                                     |
| `--vmd-text-muted`  | `#64748b`                                                                      | `#94a3b8`    | Secondary/muted text (blockquotes, line numbers, footnotes)            |
| `--vmd-link`        | `#2563eb`                                                                      | `#60a5fa`    | Link color                                                             |
| `--vmd-link-hover`  | `#1d4ed8`                                                                      | `#93bbfd`    | Link hover color                                                       |
| `--vmd-border`      | `#e2e8f0`                                                                      | `#334155`    | Borders (h2 underline, tables, inline code, `<kbd>`, horizontal rules) |
| `--vmd-bg-soft`     | `#f8fafc`                                                                      | `#1e293b`    | Soft background (table headers, inline code, code blocks, `<kbd>`)     |
| `--vmd-line-height` | `1.75`                                                                         | default      | Body line height                                                       |

Dark mode values apply automatically via `prefers-color-scheme: dark` (auto mode) and `[data-theme="dark"]` (explicit toggle). To force light mode on a dark-preference system, set `data-theme="light"` on `<html>`.

Users who want full control can skip the import and write their own CSS.

## Markdown Features

Markdown features render as static HTML. Code-copy buttons add a small client script.

### Containers

```md
::: tip
Helpful advice here.
:::

::: warning
Watch out for this.
:::

::: danger
This will break things.
:::

::: info
Some context.
:::

::: details Click to expand
Hidden content here.
:::
```

Custom titles work too: `::: tip Pro Tip`.

### GitHub Alerts

```md
> [!NOTE]
> Useful information.

> [!TIP]
> Helpful advice.

> [!IMPORTANT]
> Key information.

> [!WARNING]
> Potential issues.

> [!CAUTION]
> Dangerous actions.
```

### Syntax Highlighting

Code blocks use [Shiki](https://shiki.style) with `github-light` and `github-dark` themes by default.

### Line Highlighting

Highlight specific lines with `{lines}` in the code fence meta:

````md
```ts {1,3-5}
const a = 1; // highlighted
const b = 2;
const c = 3; // highlighted
const d = 4; // highlighted
const e = 5; // highlighted
```
````

### Diff, Focus, and Error Levels

Use inline comments to annotate lines:

```ts
export function hello() {
  console.log('old'); // [!code --]
  console.log('new'); // [!code ++]
  console.log('look here'); // [!code focus]
  console.log('problem'); // [!code error]
  console.log('careful'); // [!code warning]
}
```

Code blocks include a copy button.

### Line Numbers

Enable per code block with `:line-numbers`:

````md
```ts :line-numbers
const a = 1;
const b = 2;
```
````

Start from a specific number with `:line-numbers=5`.

### Emoji

Shortcodes convert to unicode: `:tada:` becomes :tada:, `:rocket:` becomes :rocket:.

### Footnotes

Reference a footnote inline and define it anywhere in the document:

```md
Here is a statement with a footnote.[^1]

[^1]: And here is the footnote body.
```

The references and definitions render into a linked footnote list at the end of the content.

### Attributes

Add classes, IDs, or attributes to any element:

```md
# Heading {.custom-class #my-id}

Paragraph with attributes. {.note}
```

### Navigation and Media

Headings include permalink anchors. Use `[[toc]]` for a table of contents. Images are lazy-loaded, and `.md` links resolve to page routes.

## Plugin Options

```ts
voidMarkdown({
  shiki: {
    themes: { light: 'github-light', dark: 'github-dark' },
  },
});
```

| Option         | Type                             | Default                                          | Description        |
| -------------- | -------------------------------- | ------------------------------------------------ | ------------------ |
| `shiki.themes` | `{ light: string; dark: string}` | `{ light: "github-light", dark: "github-dark" }` | Shiki color themes |

Code block languages load on demand from Shiki's bundled languages.

## Building a Sidebar

Use `@void/md/pages` to select the pages for your sidebar:

```ts
import pages from '@void/md/pages';

const docPages = pages.filter((page) => page.path.startsWith('/docs/'));
```

Render a link with `page.path` and `page.title` for each entry. Use `useFrontmatter()` in the layout to display the current page's metadata, and wrap its content in `.void-md` when using the provided theme.
