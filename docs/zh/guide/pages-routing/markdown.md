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
            { name: `layout.island${ext}`, description: "文档布局（侧边栏、目录）" },
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

# Markdown {#markdown}

在 `pages/` 中添加 `.md` 文件，即可创建 Markdown 路由。页面会继承布局并渲染为 HTML，只有 [Islands](/zh/guide/pages-routing/islands)、客户端脚本和代码复制按钮需要 JavaScript。

## 配置 {#setup}

安装 `@void/md` 和对应的框架适配器：

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

将插件添加到 Vite 配置中，放在框架适配器**之后**：

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

## 页面结构 {#page-anatomy}

Markdown 页面可以包含三个可选部分：脚本块、frontmatter 和正文。

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

- **`<script>` 块：** 在 Markdown 编译前提取。Islands 导入使用 `with { island: "..." }` 语法，见 [Islands](/zh/guide/pages-routing/islands)。块中的其他代码都会成为在浏览器中运行的[客户端脚本](#client-scripts)。
- **Frontmatter：** 位于 `---` 分隔符之间的 YAML 元数据。布局和交互岛可以通过 [`useFrontmatter()`](#frontmatter-access) 读取。
- **正文：** 支持标准 Markdown 和 GFM。`<Counter />` 这样以大写字母开头的标签会引用已导入的组件，并渲染为交互岛。

## 客户端脚本 {#client-scripts}

在 `<script>` 块中导入交互岛，并编写页面加载时运行的 JavaScript：

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

只会加载当前页面的客户端脚本。没有客户端代码的页面不需要额外的脚本。

## 文件结构 {#file-structure}

Markdown 页面与常规页面一起放在 `pages/` 中，使用相同的路由规则：

<FileTree :items="mdFileItems" adapter-tabs default-expanded />

`.md` 文件会继承布局，支持通过配套的 `.server.ts` 文件加载动态数据，并在内容为静态时[自动预渲染](/zh/guide/edge/prerendering)。这些规则与其他页面相同。

## 读取 frontmatter {#frontmatter-access}

在布局组件中使用 `useFrontmatter()`，读取当前页面的 frontmatter：

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

Markdown 页面中的交互岛组件也可以调用 `useFrontmatter()`。包含交互岛的页面会将 frontmatter 写入 HTML，供这些组件在浏览器中读取。因此，请勿在这类页面的 frontmatter 中放入私有数据。

## 页面虚拟模块 {#pages-virtual-module}

导入 `@void/md/pages`，即可在构建时获取所有 Markdown 页面的元数据，用来生成侧边栏、导航或搜索索引：

```ts
import pages from '@void/md/pages';
// [{ path: "/docs/getting-started", title: "Getting Started", frontmatter: {...}, headings: [...] }, ...]
```

列表只包含当前[环境](/zh/guide/pages-routing/overview#environment-only-pages)的页面：开发服务器中包含 `.dev` 页面，构建时包含 `.prod` 页面。`path` 中会移除环境后缀，例如 `debug.dev.md` 在列表中的路径为 `/debug`。

每个条目的结构如下：

```ts
interface MdPage {
  path: string; // route path
  title: string; // from frontmatter.title or first h1
  frontmatter: Record<string, unknown>; // full parsed frontmatter
  headings: { depth: number; slug: string; text: string }[]; // extracted headings
}
```

数组按路径排序。开发时，新增、删除或修改 `.md` 文件都会通过 HMR 更新该数组。

## 默认 CSS 主题 {#default-css-theme}

Markdown 插件提供了一个精简的 CSS 主题，包含两个入口：

### 完整主题（重置样式 + 基础样式 + 内容样式） {#full-theme-reset-baseline-content}

独立的 Markdown 站点需要完整样式表时，可以使用此入口。它包含现代 CSS 重置样式、body 基础样式，以及所有 Markdown 内容样式：

```css
@import '@void/md/theme.css';
```

### 仅内容样式（作用于 `.void-md`） {#content-only-scoped-to-void-md}

如果要在已有应用中嵌入 Markdown，而应用已经有自己的重置样式和全局样式，请使用此入口。它只包含作用于 `.void-md` 的内容样式：

```css
@import '@void/md/theme-content.css';
```

### 使用方式 {#usage}

用带有 `.void-md` 的元素包裹 Markdown 内容，以限定样式的作用范围：

```html
<main class="void-md">
  <slot />
</main>
```

主题涵盖以下内容：

- **正文：** 标题、段落、列表、引用块、表格、行内代码、链接、水平分隔线、任务列表、`<kbd>`、`<mark>`、定义列表和脚注。深色模式通过 `prefers-color-scheme` 和 `data-theme` 属性生效。
- **代码块：** 使用 Shiki 双主题高亮，通过 CSS 切换，无需 JavaScript。
- **容器：** 为 `:::tip`、`:::warning`、`:::danger`、`:::info` 和 `:::details` 提供样式。
- **GitHub 提示：** 支持 `> [!NOTE]`、`> [!TIP]`、`> [!WARNING]` 等语法。

### CSS 变量 {#css-variables}

所有样式都可以通过设置在 `.void-md` 上的 CSS 变量自定义。覆盖这些变量即可调整为你的品牌风格：

```css
.void-md {
  --vmd-link: #8b5cf6;
  --vmd-link-hover: #7c3aed;
}
```

| 变量 | 浅色默认值 | 深色默认值 | 说明 |
| --- | --- | --- | --- |
| `--vmd-font-body` | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | 同浅色默认值 | 正文字体栈 |
| `--vmd-font-mono` | `ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace` | 同浅色默认值 | 等宽字体栈 |
| `--vmd-text` | `#1a1a2e` | `#e2e8f0` | 主要文字颜色 |
| `--vmd-text-muted` | `#64748b` | `#94a3b8` | 次要文字颜色，用于引用块、行号和脚注 |
| `--vmd-link` | `#2563eb` | `#60a5fa` | 链接颜色 |
| `--vmd-link-hover` | `#1d4ed8` | `#93bbfd` | 链接悬停颜色 |
| `--vmd-border` | `#e2e8f0` | `#334155` | 边框颜色，用于 h2 下划线、表格、行内代码、`<kbd>` 和水平分隔线 |
| `--vmd-bg-soft` | `#f8fafc` | `#1e293b` | 柔和背景色，用于表头、行内代码、代码块和 `<kbd>` |
| `--vmd-line-height` | `1.75` | 同浅色默认值 | 正文行高 |

深色模式的值会通过 `prefers-color-scheme: dark`（自动模式）和 `[data-theme="dark"]`（显式切换）自动生效。如果系统偏好深色模式，但你希望强制使用浅色模式，请在 `<html>` 上设置 `data-theme="light"`。

如果希望完全自行控制样式，也可以不导入主题，直接编写自己的 CSS。

## Markdown 功能 {#markdown-features}

Markdown 功能会渲染为静态 HTML。代码复制按钮会额外加载一小段客户端脚本。

### 容器 {#containers}

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

也支持自定义标题：`::: tip Pro Tip`。

### GitHub 提示 {#github-alerts}

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

### 语法高亮 {#syntax-highlighting}

代码块使用 [Shiki](https://shiki.style)，默认主题为 `github-light` 和 `github-dark`。

### 行高亮 {#line-highlighting}

在代码块的元信息中添加 `{lines}`，即可高亮指定行：

````md
```ts {1,3-5}
const a = 1; // highlighted
const b = 2;
const c = 3; // highlighted
const d = 4; // highlighted
const e = 5; // highlighted
```
````

### 差异、聚焦与错误级别 {#diff-focus-and-error-levels}

使用行内注释标记代码行：

```ts
export function hello() {
  console.log('old'); // [!code --]
  console.log('new'); // [!code ++]
  console.log('look here'); // [!code focus]
  console.log('problem'); // [!code error]
  console.log('careful'); // [!code warning]
}
```

代码块包含复制按钮。

### 行号 {#line-numbers}

通过 `:line-numbers` 为单个代码块启用行号：

````md
```ts :line-numbers
const a = 1;
const b = 2;
```
````

使用 `:line-numbers=5` 可以指定起始行号。

### 表情符号 {#emoji}

表情短代码会转换为 Unicode 字符：`:tada:` 变为 :tada:，`:rocket:` 变为 :rocket:。

### 脚注 {#footnotes}

在正文中引用脚注，并在文档任意位置定义它：

```md
Here is a statement with a footnote.[^1]

[^1]: And here is the footnote body.
```

脚注引用和定义会在内容末尾渲染为带链接的脚注列表。

### 属性 {#attributes}

可以为任意元素添加 class、ID 或属性：

```md
# Heading {.custom-class #my-id}

Paragraph with attributes. {.note}
```

### 导航与媒体 {#navigation-and-media}

标题包含永久链接锚点。使用 `[[toc]]` 可以生成目录。图片会延迟加载，`.md` 链接会解析为页面路由。

## 插件选项 {#plugin-options}

```ts
voidMarkdown({
  shiki: {
    themes: { light: 'github-light', dark: 'github-dark' },
  },
});
```

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `shiki.themes` | `{ light: string; dark: string}` | `{ light: "github-light", dark: "github-dark" }` | Shiki 配色主题 |

代码块所需语言会从 Shiki 内置的语言中按需加载。

## 构建侧边栏 {#building-a-sidebar}

使用 `@void/md/pages` 选出要显示在侧边栏中的页面：

```ts
import pages from '@void/md/pages';

const docPages = pages.filter((page) => page.path.startsWith('/docs/'));
```

使用每个条目的 `page.path` 和 `page.title` 渲染链接。在布局中使用 `useFrontmatter()` 显示当前页面的元数据；如果使用提供的主题，请用 `.void-md` 包裹内容。
