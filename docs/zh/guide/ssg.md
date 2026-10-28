---
outline: deep
---

# 静态站点生成（SSG） {#static-site-generation-ssg}

在 `void.config.ts` 中设置 `output: "static"`，即可在构建时预渲染所有页面：

```json
{
  "output": "static"
}
```

当 `output` 为 `"static"` 时：

- 页面默认使用 `prerender = true`，并以 HTML 文件的形式写入 `dist/client/`。
- 在页面的 `.server.ts` 中导出 `export const prerender = false`，可让该页面改为在收到请求时由服务端渲染。
- 未提供 `getPrerenderPaths()` 的动态页面不会被预渲染，因为构建时无法确定它们的路径。
- 构建产物包含独立运行所需的文件，可直接部署到 Cloudflare、自行托管，或使用 `void deploy` 部署。

## 单独设置页面 {#per-page-overrides}

你可以为某个页面关闭预渲染：

```ts
// pages/dashboard.server.ts
export const prerender = false;
```

对于动态页面，Void 会按 `getPrerenderPaths()` 返回的参数组合进行预渲染：

```ts
// pages/blog/[slug].server.ts
export async function getPrerenderPaths() {
  return [{ slug: 'hello-world' }, { slug: 'getting-started' }];
}
```

## 404 页面 {#_404-pages}

静态构建只要预渲染了至少一个页面，就会在 `dist/client/` 中生成默认的 `404.html`。要自定义这个页面，可以添加 `public/404.html`，或预渲染一个路径为 `/404` 的页面。

对于完全静态的 Void 部署，请求的 URL 不存在时，默认会返回这个页面，并使用 HTTP 404 状态码。你也可以通过 [`routing.notFound`](/zh/reference/config#routing-notfound)调整此行为。混合部署则由 Worker 处理不存在的 URL。

如果自行托管 `dist/client/`，需要将托管服务配置为：页面不存在时返回 `404.html`，并使用 404 状态码。

## 与边缘预渲染的区别 {#comparison-with-edge-prerendering}

| `output` 的值 | 默认是否预渲染 | 按页面覆盖设置 | 预渲染时机 |
| --- | --- | --- | --- |
| `"server"`（默认） | `false` | `export const prerender = true` | 部署时（平台 ISR） |
| `"static"` | `true` | `export const prerender = false` | 构建时，或部署过程中的构建后阶段 |

默认的 `output: "server"` 模式下，可使用 `export const prerender = true` 开启部署时的[边缘预渲染](/zh/guide/edge/prerendering)。

## 部署方式 {#deployment-behavior}

`void deploy` 会自动选择部署方式：

- **完全静态：** 如果所有页面都已预渲染，且没有 API 路由、中间件、定时任务或队列，Void 会将其部署为纯静态站点，无需 Worker。
- **混合部署：** 如果部分页面无法预渲染，例如未提供 `getPrerenderPaths()` 的动态页面，或设置了 `export const prerender = false` 的页面，则会部署一个 Worker，在运行时处理这些路由。已经预渲染的页面仍作为静态资源提供。

## 与 `inference.appType: "static"` 的关系 {#relationship-to-inference-apptype-static}

`inference.appType` 描述应用类型（SPA、static、void），而 `output` 控制渲染策略：

| | `inference.appType: "static"` | `output: "static"` |
| --- | --- | --- |
| **作用** | 部署已构建的静态站点，不使用 Void 插件 | 在构建时预渲染 Void 应用 |
| **Worker** | 不需要，仅提供静态资源 | 只有部分页面无法预渲染时才需要 |
| **适用场景** | VitePress、普通 HTML、外部 SSG 工具 | 以静态内容为主或全部为静态内容的 Void 应用 |
