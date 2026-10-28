---
outline: deep
---

# 支持的应用类型 {#supported-app-types}

Void 支持三种应用类型：

1. **Void 应用：** 使用 Void 框架层的 Vite 应用，支持 [API 路由](/zh/guide/server-routing)、[页面模式](/zh/guide/pages-routing/overview)、[身份认证](/zh/guide/auth)、[定时任务](/zh/guide/jobs)和[队列](/zh/guide/queues)
2. **元框架：** [TanStack Start](https://tanstack.com/start/latest)、[React Router](https://reactrouter.com/)、[SvelteKit](https://svelte.dev/docs/kit)、[Nuxt](https://nuxt.com/) 和 [Astro](https://astro.build/)
3. **静态站点：** SPA、使用 [VitePress](https://vitepress.dev/) 等工具构建的站点，或任何静态文件目录

Void 会根据项目结构自动检测应用类型，你也可以在 [`void.config.ts`](/zh/reference/config) 中显式指定。

## Void 应用 {#void-apps}

在 Void 应用中，Void 负责服务端路由和部署。你可以使用 React、Vue、Svelte 或 Solid 构建服务端渲染页面，也可以使用任何兼容 Vite 的库构建前端。

Void 应用可以是**纯 API 应用**（只有 `routes/`）、**SPA + API 应用**（前端位于 `src/`，同时提供 API 路由），也可以是**使用页面模式的全栈应用**（服务端渲染页面位于 `pages/`，数据加载代码与页面放在一起）：

<VoidAppFileTree annotations />

Void 同时提供 API 路由、页面渲染、可选的[自定义 SSR](/zh/guide/ssr) 和静态资源服务。D1、KV、R2 等资源会[根据代码自动推断](/zh/reference/resource-inference)，并在部署时创建。

Void 应用也可以通过 [`output: 'static'`](/zh/guide/ssg) 在构建时预渲染所有页面，生成可以部署到任何地方的完整静态站点，无需 Cloudflare Worker。

**部署：** `void deploy` 会构建应用、创建资源、执行迁移，并上传到已保存的 Cloudflare 或 Void 目标。配置方式请参阅[部署](/zh/guide/deployment)。

## 元框架 {#meta-frameworks}

Void 支持通过 `void deploy` 部署基于 Vite 的元框架应用。框架负责路由和 SSR，Void 负责[绑定推断](/zh/reference/resource-inference)、[类型化数据库查询](/zh/guide/database)、迁移和部署。

| 框架 | 用于检测的包 | 配置指南 |
| --- | --- | --- |
| [TanStack Start](https://tanstack.com/start/latest) | `@tanstack/react-start` | [指南](/zh/integrations/frameworks/tanstack-start) |
| [React Router v7](https://reactrouter.com/) | `@react-router/dev` | [指南](/zh/integrations/frameworks/react-router) |
| [SvelteKit](https://svelte.dev/docs/kit) | `@sveltejs/kit` | [指南](/zh/integrations/frameworks/sveltekit) |
| [Nuxt](https://nuxt.com/) | `nuxt` | [指南](/zh/integrations/frameworks/nuxt) |
| [Analog](https://analogjs.org/) | `@analogjs/platform` | [指南](/zh/integrations/frameworks/analog) |
| [Astro](https://astro.build/) | `astro` | [指南](/zh/integrations/frameworks/astro) |

将 `voidPlugin()` 添加到框架的 Vite 配置中，即可使用绑定推断、类型化数据库代码生成、迁移管理、定时任务、队列和缓存。框架模式不支持由 Void 管理的身份认证；请使用 Better Auth 为相应框架提供的官方集成。支持的功能和配置指南请参阅[元框架集成](/zh/integrations/frameworks/overview)。

## 预构建的静态站点 {#pre-built-static-sites}

任何生成静态文件的项目都受支持，无论是 SPA、静态站点，还是普通文件目录。Void 直接提供静态资源服务，无需应用代码。

**SPA**（客户端单页应用）会在请求路径没有匹配文件时，以 200 状态码返回 `index.html`，因此客户端路由开箱即用。在 Void 平台上，带哈希的资源文件夹（`/assets/`）中不存在的文件则返回 404。当项目依赖 `vite` 且不存在后端文件时，Void 会将其识别为 SPA。

**静态站点**（使用 VitePress、Docusaurus 等静态站点生成器构建的站点，或任何预构建目录）为每个页面生成 HTML 文件。当项目依赖已知的 SSG，或使用 `--dir` 参数时，Void 会将其识别为静态站点。

在边缘节点，请求按以下顺序解析：

1. 精确匹配的文件路径（`/styles.css` → `styles.css`）
2. 目录下的索引文件（`/about` → `about/index.html`）
3. `404.html`，以 **404 状态码**返回（如果该文件存在）
4. 普通 404 响应

**部署：** `void deploy` 或 `void deploy --dir <path>` 会直接上传静态文件。资源由边缘节点提供，并自动缓存。

## 为静态站点添加后端 {#adding-a-backend-to-a-static-site}

如果你为静态站点生成器添加 API 路由，需要告诉 Void 是否同时部署后端。自动检测同时发现 SSG 依赖和后端文件时，会停止并要求你设置 `inference.appType`。

要同时部署两者，请将 `appType` 设为 `"void"`，并在构建 Void 应用前先构建静态站点：

```ts
import { defineConfig } from 'void/config';

export default defineConfig({
  inference: {
    appType: 'void',
    build: 'vitepress build && vite build',
  },
});
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';

export default defineConfig({
  plugins: [voidPlugin()],
  // The SSG's output becomes the static assets of the Void build.
  publicDir: '.vitepress/dist',
});
```

`vitepress build` 生成站点，随后 `vite build` 将 `publicDir` 复制到 `dist/client`，并将 Worker 输出到 `dist/ssr`。只在**根目录**的 `vite.config.ts` 中添加 `voidPlugin()`，不要添加到生成器自身的配置中（例如 `.vitepress/config.ts`）。

未匹配的请求由 Worker 处理。设置 [`routing.notFound`](/zh/reference/config#routing-notfound)，即可为这些请求返回生成器的 `404.html`：

```json
{ "routing": { "notFound": "404-page" } }
```

如果只想部署静态输出，请设置：

```json
{ "inference": { "appType": "static" } }
```

## 显式配置 {#explicit-configuration}

要固定应用类型并跳过自动检测，请在 [`void.config.ts`](/zh/reference/config) 中设置 `inference.appType`：

```json
{
  "inference": {
    "appType": "static",
    "outputDir": ".vitepress/dist"
  }
}
```

- `inference.appType`：`"void"`、`"framework"`、`"spa"` 或 `"static"`
- `inference.outputDir`：静态应用类型的输出目录（相对于项目根目录，默认为 `"dist"`）
